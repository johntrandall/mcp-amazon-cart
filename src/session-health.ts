import fs from 'node:fs';
import type { BrowserContext, Page } from 'patchright';
import { getContext } from './browser';
import { saveAmazonSession } from './session-manager';
import { opRead, opReadOtp, scrubMessage, OpError, Secret } from './op-credentials';
import { sendPushoverEscalation } from './pushover';
import { appendSessionHealthEvent, pruneSessionHealthLogs } from './audit-log';
import { getActiveReturnTaskCount } from './returns';
import {
  PUSHOVER_ESCALATION_CODES,
  TOTP_TTL_REFRESH_THRESHOLD_SECONDS,
  TOTP_WINDOW_SECONDS,
  type CheckLoginErrorCode,
  type CheckLoginResult,
  type KnownBanner,
  type RefreshErrorCode,
  type RefreshSessionResult,
  type RefreshStep,
  type ReturnAccount,
  type SessionHealth,
  type SessionHealthReport,
} from './types';
// Import is below the type-only block on purpose: banner-recovery imports
// classifyHealth / isRefreshInFlight / _testing from THIS module. The
// circular shape is fine because banner-recovery only touches values
// declared above its own usage point at runtime (attemptBannerRecovery is
// called from doCheckLogin, well after module evaluation).
import { attemptBannerRecovery } from './banner-recovery';

// ----------------------------------------------------------------------------
// Module-load assertions — fail fast on misconfiguration before any tool fires.
// ----------------------------------------------------------------------------

const AMAZON_DOMAIN_ALLOWLIST = new Set(['amazon.com', 'business.amazon.com']);
const AMAZON_DOMAIN_RE = /^[a-z0-9.-]+$/;

const _amazonDomain = process.env.AMAZON_DOMAIN || '';
if (!_amazonDomain || !AMAZON_DOMAIN_RE.test(_amazonDomain) || !AMAZON_DOMAIN_ALLOWLIST.has(_amazonDomain)) {
  throw new Error(
    `AMAZON_DOMAIN env var missing or invalid: "${_amazonDomain}". ` +
      `Expected one of: ${[...AMAZON_DOMAIN_ALLOWLIST].join(', ')}.`,
  );
}
const AMAZON_DOMAIN: string = _amazonDomain;

// Allow tests to override SESSION_HEALTH_AUDIT_DIR; prod always sets it via
// the bind mount in compose and the value matches the spec default below.
const SESSION_HEALTH_AUDIT_DIR =
  process.env.SESSION_HEALTH_AUDIT_DIR || '/var/lib/amazon-cart/session-health';
try {
  fs.statSync(SESSION_HEALTH_AUDIT_DIR);
} catch {
  throw new Error(
    `${SESSION_HEALTH_AUDIT_DIR} not found. Bind-mount ` +
      `/volume1/docker/amazon-cart-session-health from the Synology host. ` +
      `See docs/session-health-v1.1-design.md §Compose changes.`,
  );
}

// Prune retention on module load (synchronous, runs once, before any tools fire).
pruneSessionHealthLogs();

const CONTAINER_BOOT_MS = Date.now();

// ----------------------------------------------------------------------------
// Account → BASE_URL mapping. Personal hits amazon.com; business uses
// www.amazon.com with the business-account cookies (matches amazon-business.ts).
// ----------------------------------------------------------------------------

const ACCOUNT_TO_DOMAIN: Record<ReturnAccount, string> = {
  personal: 'www.amazon.com',
  business: 'www.amazon.com',
};

function ordersUrlFor(account: ReturnAccount): string {
  return account === 'business'
    ? `https://${ACCOUNT_TO_DOMAIN[account]}/ab/your-orders`
    : `https://${ACCOUNT_TO_DOMAIN[account]}/your-orders`;
}

function signinUrlFor(_account: ReturnAccount): string {
  // 2026-06-18 OBSERVE: bare /ap/signin returns Amazon's "Looking for
  // Something?" error page (verified via debug_dump_dom). The user-facing
  // /gp/sign-in.html endpoint 302's into /ap/signin with the required
  // openid.return_to / openid.assoc_handle=usflex query params, landing
  // on the real signin form. Use that consumer entry point — Amazon's
  // own redirect picks the correct downstream flow per cookie jar.
  return `https://www.${AMAZON_DOMAIN}/gp/sign-in.html`;
}

// ----------------------------------------------------------------------------
// Tracing-disabled assertion. Patchright doesn't expose a public tracing
// state inspector; instead we check the env var that ops would set to turn
// it on. The compose files never set PWDEBUG / PW_TRACING / TRACING_ENABLED,
// so any non-empty value here means a debug build leaked into prod.
// ----------------------------------------------------------------------------

function tracingEnabled(): boolean {
  return Boolean(
    process.env.PWDEBUG ||
      process.env.PW_TRACING ||
      process.env.TRACING_ENABLED === 'true' ||
      process.env.PATCHRIGHT_TRACING === 'true',
  );
}
if (tracingEnabled()) {
  throw new Error(
    'Tracing detected at module load (PWDEBUG/PW_TRACING/TRACING_ENABLED). ' +
      'Refusing to load session-health — credentials would land in trace output.',
  );
}

// ----------------------------------------------------------------------------
// Pure SessionHealth classifier — extracted for unit testability.
// ----------------------------------------------------------------------------

