import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Page } from 'patchright';
import { getContext } from './browser';
import {
  RETURN_REASONS,
  type ReturnAccount,
  type ReturnReason,
  type ReturnStep,
  type RefundMethod,
  type ListReturnableItemsResult,
  type StartReturnResult,
  type StartReturnSuccess,
  type GetReturnStatusResult,
  type FinalizeReturnResult,
  type ListReturnsResult,
  type CancelReturnResult,
} from './types';

// Fail-fast at module load — no silent fallback. A missing env var would
// produce malformed root-relative paths at print time, AFTER a return has
// already committed on Amazon's side.
const _hostPrefix = process.env.RETURNS_HOST_PATH_PREFIX;
if (!_hostPrefix) {
  throw new Error('RETURNS_HOST_PATH_PREFIX env var is required for the returns module');
}
const hostPrefix: string = _hostPrefix;

const CONTAINER_RETURNS_DIR = '/var/lib/amazon-cart/returns';

// Both personal and business returns operate on www.amazon.com.
// Business uses the same shopping surface with business-account cookies.
const BASE_URL = 'https://www.amazon.com';

// ---- In-memory task table ----

interface ReturnTask {
  task_id: string; // UUID v4 — never sequential, never reused
  account: ReturnAccount;
  order_id: string;
  item_id: string;
  item_title: string;
  quantity: number;
  reason: ReturnReason;
  reason_prose?: string;
  refund_method_chosen: RefundMethod;
  refund_amount_usd: number; // captured at start_return; compared at finalize (TOCTOU guard)
  replacement_available: boolean;
  created_at: number; // ms epoch
  current_step: ReturnStep;
  wizardPage: Page; // per-task Page from context.newPage() — NOT the singleton page
}

const TASKS = new Map<string, ReturnTask>();
const TASK_TTL_MS = 15 * 60 * 1000; // 15 min — bounds wizard-tab lifetime

// Sweep expired tasks every minute.
// allSettled + per-close timeout: a stuck page.close() must not stall the
// sweep or queue overlapping setInterval ticks.
let sweepRunning = false;
setInterval(async () => {
  if (sweepRunning) return;
  sweepRunning = true;
  try {
    const now = Date.now();
    const expired = [...TASKS.entries()].filter(([, t]) => now - t.created_at > TASK_TTL_MS);
    await Promise.allSettled(
      expired.map(async ([id, t]) => {
        try {
          await Promise.race([
            t.wizardPage.close(),
            new Promise((_, rej) => setTimeout(() => rej(new Error('close timeout')), 5_000)),
          ]);
        } catch { /* page already gone or close hung */ }
        TASKS.delete(id);
      }),
    );
  } finally {
    sweepRunning = false;
  }
}, 60_000);

// ---- Selector constants (TODO: fill via debug_inspect_selectors session) ----

// TODO selector-discovery: "Return or replace items" button on /your-orders order row
const SEL_RETURN_BUTTON_CANDIDATES = [
  'a[href*="return"]:has-text("Return")',
  'button:has-text("Return or replace")',
  'a:has-text("Return or replace")',
  '[data-testid*="return"]',
];

// TODO selector-discovery: item checkbox on item-selection page (ASIN placeholder filled at runtime)
const SEL_ITEM_CHECKBOX_ASIN = 'input[type="checkbox"][data-asin="{ASIN}"]';
const SEL_ITEM_CHECKBOX_GENERIC = 'input[type="checkbox"]';

// TODO selector-discovery: quantity dropdown on item-selection page
const SEL_QUANTITY_DROPDOWN = 'select[name*="quantity"], select[id*="quantity"]';

// TODO selector-discovery: reason radio — Amazon's radio values are empirical.
// Maps ReturnReason enum → Amazon's wizard radio input value attribute.
const REASON_TO_AMAZON_VALUE: Record<ReturnReason, string> = {
  defective:                'DEFECTIVE',                        // TODO selector-discovery
  wrong_item:               'WRONG_ITEM',                       // TODO selector-discovery
  damaged_both:             'DAMAGED_PACKAGING_AND_ITEM',       // TODO selector-discovery
  damaged_item_only:        'DAMAGED_ITEM_ONLY',                // TODO selector-discovery
  missing_parts:            'MISSING_ACCESSORIES',              // TODO selector-discovery
  not_compatible:           'NOT_COMPATIBLE',                   // TODO selector-discovery
  arrived_late:             'NOT_DELIVERED',                    // TODO selector-discovery
  no_longer_needed:         'NO_LONGER_NEEDED',                 // TODO selector-discovery
  better_price_available:   'BETTER_PRICE_FOUND',              // TODO selector-discovery
  inaccurate_description:   'INACCURATE_WEBSITE_DESCRIPTION',  // TODO selector-discovery
  bought_by_mistake:        'UNWANTED_ITEM',                   // TODO selector-discovery
};

