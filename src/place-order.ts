import { Page } from 'patchright';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { getPage } from './browser';
import { OperationResult } from './types';
import { BUSINESS_BASE_URL } from './amazon-business';

const AMAZON_DOMAIN = process.env.AMAZON_DOMAIN || 'amazon.com';
const PERSONAL_BASE_URL = `https://www.${AMAZON_DOMAIN}`;

// Pushover ACK window (seconds). Briefing: 5 minutes.
const ACK_TIMEOUT_SEC = 5 * 60;
const ACK_POLL_INTERVAL_MS = 2_000;

export interface PlaceOrderParams {
  account: 'personal' | 'business';
  confirm_total_max_usd: number;
}

interface PushoverConfig {
  token: string;
  user: string;
}

function loadPushoverConfig(): PushoverConfig | null {
  const token = process.env.PUSHOVER_APP_TOKEN;
  const user = process.env.PUSHOVER_USER_KEY;
  if (!token || !user) return null;
  return { token, user };
}

function parseSubtotalUsd(subtotalText: string): number | null {
  // Subtotal text looks like "$1,234.56" or "Subtotal (3 items): $42.00"
  const match = subtotalText.replace(/,/g, '').match(/\$\s*(\d+(?:\.\d{1,2})?)/);
  if (!match) return null;
  return parseFloat(match[1]);
}

/**
 * Send a Pushover notification with the cart summary and return the path
 * of the flag-file the user must `touch` to ACK.
 *
 * This is the v1 ACK mechanism: send-and-poll-local-file. v2 will plumb
 * a real webhook receiver into the container.
 */
async function sendPushoverAndCreateAckFlag(
  message: string,
  account: 'personal' | 'business',
): Promise<{ ackFilePath: string }> {
  const cfg = loadPushoverConfig();
  if (!cfg) {
    throw new Error(
      'Pushover not configured: set PUSHOVER_APP_TOKEN and PUSHOVER_USER_KEY env vars',
    );
  }

  const uuid = randomUUID();
  const ackFilePath = path.join(os.tmpdir(), `amazon-cart-mcp-ack-${uuid}`);

  // Compose the full Pushover message. Include the flag path so the
  // human ACK-er knows what to `touch`.
  const fullMessage =
    `Amazon ${account.toUpperCase()} order awaiting confirmation:\n\n` +
    `${message}\n\n` +
    `To approve: touch ${ackFilePath}\n` +
    `Auto-aborts in ${ACK_TIMEOUT_SEC / 60} minutes.`;

  const body = new URLSearchParams({
    token: cfg.token,
    user: cfg.user,
    message: fullMessage,
    title: `Amazon ${account === 'business' ? 'Business' : 'Personal'} order — ACK required`,
    priority: '1', // high priority per briefing; bypasses quiet hours
    expire: String(ACK_TIMEOUT_SEC),
  });

  const response = await fetch('https://api.pushover.net/1/messages.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Pushover send failed: HTTP ${response.status} ${errText}`);
  }

  return { ackFilePath };
}

/**
 * Poll the ACK flag file until it appears or the timeout elapses.
 * Returns true on ACK, false on timeout.
 */
async function waitForAckFlag(ackFilePath: string): Promise<boolean> {
  const deadline = Date.now() + ACK_TIMEOUT_SEC * 1000;
  while (Date.now() < deadline) {
    if (fs.existsSync(ackFilePath)) {
      // Cleanup the flag once we observe it.
      try {
        fs.unlinkSync(ackFilePath);
      } catch {
        /* ignore */
      }
      return true;
    }
    await new Promise((r) => setTimeout(r, ACK_POLL_INTERVAL_MS));
  }
  return false;
}

/**
 * Click the first "Place your order" button we can find. Amazon has
 * shipped at least three selectors for this over the years, depending on
 * checkout flow variant (Smart Wagon, one-click, alternate-shipping).
 */
async function clickPlaceOrderButton(page: Page): Promise<void> {
  const candidates = [
    '#submitOrderButtonId',
    '[name="placeYourOrder1"]',
    'input[aria-labelledby="submitOrderButtonId-announce"]',
  ];

  for (const selector of candidates) {
    const locator = page.locator(selector).first();
    if ((await locator.count()) > 0) {
      await Promise.all([page.waitForLoadState('networkidle'), locator.click()]);
      return;
    }
  }
  throw new Error(
    `No place-order button found (tried: ${candidates.join(', ')})`,
  );
}

