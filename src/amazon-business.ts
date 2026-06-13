import { Page } from 'patchright';
import { getContext, getPage } from './browser';
import { AddToCartParams, RemoveFromCartParams, OperationResult } from './types';
import { saveAmazonSession } from './session-manager';

// Amazon Business has TWO distinct surfaces and the original assumption that
// they're one site is wrong:
//   - business.amazon.com — Polaris AEM marketing/account site. The Hello
//     greeting + account memberships live here. Paths like /s?k= and /dp/
//     return 404.
//   - www.amazon.com — the actual shopping app. When the browser carries the
//     business-account cookies (.amazon.com scope), www serves B2B-flavored
//     search results, B2B pricing on /dp/{asin}, and a B2B cart at
//     /gp/cart/view.html. Verified via debug_dump_dom: business.amazon.com/s?k=
//     returns Page-Not-Found, www.amazon.com/s?k= returns 26 results with
//     "Business Essentials" + 27 elements carrying "business" classes.
const HOMEPAGE_URL = 'https://business.amazon.com';
const SHOPPING_URL = 'https://www.amazon.com';
const BASE_URL = SHOPPING_URL; // kept for back-compat with existing imports

async function waitForElement(page: Page, selector: string, timeout = 5000): Promise<boolean> {
  try {
    await page.waitForSelector(selector, { timeout });
    return true;
  } catch {
    return false;
  }
}

/**
 * NOTE: All selectors below are intentionally identical to amazon.ts.
 * Business and consumer Amazon share most of the DOM (Amazon reuses the
 * same SearchAssembly + product detail + cart components on b2b).
 *
 * If smoke testing reveals divergence, override the affected selector
 * inline here — do NOT introduce a selector overrides map until at least
 * two distinct overrides are needed.
 */

/**
 * Business homepage uses a different search input than consumer Amazon.
 * Find the first matching selector and return it for downstream actions.
 * Returns null if none of the candidates exist after the timeout.
 */
