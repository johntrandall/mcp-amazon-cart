/**
 * Banner-blocked self-heal — cheap reload-only recovery for transient
 * Amazon order-page error banners.
 *
 * Scope (intentionally narrow):
 *   - Triggers only when classifyHealth returns 'banner_blocked' AND the
 *     known-banner set includes 'order_retrieval_problem' (Amazon's
 *     transient server-side "We had a problem retrieving your orders"
 *     banner, which usually clears on reload).
 *   - Never auto-triggers refresh_session. refresh_session is operator-
 *     driven (consumes a TOTP from 1Password); banner reloads are not.
 *   - Short-circuits if a refresh is in flight for the same account, so
 *     this never stomps on a concurrent re-login.
 *   - Gated by env var AMAZON_BANNER_AUTO_RECOVER (default "1"; set to
 *     "0" to disable entirely without redeploying).
 *
 * Lives in its own file (and not in session-health.ts) so the credential-
 * sensitive refresh flow stays isolated from this best-effort recovery
 * layer.
 */

import type { Page } from 'patchright';
import {
  classifyHealth,
  isRefreshInFlight,
  _testing,
  type DomSnapshot,
} from './session-health';
import type { ReturnAccount, SessionHealth } from './types';

const RELOAD_BACKOFF_MS: readonly number[] = [2_000, 5_000];
const RELOAD_TIMEOUT_MS = 15_000;

export interface BannerRecoveryResult {
  /** True iff at least one reload attempt was performed. */
  attempted: boolean;
  /** Number of reload attempts performed (0 if attempted is false). */
  attempts: number;
  /** True iff the post-recovery health is 'healthy'. */
  recovered: boolean;
  /** Post-recovery health (or initial health if no attempt was made). */
  finalHealth: SessionHealth;
  /** Post-recovery DOM snapshot (or initial snapshot if no attempt was made). */
  finalDom: DomSnapshot;
  /** Post-recovery page.url() (or initial URL if no attempt was made). */
  finalUrl: string;
}

function isAutoRecoverEnabled(): boolean {
  return (process.env.AMAZON_BANNER_AUTO_RECOVER ?? '1') !== '0';
}

/**
 * Reload-recoverability test. Currently the only known reload-recoverable
 * banner is 'order_retrieval_problem'. 'attention_required' often means an
 * account-management notice that does NOT clear on reload (and may
 * indicate an auth-degradation precursor — operator's call).
 *
 * Note: this returns false for unknown banners. If Amazon ships a brand-
 * new banner id, we deliberately do NOT auto-reload — could be a Prime Day
 * overlay, a captcha-stub, or anything else; operator inspects first.
 */
function isReloadRecoverable(dom: DomSnapshot): boolean {
  const { known } = _testing.bannersFromIds(dom.bannerIds);
  return known.includes('order_retrieval_problem');
}

/**
 * In-page DOM snapshot — kept inline (rather than reused from
 * session-health.captureDomSnapshot, which is private) so this module has
 * no implicit coupling to session-health internals beyond the public
 * classifier + bannersFromIds helper.
 *
 * If session-health.captureDomSnapshot's shape ever drifts, the unit-test
 * tier ('classifyHealth — URL + banner state mapping') will fail before
 * either copy disagrees in production.
 */
async function captureBannerDom(page: Page): Promise<DomSnapshot> {
  return page.evaluate(() => {
    const bannerEls = Array.from(document.querySelectorAll('[id*="Banner"]'));
    const bannerIds = bannerEls
      .map((e) => (e as HTMLElement).id)
      .filter(Boolean);
    const otp = document.querySelector('#auth-mfa-otpcode');
    const bodyText = (document.body?.textContent || '').slice(0, 5_000);
    const approve =
      /approve this sign-in|approve this sign in|notification on/i.test(bodyText);
    const lock =
      /your account has been locked|account locked|temporarily locked/i.test(
        bodyText,
      );
    return {
      bodyText,
      bannerIds,
      hasOtpField: !!otp,
      hasApprovePushText: approve,
      hasAccountLockText: lock,
    };
  });
}

/**
 * Attempt cheap reload-only recovery from a banner_blocked state.
 *
 * Caller (doCheckLogin in session-health.ts) is expected to invoke this
 * ONLY after a fresh classifyHealth has returned 'banner_blocked' on the
 * same page. The function:
 *   1. Bails out (no-op result) if recovery is disabled, a refresh is in
 *      flight, or the banner set is not reload-recoverable.
 *   2. Sleeps RELOAD_BACKOFF_MS[i], page.reload(), re-captures DOM,
 *      re-classifies.
 *   3. Returns the first non-banner_blocked result, OR the last attempt's
 *      state if none clear, OR a no-op result if no reload-recoverable
 *      banner is left after a partial clear.
 *
 * Never throws — navigation failures abort the loop and return whatever
 * state we last observed.
 */
export async function attemptBannerRecovery(
  page: Page,
  account: ReturnAccount,
  initialDom: DomSnapshot,
): Promise<BannerRecoveryResult> {
  const initialUrl = page.url();
  const noopResult: BannerRecoveryResult = {
    attempted: false,
    attempts: 0,
    recovered: false,
    finalHealth: 'banner_blocked',
    finalDom: initialDom,
    finalUrl: initialUrl,
  };

  if (!isAutoRecoverEnabled()) return noopResult;
  if (isRefreshInFlight(account)) return noopResult;
  if (!isReloadRecoverable(initialDom)) return noopResult;

  let lastDom = initialDom;
  let lastUrl = initialUrl;
  let lastHealth: SessionHealth = 'banner_blocked';
  let attempts = 0;

  for (const backoffMs of RELOAD_BACKOFF_MS) {
    await new Promise((resolve) => setTimeout(resolve, backoffMs));
    attempts += 1;
    try {
      await page.reload({
        waitUntil: 'domcontentloaded',
        timeout: RELOAD_TIMEOUT_MS,
      });
    } catch {
      // Navigation failure — bail out with whatever we had before this
      // attempt. Caller still sees banner_blocked, which is correct.
      break;
    }
    lastUrl = page.url();
    lastDom = await captureBannerDom(page);
    lastHealth = classifyHealth(lastUrl, lastDom);

    if (lastHealth !== 'banner_blocked') {
      return {
        attempted: true,
        attempts,
        recovered: lastHealth === 'healthy',
        finalHealth: lastHealth,
        finalDom: lastDom,
        finalUrl: lastUrl,
      };
    }
    if (!isReloadRecoverable(lastDom)) {
      // The transient banner cleared but a non-reload-recoverable one
      // (e.g., attention_required) remains. Reloading again won't help.
      break;
    }
  }

  return {
    attempted: true,
    attempts,
    recovered: false,
    finalHealth: lastHealth,
    finalDom: lastDom,
    finalUrl: lastUrl,
  };
}

// Test seam — exposes the gating predicates without making them part of
// the module's public API contract.
export const _testingBannerRecovery = {
  isAutoRecoverEnabled,
  isReloadRecoverable,
  RELOAD_BACKOFF_MS,
};