// TODO selector-discovery: refund method radios on refund-method page
const SEL_REFUND_ORIGINAL_PAYMENT = [
  'input[type="radio"][value*="ORIGINAL"]',
  'input[type="radio"][value*="original"]',
  'input[type="radio"][data-refund-method*="original"]',
];
const SEL_REFUND_METHOD_ANY = 'input[type="radio"][name*="refund"], input[type="radio"][data-refund-method]';

// TODO selector-discovery: return method radios (prefer UPS QR drop-off)
const SEL_UPS_QR_CANDIDATES = [
  'input[type="radio"][value*="UPS"]',
  'input[type="radio"][data-carrier*="UPS"]',
  'input[type="radio"][value*="LABEL_FREE"]',
];
const SEL_RETURN_METHOD_ANY = 'input[type="radio"][name*="return-method"], input[type="radio"][data-return-method]';

// TODO selector-discovery: confirm page Submit button
const SEL_SUBMIT_BUTTON_CANDIDATES = [
  'button[data-testid="submit-return"]',
  'input[name="submit-return"]',
  'button:has-text("Submit return")',
  'button:has-text("Confirm return")',
  'input[type="submit"]',
];

// TODO selector-discovery: confirm page header (liveness check in finalize)
const SEL_CONFIRM_HEADER_CANDIDATES = [
  'h1[data-testid="confirm-header"]',
  '[data-testid="confirm-return"]',
  'h1:has-text("Confirm")',
  'h2:has-text("Confirm")',
];

// TODO selector-discovery: success page return_id element
const SEL_RETURN_ID_CANDIDATES = [
  '[data-testid="return-id"]',
  '.return-confirmation-id',
  '[id*="return-id"]',
  '[data-testid="confirmation-id"]',
];

// TODO selector-discovery: success page download/print button
const SEL_PRINT_BUTTON_CANDIDATES = [
  'button[data-testid="print-label"]',
  'a[data-testid="download-label"]',
  'button:has-text("Print")',
  'a:has-text("Download")',
  'button:has-text("Download")',
];

// ---- Helpers ----

async function waitForElement(page: Page, selector: string, timeout = 5000): Promise<boolean> {
  try {
    await page.waitForSelector(selector, { timeout });
    return true;
  } catch {
    return false;
  }
}

async function findFirstExisting(page: Page, selectors: string[], timeout = 3000): Promise<string | null> {
  for (const sel of selectors) {
    if (await waitForElement(page, sel, timeout)) return sel;
  }
  return null;
}

async function detectAuthProblem(page: Page): Promise<'auth_expired' | 'captcha_required' | null> {
  const url = page.url();

  if (url.includes('/ap/signin')) return 'auth_expired';
  if (url.includes('/errors/validateCaptcha') || url.includes('/ap/cvf/')) return 'captcha_required';

  const result = await page.evaluate(() => {
    const hasCaptcha = !!(
      document.querySelector('#captchacharacters') ||
      document.querySelector('[data-test="captcha"]') ||
      document.querySelector('form[action*="captcha"]')
    );
    const text = document.body?.textContent?.toLowerCase() || '';
    const hasCaptchaText = text.includes('enter the characters');
    const hasVerifyBanner = text.includes('verify your identity') || text.includes('sign in again');
    return { hasCaptcha: hasCaptcha || hasCaptchaText, hasVerifyBanner };
  });

  if (result.hasCaptcha) return 'captcha_required';
  if (result.hasVerifyBanner) return 'auth_expired';
  return null;
}

type DetectedStep = 'item_selection' | 'reason' | 'refund_method' | 'return_method' | 'confirm' | 'unknown';

async function detectCurrentWizardStep(page: Page): Promise<DetectedStep> {
  // TODO selector-discovery: each wizard step has a unique heading or form id.
  // Current implementation uses heading text heuristics — replace with
  // empirically discovered selectors after an OBSERVE session.
  const text = await page.evaluate(() => {
    const h1 = document.querySelector('h1')?.textContent?.toLowerCase() || '';
    const h2 = document.querySelector('h2')?.textContent?.toLowerCase() || '';
    const formId = document.querySelector('form')?.id?.toLowerCase() || '';
    return `${h1} ${h2} ${formId}`;
  });

  if (text.includes('select item') || text.includes('choose item') || text.includes('which item')) {
    return 'item_selection';
  }
  if (text.includes('why are you returning') || text.includes('return reason') || text.includes('select reason')) {
    return 'reason';
  }
  if (text.includes('refund method') || text.includes('how would you like your refund')) {
    return 'refund_method';
  }
  if (text.includes('return method') || text.includes('how do you want to return') || text.includes('drop off')) {
    return 'return_method';
  }
  if (text.includes('confirm') || text.includes('review') || text.includes('submit return')) {
    return 'confirm';
  }
  return 'unknown';
}