export interface DomSnapshot {
  bodyText: string;
  bannerIds: string[]; // ids of every [id*="Banner"] match on the page
  hasOtpField: boolean; // #auth-mfa-otpcode visible
  hasApprovePushText: boolean; // "Approve this sign-in" textual signal
  hasAccountLockText: boolean; // account-lock/review language
}

const KNOWN_BANNER_PATTERNS: Array<{ key: KnownBanner; idIncludes: string[] }> = [
  { key: 'attention_required', idIncludes: ['Banner', 'ttention'] },
  { key: 'order_retrieval_problem', idIncludes: ['Banner', 'roblem'] },
];

// Banner ids whose presence is page structure / per-order-row UI decoration,
// not an error indicator. Filtered out before classification so they do not
// trip banner_blocked through the unknown-id branch.
//
// [Observed 2026-06-18] On /ab/your-orders for a known-degraded business
// account, the captured DOM included 6 `yourOrderHistoryResultBanner` divs
// alongside real error banners (AttentionRequiredBanner,
// OrderRetreivalProblemBanner). 6× repetition on a single page is
// structurally inconsistent with an attention banner — Amazon does not
// stack identical error banners. The simpler reading is per-order-row
// status decoration. Adding here pending Verified evidence (a known-
// healthy /your-orders snapshot that still contains the same id would
// confirm; absence would mean revisiting). If a future legitimate error
// banner uses the same id, the unit test for known/benign discrimination
// will flag the conflict.
const BENIGN_BANNER_PATTERNS: Array<{ idIncludes: string[]; description: string }> = [
  {
    idIncludes: ['Banner', 'yourOrderHistoryResult'],
    description: 'per-order-row decoration on /your-orders',
  },
];

function isBenignBannerId(id: string): boolean {
  return BENIGN_BANNER_PATTERNS.some((pat) =>
    pat.idIncludes.every((needle) => id.includes(needle)),
  );
}

function bannersFromIds(
  bannerIds: string[],
): { known: KnownBanner[]; unknown: string[] } {
  const known: KnownBanner[] = [];
  const unknown: string[] = [];
  for (const id of bannerIds) {
    if (isBenignBannerId(id)) continue;
    let matched = false;
    for (const pat of KNOWN_BANNER_PATTERNS) {
      if (pat.idIncludes.every((needle) => id.includes(needle))) {
        if (!known.includes(pat.key)) known.push(pat.key);
        matched = true;
        break;
      }
    }
    if (!matched) {
      unknown.push(id);
    }
  }
  return { known, unknown };
}

/**
 * Pure classifier — given a URL and DOM signals, return the SessionHealth.
 * No I/O; safe to call from tests with hand-rolled DomSnapshots.
 */
export function classifyHealth(url: string, dom: DomSnapshot): SessionHealth {
  // URL is the strongest signal — Amazon redirects to canonical paths
  // for each challenge state.
  if (/\/ap\/signin/i.test(url)) {
    return 'auth_expired';
  }
  if (/\/errors\/validateCaptcha|\/ap\/cvf\//i.test(url)) {
    return 'captcha_challenge';
  }
  if (/\/ap\/mfa/i.test(url)) {
    return 'mfa_challenge';
  }
  // DOM-side challenge signals — push MFA never leaves /ap/signin.
  if (dom.hasOtpField) {
    return 'mfa_challenge';
  }
  if (dom.hasApprovePushText) {
    return 'mfa_push_pending';
  }
  if (dom.hasAccountLockText) {
    return 'account_locked';
  }
  if (/verify your identity/i.test(dom.bodyText)) {
    return 'mfa_challenge';
  }
  // Banner detection — order matters: attention-banner outranks generic body.
  const { known, unknown } = bannersFromIds(dom.bannerIds);
  if (known.length > 0 || unknown.length > 0) {
    return 'banner_blocked';
  }
  // Healthy iff the body has the canonical greeting text. We rely on
  // captureDomSnapshot below to surface this through `bodyText`.
  if (/Hello[, ]/.test(dom.bodyText) || /Your Orders/i.test(dom.bodyText)) {
    return 'healthy';
  }
  return 'unknown_degraded';
}

// ----------------------------------------------------------------------------
// Page-side helpers — actual DOM probing.
// ----------------------------------------------------------------------------

async function captureDomSnapshot(page: Page): Promise<DomSnapshot> {
  return page.evaluate(() => {
    const bannerEls = Array.from(document.querySelectorAll('[id*="Banner"]'));
    const bannerIds = bannerEls.map((e) => (e as HTMLElement).id).filter(Boolean);
    const otp = document.querySelector('#auth-mfa-otpcode');
    const bodyText = (document.body?.textContent || '').slice(0, 5000);
    const approve = /approve this sign-in|approve this sign in|notification on/i.test(bodyText);
    const lock = /your account has been locked|account locked|temporarily locked/i.test(bodyText);
    return {
      bodyText,
      bannerIds,
      hasOtpField: !!otp,
      hasApprovePushText: approve,
      hasAccountLockText: lock,
    };
  });
}

async function captureGreeting(page: Page): Promise<string | undefined> {
  return page.evaluate(() => {
    const sels = [
      '#nav-link-accountList-nav-line-1',
      '#nav-link-accountList',
      '.nav-line-1',
      '[id*="accountList"]',
    ];
    for (const sel of sels) {
      const el = document.querySelector(sel);
      const t = el?.textContent?.trim() || '';
      if (t.startsWith('Hello') && t.length <= 60) {
        return t;
      }
    }
    const m = (document.body?.textContent || '').match(/Hello[, ][^\n]{1,40}/);
    return m ? m[0].trim() : undefined;
  });
}

