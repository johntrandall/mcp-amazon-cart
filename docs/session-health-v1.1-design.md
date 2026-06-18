# mcp-amazon-cart v1.1 — Session Health Spec

Design intent for v1.1 session-health surface. Companion to [returns-design.md](./returns-design.md) (v1.0). Driven by OBSERVE finding 2026-06-18: cart MCP's headless Chrome session drifts into banner-blocked / signed-out state with no programmatic recovery; human had to VNC in.

**Revision 2026-06-18b** — incorporates 5-verifier review (internal DRY, external DRY, security, failure-mode, build feasibility). Rationale notes inline where v2 diverges from the original draft.

## Goal

Eliminate the human VNC step for normal session drift. Programmatic re-auth covers ~90% of cases via 1P credentials read at runtime. Pushover escalation handles ~10% (CAPTCHA, SMS verification, account-lock review) where Amazon legitimately needs human credibility signals.

## Scope — v1.1 additions

| Tool | Purpose |
|---|---|
| `check_login_personal` | EXTEND — deep validation, banner detection on `/your-orders` |
| `check_login_business` | EXTEND — same, on `/ab/your-orders` |
| `refresh_session_personal` | NEW — drive 1P-credentialed login flow |
| `refresh_session_business` | NEW — same for Business |
| `session_health_personal` | NEW — composite report (auth + banners + ops state) |
| `session_health_business` | NEW |

**Naming convention.** These tools follow `check_login_*` (account-as-suffix) rather than v1.0 returns' `account:` argument pattern, because they extend the older convention rather than the newer one. Migrating both halves to `account:` argument is a v1.2 cleanup, not a v1.1 task — splitting now would burn iteration cycles.

No changes to v1.0 returns tools; this is purely session-health.

## Non-goals (deferred to v1.2+)

- Automated CAPTCHA solving (Browserbase escalation)
- SMS-based MFA via Twilio (Pushover-only for v1.1)
- Periodic background refresh (operator-triggered only in v1.1)
- Account-suffix → `account:` argument cleanup across the MCP

## Divergence from `container-secret-management` skill — runtime `op read`

The canonical container-secret-management pattern is bake-at-deploy via Portainer Env array. **v1.1 deliberately diverges** by invoking `op read` at runtime to fetch Amazon credentials and Pushover tokens. Justification:

- The whole point of v1.1 is *human shouldn't need to intervene*. Bake-at-deploy means a rotated Amazon password requires: read 1P → update Portainer Env → redeploy stack. That's 3 operator steps. Runtime `op read` means: rotate 1P entry; next `refresh_session_*` picks up the new value. 0 operator steps.
- The threat model is bounded: a single 1P service-account token scoped item-level to only Amazon Personal/Business and Pushover entries. Leaking that token grants exactly those credentials; nothing else.
- This is the *first* cart MCP container to do runtime `op`. Pattern is being established here; if successful, the `container-secret-management` skill should be amended in v1.2 to acknowledge a "runtime-rotation-capable" tier.

The `mcp-management` skill and `MCP-Server-Inventory.md` rows must be updated to flag this MCP as the first runtime-`op` consumer.

## Out-of-band setup (one-time per container)

| Env var | Sources from | Notes |
|---|---|---|
| `OP_SERVICE_ACCOUNT_TOKEN` | Portainer Env (populated from 1P entry `mcp-amazon-cart-op-token` at deploy time) | Service account item-scoped to the 3 entries below. **Rotate every 90 days** — calendared reminder. |
| `AMAZON_LOGIN_EMAIL_1P_PATH` | Portainer Env, literal path string (not a secret) | e.g. `op://JRVIS Execution/Amazon Personal/username`. **Verify actual field label** during deploy — 1P Login items canonically use `username`, not `email`. |
| `AMAZON_LOGIN_PASSWORD_1P_PATH` | Portainer Env, literal path | e.g. `op://JRVIS Execution/Amazon Personal/password` |
| `AMAZON_LOGIN_TOTP_1P_PATH` | Portainer Env, literal path, optional | e.g. `op://JRVIS Execution/Amazon Personal/one-time password`. **Verify actual field label** — 1P TOTP fields commonly come up as `one-time password` or `OTP`, not `totp`. If Amazon MFA is enabled. |
| `PUSHOVER_APP_TOKEN_1P_PATH` | Portainer Env, literal path | Deploy session creates a dedicated `Pushover - mcp-amazon-cart` item (per the existing pattern: `Pushover - JRVIS`, `Pushover - JRVIS Health Check`, `Pushover - xyOps Application` — one item per noisy producer). Path will be `op://JRVIS Infra/Pushover - mcp-amazon-cart/app_token`. |
| `PUSHOVER_USER_KEY_1P_PATH` | Portainer Env, literal path | Same item: `op://JRVIS Infra/Pushover - mcp-amazon-cart/user_key`. |
| `AMAZON_DOMAIN` | Portainer Env, literal | Already exists. Personal: `amazon.com`. Business: `business.amazon.com`. v1.1 module-load asserts value matches `/^[a-z0-9.-]+$/` AND is in the allowlist `['amazon.com', 'business.amazon.com']`; throws `amazon_domain_invalid` otherwise. |