/**
 * Extract the order ID from the confirmation page. Amazon renders the
 * order ID in the orderDetails link href: /gp/your-account/order-details?orderID=XXX-XXXXXXX-XXXXXXX
 */
async function extractOrderId(page: Page): Promise<string | null> {
  const orderId = await page.evaluate(() => {
    // Try the order-details link first.
    const anchors = Array.from(document.querySelectorAll('a')) as HTMLAnchorElement[];
    for (const a of anchors) {
      const href = a.getAttribute('href') || '';
      const match = href.match(/orderID=([A-Z0-9-]+)/i);
      if (match) return match[1];
    }
    // Fallback: text node search for "Order #XXX-XXXXXXX-XXXXXXX"
    const text = document.body.textContent || '';
    const orderMatch = text.match(/[#]\s*(\d{3}-\d{7}-\d{7})/);
    return orderMatch ? orderMatch[1] : null;
  });
  return orderId;
}

export async function placeOrder(params: PlaceOrderParams): Promise<OperationResult> {
  const baseUrl = params.account === 'business' ? BUSINESS_BASE_URL : PERSONAL_BASE_URL;

  try {
    const page = await getPage();

    // 1. Navigate to cart.
    await page.goto(`${baseUrl}/gp/cart/view.html`, { waitUntil: 'networkidle' });

    // 2. Read subtotal using same selector as view_cart.
    const subtotalText = await page.evaluate(() => {
      const subtotalEl = document.querySelector('#sc-subtotal-amount-activecart .sc-price');
      return subtotalEl?.textContent?.trim() || '';
    });

    const subtotalUsd = parseSubtotalUsd(subtotalText);
    if (subtotalUsd === null) {
      throw new Error(`Could not parse cart subtotal (got: "${subtotalText}")`);
    }

    // 3. Hard cap enforcement BEFORE any irreversible action.
    if (subtotalUsd > params.confirm_total_max_usd) {
      return {
        success: false,
        message: 'Cart total exceeds cap; order aborted',
        error: `cart total $${subtotalUsd.toFixed(2)} exceeds cap $${params.confirm_total_max_usd.toFixed(2)}`,
        data: { subtotalUsd, cap: params.confirm_total_max_usd },
      };
    }

    // 4. Read item count for the ACK summary.
    const itemCount = await page.evaluate(() => {
      return document.querySelectorAll('[data-name="Active Items"] .sc-list-item').length;
    });

    // 5. Click "Proceed to checkout".
    const proceedSelectors = [
      '#sc-buy-box-ptc-button',
      '[name="proceedToRetailCheckout"]',
    ];
    let clicked = false;
    for (const selector of proceedSelectors) {
      const locator = page.locator(selector).first();
      if ((await locator.count()) > 0) {
        await Promise.all([page.waitForLoadState('networkidle'), locator.click()]);
        clicked = true;
        break;
      }
    }
    if (!clicked) {
      throw new Error(
        `No proceed-to-checkout button found (tried: ${proceedSelectors.join(', ')})`,
      );
    }

    // 6. Wait for review page to settle.
    await page.waitForLoadState('domcontentloaded');

    // 7. Pushover ACK gate. DO NOT bypass for testing — smoke tests provide real ACKs.
    const ackMessage = `${itemCount} item(s), subtotal ${subtotalText} (cap $${params.confirm_total_max_usd.toFixed(2)})`;
    const { ackFilePath } = await sendPushoverAndCreateAckFlag(ackMessage, params.account);

    console.log(`Awaiting ACK — touch ${ackFilePath} to approve (timeout ${ACK_TIMEOUT_SEC}s)`);
    const acked = await waitForAckFlag(ackFilePath);

    if (!acked) {
      return {
        success: false,
        message: 'Order aborted: ACK timeout',
        error: `no ACK received within ${ACK_TIMEOUT_SEC}s (flag file: ${ackFilePath})`,
        data: { subtotalUsd, ackFilePath },
      };
    }

    // 8. Click "Place your order".
    await clickPlaceOrderButton(page);

    // 9. Wait for confirmation page.
    await page.waitForLoadState('networkidle');

    // 10. Capture order ID.
    const orderId = await extractOrderId(page);

    return {
      success: true,
      message: orderId
        ? `Order placed: ${orderId}`
        : 'Order submitted (order ID could not be extracted)',
      data: {
        orderId,
        subtotal: subtotalText,
        placedAt: new Date().toISOString(),
        account: params.account,
      },
    };
  } catch (error) {
    return {
      success: false,
      message: 'Failed to place order',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