async function clickContinue(page: Page): Promise<void> {
  const candidates = [
    'button[data-testid="continue-button"]',
    'input[value="Continue"]',
    'button:has-text("Continue")',
    'button[type="submit"]:not([data-testid*="submit-return"])',
    'input[type="submit"]',
  ];
  for (const sel of candidates) {
    const btn = page.locator(sel).first();
    if ((await btn.count()) > 0) {
      await btn.click();
      return;
    }
  }
  throw new Error('Continue button not found on wizard step');
}

// ---- Tool handlers ----

export async function listReturnableItems(params: {
  account: ReturnAccount;
  lookback_days?: number;
}): Promise<ListReturnableItemsResult> {
  const { account, lookback_days = 60 } = params;
  const cappedDays = Math.min(lookback_days, 365);
  const context = await getContext();
  const page = await context.newPage();

  try {
    // TODO selector-discovery: confirm time-filter query param format
    const url = `${BASE_URL}/your-orders/orders?timeFilter=last${cappedDays}`;
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    const authProblem = await detectAuthProblem(page);
    if (authProblem) {
      return { success: true, account, items: [] };
    }

    // TODO selector-discovery: order card + item selectors on /your-orders
    const items = await page.evaluate(() => {
      const ORDER_CARD_SEL = '.order, [data-component="orderCard"], .a-box-group[data-order-id]';
      const cards = Array.from(document.querySelectorAll(ORDER_CARD_SEL));
      const results: Array<{
        order_id: string;
        item_id: string;
        title: string;
        quantity_ordered: number;
        unit_price_usd: number;
        delivered_on: string;
        eligible_until: string;
        days_remaining: number;
        non_returnable_reason?: string;
      }> = [];

      for (const card of cards) {
        const orderId = card.getAttribute('data-order-id') || '';
        const itemEls = Array.from(card.querySelectorAll('[data-asin]'));
        for (const itemEl of itemEls) {
          const asin = itemEl.getAttribute('data-asin') || '';
          if (!asin) continue;
          const title = itemEl.querySelector('.a-link-normal span, .a-text-bold')?.textContent?.trim() || 'Unknown';
          const priceEl = itemEl.querySelector('.a-price .a-offscreen, .item-price');
          const priceText = priceEl?.textContent?.replace(/,/g, '').match(/[\d.]+/)?.[0] || '0';
          results.push({
            order_id: orderId,
            item_id: asin,
            title,
            quantity_ordered: 1,
            unit_price_usd: parseFloat(priceText),
            delivered_on: new Date().toISOString().slice(0, 10), // TODO selector-discovery
            eligible_until: new Date().toISOString().slice(0, 10), // TODO selector-discovery
            days_remaining: 0, // TODO selector-discovery
          });
        }
      }
      return results;
    });

    return { success: true, account, items };
  } finally {
    await page.close().catch(() => {});
  }
}