// ----------------------------------------------------------------------------
// In-flight refresh tracking (per-account mutex + last-refresh state).
// ----------------------------------------------------------------------------

const refreshInFlight = new Map<ReturnAccount, Promise<RefreshSessionResult>>();

interface LastRefresh {
  at: string;
  outcome: 'success' | 'failure';
  error_code?: RefreshErrorCode;
}
const lastRefresh = new Map<ReturnAccount, LastRefresh>();

// Exposed so server.ts can tell whether a check_login should bail with
// refresh_in_progress without spawning a navigation.
export function isRefreshInFlight(account: ReturnAccount): boolean {
  return refreshInFlight.has(account);
}

// ----------------------------------------------------------------------------
// Error-message stock text — keep it short, never include raw exception
// content. scrubMessage runs over the result before it surfaces.
// ----------------------------------------------------------------------------

const REFRESH_ERROR_MESSAGES: Record<RefreshErrorCode, string> = {
  op_binary_missing: 'op CLI not present in container; rebuild the image.',
  op_token_invalid: 'op service-account token rejected; rotate the 1P token.',
  creds_missing: 'Amazon credentials missing from 1P entry.',
  navigation_failed: 'Could not reach Amazon sign-in URL.',
  email_step_failed: 'Email-entry page did not resolve.',
  password_step_failed: 'Password rejected by Amazon.',
  mfa_required_no_totp: 'Amazon requested MFA but no TOTP path is configured.',
  mfa_totp_rejected: 'TOTP code rejected by Amazon after retry.',
  captcha_encountered: 'CAPTCHA encountered; requires human via VNC.',
  security_challenge: 'Amazon security challenge (push MFA or SMS); requires human via VNC.',
  account_locked: 'Amazon reports the account is locked.',
  returns_in_flight: 'A returns task is in flight; operator must wait or cancel.',
  refresh_in_progress: 'Another refresh is in flight for this account.',
  amazon_domain_invalid: 'AMAZON_DOMAIN env var missing or not in allowlist.',
  tracing_enabled: 'Tracing detected; refusing to type credentials.',
  unknown_error: 'Refresh failed; see audit log.',
};

const CHECK_LOGIN_ERROR_MESSAGES: Record<CheckLoginErrorCode, string> = {
  browser_crashed: 'Browser context crashed.',
  navigation_timeout: 'Navigation to orders page timed out.',
  op_binary_missing: 'op CLI not present in container; rebuild the image.',
  op_token_invalid: 'op service-account token rejected; rotate the 1P token.',
  amazon_domain_invalid: 'AMAZON_DOMAIN env var missing or not in allowlist.',
};

function buildRefreshError(
  code: RefreshErrorCode,
  step_failed: RefreshStep | undefined,
  retry_after_seconds?: number,
): { result: import('./types').RefreshSessionError; pushover_sent_intent: boolean } {
  const pushover_sent_intent = PUSHOVER_ESCALATION_CODES.has(code);
  const recoverable =
    code === 'returns_in_flight' ||
    code === 'refresh_in_progress' ||
    code === 'navigation_failed';
  return {
    result: {
      success: false,
      error_code: code,
      message: scrubMessage(REFRESH_ERROR_MESSAGES[code], []),
      step_failed,
      pushover_sent: false, // overwritten after sendPushoverEscalation resolves
      recoverable,
      retry_after_seconds,
    },
    pushover_sent_intent,
  };
}

// ----------------------------------------------------------------------------
// check_login implementation
// ----------------------------------------------------------------------------

