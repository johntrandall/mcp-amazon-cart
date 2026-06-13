import { Page } from 'patchright';
import { getContext, getPage } from './browser';
import { AddToCartParams, OperationResult } from './types';
import { saveAmazonSession } from './session-manager';

const AMAZON_DOMAIN = process.env.AMAZON_DOMAIN || 'amazon.com';
const BASE_URL = `https://www.${AMAZON_DOMAIN}`;

async function waitForElement(page: Page, selector: string, timeout = 5000): Promise<boolean> {
  try {
    await page.waitForSelector(selector, { timeout });
    return true;
  } catch {
    return false;
  }
}

export async function searchProducts(query: string): Promise<OperationResult> {
  try {
    const page = await getPage();
    const context = await getContext();

    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });

    // Search for product
    await page.waitForSelector('#twotabsearchtextbox');
    await page.fill('#twotabsearchtextbox', query);
    await page.click('#nav-search-submit-button');

    await page.waitForSelector('[data-component-type="s-search-result"]');

    // Extract search results
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

    // Auto-save session after successful search (captures any new cookies)
    await saveAmazonSession(context).catch(() => {});

    return {
      success: true,
      message: `Found ${results.length} products`,
      data: results,
    };
  } catch (error) {
    return {
      success: false,
      message: 'Failed to search products',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function addToCart(params: AddToCartParams): Promise<OperationResult> {
  try {
    const page = await getPage();
    const context = await getContext();
    const quantity = params.quantity || 1;

    // Resolve ASIN. The historical "search then click first result" path
    // was brittle (Amazon moves the h2-a link selector frequently). Instead
    // we use the same search extractor that already works, pull the first
    // data-asin off the results page, and navigate directly to /dp/{asin}.
    let resolvedAsin = params.asin;
    if (!resolvedAsin) {
      if (!params.query) {
        throw new Error('Either query or asin must be provided');
      }
      const search = await searchProducts(params.query);
      if (!search.success || !Array.isArray(search.data) || search.data.length === 0) {
        throw new Error(`Search returned no results for "${params.query}"`);
      }
      const firstAsin = search.data
        .map((r: any) => r?.asin)
        .find((a: string | undefined) => a && a.length > 0);
      if (!firstAsin) {
        throw new Error(`Search results had no usable ASIN for "${params.query}"`);
      }
      resolvedAsin = firstAsin;
    }

    await page.goto(`${BASE_URL}/dp/${resolvedAsin}`, { waitUntil: 'domcontentloaded' });

    // Get product title
    const title = await page.evaluate(() => {
      const titleEl = document.querySelector('#productTitle');
      return titleEl?.textContent?.trim() || 'Unknown Product';
    });

    // Set quantity if more than 1
    if (quantity > 1) {
      const quantityExists = await waitForElement(page, '#quantity');
      if (quantityExists) {
        await page.locator('#quantity').selectOption(String(quantity));
      }
    }

    // Click Add to Cart button. Amazon ships several variants; try each.
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
        `Add to Cart button not found (tried ${addToCartCandidates.length} candidates)`,
      );
    }

    // Wait for confirmation
    const confirmationExists = await waitForElement(
      page,
      '#sw-atc-confirmation, #NATC_SMART_WAGON_CONF_MSG_SUCCESS',
      3000,
    );

    if (!confirmationExists) {
      // Try alternate method - check if cart count increased
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    // Auto-save session after cart modification
    await saveAmazonSession(context).catch(() => {});

    return {
      success: true,
      message: `Added "${title}" to cart (quantity: ${quantity})`,
      data: { title, quantity },
    };
  } catch (error) {
    return {
      success: false,
      message: 'Failed to add item to cart',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function getCart(): Promise<OperationResult> {
  try {
    const page = await getPage();

    await page.goto(`${BASE_URL}/gp/cart/view.html`, { waitUntil: 'domcontentloaded' });

    // Check if cart is empty
    const emptyCart = await page.locator('.sc-your-amazon-cart-is-empty').count();
    if (emptyCart > 0) {
      return {
        success: true,
        message: 'Cart is empty',
        data: { items: [], total: '$0.00' },
      };
    }

    // Extract cart items
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

    // Get subtotal
    const subtotal = await page.evaluate(() => {
      const subtotalEl = document.querySelector('#sc-subtotal-amount-activecart .sc-price');
      return subtotalEl?.textContent?.trim() || '$0.00';
    });

    return {
      success: true,
      message: `Cart contains ${items.length} item(s)`,
      data: { items, subtotal },
    };
  } catch (error) {
    return {
      success: false,
      message: 'Failed to get cart contents',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function checkLoginStatus(): Promise<OperationResult> {
  try {
    const page = await getPage();
    const context = await getContext();
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });

    const loginInfo = await page.evaluate(() => {
      const accountList = document.querySelector('#nav-link-accountList-nav-line-1');
      const accountText = accountList?.textContent?.trim() || '';
      const isLoggedIn = accountText.includes('Hello');

      // Get cookie count for debugging
      const cookieCount = document.cookie.split(';').filter((c) => c.trim()).length;

      return {
        isLoggedIn,
        accountText,
        cookieCount,
      };
    });

    console.log('Login status check:', {
      loggedIn: loginInfo.isLoggedIn,
      accountText: loginInfo.accountText,
      cookieCount: loginInfo.cookieCount,
    });

    // If logged in, save the session automatically
    if (loginInfo.isLoggedIn) {
      await saveAmazonSession(context).catch(() => {});
      console.log('✓ Session auto-saved after login verification');
    }

    return {
      success: true,
      message: loginInfo.isLoggedIn
        ? `Logged in to Amazon (${loginInfo.accountText})`
        : 'Not logged in',
      data: {
        loggedIn: loginInfo.isLoggedIn,
        accountText: loginInfo.accountText,
        cookieCount: loginInfo.cookieCount,
      },
    };
  } catch (error) {
    return {
      success: false,
      message: 'Failed to check login status',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