export async function startReturn(params: {
  account: ReturnAccount;
  order_id: string;
  item_id: string;
  quantity?: number;
  reason: ReturnReason;
  reason_prose?: string;
}): Promise<StartReturnResult> {
  const { account, item_id, reason, reason_prose } = params;
  const quantity = params.quantity ?? 1;
  const order_id = params.order_id.trim();

  if (!/^\d{3}-\d{7}-\d{7}$/.test(order_id)) {
    return {
      success: false,
      error_code: 'order_id_malformed',
      message: `order_id "${order_id}" does not match expected format ###-#######-#######`,
    };
  }

  const context = await getContext();
  const wizardPage = await context.newPage();

  try {
    // Phase A: Navigate to your-orders, check auth
    await wizardPage.goto(`${BASE_URL}/your-orders/orders`, { waitUntil: 'domcontentloaded' });

    const authProblem = await detectAuthProblem(wizardPage);
    if (authProblem) {
      await wizardPage.close().catch(() => {});
      return {
        success: false,
        error_code: authProblem,
        message: authProblem === 'auth_expired'
          ? 'Amazon session expired. Log in again via check_login.'
          : 'CAPTCHA challenge detected. Manual intervention required.',
      };
    }

    // Phase B: Find the "Return or replace items" button for this order.
    // Try the order row on the list page first, then fall back to the
    // order detail page if this order isn't in the current view window.
    // TODO selector-discovery: confirm return button selector for your-orders rows
    const orderRowSel = `[data-order-id="${order_id}"]`;
    const orderRowFound = await waitForElement(wizardPage, orderRowSel, 5000);

    let returnBtnClicked = false;

    if (orderRowFound) {
      for (const btnSel of SEL_RETURN_BUTTON_CANDIDATES) {
        const fullSel = `${orderRowSel} ${btnSel}`;
        const btn = wizardPage.locator(fullSel).first();
        if ((await btn.count()) > 0) {
          await btn.click();
          returnBtnClicked = true;
          break;
        }
      }
    }

    if (!returnBtnClicked) {
      // Try order detail page — may surface return button there
      await wizardPage.goto(
        `${BASE_URL}/gp/your-account/order-details?orderID=${order_id}`,
        { waitUntil: 'domcontentloaded' },
      );

      const detailAuth = await detectAuthProblem(wizardPage);
      if (detailAuth) {
        await wizardPage.close().catch(() => {});
        return {
          success: false,
          error_code: detailAuth,
          message: 'Authentication problem on order detail page.',
        };
      }

      const orderOnPage = await wizardPage.evaluate((oid: string) => {
        return document.body.textContent?.includes(oid) ?? false;
      }, order_id);

      if (!orderOnPage) {
        await wizardPage.close().catch(() => {});
        return {
          success: false,
          error_code: 'order_not_found',
          message: `Order ${order_id} was not found on this account.`,
        };
      }

      for (const btnSel of SEL_RETURN_BUTTON_CANDIDATES) {
        const btn = wizardPage.locator(btnSel).first();
        if ((await btn.count()) > 0) {
          await btn.click();
          returnBtnClicked = true;
          break;
        }
      }
    }

    if (!returnBtnClicked) {
      // Direct wizard URL fallback
      // TODO selector-discovery: confirm correct initiation URL pattern
      await wizardPage.goto(
        `${BASE_URL}/spr/returns/initiate?orderId=${order_id}`,
        { waitUntil: 'domcontentloaded' },
      );
    }

    await wizardPage.waitForLoadState('domcontentloaded');

    const postNavAuth = await detectAuthProblem(wizardPage);
    if (postNavAuth) {
      await wizardPage.close().catch(() => {});
      return {
        success: false,
        error_code: postNavAuth,
        message: `${postNavAuth === 'captcha_required' ? 'CAPTCHA' : 'Auth'} appeared during wizard navigation.`,
      };
    }

    let currentStep = await detectCurrentWizardStep(wizardPage);

    // Phase C: Item selection page
    if (currentStep === 'item_selection') {
      // Check for return-window-expired or non-returnable badges
      // TODO selector-discovery: return window expired + non-returnable selectors
      const ineligibleSel = '[data-testid="ineligible-reason"], .return-window-expired, .ineligible-badge';
      const ineligibleFound = await waitForElement(wizardPage, ineligibleSel, 2000);
      if (ineligibleFound) {
        const reason = await wizardPage.evaluate((sel: string) => {
          return document.querySelector(sel)?.textContent?.trim() || 'Item is not eligible for return';
        }, ineligibleSel);
        await wizardPage.close().catch(() => {});
        return { success: false, error_code: 'return_window_expired', message: reason };
      }

      // Find item checkbox by ASIN first, fall back to first checkbox
      const asinCheckboxSel = SEL_ITEM_CHECKBOX_ASIN.replace('{ASIN}', item_id);
      const asinCheckboxFound = await waitForElement(wizardPage, asinCheckboxSel, 3000);

      if (asinCheckboxFound) {
        await wizardPage.locator(asinCheckboxSel).first().check();
      } else {
        const anyCheckboxFound = await waitForElement(wizardPage, SEL_ITEM_CHECKBOX_GENERIC, 2000);
        if (!anyCheckboxFound) {
          await wizardPage.close().catch(() => {});
          return {
            success: false,
            error_code: 'item_not_in_order',
            message: `Item ${item_id} was not found in order ${order_id}.`,
          };
        }
        await wizardPage.locator(SEL_ITEM_CHECKBOX_GENERIC).first().check();
      }

      if (quantity > 1) {
        const qtyFound = await waitForElement(wizardPage, SEL_QUANTITY_DROPDOWN, 2000);
        if (qtyFound) {
          await wizardPage.locator(SEL_QUANTITY_DROPDOWN).first().selectOption(String(quantity));
        }
      }

      await clickContinue(wizardPage);
      await wizardPage.waitForLoadState('domcontentloaded');
      currentStep = await detectCurrentWizardStep(wizardPage);
    }

    // Phase D: Reason page
    if (currentStep === 'reason' || currentStep === 'unknown') {
      const amazonValue = REASON_TO_AMAZON_VALUE[reason];
      // TODO selector-discovery: reason radio value attribute (empirical)
      const reasonRadioCandidates = [
        `input[type="radio"][value="${amazonValue}"]`,
        `input[type="radio"][data-return-reason="${amazonValue}"]`,
        `input[type="radio"][data-value="${amazonValue}"]`,
      ];
      const reasonSel = await findFirstExisting(wizardPage, reasonRadioCandidates, 5000);
      if (reasonSel) {
        await wizardPage.locator(reasonSel).first().check();
      } else {
        // Fall back to first available reason radio
        const fallback = await waitForElement(wizardPage, 'input[type="radio"]', 3000);
        if (fallback) {
          await wizardPage.locator('input[type="radio"]').first().check();
        }
      }

      await clickContinue(wizardPage);
      await wizardPage.waitForLoadState('domcontentloaded');
      currentStep = await detectCurrentWizardStep(wizardPage);
    }

    // Phase E: Refund method page (skip-able)
    if (currentStep === 'refund_method') {
      const origSel = await findFirstExisting(wizardPage, SEL_REFUND_ORIGINAL_PAYMENT, 2000);
      if (origSel) {
        await wizardPage.locator(origSel).first().check();
      } else {
        const anySel = await waitForElement(wizardPage, SEL_REFUND_METHOD_ANY, 2000);
        if (anySel) {
          await wizardPage.locator(SEL_REFUND_METHOD_ANY).first().check();
        }
      }
      await clickContinue(wizardPage);
      await wizardPage.waitForLoadState('domcontentloaded');
      currentStep = await detectCurrentWizardStep(wizardPage);
    }

    // Phase F: Return method page (skip-able, prefer UPS QR)
    if (currentStep === 'return_method') {
      const upsSel = await findFirstExisting(wizardPage, SEL_UPS_QR_CANDIDATES, 2000);
      if (upsSel) {
        await wizardPage.locator(upsSel).first().check();
      } else {
        const anySel = await waitForElement(wizardPage, SEL_RETURN_METHOD_ANY, 2000);
        if (anySel) {
          await wizardPage.locator(SEL_RETURN_METHOD_ANY).first().check();
        }
      }
      await clickContinue(wizardPage);
      await wizardPage.waitForLoadState('domcontentloaded');
      currentStep = await detectCurrentWizardStep(wizardPage);
    }

    // Phase G: Confirm page — store task, return task_id without submitting
    if (currentStep !== 'confirm') {
      await wizardPage.close().catch(() => {});
      return {
        success: false,
        error_code: 'order_not_found',
        message: `Wizard ended in unexpected step "${currentStep}". Use debug_dump_dom to inspect the current page.`,
      };
    }

    // Scrape confirm-page data for task storage + TOCTOU guard
    // TODO selector-discovery: refund amount + method + item title on confirm page
    const confirmData = await wizardPage.evaluate(() => {
      const refundEl = document.querySelector('[data-testid="refund-amount"], .refund-amount, .a-color-price');
      const refundText = refundEl?.textContent?.trim().replace(/,/g, '') || '0';
      const refundMatch = refundText.match(/[\d.]+/);
      const refundAmountUsd = refundMatch ? parseFloat(refundMatch[0]) : 0;

      const methodEl = document.querySelector('[data-testid="refund-method"], .refund-method');
      const methodText = methodEl?.textContent?.toLowerCase() || '';

      const titleEl = document.querySelector('[data-testid="item-title"], .item-title, .a-text-bold');
      const itemTitle = titleEl?.textContent?.trim() || 'Unknown Item';

      const replacementEl = document.querySelector('[data-testid="replacement-option"], .replacement-available');
      const replacementAvailable = !!replacementEl;

      return { refundAmountUsd, methodText, itemTitle, replacementAvailable };
    });

    const refundMethodChosen: RefundMethod = confirmData.methodText.includes('balance')
      ? 'amazon_balance'
      : confirmData.methodText.includes('gift')
      ? 'gift_card'
      : 'original_payment';

    const task_id = randomUUID();
    const task: ReturnTask = {
      task_id,
      account,
      order_id,
      item_id,
      item_title: confirmData.itemTitle,
      quantity,
      reason,
      reason_prose,
      refund_method_chosen: refundMethodChosen,
      refund_amount_usd: confirmData.refundAmountUsd,
      replacement_available: confirmData.replacementAvailable,
      created_at: Date.now(),
      current_step: 'ready_to_submit',
      wizardPage,
    };
    TASKS.set(task_id, task);

    const result: StartReturnSuccess = {
      success: true,
      task_id,
      account,
      order_id,
      item_id,
      item_title: confirmData.itemTitle,
      quantity,
      reason_echoed: reason,
      refund_methods_offered: ['original_payment'],
      refund_method_chosen: refundMethodChosen,
      refund_amount_usd: confirmData.refundAmountUsd,
      replacement_available: confirmData.replacementAvailable,
      current_step: 'ready_to_submit',
    };
    return result;
  } catch (error) {
    await wizardPage.close().catch(() => {});
    throw error;
  }
}