async function findFirstSelector(
  page: Page,
  candidates: string[],
  timeoutMs = 8000,
): Promise<string | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    for (const sel of candidates) {
      try {
        if ((await page.locator(sel).count()) > 0) {
          return sel;
        }
      } catch {
        // ignore bad selector
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

const BUSINESS_SEARCH_INPUT_CANDIDATES = [
  '#twotabsearchtextbox',
  'input[name="field-keywords"]',
  '#nav-search input[type="text"]',
  '#nav-search input[type="search"]',
  'input[type="search"]',
  '[role="searchbox"]',
  '#searchDropdownBox + input',
];

const BUSINESS_SEARCH_SUBMIT_CANDIDATES = [
  '#nav-search-submit-button',
  'input[type="submit"][value="Go"]',
  '#nav-search button[type="submit"]',
  '[aria-label="Go" i]',
  'form[role="search"] button[type="submit"]',
];

export async function searchProductsBusiness(query: string): Promise<OperationResult> {
  try {
    const page = await getPage();
    const context = await getContext();

    // Skip the homepage entirely. business.amazon.com uses the Polaris design
    // system with a collapsed/hidden search bar that needs JS hydration before
    // it becomes interactable. Navigating directly to /s?k=query produces the
    // same results page with no homepage handshake.
    const url = `${BASE_URL}/s?k=${encodeURIComponent(query)}`;
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    await page.waitForSelector('[data-component-type="s-search-result"]', { timeout: 30000 });

    const results = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll('[data-component-type="s-search-result"]')) as Element[];
      return items.slice(0, 5).map((item: Element) => {
        const titleEl = item.querySelector('h2 a span');
        const priceWhole = item.querySelector('.a-price-whole');
        const priceFraction = item.querySelector('.a-price-fraction');
        const ratingEl = item.querySelector('.a-icon-star-small span');
        const imageEl = item.querySelector('img.s-image');
        const asinAttr = item.getAttribute('data-asin');

        return {
          title: titleEl?.textContent?.trim() || 'Unknown',
          price:
            priceWhole && priceFraction
              ? `$${priceWhole.textContent}${priceFraction.textContent}`
              : 'Price not available',
          rating: ratingEl?.textContent?.trim() || 'No rating',
          imageUrl: imageEl?.getAttribute('src') || '',
          asin: asinAttr || '',
        };
      });
    });

    await saveAmazonSession(context).catch(() => {});

    return {
      success: true,
      message: `Found ${results.length} products (Business)`,
      data: results,
    };
  } catch (error) {
    return {
      success: false,
      message: 'Failed to search products on Amazon Business',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function addToCartBusiness(params: AddToCartParams): Promise<OperationResult> {
  try {
    const page = await getPage();
    const context = await getContext();
    const quantity = params.quantity || 1;

    // Same pattern as personal: avoid the brittle click-first-result selector
    // by resolving an ASIN first, then navigating directly.
    let resolvedAsin = params.asin;
    if (!resolvedAsin) {
      if (!params.query) {
        throw new Error('Either query or asin must be provided');
      }
      const search = await searchProductsBusiness(params.query);
      if (!search.success || !Array.isArray(search.data) || search.data.length === 0) {
        throw new Error(`Business search returned no results for "${params.query}"`);
      }
      const firstAsin = search.data
        .map((r: any) => r?.asin)
        .find((a: string | undefined) => a && a.length > 0);
      if (!firstAsin) {
        throw new Error(`Business search results had no usable ASIN for "${params.query}"`);
      }
      resolvedAsin = firstAsin;
    }

    await page.goto(`${BASE_URL}/dp/${resolvedAsin}`, { waitUntil: 'domcontentloaded' });

    const title = await page.evaluate(() => {
      const titleEl = document.querySelector('#productTitle');
      return titleEl?.textContent?.trim() || 'Unknown Product';
    });

    if (quantity > 1) {
      const quantityExists = await waitForElement(page, '#quantity');
      if (quantityExists) {
        await page.locator('#quantity').selectOption(String(quantity));
      }
    }

    const addToCartCandidates = [
      '#add-to-cart-button',
      'input[name="submit.add-to-cart"]',
      '#submit\\.add-to-cart',
      'input#add-to-cart-button',
      '[aria-labelledby*="add-to-cart"]',
    ];
    let clicked = false;
    for (const sel of addToCartCandidates) {
      const btn = page.locator(sel).first();
      if ((await btn.count()) > 0) {
        await btn.click();
        clicked = true;
        break;
      }
    }
    if (!clicked) {
      throw new Error(
        `Business Add to Cart button not found (tried ${addToCartCandidates.length} candidates)`,
      );
    }

    const confirmationExists = await waitForElement(
      page,
      '#sw-atc-confirmation, #NATC_SMART_WAGON_CONF_MSG_SUCCESS',
      3000,
    );

    if (!confirmationExists) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    await saveAmazonSession(context).catch(() => {});

    return {
      success: true,
      message: `Added "${title}" to Business cart (quantity: ${quantity})`,
      data: { title, quantity },
    };
  } catch (error) {
    return {
      success: false,
      message: 'Failed to add item to Amazon Business cart',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function getCartBusiness(): Promise<OperationResult> {
  try {
    const page = await getPage();

    await page.goto(`${BASE_URL}/gp/cart/view.html`, { waitUntil: 'domcontentloaded' });

    const emptyCart = await page.locator('.sc-your-amazon-cart-is-empty').count();
    if (emptyCart > 0) {
      return {
        success: true,
        message: 'Business cart is empty',
        data: { items: [], total: '$0.00' },
      };
    }

    const items = await page.evaluate(() => {
      const cartItems = Array.from(
        document.querySelectorAll('[data-name="Active Items"] .sc-list-item'),
      ) as Element[];
      return cartItems.map((item: Element) => {
        const titleEl = item.querySelector('.sc-product-title');
        const priceEl = item.querySelector('.sc-product-price');
        const quantityEl = item.querySelector('[name^="quantity"]') as HTMLSelectElement;
        const imageEl = item.querySelector('img');
        const asinAttr = item.getAttribute('data-asin');

        return {
          title: titleEl?.textContent?.trim() || 'Unknown',
          price: priceEl?.textContent?.trim() || 'N/A',
          quantity: quantityEl?.value ? parseInt(quantityEl.value) : 1,
          asin: asinAttr || '',
          imageUrl: imageEl?.getAttribute('src') || '',
        };
      });
    });

    const subtotal = await page.evaluate(() => {
      const subtotalEl = document.querySelector('#sc-subtotal-amount-activecart .sc-price');
      return subtotalEl?.textContent?.trim() || '$0.00';
    });

    return {
      success: true,
      message: `Business cart contains ${items.length} item(s)`,
      data: { items, subtotal },
    };
  } catch (error) {
    return {
      success: false,
      message: 'Failed to get Business cart contents',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function removeFromCartBusiness(params: RemoveFromCartParams): Promise<OperationResult> {
  try {
    const page = await getPage();
    const context = await getContext();
    if (!params.asin) {
      throw new Error('asin is required');
    }

    // Cart operations go to the shopping (www) surface — business.amazon.com
    // /gp/cart/view.html does not host the cart UI.
    await page.goto(`${BASE_URL}/gp/cart/view.html`, { waitUntil: 'domcontentloaded' });

    const rowSelector = `[data-name="Active Items"] [data-asin="${params.asin}"]`;
    const rowExists = await waitForElement(page, rowSelector, 5000);
    if (!rowExists) {
      return {
        success: false,
        message: `ASIN ${params.asin} not found in Business cart (already removed?)`,
      };
    }

    const deleteBtn = page
      .locator(`${rowSelector} input[name^="submit.delete-active."]`)
      .first();
    if ((await deleteBtn.count()) === 0) {
      throw new Error(`Business Delete button not found inside row for ASIN ${params.asin}`);
    }

    await deleteBtn.click();

    // Same authoritative check as Personal: poll getCartBusiness() and
    // confirm the ASIN no longer appears in items. The row-count poll
    // false-positives on the "removed" stub Amazon briefly renders.
    let removed = false;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const cartCheck = await getCartBusiness();
      const stillPresent =
        cartCheck.success &&
        Array.isArray(cartCheck.data?.items) &&
        cartCheck.data.items.some((it: any) => it?.asin === params.asin);
      if (!stillPresent) {
        removed = true;
        break;
      }
    }

    await saveAmazonSession(context).catch(() => {});

    return {
      success: true,
      message: removed
        ? `Removed ASIN ${params.asin} from Business cart`
        : `Clicked Delete for ASIN ${params.asin}, but item still appears in Business cart after 5s`,
      data: { asin: params.asin, confirmedRemoved: removed },
    };
  } catch (error) {
    return {
      success: false,
      message: 'Failed to remove from Business cart',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function checkLoginStatusBusiness(): Promise<OperationResult> {
  try {
    const page = await getPage();
    const context = await getContext();
    // Login check uses the Polaris homepage (where the account greeting lives),
    // NOT the shopping URL.
    await page.goto(HOMEPAGE_URL, { waitUntil: 'domcontentloaded' });

    const loginInfo = await page.evaluate(() => {
      // Strategy 1: known candidate selectors (consumer + business variants)
      const candidates = [
        '#nav-link-accountList-nav-line-1',
        '#nav-link-accountList',
        '[data-csa-c-content-id="nav_ya_signin"]',
        '#nav-your-amazon-business',
        '#nav-link-yourAccount',
        '#nav-link-yourBusinessAccount',
        '#nav-greet-name',
        '#nav-greeting',
        '.nav-line-1',
        '[id*="accountList"]',
        '[id*="greet"]',
      ];
      let accountText = '';
      let matchedSelector = '';
      for (const sel of candidates) {
        try {
          const el = document.querySelector(sel);
          const t = el?.textContent?.trim() || '';
          if (t && t.includes('Hello')) {
            accountText = t.slice(0, 200);
            matchedSelector = sel;
            break;
          }
          if (t && !accountText) accountText = t.slice(0, 200);
        } catch {
          // bad selector — keep going
        }
      }

      // Strategy 2: DOM text-walk for "Hello" — the most resilient path.
      // Amazon Business renders "Hello, $first_name$" as a JS-hydration
      // placeholder before the real name appears; skip that variant and
      // keep walking so the real hydrated text wins.
      if (!accountText.includes('Hello') || /\$first_name\$/i.test(accountText)) {
        try {
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          let firstHello: { text: string; sel: string } | null = null;
          while (walker.nextNode()) {
            const node = walker.currentNode as Text;
            const text = (node.textContent || '').trim();
            const m = text.match(/Hello[,\s][^\n]{1,150}/);
            if (m && node.parentElement) {
              const matched = m[0].trim().slice(0, 200);
              const p = node.parentElement;
              const sel = `text-walk:${p.tagName.toLowerCase()}${p.id ? '#' + p.id : ''}`;
              // Prefer the first non-placeholder hit
              if (!/\$first_name\$/i.test(matched)) {
                accountText = matched;
                matchedSelector = sel;
                break;
              }
              if (!firstHello) firstHello = { text: matched, sel };
            }
          }
          // If only the placeholder was found, fall back to it (still a logged-in signal)
          if (!accountText.includes('Hello') && firstHello) {
            accountText = firstHello.text;
            matchedSelector = firstHello.sel + ':placeholder';
          }
        } catch {
          // walker errored — fall through
        }
      }

      // Strategy 3: nav-belt/header regex
      if (!accountText.includes('Hello')) {
        const nav = document.querySelector('#nav-belt, #nav-main, #nav-tools, header');
        const navText = nav?.textContent || '';
        const m = navText.match(/Hello[^,\n]*[,\n][^\n]{1,80}/);
        if (m) {
          accountText = m[0].trim().slice(0, 200);
          matchedSelector = 'regex:nav-belt';
        }
      }

      const cookieCount = document.cookie.split(';').filter((c) => c.trim()).length;

      // Fallback heuristic: if account text didn't surface but cookie count
      // is high (>15), the session is almost certainly logged in — the consumer
      // logged-out page has ~5-10 cookies; logged-in 20+.
      const hasHello = accountText.includes('Hello');
      const isLoggedIn = hasHello || cookieCount >= 20;

      return {
        isLoggedIn,
        accountText,
        cookieCount,
        matchedSelector,
        loginDetectionMethod: hasHello ? 'account-text' : isLoggedIn ? 'cookie-count' : 'none',
      };
    });

    console.log('Business login status check:', {
      loggedIn: loginInfo.isLoggedIn,
      accountText: loginInfo.accountText,
      cookieCount: loginInfo.cookieCount,
      matchedSelector: loginInfo.matchedSelector,
      method: loginInfo.loginDetectionMethod,
    });

    if (loginInfo.isLoggedIn) {
      await saveAmazonSession(context).catch(() => {});
    }

    return {
      success: true,
      message: loginInfo.isLoggedIn
        ? `Logged in to Amazon Business (${loginInfo.accountText || 'session valid via cookie heuristic'})`
        : 'Not logged in to Amazon Business',
      data: {
        loggedIn: loginInfo.isLoggedIn,
        accountText: loginInfo.accountText,
        cookieCount: loginInfo.cookieCount,
        matchedSelector: loginInfo.matchedSelector,
        loginDetectionMethod: loginInfo.loginDetectionMethod,
      },
    };
  } catch (error) {
    return {
      success: false,
      message: 'Failed to check Amazon Business login status',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export { BASE_URL as BUSINESS_BASE_URL };
