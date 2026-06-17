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