async function doCheckLogin(account: ReturnAccount): Promise<CheckLoginResult> {
  // External refresh-in-progress short-circuit — prevents this navigation
  // from yanking the singleton page out from under the refresh flow.
  if (refreshInFlight.has(account)) {
    return {
      success: true,
      loggedIn: false,
      health: 'refresh_in_progress',
      cookieCount: 0,
      ordersUrl: ordersUrlFor(account),
      ordersUrlReached: ordersUrlFor(account),
      bannersDetected: [],
      detectedAt: new Date().toISOString(),
    };
  }

  let context: BrowserContext;
  try {
    context = await getContext();
  } catch (err: any) {
    return {
      success: false,
      error_code: 'browser_crashed',
      message: scrubMessage(CHECK_LOGIN_ERROR_MESSAGES.browser_crashed, []),
    };
  }

  // Use a dedicated newPage() so check_login never disturbs whatever page
  // a concurrent cart op might be sitting on.
  const page = await context.newPage();
  const ordersUrl = ordersUrlFor(account);
  let ordersUrlReached = ordersUrl;
  try {
    try {
      await page.goto(ordersUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    } catch {
      return {
        success: false,
        error_code: 'navigation_timeout',
        message: scrubMessage(CHECK_LOGIN_ERROR_MESSAGES.navigation_timeout, []),
      };
    }
    ordersUrlReached = page.url();
    const initialDom = await captureDomSnapshot(page);
    const initialHealth = classifyHealth(ordersUrlReached, initialDom);

    // Self-heal layer: if banner_blocked, attempt cheap reload-only
    // recovery (see banner-recovery.ts). Only triggers when the known
    // banner set contains an entry on the reload-recoverable list; never
    // calls refresh_session and never burns a TOTP. No-op for every other
    // health state — additive, leaves the prior contract intact.
    let dom = initialDom;
    let health = initialHealth;
    let selfHealAttempts = 0;
    if (initialHealth === 'banner_blocked') {
      const recovery = await attemptBannerRecovery(page, account, initialDom);
      selfHealAttempts = recovery.attempts;
      dom = recovery.finalDom;
      health = recovery.finalHealth;
      ordersUrlReached = recovery.finalUrl;
    }

    const greeting = health === 'healthy' ? await captureGreeting(page) : undefined;
    const validatedGreeting =
      greeting && /^Hello[, ].{1,40}$/.test(greeting) ? greeting : undefined;

    const cookies = await context.cookies('https://www.amazon.com').catch(() => []);

    const { known, unknown } = bannersFromIds(dom.bannerIds);
    const result: CheckLoginResult = {
      success: true,
      loggedIn: health === 'healthy',
      health,
      greeting: validatedGreeting,
      cookieCount: cookies.length,
      ordersUrl,
      ordersUrlReached,
      bannersDetected: known,
      unknownBannerIds: unknown.length > 0 ? unknown : undefined,
      detectedAt: new Date().toISOString(),
      selfHealAttempts: selfHealAttempts > 0 ? selfHealAttempts : undefined,
    };

    void appendSessionHealthEvent({
      timestamp: new Date().toISOString(),
      tool: 'check_login',
      account,
      final_error_code: 'success',
      self_heal_attempts: selfHealAttempts > 0 ? selfHealAttempts : undefined,
    });

    return result;
  } finally {
    await page.close().catch(() => {});
  }
}

export async function checkLoginPersonal(): Promise<CheckLoginResult> {
  return doCheckLogin('personal');
}
export async function checkLoginBusiness(): Promise<CheckLoginResult> {
  return doCheckLogin('business');
}

// ----------------------------------------------------------------------------
// refresh_session implementation — phased flow per spec §refresh_session.
// ----------------------------------------------------------------------------

const VNC_URL_PERSONAL = 'vnc://umbridge:5937';
const VNC_URL_BUSINESS = 'vnc://umbridge:5938';

function vncUrlFor(account: ReturnAccount): string {
  return account === 'business' ? VNC_URL_BUSINESS : VNC_URL_PERSONAL;
}

async function totpTtlSafeRead(otpPath: string): Promise<Secret> {
  const code = await opReadOtp(otpPath);
  const ttl = TOTP_WINDOW_SECONDS - (Math.floor(Date.now() / 1000) % TOTP_WINDOW_SECONDS);
  if (ttl < TOTP_TTL_REFRESH_THRESHOLD_SECONDS) {
    // Sleep across the window boundary, then re-read.
    await new Promise((resolve) => setTimeout(resolve, (ttl + 1) * 1000));
    return opReadOtp(otpPath);
  }
  return code;
}

interface FillResult {
  ok: boolean;
}

/**
 * Return the first locator in `selectors` that exists AND is visible, or null.
 * Visibility-gating is load-bearing: Amazon's sign-in form carries hidden
 * inputs (e.g. the remembered-email `#ap-claim` with name="email"). Calling
 * `.fill()` on a hidden input throws in patchright/Playwright. We must never
 * select one — classify the page only by controls the user could actually act
 * on. (2026-06-22)
 */
async function firstVisibleLocator(page: Page, selectors: string[]) {
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      if ((await loc.count()) > 0 && (await loc.isVisible())) return loc;
    } catch {
      // try next selector
    }
  }
  return null;
}

/** Accessibility fallback: first VISIBLE textbox whose accessible name matches. */
async function visibleRoleTextbox(page: Page, name: RegExp) {
  try {
    const loc = page.getByRole('textbox', { name }).first();
    if ((await loc.count()) > 0 && (await loc.isVisible())) return loc;
  } catch {
    // fall through
  }
  return null;
}

/**
 * Poll until any of `selectors` is visible, or `timeoutMs` elapses. Amazon
 * renders the credential form via an async auth pagelet; classifying the page
 * at `domcontentloaded` races that render and yields false negatives. Settle on
 * a real, visible control before deciding what step we are on. (2026-06-22)
 */
async function waitForAnyVisible(page: Page, selectors: string[], timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await firstVisibleLocator(page, selectors)) return true;
    await page.waitForTimeout(250);
  }
  return false;
}

/**
 * Submit the <form> that `field` actually belongs to, rather than clicking
 * whatever button owns a hard-coded id. Amazon renders a sibling
 * "Sign in with a passkey" button with id="continue" on the password page; a
 * generic id-ordered click fires the (failing) passkey flow instead of
 * submitting the password. Walk to the field's ancestor form and click ITS
 * submit; fall back to the canonical #signInSubmit, then to native Enter.
 * (2026-06-22)
 */
async function submitOwningForm(
  page: Page,
  field: Awaited<ReturnType<typeof firstVisibleLocator>>,
): Promise<boolean> {
  if (!field) return false;
  try {
    const submit = field
      .locator('xpath=ancestor::form[1]')
      .locator('button[type="submit"], input[type="submit"]')
      .first();
    if ((await submit.count()) > 0 && (await submit.isVisible())) {
      await submit.click();
      return true;
    }
  } catch {
    // fall through
  }
  const byId = await firstVisibleLocator(page, ['#signInSubmit']);
  if (byId) {
    try {
      await byId.click();
      return true;
    } catch {
      // fall through
    }
  }
  try {
    await field.press('Enter');
    return true;
  } catch {
    return false;
  }
}

