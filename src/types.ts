export interface AddToCartParams {
  query?: string;           // Search query
  asin?: string;            // Amazon ASIN
  quantity?: number;        // Quantity to add (default: 1)
}

export interface RemoveFromCartParams {
  asin: string;             // Amazon ASIN — must be currently in the cart
}

export interface CartItem {
  title: string;
  price: string;
  quantity: number;
  asin: string;
  imageUrl: string;
}

export interface SearchResult {
  title: string;
  asin: string;
  price: string;
  rating: string;
  imageUrl: string;
}

export interface OperationResult {
  success: boolean;
  message: string;
  data?: any;
  error?: string;
}

// ---- Returns types ----

export const RETURN_REASONS = [
  'defective',
  'wrong_item',
  'damaged_both',
  'damaged_item_only',
  'missing_parts',
  'not_compatible',
  'arrived_late',
  'no_longer_needed',
  'better_price_available',
  'inaccurate_description',
  'bought_by_mistake',
] as const;
export type ReturnReason = typeof RETURN_REASONS[number];

export type ReturnAccount = 'personal' | 'business';

export type RefundMethod = 'original_payment' | 'amazon_balance' | 'gift_card';

export type ReturnStep =
  | 'reason_selected'
  | 'refund_method_selected'
  | 'return_method_selected'
  | 'ready_to_submit';

export type ReturnStepOrExpired = ReturnStep | 'expired';

export interface ReturnableItem {
  order_id: string;
  item_id: string;
  title: string;
  quantity_ordered: number;
  unit_price_usd: number;
  delivered_on: string;
  eligible_until: string;
  days_remaining: number;
  non_returnable_reason?: string;
}

export interface ListReturnableItemsResult {
  success: true;
  account: ReturnAccount;
  items: ReturnableItem[];
}

export interface StartReturnSuccess {
  success: true;
  task_id: string;
  account: ReturnAccount;
  order_id: string;
  item_id: string;
  item_title: string;
  quantity: number;
  reason_echoed: ReturnReason;
  refund_methods_offered: RefundMethod[];
  refund_method_chosen: RefundMethod;
  refund_amount_usd: number;
  replacement_available: boolean;
  current_step: ReturnStep;
}

export interface StartReturnError {
  success: false;
  error_code:
    | 'return_window_expired'
    | 'non_returnable'
    | 'item_not_on_account'
    | 'order_id_malformed'
    | 'order_not_found'
    | 'item_not_in_order'
    | 'auth_expired'
    | 'captcha_required';
  message: string;
  eligible_until?: string;
  expired_days_ago?: number;
  non_returnable_reason?: string;
}

export type StartReturnResult = StartReturnSuccess | StartReturnError;

export interface GetReturnStatusResult {
  success: true;
  task_id: string;
  current_step: ReturnStepOrExpired;
  age_seconds: number;
  ttl_seconds: number;
}

export interface FinalizeReturnSuccess {
  success: true;
  task_id: string;
  return_id: string;
  refund_amount_usd: number;
  refund_method: RefundMethod;
  carrier: string;
  drop_off_method: 'qr_code' | 'printed_label' | 'pickup_scheduled' | 'other';
  qr_png_host_path: string;
  drop_off_by: string;
  caption: string;
}

export interface FinalizeReturnError {
  success: false;
  error_code:
    | 'task_not_found'
    | 'task_expired'
    | 'wizard_advanced_unexpectedly'
    | 'submit_failed'
    | 'auth_expired'
    | 'captcha_required';
  message: string;
  task_id?: string;
  recoverable: boolean;
}

export type FinalizeReturnResult = FinalizeReturnSuccess | FinalizeReturnError;

export interface ListReturnsResult {
  success: true;
  account: ReturnAccount;
  returns: Array<{
    return_id: string;
    order_id: string;
    item_id: string;
    item_title: string;
    status: 'awaiting_drop_off' | 'in_transit' | 'received' | 'refunded' | 'cancelled' | 'expired_undelivered';
    refund_amount_usd: number;
    refund_method: RefundMethod;
    submitted_at: string;
    refunded_at?: string;
    drop_off_by?: string;
  }>;
}

export interface CancelReturnSuccess {
  success: true;
  return_id: string;
  cancelled_at: string;
}

