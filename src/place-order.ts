import { Page } from 'patchright';
import { getPage } from './browser';
import { OperationResult } from './types';
import { BUSINESS_BASE_URL } from './amazon-business';

const AMAZON_DOMAIN = process.env.AMAZON_DOMAIN || 'amazon.com';
const PERSONAL_BASE_URL = `https://www.${AMAZON_DOMAIN}`;

export interface PlaceOrderParams {
  account: 'personal' | 'business';
  confirm_total_max_usd: number;
}

function parseSubtotalUsd(subtotalText: string): number | null {
  // Subtotal text looks like "$1,234.56" or "Subtotal (3 items): $42.00"
  const match = subtotalText.replace(/,/g, '').match(/\$\s*(\d+(?:\.\d{1,2})?)/);
  if (!match) return null;
  return parseFloat(match[1]);
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

    // 3. Hard cap enforcement BEFORE any irreversible action. This is the
    // only server-side safety check. Higher-layer caller (autonomous-shopping
    // skill) enforces operator approval via Pushover/inline-chat at $50+.
    if (subtotalUsd > params.confirm_total_max_usd) {
      return {
        success: false,
        message: 'Cart total exceeds cap; order aborted',
        error: `cart total $${subtotalUsd.toFixed(2)} exceeds cap $${params.confirm_total_max_usd.toFixed(2)}`,
        data: { subtotalUsd, cap: params.confirm_total_max_usd },
      };
    }

    // 4. Click "Proceed to checkout".
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

    // 5. Wait for review page to settle.
    await page.waitForLoadState('domcontentloaded');

    // 6. Click "Place your order".
    await clickPlaceOrderButton(page);

    // 7. Wait for confirmation page.
    await page.waitForLoadState('networkidle');

    // 8. Capture order ID.
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