async function fillWithFallback(
  page: Page,
  candidates: string[],
  roleFallback: () => Promise<boolean>,
  value: Secret,
  timeoutMs = 8000,
): Promise<FillResult> {
  const deadline = Date.now() + timeoutMs;
  for (const sel of candidates) {
    if (Date.now() > deadline) break;
    try {
      const loc = page.locator(sel).first();
      if ((await loc.count()) > 0) {
        await loc.fill(value.reveal());
        return { ok: true };
      }
    } catch {
      // try next
    }
  }
  // Role-based fallback — invoked last.
  try {
    if (await roleFallback()) {
      return { ok: true };
    }
  } catch {
    // fall through
  }
  return { ok: false };
}

async function clickContinueOrSignin(page: Page): Promise<boolean> {
  // TODO selector-discovery: confirm IDs on live wizard.
  const candidates = ['#continue', '#signInSubmit', 'input[id="continue"]', 'input[id="signInSubmit"]'];
  for (const sel of candidates) {
    try {
      const loc = page.locator(sel).first();
      if ((await loc.count()) > 0) {
        await loc.click();
        return true;
      }
    } catch {
      // try next
    }
  }
  try {
    const role = page.getByRole('button', { name: /continue|sign in|sign-in/i }).first();
    if ((await role.count()) > 0) {
      await role.click();
      return true;
    }
  } catch {
    /* fall through */
  }
  return false;
}