export async function getReturnStatus(params: {
  task_id: string;
}): Promise<GetReturnStatusResult | { success: false; error_code: string; message: string }> {
  const task = TASKS.get(params.task_id);
  if (!task) {
    return {
      success: false,
      error_code: 'task_not_found',
      message: `No active return task for task_id "${params.task_id}". Task may have expired or the server restarted.`,
    };
  }

  const age_seconds = Math.floor((Date.now() - task.created_at) / 1000);
  const ttl_seconds = Math.floor(TASK_TTL_MS / 1000);

  return {
    success: true,
    task_id: task.task_id,
    current_step: task.current_step,
    age_seconds,
    ttl_seconds,
  };
}

export async function finalizeReturn(params: {
  task_id: string;
  confirm_reason?: ReturnReason;
}): Promise<FinalizeReturnResult> {
  const task = TASKS.get(params.task_id);

  if (!task) {
    return {
      success: false,
      error_code: 'task_not_found',
      message: `No active return task for task_id "${params.task_id}".`,
      task_id: params.task_id,
      recoverable: true,
    };
  }

  if (Date.now() - task.created_at > TASK_TTL_MS) {
    TASKS.delete(params.task_id);
    await task.wizardPage.close().catch(() => {});
    return {
      success: false,
      error_code: 'task_expired',
      message: 'Return task has expired (15 min TTL). Run start_return again.',
      task_id: params.task_id,
      recoverable: true,
    };
  }

  const page = task.wizardPage;

  // Verify wizard page is still alive
  try {
    await page.evaluate(() => document.readyState);
  } catch {
    TASKS.delete(params.task_id);
    return {
      success: false,
      error_code: 'task_expired',
      message: 'Wizard page has been closed (browser restarted?). Run start_return again.',
      task_id: params.task_id,
      recoverable: true,
    };
  }

  // Phase H.1: Selector liveness check — confirm page still showing
  // Using selector check, NOT URL match — Amazon may A/B-route confirm-page paths.
  const submitSel = await findFirstExisting(page, SEL_SUBMIT_BUTTON_CANDIDATES, 3000);
  const headerSel = await findFirstExisting(page, SEL_CONFIRM_HEADER_CANDIDATES, 3000);

  if (!submitSel || !headerSel) {
    TASKS.delete(params.task_id);
    await page.close().catch(() => {});
    return {
      success: false,
      error_code: 'wizard_advanced_unexpectedly',
      // pre-Submit — return NOT committed. Safe to retry from scratch.
      message: 'Confirm page no longer showing (wizard may have advanced or timed out). Return was NOT submitted — safe to re-run start_return.',
      task_id: params.task_id,
      recoverable: true,
    };
  }

  // Phase H.2: TOCTOU guard — re-scrape refund amount and compare.
  // State can change in the 15-min window (e.g. seller-initiated refund,
  // order edit, item flipped non-returnable). Mismatch → abort before submit.
  const freshAmount = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="refund-amount"], .refund-amount, .a-color-price');
    const text = el?.textContent?.trim().replace(/,/g, '') || '';
    const match = text.match(/[\d.]+/);
    return match ? parseFloat(match[0]) : -1;
  });

  if (freshAmount >= 0 && Math.abs(freshAmount - task.refund_amount_usd) > 0.01) {
    TASKS.delete(params.task_id);
    await page.close().catch(() => {});
    return {
      success: false,
      error_code: 'submit_failed',
      // post-Submit semantics: treat as unknown-commit-state since we're aborting
      // rather than submitting, but recoverable=false to force user to verify first.
      message: `Refund amount changed from $${task.refund_amount_usd} to $${freshAmount} since start_return. Check Your Orders before retrying to avoid a duplicate return.`,
      task_id: params.task_id,
      recoverable: false,
    };
  }

  // Phase H.3: Click Submit, verify success transition.
  // Delete task BEFORE click — a second finalize call after this point
  // returns task_not_found, preventing duplicate submissions.
  TASKS.delete(params.task_id);

  try {
    // Set up download listener BEFORE clicking (racing with fast downloads).
    const downloadPromise = page.waitForEvent('download', { timeout: 30_000 }).catch(() => null);

    const submitBtn = page.locator(submitSel).first();
    await submitBtn.click();

    await page.waitForLoadState('domcontentloaded', { timeout: 30_000 });

    const successTransitioned = await page.evaluate(() => {
      const text = document.body?.textContent?.toLowerCase() || '';
      const url = window.location.href.toLowerCase();
      return (
        text.includes('return submitted') ||
        text.includes('return confirmed') ||
        text.includes('drop off by') ||
        url.includes('success') ||
        url.includes('confirmation')
      );
    });

    if (!successTransitioned) {
      await page.close().catch(() => {});
      return {
        success: false,
        error_code: 'submit_failed',
        // post-Submit: commit status UNKNOWN. Do NOT silently retry.
        message: 'Submit was clicked but success page did not load. Return status is UNKNOWN — check Your Orders before any retry to avoid a duplicate return.',
        task_id: params.task_id,
        recoverable: false,
      };
    }

    // Scrape return_id FIRST — the QR filename depends on it.
    // TODO selector-discovery: return_id element on success page
    const return_id = await page.evaluate((selectors: string[]) => {
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el?.textContent?.trim()) return el.textContent.trim();
      }
      // Fallback: text search
      const text = document.body?.textContent || '';
      const match = text.match(/return\s*(?:id|#|number)[:\s#]*([A-Z0-9]{6,})/i);
      return match ? match[1] : `UNKNOWN-${Date.now()}`;
    }, SEL_RETURN_ID_CANDIDATES);

    // TODO selector-discovery: carrier name on success page
    const carrier = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="carrier"], .carrier-name, [data-testid="drop-off-location"]');
      if (el) return el.textContent?.trim() || 'UPS';
      const text = document.body?.textContent || '';
      if (/\bUPS\b/.test(text)) return 'UPS';
      if (/\bUSPS\b/.test(text)) return 'USPS';
      if (/\bFedEx\b/i.test(text)) return 'FedEx';
      if (/Whole Foods/i.test(text)) return 'Whole Foods';
      if (/Kohl/i.test(text)) return 'Kohls';
      return 'UPS';
    });

    // TODO selector-discovery: drop-off deadline on success page
    const drop_off_by = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="drop-off-by"], .drop-off-deadline, [data-testid="return-deadline"]');
      if (el) return el.textContent?.trim() || '';
      return new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    });

    // Construct QR filename after scraping return_id (filename depends on it)
    const dateStr = new Date().toISOString().slice(0, 10);
    const filename = `${dateStr}-${task.account}-${return_id}.png`;
    const containerPath = `${CONTAINER_RETURNS_DIR}/${filename}`;
    const qr_png_host_path = `${hostPrefix}/${filename}`;

    await fs.mkdir(CONTAINER_RETURNS_DIR, { recursive: true }).catch(() => {});

    // QR capture: try download event first (set up before click above),
    // then inline img (data: URL or CDN URL), then print button click.
    const download = await downloadPromise;
    if (download) {
      await download.saveAs(containerPath).catch((err: Error) => {
        console.error(`QR download.saveAs failed: ${err.message}`);
      });
    } else {
      const qrResult = await page.evaluate(() => {
        const img = document.querySelector('img[src*="data:image"], img[alt*="QR"], img[alt*="qr"], img[alt*="barcode"]') as HTMLImageElement | null;
        if (!img) return null;
        const src = img.src;
        if (src.startsWith('data:')) {
          (window as any).__qrDataUrl = src;
          return 'data';
        }
        return src; // CDN URL
      });

      if (qrResult === 'data') {
        const dataUrl = await page.evaluate(() => (window as any).__qrDataUrl as string || '');
        if (dataUrl) {
          const base64 = dataUrl.replace(/^data:[^;]+;base64,/, '');
          await fs.writeFile(containerPath, Buffer.from(base64, 'base64')).catch((err: Error) => {
            console.error(`QR data-URL write failed: ${err.message}`);
          });
        }
      } else if (typeof qrResult === 'string' && qrResult.startsWith('http')) {
        const response = await page.request.get(qrResult).catch(() => null);
        if (response?.ok()) {
          const body = await response.body();
          await fs.writeFile(containerPath, body).catch((err: Error) => {
            console.error(`QR CDN fetch write failed: ${err.message}`);
          });
        }
      } else {
        // Try print button for a download
        // TODO selector-discovery: print/download button on success page
        const printSel = await findFirstExisting(page, SEL_PRINT_BUTTON_CANDIDATES, 3000);
        if (printSel) {
          const dl2 = page.waitForEvent('download', { timeout: 15_000 }).catch(() => null);
          await page.locator(printSel).first().click();
          const download2 = await dl2;
          if (download2) {
            await download2.saveAs(containerPath).catch((err: Error) => {
              console.error(`QR print-button download failed: ${err.message}`);
            });
          }
        }
      }
    }

    await page.close().catch(() => {});

    // Write audit log AFTER finalize completes (per spec)
    const auditPath = `${CONTAINER_RETURNS_DIR}/${dateStr}-${task.account}-${return_id}.json`;
    const auditData = {
      timestamp: new Date().toISOString(),
      account: task.account,
      order_id: task.order_id,
      item_id: task.item_id,
      item_title: task.item_title,
      quantity: task.quantity,
      reason_enum: task.reason,
      reason_prose: task.reason_prose,
      refund_amount_usd: task.refund_amount_usd,
      refund_method: task.refund_method_chosen,
      return_id,
      carrier,
      drop_off_by,
      qr_png_host_path,
    };
    await fs.writeFile(auditPath, JSON.stringify(auditData, null, 2)).catch((err: Error) => {
      console.error(`Audit log write failed: ${err.message}`);
    });

    // Server-authored caption — callers MUST pass this to print-qr verbatim
    const caption = `Return ${return_id} — drop at ${carrier}`;

    return {
      success: true,
      task_id: params.task_id,
      return_id,
      refund_amount_usd: task.refund_amount_usd,
      refund_method: task.refund_method_chosen,
      carrier,
      drop_off_method: 'qr_code',
      qr_png_host_path,
      drop_off_by,
      caption,
    };
  } catch (error) {
    await page.close().catch(() => {});
    return {
      success: false,
      error_code: 'submit_failed',
      message: `Error during submit: ${error instanceof Error ? error.message : String(error)}. Return status UNKNOWN — check Your Orders before any retry.`,
      task_id: params.task_id,
      recoverable: false,
    };
  }
}