export interface CancelReturnError {
  success: false;
  error_code: 'already_dropped_off' | 'already_refunded' | 'already_cancelled' | 'not_found';
  message: string;
  return_id?: string;
}

export type CancelReturnResult = CancelReturnSuccess | CancelReturnError;

// ---- v1.1 Session-health types ----

export const SESSION_HEALTH_STATES = [
  'healthy',
  'banner_blocked',
  'auth_expired',
  'mfa_challenge',
  'mfa_push_pending',
  'captcha_challenge',
  'account_locked',
  'unknown_degraded',
  'refresh_in_progress',
] as const;
export type SessionHealth = typeof SESSION_HEALTH_STATES[number];

// Health states that genuinely prevent transacting (cart / checkout) because
// the account is NOT usable: a real Amazon challenge is in the way, or the
// session is gone. These hard-block purchasing.
//
// `banner_blocked` is DELIBERATELY ABSENT. [Verified 2026-06-24, live business
// session screenshot] `banner_blocked` is derived from the /your-orders probe
// and means only that the ORDER-HISTORY page failed to render cleanly
// (AttentionRequiredBanner / OrderRetreivalProblemBanner). It does NOT mean the
// account can't add to cart or check out — the cart and checkout pages load
// from their own URLs and were observed fully functional ("Proceed to checkout"
// present) while /your-orders showed those banners. Treating banner_blocked as
// a transacting block was the false-positive that stranded the operator.
// See classifyHealth() in session-health.ts and isPurchasingBlocked() below.
//
// `unknown_degraded` IS included: if we cannot positively confirm a logged-in
// session AND we did not see a known-benign banner page, we conservatively
// refuse to transact rather than risk acting on a signed-out / unexpected page.
export const PURCHASE_BLOCKING_HEALTH_STATES: ReadonlySet<SessionHealth> = new Set<SessionHealth>([
  'auth_expired',
  'mfa_challenge',
  'mfa_push_pending',
  'captcha_challenge',
  'account_locked',
  'unknown_degraded',
  'refresh_in_progress',
]);

/**
 * Single source of truth for "does this health state block purchasing
 * (cart / checkout)?" — used by check_login result derivation and by any
 * consumer that needs to gate a transacting action on session health.
 *
 * Orders-page notification banners (banner_blocked) do NOT block purchasing;
 * genuine challenge / signed-out states do.
 */
export function isPurchasingBlocked(health: SessionHealth): boolean {
  return PURCHASE_BLOCKING_HEALTH_STATES.has(health);
}

export const REFRESH_ERROR_CODES = [
  'op_binary_missing',
  'op_token_invalid',
  'creds_missing',
  'navigation_failed',
  'email_step_failed',
  'password_step_failed',
  'mfa_required_no_totp',
  'mfa_totp_rejected',
  'captcha_encountered',
  'security_challenge',
  'account_locked',
  'returns_in_flight',
  'refresh_in_progress',
  'amazon_domain_invalid',
  'tracing_enabled',
  'unknown_error',
] as const;
export type RefreshErrorCode = typeof REFRESH_ERROR_CODES[number];

export const CHECK_LOGIN_ERROR_CODES = [
  'browser_crashed',
  'navigation_timeout',
  'op_binary_missing',
  'op_token_invalid',
  'amazon_domain_invalid',
] as const;
export type CheckLoginErrorCode = typeof CHECK_LOGIN_ERROR_CODES[number];