async function detectChallengeOnPage(
  page: Page,
): Promise<'captcha' | 'security' | 'account_locked' | 'mfa' | 'mfa_push' | null> {
  const url = page.url();
  if (/\/errors\/validateCaptcha|\/ap\/cvf\//i.test(url)) return 'captcha';
  const dom = await captureDomSnapshot(page);
  if (/captcha|validateCaptcha/i.test(dom.bodyText)) return 'captcha';
  if (dom.hasAccountLockText) return 'account_locked';
  if (dom.hasOtpField) return 'mfa';
  if (dom.hasApprovePushText) return 'mfa_push';
  if (/verify your identity|security challenge/i.test(dom.bodyText)) return 'security';
  return null;
}

async function safeCleanup(page: Page): Promise<void> {
  try {
    await page.goto('about:blank', { timeout: 5_000 });
  } catch {
    /* mid-redirect or context gone; never let cleanup mask the original error */
  }
  try {
    await page.close();
  } catch {
    /* already closed */
  }
}

async function doRefresh(
  account: ReturnAccount,
  force: boolean,
): Promise<RefreshSessionResult> {
  const t0 = Date.now();
  const steps_attempted: RefreshStep[] = [];
  let pre_health: SessionHealth = 'unknown_degraded';

  // Tracing re-assert immediately before any credential typing path is wired up.
  if (tracingEnabled()) {
    const { result } = buildRefreshError('tracing_enabled', undefined);
    void sendPushoverEscalation({
      account: account as 'personal' | 'business',
      error_code: 'tracing_enabled',
      vnc_url: vncUrlFor(account),
    }).then((ok) => {
      result.pushover_sent = ok;
    });
    return result;
  }

  // 1a — pre-flight: v1.0 TASKS in flight?
  const activeReturns = getActiveReturnTaskCount();
  if (activeReturns > 0) {
    const { result } = buildRefreshError('returns_in_flight', undefined);
    return result;
  }

  // 1b — pre-flight: check_login_*, unless force
  if (!force) {
    try {
      const pre = await doCheckLogin(account);
      if (pre.success) {
        pre_health = pre.health;
        if (pre.health === 'healthy') {
          // Success early return — no work to do.
          const success: RefreshSessionResult = {
            success: true,
            pre_health,
            post_health: pre.health,
            duration_ms: Date.now() - t0,
            steps_attempted,
            session_saved: false,
            pushover_sent: false,
          };
          lastRefresh.set(account, { at: new Date().toISOString(), outcome: 'success' });
          void appendSessionHealthEvent({
            timestamp: new Date().toISOString(),
            tool: 'refresh_session',
            account,
            final_error_code: 'success',
          });
          return success;
        }
      } else {
        // check_login itself errored — treat as needs-refresh, continue.
        pre_health = 'unknown_degraded';
      }
    } catch {
      pre_health = 'unknown_degraded';
    }
  }

  // 2 — fetch credentials
  const emailPath = process.env.AMAZON_LOGIN_EMAIL_1P_PATH;
  const passwordPath = process.env.AMAZON_LOGIN_PASSWORD_1P_PATH;
  const totpPath = process.env.AMAZON_LOGIN_TOTP_1P_PATH; // optional
  if (!emailPath || !passwordPath) {
    return finalizeFailure(account, 'creds_missing', undefined, pre_health, steps_attempted, []);
  }

  let email: Secret;
  let password: Secret;
  try {
    email = await opRead(emailPath);
    password = await opRead(passwordPath);
  } catch (err: any) {
    if (err instanceof OpError) {
      const code: RefreshErrorCode = err.code; // narrowed by OpErrorCode ⊂ RefreshErrorCode
      return finalizeFailure(account, code, undefined, pre_health, steps_attempted, []);
    }
    return finalizeFailure(account, 'unknown_error', undefined, pre_health, steps_attempted, []);
  }

  const allSecrets: Secret[] = [email, password];

  let context: BrowserContext;
  try {
    context = await getContext();
  } catch {
    return finalizeFailure(account, 'navigation_failed', undefined, pre_health, steps_attempted, allSecrets);
  }
  const page = await context.newPage();

  try {
    // 3 — navigate to signin
    steps_attempted.push('navigate_signin');
    try {
      await page.goto(signinUrlFor(account), { waitUntil: 'domcontentloaded', timeout: 20_000 });
    } catch {
      await safeCleanup(page);
      return finalizeFailure(account, 'navigation_failed', 'navigate_signin', pre_health, steps_attempted, allSecrets);
    }
    {
      const challenge = await detectChallengeOnPage(page);
      if (challenge === 'captcha') {
        await safeCleanup(page);
        return finalizeFailure(account, 'captcha_encountered', 'navigate_signin', pre_health, steps_attempted, allSecrets);
      }
      if (challenge === 'account_locked') {
        await safeCleanup(page);
        return finalizeFailure(account, 'account_locked', 'navigate_signin', pre_health, steps_attempted, allSecrets);
      }
    }

    // 4 — settle, then email step. Amazon renders the sign-in form via an
    // async auth pagelet and adapts the layout to cookie state (email-first vs
    // remembered-email password-first vs passkey-first). Wait for SOME
    // credential control to paint, then classify by what is VISIBLE — never by
    // a once-only count at domcontentloaded, and never act on hidden inputs.
    // (2026-06-22: the prior eager `#ap_password` count raced the pagelet, fell
    // through to the email branch, and .fill()'d the hidden remembered-email
    // input `#ap-claim` → email_step_failed. See field report same date.)
    await waitForAnyVisible(
      page,
      ['#ap_password', 'input[type="password"]', '#ap_email_login', '#ap_email', 'input[type="email"]', '#auth-mfa-otpcode'],
      10_000,
    );
    steps_attempted.push('fill_email');
    const visiblePasswordPresent =
      (await firstVisibleLocator(page, ['#ap_password', 'input[type="password"]'])) !== null;
    if (!visiblePasswordPresent) {
      const emailLoc =
        (await firstVisibleLocator(page, ['#ap_email_login', '#ap_email', 'input[type="email"]', 'input[name="email"]'])) ??
        (await visibleRoleTextbox(page, /email|phone/i));
      if (!emailLoc) {
        await safeCleanup(page);
        return finalizeFailure(account, 'email_step_failed', 'fill_email', pre_health, steps_attempted, allSecrets);
      }
      try {
        await emailLoc.fill(email.reveal());
      } catch {
        await safeCleanup(page);
        return finalizeFailure(account, 'email_step_failed', 'fill_email', pre_health, steps_attempted, allSecrets);
      }
      if (!(await clickContinueOrSignin(page))) {
        await safeCleanup(page);
        return finalizeFailure(account, 'email_step_failed', 'fill_email', pre_health, steps_attempted, allSecrets);
      }
      await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => {});
      // Settle the password pagelet before the password step classifies it.
      await waitForAnyVisible(page, ['#ap_password', 'input[type="password"]', '#auth-mfa-otpcode'], 10_000);
      const c = await detectChallengeOnPage(page);
      if (c === 'captcha') {
        await safeCleanup(page);
        return finalizeFailure(account, 'captcha_encountered', 'fill_email', pre_health, steps_attempted, allSecrets);
      }
    }

    // 5 — password step
    steps_attempted.push('fill_password');
    // Pre-fill tracing re-assert — refuse to type if a debug build sneaked in.
    if (tracingEnabled()) {
      await safeCleanup(page);
      return finalizeFailure(account, 'tracing_enabled', 'fill_password', pre_health, steps_attempted, allSecrets);
    }
    let pwdLoc: Awaited<ReturnType<typeof firstVisibleLocator>> = null;
    try {
      pwdLoc =
        (await firstVisibleLocator(page, ['#ap_password', 'input[type="password"]'])) ??
        (await visibleRoleTextbox(page, /password/i));
      if (!pwdLoc) {
        await safeCleanup(page);
        return finalizeFailure(account, 'password_step_failed', 'fill_password', pre_health, steps_attempted, allSecrets);
      }
      await pwdLoc.fill(password.reveal());
    } catch {
      await safeCleanup(page);
      return finalizeFailure(account, 'password_step_failed', 'fill_password', pre_health, steps_attempted, allSecrets);
    }

    steps_attempted.push('submit_password');
    // Submit the password field's OWN form — not the sibling passkey button
    // (id="continue") that Amazon renders alongside it. (2026-06-22)
    if (!(await submitOwningForm(page, pwdLoc))) {
      await safeCleanup(page);
      return finalizeFailure(account, 'password_step_failed', 'submit_password', pre_health, steps_attempted, allSecrets);
    }
    try {
      await page.waitForLoadState('domcontentloaded', { timeout: 20_000 });
    } catch {
      /* may have already landed */
    }

    // Branch on post-submit state
    {
      const c = await detectChallengeOnPage(page);
      if (c === 'captcha') {
        await safeCleanup(page);
        return finalizeFailure(account, 'captcha_encountered', 'submit_password', pre_health, steps_attempted, allSecrets);
      }
      if (c === 'account_locked') {
        await safeCleanup(page);
        return finalizeFailure(account, 'account_locked', 'submit_password', pre_health, steps_attempted, allSecrets);
      }
      if (c === 'security' || c === 'mfa_push') {
        await safeCleanup(page);
        return finalizeFailure(account, 'security_challenge', 'submit_password', pre_health, steps_attempted, allSecrets);
      }
      if (c === 'mfa') {
        // 6 — MFA TOTP
        steps_attempted.push('mfa_totp');
        if (!totpPath) {
          await safeCleanup(page);
          return finalizeFailure(account, 'mfa_required_no_totp', 'mfa_totp', pre_health, steps_attempted, allSecrets);
        }
        let mfaOk = false;
        for (let attempt = 0; attempt < 2; attempt++) {
          let code: Secret;
          try {
            code = await totpTtlSafeRead(totpPath);
          } catch (err: any) {
            await safeCleanup(page);
            const errCode: RefreshErrorCode =
              err instanceof OpError ? (err.code as RefreshErrorCode) : 'unknown_error';
            return finalizeFailure(account, errCode, 'mfa_totp', pre_health, steps_attempted, allSecrets);
          }
          allSecrets.push(code);
          try {
            const otpLoc = page.locator('#auth-mfa-otpcode').first();
            if ((await otpLoc.count()) === 0) {
              await safeCleanup(page);
              return finalizeFailure(account, 'mfa_totp_rejected', 'mfa_totp', pre_health, steps_attempted, allSecrets);
            }
            await otpLoc.fill(code.reveal());
            const submitLoc = page.locator('#auth-signin-button').first();
            if ((await submitLoc.count()) > 0) {
              await submitLoc.click();
            } else {
              await clickContinueOrSignin(page);
            }
            try {
              await page.waitForLoadState('domcontentloaded', { timeout: 20_000 });
            } catch {
              /* may have stayed on page */
            }
            const cc = await detectChallengeOnPage(page);
            if (cc === null || !cc) {
              // success path or further branch
              if (cc === null) {
                mfaOk = true;
                break;
              }
            }
            if (cc === 'mfa') {
              // Amazon kept us on MFA — retry once with fresh code.
              continue;
            }
            if (cc === 'captcha') {
              await safeCleanup(page);
              return finalizeFailure(account, 'captcha_encountered', 'mfa_totp', pre_health, steps_attempted, allSecrets);
            }
            if (cc === 'account_locked') {
              await safeCleanup(page);
              return finalizeFailure(account, 'account_locked', 'mfa_totp', pre_health, steps_attempted, allSecrets);
            }
            if (cc === 'security' || cc === 'mfa_push') {
              await safeCleanup(page);
              return finalizeFailure(account, 'security_challenge', 'mfa_totp', pre_health, steps_attempted, allSecrets);
            }
          } catch {
            await safeCleanup(page);
            return finalizeFailure(account, 'mfa_totp_rejected', 'mfa_totp', pre_health, steps_attempted, allSecrets);
          }
        }
        if (!mfaOk) {
          await safeCleanup(page);
          return finalizeFailure(account, 'mfa_totp_rejected', 'mfa_totp', pre_health, steps_attempted, allSecrets);
        }
      }
    }

    // 8 — trust this device (non-fatal)
    steps_attempted.push('trust_device');
    try {
      const trustLoc = page.locator('#auth-remember-me-checkbox').first();
      if ((await trustLoc.count()) > 0) {
        await trustLoc.check({ timeout: 2_000 });
      }
    } catch {
      // non-fatal per spec
      void appendSessionHealthEvent({
        timestamp: new Date().toISOString(),
        tool: 'refresh_session',
        account,
        final_error_code: 'success', // trust_device failure does not change outcome
      });
    }

    // 9 — verify landing via check_login
    steps_attempted.push('verify_landing');
    let post: CheckLoginResult;
    try {
      // Note: we are still holding the refresh mutex; doCheckLogin's
      // refresh_in_progress guard reads from refreshInFlight via the same
      // map. Internal verify needs to bypass that — call captureDomSnapshot
      // on a fresh page instead.
      const verifyPage = await context.newPage();
      try {
        await verifyPage.goto(ordersUrlFor(account), { waitUntil: 'domcontentloaded', timeout: 20_000 });
        const dom = await captureDomSnapshot(verifyPage);
        const health = classifyHealth(verifyPage.url(), dom);
        const cookies = await context.cookies('https://www.amazon.com').catch(() => []);
        post = {
          success: true,
          loggedIn: health === 'healthy',
          health,
          cookieCount: cookies.length,
          ordersUrl: ordersUrlFor(account),
          ordersUrlReached: verifyPage.url(),
          bannersDetected: bannersFromIds(dom.bannerIds).known,
          detectedAt: new Date().toISOString(),
        };
      } finally {
        await verifyPage.close().catch(() => {});
      }
    } catch {
      await safeCleanup(page);
      return finalizeFailure(account, 'unknown_error', 'verify_landing', pre_health, steps_attempted, allSecrets);
    }
    if (!post.success || post.health !== 'healthy') {
      await safeCleanup(page);
      return finalizeFailure(account, 'unknown_error', 'verify_landing', pre_health, steps_attempted, allSecrets);
    }

    // 10 — save session
    let session_saved = false;
    try {
      await saveAmazonSession(context);
      session_saved = true;
    } catch {
      /* non-fatal */
    }

    await page.close().catch(() => {});

    const success: RefreshSessionResult = {
      success: true,
      pre_health,
      post_health: post.health,
      duration_ms: Date.now() - t0,
      steps_attempted,
      session_saved,
      pushover_sent: false,
    };
    lastRefresh.set(account, { at: new Date().toISOString(), outcome: 'success' });
    void appendSessionHealthEvent({
      timestamp: new Date().toISOString(),
      tool: 'refresh_session',
      account,
      final_error_code: 'success',
    });
    return success;
  } catch {
    await safeCleanup(page);
    return finalizeFailure(account, 'unknown_error', undefined, pre_health, steps_attempted, allSecrets);
  }
}