export async function listReturns(params: {
  account: ReturnAccount;
  status?: 'open' | 'completed' | 'all';
}): Promise<ListReturnsResult> {
  const { account, status = 'all' } = params;
  const context = await getContext();
  const page = await context.newPage();

  try {
    // TODO selector-discovery: confirm correct returns history URL
    await page.goto(`${BASE_URL}/returns`, { waitUntil: 'domcontentloaded' });

    const authProblem = await detectAuthProblem(page);
    if (authProblem) {
      return { success: true, account, returns: [] };
    }

    // TODO selector-discovery: return card selectors on returns history page
    const returns = await page.evaluate((filterStatus: string) => {
      const CARD_SEL = '[data-component="returnCard"], .return-card, [data-return-id]';
      const cards = Array.from(document.querySelectorAll(CARD_SEL));
      return cards.map((card) => {
        const returnId = card.getAttribute('data-return-id') || '';
        const orderId = card.getAttribute('data-order-id') || '';
        const itemTitle = card.querySelector('.item-title, .a-text-bold')?.textContent?.trim() || 'Unknown';
        const statusEl = card.querySelector('[data-testid="return-status"], .return-status');
        const statusText = statusEl?.textContent?.toLowerCase() || '';
        let status: 'awaiting_drop_off' | 'in_transit' | 'received' | 'refunded' | 'cancelled' | 'expired_undelivered' = 'awaiting_drop_off';
        if (statusText.includes('transit') || statusText.includes('shipped')) status = 'in_transit';
        else if (statusText.includes('received') || statusText.includes('delivered to amazon')) status = 'received';
        else if (statusText.includes('refund') || statusText.includes('credit')) status = 'refunded';
        else if (statusText.includes('cancel')) status = 'cancelled';
        else if (statusText.includes('expired')) status = 'expired_undelivered';
        return {
          return_id: returnId,
          order_id: orderId,
          item_id: '',
          item_title: itemTitle,
          status,
          refund_amount_usd: 0,
          refund_method: 'original_payment' as const,
          submitted_at: new Date().toISOString(),
        };
      }).filter((r) => {
        if (filterStatus === 'all') return true;
        if (filterStatus === 'open') return ['awaiting_drop_off', 'in_transit', 'received'].includes(r.status);
        if (filterStatus === 'completed') return ['refunded', 'cancelled', 'expired_undelivered'].includes(r.status);
        return true;
      });
    }, status);

    return { success: true, account, returns };
  } finally {
    await page.close().catch(() => {});
  }
}