// Pushover-escalating subset of RefreshErrorCode. Single source of truth
// referenced from session-health.ts (pushover_sent derivation) and
// pushover.ts (sendPushoverEscalation gating).
export const PUSHOVER_ESCALATION_CODES: ReadonlySet<RefreshErrorCode> = new Set<RefreshErrorCode>([
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

// TOTP RFC 6238 window. Amazon uses the standard 30s window. If less
// than TOTP_TTL_REFRESH_THRESHOLD_SECONDS remain we sleep across the
// window boundary to avoid the read-at-28s-submit-at-32s race.
export const TOTP_WINDOW_SECONDS = 30;
export const TOTP_TTL_REFRESH_THRESHOLD_SECONDS = 10;

export const SESSION_HEALTH_AUDIT_RETENTION_DAYS = 14;

export type KnownBanner = 'attention_required' | 'order_retrieval_problem' | 'unknown_banner';

export interface CheckLoginSuccess {
  success: true;
  loggedIn: boolean;
  health: SessionHealth;
  // Orthogonal to `health`: can the operator transact (add_to_cart / place_order)
  // RIGHT NOW? This is the field purchasing consumers should gate on — NOT
  // `loggedIn` (which is health==='healthy') and NOT `health !== 'banner_blocked'`.
  // True unless a genuine challenge / signed-out state is in the way
  // (see isPurchasingBlocked). An orders-page banner alone leaves this true.
  // (2026-06-24)
  purchasingAvailable: boolean;
  greeting?: string;
  cookieCount: number;
  ordersUrl: string;
  ordersUrlReached: string;
  bannersDetected: KnownBanner[];
  // Non-blocking advisory: order-history banners seen on the /your-orders probe.
  // Surfaced so the operator KNOWS order-history / returns reads may be
  // degraded, while purchasing is still allowed. Populated from bannersDetected
  // when health === 'banner_blocked'. (2026-06-24)
  bannerWarnings?: KnownBanner[];
  unknownBannerIds?: string[];
  detectedAt: string;
  // Reload-only banner-recovery attempts performed during this
  // check_login. Absent when zero (the common case). Never includes
  // refresh_session attempts — those are a different operation and are
  // tracked via last_refresh_* on SessionHealthReport.
  selfHealAttempts?: number;
}

export interface CheckLoginError {
  success: false;
  error_code: CheckLoginErrorCode;
  message: string;
}

export type CheckLoginResult = CheckLoginSuccess | CheckLoginError;

export type RefreshStep =
  | 'navigate_signin'
  | 'fill_email'
  | 'fill_password'
  | 'submit_password'
  | 'mfa_totp'
  | 'trust_device'
  | 'verify_landing';

export interface RefreshSessionInput {
  force?: boolean;
}

export interface RefreshSessionSuccess {
  success: true;
  pre_health: SessionHealth;
  post_health: SessionHealth;
  duration_ms: number;
  steps_attempted: RefreshStep[];
  session_saved: boolean;
  pushover_sent: false;
}

export interface RefreshSessionError {
  success: false;
  error_code: RefreshErrorCode;
  message: string;
  step_failed?: RefreshStep;
  pushover_sent: boolean;
  recoverable: boolean;
  retry_after_seconds?: number;
}

export type RefreshSessionResult = RefreshSessionSuccess | RefreshSessionError;

export interface SessionHealthReport {
  success: true;
  health: SessionHealth;
  greeting?: string;
  bannersDetected: string[];
  last_refresh_at?: string;
  last_refresh_outcome?: 'success' | 'failure';
  last_refresh_error_code?: RefreshErrorCode;
  container_uptime_seconds: number;
  in_flight_return_tasks: number;
  refresh_in_flight: boolean;
}

// Audit shapes — what lands on disk.

export interface ReturnAuditRecord {
  timestamp: string;
  account: ReturnAccount;
  order_id: string;
  item_id: string;
  item_title: string;
  quantity: number;
  reason_enum: ReturnReason;
  reason_prose?: string;
  refund_amount_usd: number;
  refund_method: RefundMethod;
  return_id: string;
  carrier: string;
  drop_off_by: string;
  qr_png_host_path: string;
}

// v1.1 audit shape — DELIBERATELY MINIMAL. step_failed and
// steps_attempted stay in the transient tool response only; both
// would otherwise be auth-state oracles for anyone who later
// reads the audit log.
//
// self_heal_attempts (added 2026-06-18) is a bounded reload counter
// (0..RELOAD_BACKOFF_MS.length) for the banner-recovery layer in
// banner-recovery.ts. It is NOT an auth oracle — it only reveals that
// a transient order-page banner appeared and was reloaded; the same
// signal is already public via /your-orders 5xx responses Amazon
// serves to any client.
export interface SessionHealthAuditRecord {
  timestamp: string;
  tool: 'refresh_session' | 'check_login' | 'session_health';
  account: ReturnAccount;
  final_error_code: RefreshErrorCode | CheckLoginErrorCode | 'success';
  self_heal_attempts?: number;
}