**Vault choice.** Amazon credentials live in `JRVIS Execution` (matches the skill's "SaaS logins" category). Service account is item-scoped to exactly the entries listed — vault-scoping would over-grant. This avoids creating a new vault.

**Rotation: 90 days.** Tighter than the original 6-month proposal — credentials co-locate password + TOTP under one token, so MFA provides zero defense if the token leaks. Calendar reminder via OmniFocus.

**Audit log backup exclusion.** The bind-mount target `/volume1/docker/amazon-cart-session-health/` must be added to Hyper Backup's exclusion list AND Cloud Sync's stignore — credentials must never leak into a regression that lands them in audit, then off-host. Verify exclusion as part of the deploy step.

## Shared types — single source of truth

```typescript
// types.ts additions

export const SESSION_HEALTH_STATES = [
  'healthy',              // orders page renders, no banners
  'banner_blocked',       // logged in, but /your-orders shows attention banner
  'auth_expired',         // redirects to /ap/signin
  'mfa_challenge',        // /ap/mfa or "verify your identity" interstitial
  'mfa_push_pending',     // "tap notification on phone" — no OTP field
  'captcha_challenge',    // /errors/validateCaptcha or /ap/cvf/
  'account_locked',       // fraud review / account-locked language
  'unknown_degraded',     // page loaded, expected DOM landmarks missing
  'refresh_in_progress',  // a refresh_session_* call is currently running
] as const;
export type SessionHealth = typeof SESSION_HEALTH_STATES[number];

export const REFRESH_ERROR_CODES = [
  'op_binary_missing',       // op CLI not in container image — operator misconfigured Dockerfile — PUSHOVER YES (rare; operator-actionable)
  'op_token_invalid',        // OP_SERVICE_ACCOUNT_TOKEN expired or wrong scope — PUSHOVER YES
  'creds_missing',           // 1P entry missing email/password field — PUSHOVER YES
  'navigation_failed',       // couldn't reach signin URL (network) — PUSHOVER NO
  'email_step_failed',       // email-page never resolved — PUSHOVER NO
  'password_step_failed',    // wrong password from 1P rotation — PUSHOVER YES
  'mfa_required_no_totp',    // MFA challenged but no TOTP path configured — PUSHOVER YES
  'mfa_totp_rejected',       // TOTP submitted, Amazon rejected (after fresh-code retry) — PUSHOVER YES
  'captcha_encountered',     // CAPTCHA at any login step — PUSHOVER YES
  'security_challenge',      // SMS / device challenge / push-MFA — PUSHOVER YES
  'account_locked',          // Amazon-reported account lock — PUSHOVER YES
  'returns_in_flight',       // v1.0 TASKS.size > 0 — operator must wait — PUSHOVER NO
  'refresh_in_progress',     // another refresh in flight — caller should await — PUSHOVER NO
  'amazon_domain_invalid',   // AMAZON_DOMAIN env missing/malformed — operator misconfigured compose — PUSHOVER YES
  'tracing_enabled',         // Playwright tracing detected before password.fill — refuses to type — PUSHOVER YES (operator left a debug build running)
  'unknown_error',           // catchall — PUSHOVER YES
] as const;
export type RefreshErrorCode = typeof REFRESH_ERROR_CODES[number];

// Pushover-triggering codes — derived from the canonical PUSHOVER_ESCALATION_CODES set in pushover.ts.
// Implementation MUST derive escalation from `PUSHOVER_ESCALATION_CODES.has(error_code)`; the YES/NO
// column above is the comment annotation, not a second source of truth.
export const PUSHOVER_ESCALATION_CODES: ReadonlySet<RefreshErrorCode> = new Set([
  'op_binary_missing',
  'op_token_invalid',
  'creds_missing',
  'password_step_failed',
  'mfa_required_no_totp',
  'mfa_totp_rejected',
  'captcha_encountered',
  'security_challenge',
  'account_locked',
  'amazon_domain_invalid',
  'tracing_enabled',
  'unknown_error',
]);

export const CHECK_LOGIN_ERROR_CODES = [
  'browser_crashed',
  'navigation_timeout',
  'op_binary_missing',        // shares semantic with RefreshErrorCode
  'op_token_invalid',         // shares semantic with RefreshErrorCode
  'amazon_domain_invalid',    // shares semantic with RefreshErrorCode
] as const;
export type CheckLoginErrorCode = typeof CHECK_LOGIN_ERROR_CODES[number];

// TOTP TTL window — single source of truth.
export const TOTP_TTL_REFRESH_THRESHOLD_SECONDS = 10;
export const TOTP_WINDOW_SECONDS = 30;
```

## Tool specs

### `check_login_personal` / `check_login_business` (EXTENDED)

```typescript
export interface CheckLoginSuccess {
  success: true;
  loggedIn: boolean;                  // true only if health === 'healthy'
  health: SessionHealth;
  greeting?: string;                  // whitelist-validated /^Hello[, ].{1,40}$/
  cookieCount: number;
  ordersUrl: string;                  // canonical URL probed
  ordersUrlReached: string;           // actual URL after navigation
  bannersDetected: Array<'attention_required' | 'order_retrieval_problem' | 'unknown_banner'>;
  unknownBannerIds?: string[];        // future-proofing: unrecognized banner IDs logged
  detectedAt: string;                 // ISO
}

export interface CheckLoginError {
  success: false;
  error_code: CheckLoginErrorCode;
  message: string;                    // scrubbed; never contains credential content
}

export type CheckLoginResult = CheckLoginSuccess | CheckLoginError;
```

**Banner detection — fuzzy + future-proof.** Don't pin exact IDs (`#AttentionRequiredBanner`); Amazon's typo `OrderRetreivalProblemBanner` could be fixed silently. Use attribute selectors: `[id*="Banner"][id*="ttention"]`, `[id*="Banner"][id*="roblem"]`. Any unrecognized `[id*="Banner"]` lands in `unknownBannerIds` and audit log for future analysis.

**Login-page DOM fallback chain.** Email field: try `#ap_email_login`, `#ap_email`, `page.getByRole('textbox', { name: /email|phone/i })`. Password: `#ap_password`, fallback role-based. Continue button: `#continue`, fallback `page.getByRole('button', { name: /continue/i })`. Resilient against Amazon redesigns.

**AMAZON_DOMAIN coupling.** Each container has `AMAZON_DOMAIN` env (personal: `amazon.com`, business: `business.amazon.com`). All URL construction derives from this; never hardcode `amazon.com` in v1.1 code. Reason: the business container's signin URL is `https://www.amazon.com/ap/signin?...&openid.assoc_handle=amzn_business_ldap` — different from personal.

**Tracing-disabled assert.** At module load: assert no `tracing.start({ sources: true, ... })` is active. Prod containers run `HEADLESS=true` and tracing off; this assertion catches a debug-build accident before any password gets typed.

Health detection ≤5s in healthy case.

### `refresh_session_personal` / `refresh_session_business` (NEW)

```typescript
export interface RefreshSessionInput {
  force?: boolean;  // skip pre-flight; refresh even if health === 'healthy'
}

export interface RefreshSessionSuccess {
  success: true;
  pre_health: SessionHealth;
  post_health: SessionHealth;
  duration_ms: number;
  steps_attempted: Array<'navigate_signin' | 'fill_email' | 'fill_password' | 'submit_password' | 'mfa_totp' | 'trust_device' | 'verify_landing'>;
  session_saved: boolean;
  pushover_sent: false;               // success path never sends Pushover
}

export interface RefreshSessionError {
  success: false;
  error_code: RefreshErrorCode;       // from canonical const above
  message: string;                    // ENUM-DERIVED STOCK TEXT — never raw exception, never credential content
  step_failed?: string;
  pushover_sent: boolean;             // matches PUSHOVER_ESCALATION_CODES membership
  recoverable: boolean;
  retry_after_seconds?: number;       // set when error_code === 'refresh_in_progress'
}

export type RefreshSessionResult = RefreshSessionSuccess | RefreshSessionError;
```

**Implementation phases** (use `opRead` helper for all 1P access — see Implementation details):

1. **Pre-flight guards** (in order, all returning structured errors not throws):
   - If `force !== true`: call `check_login_{account}`. If `health === 'healthy'` → success early return, no-op.
   - If `check_login` itself errored → treat as needs-refresh, continue. Log the pre-flight error in audit.
   - If `TASKS.size > 0` (import from `returns.ts` v1.0) → `returns_in_flight`, recoverable, no Pushover.
   - If `refreshInFlight` promise exists → `refresh_in_progress` with `retry_after_seconds`, callers should `await` the in-flight promise instead.
2. **Fetch credentials** via `opRead` (catches ENOENT → `op_unavailable`). If email or password missing → `creds_missing` + Pushover (operator misconfigured 1P).
3. **Navigate to signin.** Use `(await getContext()).newPage()` per [returns-design.md §Browser context model](./returns-design.md#browser-context-model). Go to `https://www.${AMAZON_DOMAIN}/ap/signin`. Wait for `domcontentloaded`. Pre-step CAPTCHA check (CAPTCHA can appear here, not just at submit) — if detected → `captcha_encountered` + Pushover.
4. **Email step.** Fill via fallback selector chain. Check whether `#ap_password` is ALREADY visible (combined-form A/B variant) — if so, skip step 5's separate-page wait. Click continue / submit. CAPTCHA check.
5. **Password step.** Fill password via `page.locator('#ap_password').fill(password)` (NOT `page.evaluate` with template literal — credential would land in JS eval transcript per memory `feedback-no-pw-in-js-eval`). Click sign-in. Wait for one of: orders-landing redirect, MFA OTP page, MFA push-pending page ("Approve this sign-in"), CAPTCHA, security challenge, account-locked, generic error. Branch accordingly.
6. **MFA step** (only if step 5 landed on MFA OTP page):
   - If `AMAZON_LOGIN_TOTP_1P_PATH` not set → `mfa_required_no_totp` + Pushover.
   - **TOTP TTL guard — compute client-side.** `op read --otp op://...` returns the current 6-digit code only; the CLI does NOT expose TTL. Compute TTL via the standard TOTP RFC 6238 formula: `ttl = TOTP_WINDOW_SECONDS - (Math.floor(Date.now()/1000) % TOTP_WINDOW_SECONDS)`. If `ttl < TOTP_TTL_REFRESH_THRESHOLD_SECONDS` (10s), sleep `ttl + 1` seconds, then re-read. Amazon uses standard 30s TOTP. Avoids the read-at-28s-submit-at-32s race.
   - Fill `#auth-mfa-otpcode`, click `#auth-signin-button`.
   - If rejected: retry ONCE with freshly-read code. If still rejected → `mfa_totp_rejected` + Pushover.
7. **MFA push-pending** (only if step 5 landed on "Approve this sign-in"):
   - `security_challenge` + Pushover. Operator taps phone; on `save_session` they call from operator side, refresh ends.
8. **Trust this device.** After successful login, check `#auth-remember-me-checkbox` if present. Reduces MFA frequency for the persistent profile. **Failure non-fatal:** wrap in try/catch; log to audit; continue to verify step. Login already succeeded by this point. (Checkbox may be hidden, click may throw, or page may have already navigated away.)
9. **Verify landing.** Call `check_login_{account}` again. If `post_health === 'healthy'` → success. Else → `unknown_error` + Pushover.
10. **Save session.** Call `saveAmazonSession(context)` from existing `session-manager.ts`. Note: existing tool is `save_session` (singular, no account suffix). Refresh calls the function directly; operator calls the tool `save_session` after manually resolving a push-MFA challenge.
11. **Cleanup on failure.** On any post-`submit_password` error, attempt to navigate the refresh page to `about:blank` and close it — don't leave a half-authenticated page parked. **Cleanup itself wrapped in try/catch**: if the refresh page is mid-CAPTCHA-redirect or the browser context has crashed, ignore the cleanup error (log to audit). Never let cleanup failure mask the original error code.

**Awaitable mutex.** Match the `contextInflight` pattern in `browser.ts`. Per-account map (not single global) — v1.1 has one key per container but the per-account shape prevents v1.2 consolidation from introducing cross-account collisions:

```typescript
const refreshInFlight = new Map<ReturnAccount, Promise<RefreshSessionResult>>();

async function refreshSession(account: ReturnAccount, force = false): Promise<RefreshSessionResult> {
  const inFlight = refreshInFlight.get(account);
  if (inFlight) {
    // Second caller awaits the in-flight result rather than getting a flat error.
    try {
      return await Promise.race([
        inFlight,
        new Promise<RefreshSessionResult>((_, rej) =>
          setTimeout(() => rej(new Error('refresh_in_progress_timeout')), 60_000),
        ),
      ]);
    } catch (e) {
      // Distinguish timeout vs underlying doRefresh rejection. The first caller's
      // doRefresh contract is "always return structured error, never throw"; if it
      // does throw, that's a bug, not a refresh_in_progress.
      if (e instanceof Error && e.message === 'refresh_in_progress_timeout') {
        return { success: false, error_code: 'refresh_in_progress', message: 'await timed out', pushover_sent: false, recoverable: true, retry_after_seconds: 60 };
      }
      return { success: false, error_code: 'unknown_error', message: 'first caller threw unexpectedly', pushover_sent: false, recoverable: true };
    }
  }
  // Promise.resolve().then() converts any synchronous throw inside doRefresh into a
  // rejected promise — preserves the "always return, never throw" contract even if
  // doRefresh has a synchronous bug. The mutex still clears in finally.
  const promise = Promise.resolve().then(() => doRefresh(account, force));
  refreshInFlight.set(account, promise);
  try {
    return await promise;
  } finally {
    refreshInFlight.delete(account);
  }
}
```

**check_login serialization.** External `check_login_*` calls during a refresh would navigate the same context's first page out from under the refresh flow (per `browser.ts` singleton). To prevent this, `check_login_*` checks `refreshInFlight.has(account)` and returns `{health: 'refresh_in_progress', ...}` synthetic state immediately. The refresh's own internal pre-flight + post-verify check_login calls bypass this gate (different code path; they operate on the refresh's own `newPage()`).

### `session_health_{personal,business}` (NEW — composite)

```typescript
export interface SessionHealthReport {
  success: true;
  health: SessionHealth;
  greeting?: string;
  bannersDetected: string[];
  last_refresh_at?: string;
  last_refresh_outcome?: 'success' | 'failure';
  last_refresh_error_code?: RefreshErrorCode;
  container_uptime_seconds: number;
  in_flight_return_tasks: number;     // from v1.0 TASKS.size
  refresh_in_flight: boolean;
}
```

**Implementation size: ~60–80 LOC** (not the 30 in the original draft). Needs container_uptime via `process.uptime()`, last-refresh state via module-level vars, import of `TASKS` and `refreshInFlightPromise`.

## Implementation details

### Module split

| File | Purpose | LOC est |
|---|---|---|
| `src/session-health.ts` | Tool entry points, browser flow, **pure `classifyHealth` function** (extract from check_login flow for unit-test isolation), mutex helper | ~600 |
| `src/op-credentials.ts` | `opRead`, `opReadOtp`, `Secret` class, env validation, ENOENT mapping | ~80 |
| `src/pushover.ts` | Pushover client (native `fetch`), payload formatting, `PUSHOVER_ESCALATION_CODES` set, `PUSHOVER_TEST_MODE` priority override | ~100 |
| `src/audit-log.ts` | Shared writer with TWO exports (`writeReturnEvent` v1.0 shape + `appendSessionHealthEvent` v1.1 shape), rotation, ENOSPC fallback | ~80 |
| `src/session-health.test.ts` | Unit tests | ~200 |
| `src/session-health.test.fixtures.ts` | Canned HTML snippets + sentinel passwords for tests #2 and #5 | ~30 |
| `src/returns.ts` (MODIFY) | Add `export function getActiveReturnTaskCount(): number { return TASKS.size; }`. Swap inline audit-log writer for `writeReturnEvent` from `audit-log.ts`. | ~10 |

Total v1.1 contribution ≈ **1290 LOC** (revised per R2 build feasibility review).

**Module dependency graph** (no cycles — build agent should not introduce a `returns.ts` → `session-health.ts` edge):

```
session-health.ts ─→ returns.ts (getActiveReturnTaskCount)
                   ─→ op-credentials.ts
                   ─→ pushover.ts
                   ─→ audit-log.ts
                   ─→ browser.ts (getContext)
                   ─→ session-manager.ts (saveAmazonSession)

returns.ts        ─→ audit-log.ts (writeReturnEvent — after refactor)
                   ─→ browser.ts

pushover.ts       ─→ op-credentials.ts (opRead for tokens)
```

**Justification for module split** (vs the convention of fewer, larger feature modules): `op-credentials.ts` and `pushover.ts` are not feature modules — they're cross-cutting infrastructure that will absolutely be reused when v1.2 work begins (refresh-on-schedule, more MCPs, browserbase escalation). Pulling them out now beats refactoring out of `session-health.ts` later. `audit-log.ts` is shared with v1.0 returns and is a clear extraction win. This is a deliberate convention pivot; document it in `~/.claude/skills/mcp-management/SKILL.md` if it lands well.

### `opRead` helper (in `op-credentials.ts`)

```typescript
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileP = promisify(execFile);

// Opaque wrapper prevents accidental JSON.stringify / console.log of secret.
// All four interpolation hooks override — Symbol.toPrimitive covers template-literal
// and arithmetic coercion; inspect symbol covers Node's util.inspect / console.log.
export class Secret {
  constructor(private readonly value: string) {}
  reveal(): string { return this.value; }
  toString(): string { return '[Secret]'; }
  toJSON(): string { return '[Secret]'; }
  [Symbol.toPrimitive](): string { return '[Secret]'; }
  [Symbol.for('nodejs.util.inspect.custom')](): string { return '[Secret]'; }
}

// LINT REQUIREMENT: no occurrence of `${...reveal()...}` may appear in any source
// file. Test suite must include a grep-based assertion that fails CI if any
// template literal contains `.reveal()`. See test plan item #4.

export async function opRead(path: string): Promise<Secret> {
  if (!process.env.OP_SERVICE_ACCOUNT_TOKEN) {
    throw new OpError('op_token_invalid', 'OP_SERVICE_ACCOUNT_TOKEN not set in container env.');
  }
  try {
    // Tight env — passthrough only what op CLI may need. OP_CONFIG_DIR and
    // OP_ACCOUNT are passed through if set (rare; standard install doesn't need them).
    const childEnv: Record<string, string> = {
      OP_SERVICE_ACCOUNT_TOKEN: process.env.OP_SERVICE_ACCOUNT_TOKEN,
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    };
    if (process.env.HOME) childEnv.HOME = process.env.HOME;
    if (process.env.OP_CONFIG_DIR) childEnv.OP_CONFIG_DIR = process.env.OP_CONFIG_DIR;
    if (process.env.OP_ACCOUNT) childEnv.OP_ACCOUNT = process.env.OP_ACCOUNT;

    const { stdout } = await execFileP('op', ['read', path], {
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000,  // 10s is tight under load; 15s gives op cold-start headroom
    });
    return new Secret(stdout.trim());
  } catch (err: any) {
    if (err.code === 'ENOENT') throw new OpError('op_binary_missing', 'op CLI not in container. Rebuild image.');
    if (/UNAUTHORIZED/i.test(err.stderr ?? '')) throw new OpError('op_token_invalid', 'op service-account token expired or wrong scope. Rotate mcp-amazon-cart-op-token.');
    if (/not found/i.test(err.stderr ?? '')) throw new OpError('creds_missing', '1P path resolved no item.');  // path omitted from message — non-secret but reveals vault structure
    throw new OpError('op_token_invalid', 'op read failed with unknown error');
  }
}

// TOTP reader — returns just the 6-digit code. TTL is computed client-side
// from the standard 30s window (TOTP_WINDOW_SECONDS const). Spec/test §6.
export async function opReadOtp(path: string): Promise<Secret> {
  // `op read --otp op://...` returns the current code on stdout.
  // The CLI does NOT expose TTL; callers compute via Date.now() % 30.
  // ... shape identical to opRead, separate function for clarity ...
}
```

### Error-message scrubbing

A single pass before any surface (audit, tool response, Pushover):

```typescript
function scrubMessage(raw: string, secrets: Secret[]): string {
  let scrubbed = raw;
  for (const s of secrets) {
    if (s.reveal().length >= 4) {
      scrubbed = scrubbed.replaceAll(s.reveal(), '[REDACTED]');
    }
  }
  // Also strip Patchright/Playwright echo patterns:
  scrubbed = scrubbed.replace(/while typing "[^"]*"/g, 'while typing [REDACTED]');
  return scrubbed;
}
```

All error paths construct messages from a stock-text table keyed by `error_code`. Caught exceptions go through `scrubMessage` before any field gets populated.

### Pushover payload (no `message` echo)

```typescript
export async function sendPushoverEscalation(args: {
  account: 'personal' | 'business';
  error_code: RefreshErrorCode;
  step_failed?: string;
  vnc_url: string;
}): Promise<boolean> {
  const appToken = await opRead(process.env.PUSHOVER_APP_TOKEN_1P_PATH!);
  const userKey = await opRead(process.env.PUSHOVER_USER_KEY_1P_PATH!);
  const body = new URLSearchParams({
    token: appToken.reveal(),
    user: userKey.reveal(),
    title: `Amazon Cart MCP — ${args.account} session needs you`,
    message: `Error: ${args.error_code}${args.step_failed ? ` (step: ${args.step_failed})` : ''}\nVNC: ${args.vnc_url}`,
    priority: '2',
    retry: '60',
    expire: '300',
    url: args.vnc_url,
    url_title: 'VNC in',
  });
  const res = await fetch('https://api.pushover.net/1/messages.json', {
    method: 'POST',
    body,
  });
  return res.ok;
}
```

`message` field only contains the enum-derived `error_code`, `step_failed` (enum), and VNC URL. **No free-form text. No exception content. No credential content.** Priority `2` (emergency), retry 60s, expire 300s — these are correct Pushover-API values.

### Audit log — split from v1.0 + rotation

`src/audit-log.ts` is the consolidated writer with TWO named exports — one per audit shape:

```typescript
// v1.0 — per-event JSON files (low volume, artifact-shaped)
// Path: /var/lib/amazon-cart/returns/<dateStr>-<account>-<return_id>.json
export function writeReturnEvent(
  filename: string,                                          // e.g. "2026-06-18-personal-RYZ123ABC456.json"
  event: ReturnAuditRecord,
): Promise<void>;

// v1.1 — daily JSONL with rotation (higher volume, event-stream-shaped)
// Path: /var/lib/amazon-cart/session-health/audit-YYYY-MM-DD.log
export function appendSessionHealthEvent(
  event: SessionHealthAuditRecord,                           // includes timestamp, tool, account, final_error_code
): Promise<void>;
```

Shared infra: mkdir-if-needed; ENOSPC handler that writes to stderr and continues (audit-write failure must never fail the originating tool call); v1.1 daily rotation at midnight UTC; v1.1 retention prune at module load (drop files older than `SESSION_HEALTH_AUDIT_RETENTION_DAYS = 14` per security review — was 30, tightened because audit log records credential-rotation history and a 14-day window beats a 30-day window in the hash-cracking timeline).

The v1.0 and v1.1 audit formats *intentionally differ* — they shouldn't claim to mirror. v1.1 audit content includes `{timestamp, tool, account, final_error_code}` ONLY. NOT `steps_attempted`, NOT `step_failed` (both useful as auth-state oracle to an attacker who later reads the audit log; both remain in transient tool response).

Phase 3 build agent: refactor v1.0 returns to use `writeReturnEvent` (existing inline writer at returns.ts ~line 869). Preserve current path semantics + per-event filename pattern. Don't break v1.0 contract tests.

### Bind-mount fail-fast (matches v1.0 pattern)

At module load:

```typescript
const SESSION_HEALTH_AUDIT_DIR = '/var/lib/amazon-cart/session-health';
try {
  fs.statSync(SESSION_HEALTH_AUDIT_DIR);
} catch {
  throw new Error(
    `${SESSION_HEALTH_AUDIT_DIR} not found. Bind-mount /volume1/docker/amazon-cart-session-health from the Synology host. See docs/session-health-v1.1-design.md §Compose changes.`,
  );
}
```

Mirrors v1.0's `RETURNS_HOST_PATH_PREFIX` fail-fast.

### Dockerfile op CLI install — pinned, signed, consolidated

Use the official 1Password apt repo with GPG-signed package. Pin to a specific version (no wildcard — Debian apt fails wildcard pins cleanly). Do NOT use `latest.deb` (mutable, supply-chain risk).

**Insertion point: runtime stage, fold INTO the existing `apt-get install` block at Dockerfile line ~71-80** (don't add a second block — wastes cache layer, opens apt-list-leak window between install and `rm`). The existing block already has `gnupg` and runs as root; add the 1P apt source setup BEFORE the existing `apt-get update`:

```dockerfile
# In runtime stage — fold into existing apt block at line ~71.
ARG OP_CLI_VERSION=2.30.0
RUN curl -sS https://downloads.1password.com/linux/keys/1password.asc \
      | gpg --dearmor --output /usr/share/keyrings/1password-archive-keyring.gpg \
 && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/1password-archive-keyring.gpg] https://downloads.1password.com/linux/debian/amd64 stable main" \
      > /etc/apt/sources.list.d/1password.list \
 && apt-get update \
 && apt-get install -y \
      <existing-packages-from-line-72-79> \
      1password-cli=${OP_CLI_VERSION} \
 && rm -rf /var/lib/apt/lists/*
```

Single `RUN` keeps layer cache tight. Version pin `1password-cli=2.30.0` (no asterisk) resolves cleanly or fails fast.

**Integrity check at runtime.** Add post-install: `RUN sha256sum /usr/bin/op > /etc/op.sha256`. At container entrypoint, verify before any `op read`: `sha256sum -c /etc/op.sha256` — defense against base-image-layer compromise replacing the binary.

## Pushover-code mapping (canonical)

Eight of thirteen `REFRESH_ERROR_CODES` send Pushover. The set lives in `pushover.ts` (`PUSHOVER_ESCALATION_CODES`); the `REFRESH_ERROR_CODES` table above is the authoritative comment annotation. Implementation must derive escalation decision from `PUSHOVER_ESCALATION_CODES.has(error_code)` — no second source of truth.

## Compose changes — diff against current state

For both `compose-personal.yml` and `compose-business.yml`. **Use map form to match existing convention** (current files use `KEY: ${VAR}`, not `- KEY=${VAR}`). The Portainer Env array values DIFFER per stack (personal uses Amazon Personal 1P paths; business uses Amazon Business).

```yaml
services:
  mcp-amazon-cart-{personal,business}:
    environment:
      # existing (verify against current file)
      AUTH_TOKEN: ${AUTH_TOKEN}
      VNC_PASSWORD: ${VNC_PASSWORD}
      AMAZON_DOMAIN: ${AMAZON_DOMAIN}     # asserted at module load against allowlist
      HEADLESS: ${HEADLESS:-true}
      RETURNS_HOST_PATH_PREFIX: /volume1/docker/amazon-returns   # v1.0 (note: returns-design.md §Compose changes is stale — uses /Users/johnrandall path; current files use /volume1/docker)
      # v1.1 additions:
      OP_SERVICE_ACCOUNT_TOKEN: ${OP_SERVICE_ACCOUNT_TOKEN}
      AMAZON_LOGIN_EMAIL_1P_PATH: ${AMAZON_LOGIN_EMAIL_1P_PATH}        # personal: op://JRVIS Execution/Amazon Personal/username   (verify actual field label during deploy)
      AMAZON_LOGIN_PASSWORD_1P_PATH: ${AMAZON_LOGIN_PASSWORD_1P_PATH}   # personal: op://JRVIS Execution/Amazon Personal/password
      AMAZON_LOGIN_TOTP_1P_PATH: ${AMAZON_LOGIN_TOTP_1P_PATH:-}         # personal: op://JRVIS Execution/Amazon Personal/one-time password   (verify field)
      PUSHOVER_APP_TOKEN_1P_PATH: ${PUSHOVER_APP_TOKEN_1P_PATH}         # op://JRVIS Infra/Pushover - mcp-amazon-cart/app_token
      PUSHOVER_USER_KEY_1P_PATH: ${PUSHOVER_USER_KEY_1P_PATH}           # op://JRVIS Infra/Pushover - mcp-amazon-cart/user_key
      PUSHOVER_TEST_MODE: ${PUSHOVER_TEST_MODE:-false}                   # true → priority 0 (silent) for criterion-4 test fire
    volumes:
      # existing
      - /volume1/docker/amazon-returns:/var/lib/amazon-cart/returns  # v1.0
      # v1.1 addition:
      - /volume1/docker/amazon-cart-session-health:/var/lib/amazon-cart/session-health
```

**Deploy session pre-flight (manual operator steps before Portainer redeploy):**

1. Pre-create `/volume1/docker/amazon-cart-session-health` on Umbridge: `ssh infra-agent@umbridge "sudo mkdir -p /volume1/docker/amazon-cart-session-health && sudo chown infra-agent:users /volume1/docker/amazon-cart-session-health"`.
2. Add the host path to Hyper Backup exclusion list.
3. Add `# Session-health audit logs — never sync` + `/amazon-cart-session-health/` to Cloud Sync stignore on the parent share.
4. Create the `Pushover - mcp-amazon-cart` 1P item in `JRVIS Infra` vault (app_token + user_key fields).
5. Confirm 1P field labels for `Amazon Personal` and `Amazon Business` entries via `op item get "Amazon Personal" --vault "JRVIS Execution" --format json | jq '.fields[] | {id, label, type}'`. Update env paths in Portainer Env to match.
6. Diff `compose-personal.yml` and `compose-business.yml` post-edit to verify the only intentional differences are stack-specific values.

## Test plan

Unit tests in `src/session-health.test.ts` (~200 LOC):

1. `SessionHealth` classifier: URL `/ap/signin` → `auth_expired`; URL `/errors/validateCaptcha` → `captcha_challenge`; banner ID match → `banner_blocked`.
2. Banner detection: known IDs match; unknown `[id*="Banner"]` lands in `unknownBannerIds`.
3. `opRead` env-var validation: missing token throws `op_unavailable`. ENOENT mocked → throws with `op CLI binary not in container`.
4. `Secret` class: `JSON.stringify` returns `'[Secret]'`; `String()` returns `'[Secret]'`.
5. `scrubMessage`: known password substring → replaced. Patchright echo pattern → replaced.
6. Pushover payload: `message` never contains a Secret value; priority is `2`.
7. Awaitable mutex: second caller awaits first's result; first error doesn't crash second's promise.
8. TASKS-nonzero refusal: pre-populate v1.0 TASKS map → refresh returns `returns_in_flight`.
9. TOTP TTL guard: mock `opGetOtp` returns ttl=5s → triggers sleep + re-read.
10. Audit-log writer: ENOSPC mocked → writes to stderr, doesn't throw.

Browser-flow tests are NOT in scope (live Amazon). Phase 5 OBSERVE covers those.

## Build session — deliverables checklist

The Phase 3 build agent must produce:

1. `src/session-health.ts` (NEW, ~600 LOC)
2. `src/op-credentials.ts` (NEW, ~80 LOC)
3. `src/pushover.ts` (NEW, ~100 LOC)
4. `src/audit-log.ts` (NEW, ~80 LOC, also refactor v1.0 returns to use it)
5. `src/session-health.test.ts` (NEW, ~200 LOC)
6. `src/types.ts` — append SessionHealth, RefreshErrorCode, etc.
7. `src/server.ts` — TOOLS array adds (6 tools — `check_login_*` extended descriptions, 4 NEW), switch dispatch, imports
8. `src/amazon.ts` — `checkLoginStatus` either extended or new function added; keep existing exports for back-compat
9. `src/amazon-business.ts` — same
10. `Dockerfile` — pinned `1password-cli` apt install in runtime stage
11. `compose-personal.yml`, `compose-business.yml` — env + volume additions per §Compose changes
12. `~/admin-technical/inventories/MCP-Server-Inventory.md` — bump tool count 21 → 25 per cart MCP (4 NEW tools; `check_login_*` extended in-place, no count bump). Flag as first runtime-`op` MCP. Also update `~/.claude/skills/mcp-management/SKILL.md` with a "runtime-op tier" note.
13. `docs/session-health-v1.1-design.md` — no further changes; spec is authoritative
14. Tests pass: `npm test`. Compile clean: `npm run build`.
15. Commit with session attribution; push origin + umbridge.

Model: **Opus 4.7 1M context**, not Sonnet. v1.0 build session ran out of context on Sonnet — same shape, more files this round. Budget per Phase 5: 5M output tokens, 24h wall, 10 fix-deploy iterations.

## Open questions (verified clean — none blocking)

1. **CAPTCHA escalation to Browserbase** — v1.2 work item. v1.1 Pushovers, stops.
2. **Periodic auto-refresh** — v1.2 with rate-limiting. v1.1 operator-triggered.
3. **TOTP type assumption** — TOTP only works if Amazon account has TOTP MFA (not SMS-only). Document during deploy; some accounts may need MFA-method change.
4. **Pushover 1P entry path** — spec assumes `op://JRVIS Infra/Pushover/{app_token,user_key}`. Deploy session must `op item list --vault "JRVIS Infra" | grep -i pushover` and confirm actual paths.

## Amendment 2026-06-18: banner-blocked self-heal layer

Production OBSERVE found the business account stuck in `banner_blocked` with banners `[order_retrieval_problem, attention_required]`. `refresh_session` was the documented remedy (success criterion 2 below), but it consumes a TOTP from 1Password and runs a full email→password→MFA flow — wrong tool for a transient server-side "We had a problem retrieving your orders" error that typically clears on page reload.

Added (banner-recovery.ts):

- **Tier 1 (cheap, reload-only)**: `attemptBannerRecovery` is called from `doCheckLogin` when `classifyHealth` returns `banner_blocked` and the known-banner set contains `order_retrieval_problem`. Up to 2 page reloads with 2s + 5s backoff. Re-classifies after each reload; returns the first non-`banner_blocked` state.
- **Tier 2 (operator-driven, unchanged)**: For `attention_required` alone, persistent `banner_blocked`, or any other state, operator still calls `refresh_session` explicitly. Success criterion 2 below still applies.
- **Never auto-escalates** from banner detection to `refresh_session` — TOTP-burn / MFA-window race risk.
- **Short-circuits** if `refreshInFlight.has(account)` so concurrent refresh isn't stomped by a reload.
- **Gated** by env var `AMAZON_BANNER_AUTO_RECOVER` (default `"1"`; set `"0"` to disable without redeploying).
- **Audit**: `SessionHealthAuditRecord.self_heal_attempts` records the count (bounded 0..2) — not an auth oracle (same signal Amazon already serves via /your-orders 5xx to any client).

## Success criteria for Phase 5 OBSERVE termination

Phase 5 unattended loop terminates **SUCCESS** when ALL:

1. Both containers' `session_health_*` returns `healthy` from a known-degraded starting state without human VNC.
2. `refresh_session_*` succeeds (post_health = healthy) on a banner-blocked session in ≤60s.
3. After refresh, `list_returnable_items` (v1.0) returns non-empty for both accounts.
4. Pushover escalation fires (test mode) for a forced `captcha_encountered` simulation.
5. Audit log shows complete entries; no truncated / malformed records; no credential content matches (regex scan).
6. Test suite passes after each fix iteration.

Terminates **STUCK** when ANY:

- 10 fix-deploy iterations consumed without all 6 criteria met
- 5M output tokens consumed
- 24h wall clock elapsed
- Amazon-side legit challenge (real CAPTCHA / SMS / account lock) blocks the test account — these go to Pushover and human deals with them

On STUCK, the loop sends a single Pushover summarizing what's left + which iteration broke.