async function finalizeFailure(
  account: ReturnAccount,
  code: RefreshErrorCode,
  step_failed: RefreshStep | undefined,
  _pre_health: SessionHealth,
  _steps_attempted: RefreshStep[],
  _secrets: Secret[],
): Promise<RefreshSessionResult> {
  lastRefresh.set(account, {
    at: new Date().toISOString(),
    outcome: 'failure',
    error_code: code,
  });
  void appendSessionHealthEvent({
    timestamp: new Date().toISOString(),
    tool: 'refresh_session',
    account,
    final_error_code: code,
  });
  const { result } = buildRefreshError(code, step_failed);
  if (PUSHOVER_ESCALATION_CODES.has(code)) {
    const sent = await sendPushoverEscalation({
      account: account as 'personal' | 'business',
      error_code: code,
      step_failed,
      vnc_url: vncUrlFor(account),
    });
    result.pushover_sent = sent;
  }
  return result;
}

export async function refreshSession(
  account: ReturnAccount,
  force = false,
): Promise<RefreshSessionResult> {
  // Refusal: another refresh already running.
  const inFlight = refreshInFlight.get(account);
  if (inFlight) {
    try {
      return await Promise.race([
        inFlight,
        new Promise<RefreshSessionResult>((_, rej) =>
          setTimeout(() => rej(new Error('refresh_in_progress_timeout')), 60_000),
        ),
      ]);
    } catch (e: any) {
      if (e instanceof Error && e.message === 'refresh_in_progress_timeout') {
        return {
          success: false,
          error_code: 'refresh_in_progress',
          message: scrubMessage(REFRESH_ERROR_MESSAGES.refresh_in_progress, []),
          pushover_sent: false,
          recoverable: true,
          retry_after_seconds: 60,
        };
      }
      return {
        success: false,
        error_code: 'unknown_error',
        message: scrubMessage(REFRESH_ERROR_MESSAGES.unknown_error, []),
        pushover_sent: false,
        recoverable: true,
      };
    }
  }

  // Promise.resolve().then() converts a synchronous throw in doRefresh into
  // a rejected promise — preserves the "always return, never throw" contract.
  const promise = Promise.resolve().then(() => doRefresh(account, force));
  refreshInFlight.set(account, promise);
  try {
    return await promise;
  } catch {
    return {
      success: false,
      error_code: 'unknown_error',
      message: scrubMessage(REFRESH_ERROR_MESSAGES.unknown_error, []),
      pushover_sent: false,
      recoverable: true,
    };
  } finally {
    refreshInFlight.delete(account);
  }
}

