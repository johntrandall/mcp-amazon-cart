import { Page } from 'patchright';
import { getContext, getPage } from './browser';
import { AddToCartParams, OperationResult } from './types';
import { saveAmazonSession } from './session-manager';

// Business Amazon has its own subdomain; same Amazon retail backend, but
// b2b auth, pricing, and addresses route through it.
const BASE_URL = 'https://business.amazon.com';

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

export async function searchProductsBusiness(query: string): Promise<OperationResult> {
  try {
    const page = await getPage();
    const context = await getContext();

    await page.goto(BASE_URL, { waitUntil: 'networkidle' });

    await page.waitForSelector('#twotabsearchtextbox');
    await page.fill('#twotabsearchtextbox', query);
    await page.click('#nav-search-submit-button');

    await page.waitForSelector('[data-component-type="s-search-result"]');

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

    if (params.asin) {
      await page.goto(`${BASE_URL}/dp/${params.asin}`, { waitUntil: 'networkidle' });
    } else if (params.query) {
      await page.goto(BASE_URL, { waitUntil: 'networkidle' });
      await page.waitForSelector('#twotabsearchtextbox');
      await page.fill('#twotabsearchtextbox', params.query);
      await page.click('#nav-search-submit-button');

      await page.waitForSelector('[data-component-type="s-search-result"] h2 a');
      await Promise.all([
        page.waitForLoadState('networkidle'),
        page.click('[data-component-type="s-search-result"] h2 a'),
      ]);
    } else {
      throw new Error('Either query or asin must be provided');
    }

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

    const addToCartButton = page.locator('#add-to-cart-button').first();
    if ((await addToCartButton.count()) === 0) {
      throw new Error('Add to Cart button not found');
    }

    await addToCartButton.click();

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

    await page.goto(`${BASE_URL}/gp/cart/view.html`, { waitUntil: 'networkidle' });

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

export async function checkLoginStatusBusiness(): Promise<OperationResult> {
  try {
    const page = await getPage();
    const context = await getContext();
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });

    const loginInfo = await page.evaluate(() => {
      const accountList = document.querySelector('#nav-link-accountList-nav-line-1');
      const accountText = accountList?.textContent?.trim() || '';
      const isLoggedIn = accountText.includes('Hello');

      const cookieCount = document.cookie.split(';').filter((c) => c.trim()).length;

      return {
        isLoggedIn,
        accountText,
        cookieCount,
      };
    });

    console.log('Business login status check:', {
      loggedIn: loginInfo.isLoggedIn,
      accountText: loginInfo.accountText,
      cookieCount: loginInfo.cookieCount,
    });

    if (loginInfo.isLoggedIn) {
      await saveAmazonSession(context).catch(() => {});
    }

    return {
      success: true,
      message: loginInfo.isLoggedIn
        ? `Logged in to Amazon Business (${loginInfo.accountText})`
        : 'Not logged in to Amazon Business',
      data: {
        loggedIn: loginInfo.isLoggedIn,
        accountText: loginInfo.accountText,
        cookieCount: loginInfo.cookieCount,
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