export async function cancelReturn(params: {
  account: ReturnAccount;
  return_id: string;
}): Promise<CancelReturnResult> {
  const { return_id } = params;
  const context = await getContext();
  const page = await context.newPage();

  try {
    // TODO selector-discovery: confirm correct returns page URL + cancel button pattern
    await page.goto(`${BASE_URL}/returns`, { waitUntil: 'domcontentloaded' });

    const authProblem = await detectAuthProblem(page);
    if (authProblem) {
      return {
        success: false,
        error_code: 'not_found',
        message: 'Authentication problem. Log in again via check_login.',
        return_id,
      };
    }

    // TODO selector-discovery: cancel button scoped to this return_id's row
    const cancelCandidates = [
      `[data-return-id="${return_id}"] button:has-text("Cancel")`,
      `[data-return-id="${return_id}"] a:has-text("Cancel")`,
      `[data-return-id="${return_id}"] [data-testid="cancel-return"]`,
    ];
    const cancelSel = await findFirstExisting(page, cancelCandidates, 5000);

    if (!cancelSel) {
      return {
        success: false,
        error_code: 'not_found',
        message: `Return ${return_id} not found or no cancel option available (may already be dropped off, refunded, or cancelled).`,
        return_id,
      };
    }

    await page.locator(cancelSel).first().click();
    await page.waitForLoadState('domcontentloaded');

    const cancelled = await page.evaluate(() => {
      const text = document.body?.textContent?.toLowerCase() || '';
      return text.includes('cancelled') || text.includes('canceled') || text.includes('return cancelled');
    });

    if (!cancelled) {
      return {
        success: false,
        error_code: 'already_dropped_off',
        message: 'Cancel click succeeded but confirmation text not found — check Your Returns to confirm status.',
        return_id,
      };
    }

    return {
      success: true,
      return_id,
      cancelled_at: new Date().toISOString(),
    };
  } finally {
    await page.close().catch(() => {});
  }
}

// Export RETURN_REASONS for server.ts tool definition (avoids re-importing types.ts)
export { RETURN_REASONS };