export async function refreshSessionPersonal(
  input: { force?: boolean } = {},
): Promise<RefreshSessionResult> {
  return refreshSession('personal', input.force === true);
}
export async function refreshSessionBusiness(
  input: { force?: boolean } = {},
): Promise<RefreshSessionResult> {
  return refreshSession('business', input.force === true);
}

// ----------------------------------------------------------------------------
// session_health composite report
// ----------------------------------------------------------------------------

async function doSessionHealth(account: ReturnAccount): Promise<SessionHealthReport> {
  const check = await doCheckLogin(account);
  const last = lastRefresh.get(account);
  const uptime_seconds = Math.floor((Date.now() - CONTAINER_BOOT_MS) / 1000);
  if (check.success) {
    return {
      success: true,
      health: check.health,
      greeting: check.greeting,
      bannersDetected: check.bannersDetected,
      last_refresh_at: last?.at,
      last_refresh_outcome: last?.outcome,
      last_refresh_error_code: last?.error_code,
      container_uptime_seconds: uptime_seconds,
      in_flight_return_tasks: getActiveReturnTaskCount(),
      refresh_in_flight: refreshInFlight.has(account),
    };
  }
  return {
    success: true,
    health: 'unknown_degraded',
    bannersDetected: [],
    last_refresh_at: last?.at,
    last_refresh_outcome: last?.outcome,
    last_refresh_error_code: last?.error_code,
    container_uptime_seconds: uptime_seconds,
    in_flight_return_tasks: getActiveReturnTaskCount(),
    refresh_in_flight: refreshInFlight.has(account),
  };
}

export async function sessionHealthPersonal(): Promise<SessionHealthReport> {
  return doSessionHealth('personal');
}
export async function sessionHealthBusiness(): Promise<SessionHealthReport> {
  return doSessionHealth('business');
}

// Internal exports for tests
export const _testing = {
  classifyHealth,
  bannersFromIds,
  KNOWN_BANNER_PATTERNS,
  refreshInFlight,
  lastRefresh,
  buildRefreshError,
};
