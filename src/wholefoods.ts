import { Page } from 'puppeteer';
import { getPage } from './browser';
import { OperationResult } from './types';
import { saveAmazonSession } from './session-manager';

const AMAZON_DOMAIN = process.env.AMAZON_DOMAIN || 'amazon.com';
const WHOLEFOODS_STOREFRONT = `https://www.${AMAZON_DOMAIN}/alm/storefront?almBrandId=VUZHIFdob2xlIEZvb2Rz`;
const WHOLEFOODS_CART = `https://www.${AMAZON_DOMAIN}/cart/localmarket?almBrandId=VUZHIFdob2xlIEZvb2Rz`;

async function waitForElement(page: Page, selector: string, timeout = 8000): Promise<boolean> {
  try {
    await page.waitForSelector(selector, { timeout });
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure we're on the Whole Foods storefront, handling any zip code / address prompts.
 */
async function ensureWholeFoodsStorefront(page: Page): Promise<void> {
  await page.goto(WHOLEFOODS_STOREFRONT, { waitUntil: 'domcontentloaded' });

  // Check for address/zip code modal and dismiss if present
  const addressModal = await waitForElement(page, '[data-testid="address-modal"], .alm-location-modal, #alm-toast-container', 3000);
  if (addressModal) {
    // Try to close the modal if there's a continue/dismiss button
    const dismissBtn = await page.$('[data-testid="address-modal"] button, .alm-location-modal button, #alm-toast-container button');
    if (dismissBtn) {
      await dismissBtn.click();
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
}

export async function searchWholeFoods(query: string): Promise<OperationResult> {
  try {
    const page = await getPage();

    await ensureWholeFoodsStorefront(page);

    // Use the search box — on the Whole Foods storefront, searches are scoped to grocery
    const searchBox = await page.$('#twotabsearchtextbox');
    if (!searchBox) {
      throw new Error('Search box not found on Whole Foods storefront');
    }

    // Clear existing text and type new query
    await page.click('#twotabsearchtextbox', { clickCount: 3 });
    await page.type('#twotabsearchtextbox', query);
    await page.click('#nav-search-submit-button');

    // Wait for results
    const hasResults = await waitForElement(page, '[data-component-type="s-search-result"], .s-result-item, [data-asin]', 10000);

    if (!hasResults) {
      return {
        success: true,
        message: `No Whole Foods results found for "${query}"`,
        data: [],
      };
    }

    const results = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll('[data-component-type="s-search-result"], [data-asin]')) as Element[];
      return items.slice(0, 8).map((item: Element) => {
        const titleEl = item.querySelector('h2 a span, .a-text-normal');
        const priceWhole = item.querySelector('.a-price-whole');
        const priceFraction = item.querySelector('.a-price-fraction');
        const perUnitEl = item.querySelector('.a-price + .a-size-base, .a-price ~ span');
        const ratingEl = item.querySelector('.a-icon-star-small span, .a-icon-alt');
        const imageEl = item.querySelector('img.s-image');
        const asinAttr = item.getAttribute('data-asin');
        const linkEl = item.querySelector('h2 a, a.a-link-normal');

        return {
          title: titleEl?.textContent?.trim() || 'Unknown',
          price: priceWhole && priceFraction
            ? `$${priceWhole.textContent}${priceFraction.textContent}`
            : 'Price not available',
          perUnit: perUnitEl?.textContent?.trim() || '',
          rating: ratingEl?.textContent?.trim() || 'No rating',
          imageUrl: imageEl?.getAttribute('src') || '',
          asin: asinAttr || '',
          url: linkEl?.getAttribute('href') || '',
        };
      }).filter(item => item.asin);
    });

    await saveAmazonSession(page).catch(() => {});

    return {
      success: true,
      message: `Found ${results.length} Whole Foods products for "${query}"`,
      data: results,
    };
  } catch (error) {
    return {
      success: false,
      message: 'Failed to search Whole Foods products',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function addToWholeFoodsCart(params: { query?: string; asin?: string; quantity?: number }): Promise<OperationResult> {
  try {
    const page = await getPage();
    const quantity = params.quantity || 1;

    if (params.asin) {
      // Navigate to the product page with the Whole Foods brand ID for delivery context
      await page.goto(`https://www.${AMAZON_DOMAIN}/dp/${params.asin}?almBrandId=VUZHIFdob2xlIEZvb2Rz`, { waitUntil: 'domcontentloaded' });
      // Wait for the product page to fully render (buy box loads asynchronously)
      await waitForElement(page, '#productTitle, #add-to-cart-button-grocery, #add-to-cart-button', 10000);
    } else if (params.query) {
      // Search first on Whole Foods storefront
      await ensureWholeFoodsStorefront(page);

      const searchBox = await page.$('#twotabsearchtextbox');
      if (!searchBox) throw new Error('Search box not found');

      await page.click('#twotabsearchtextbox', { clickCount: 3 });
      await page.type('#twotabsearchtextbox', params.query);
      await page.click('#nav-search-submit-button');

      // Wait for results and click first one
      const hasResults = await waitForElement(page, '[data-component-type="s-search-result"] h2 a, [data-asin] h2 a', 10000);
      if (!hasResults) {
        throw new Error(`No Whole Foods results found for "${params.query}"`);
      }

      await page.click('[data-component-type="s-search-result"] h2 a, [data-asin] h2 a');
      await page.waitForNavigation({ waitUntil: 'domcontentloaded' });
    } else {
      throw new Error('Either query or asin must be provided');
    }

    // Get product title — also capture page URL and state for debugging
    const pageState = await page.evaluate(() => {
      const titleEl = document.querySelector('#productTitle, #title');
      const bodyText = document.body?.innerText?.slice(0, 300) || '';
      return {
        title: titleEl?.textContent?.trim() || '',
        url: window.location.href,
        docTitle: document.title,
        hasCaptcha: !!document.querySelector('#captchacharacters'),
        hasSignIn: !!document.querySelector('#ap_email, #signInSubmit'),
        bodyPreview: bodyText,
      };
    });

    if (!pageState.title) {
      console.error('[wholefoods] Product page blank. State:', JSON.stringify(pageState));
    }

    const title = pageState.title || 'Unknown Product';

    // For fresh/grocery items, try multiple add-to-cart button variants.
    // Amazon uses different buy-box widgets depending on delivery mode (Fresh, WF, standard).
    const addButtonSelectors = [
      '#add-to-cart-button-grocery',
      '#add-to-cart-button',
      '#freshAddToCartButton',
      '#add-to-fresh-cart-button',
      '#add-to-cart-button-ubb',
      'input[name="submit.add-to-cart"]',
      '.qs-widget-summary-atc',
      '#add-to-fresh-cart',
    ];

    // Set quantity if > 1 before clicking add-to-cart
    if (quantity > 1) {
      const qtySelect = await page.$('#quantity, #freshAddToCartForm select, select[name="quantity"]');
      if (qtySelect) {
        await page.select(qtySelect as any, String(quantity));
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    // Scroll down to ensure the buy box is rendered (Amazon lazy-loads it)
    await page.evaluate(() => window.scrollBy(0, 300));
    await new Promise(resolve => setTimeout(resolve, 1000));

    let clicked = false;
    for (const selector of addButtonSelectors) {
      const btn = await page.$(selector);
      if (btn) {
        await btn.click();
        clicked = true;
        console.log('[wholefoods] Clicked add-to-cart via:', selector);
        break;
      }
    }

    if (!clicked) {
      // Log what we actually see for debugging
      const debugInfo = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('input[type=submit], button, .a-button'));
        const relevant = btns.filter(b => b.textContent?.toLowerCase().includes('cart') || b.id?.toLowerCase().includes('cart'));
        return relevant.map(b => ({ tag: b.tagName, id: b.id, text: b.textContent?.trim().slice(0, 60) }));
      });
      console.error('[wholefoods] No add-to-cart button found. Cart-related elements:', JSON.stringify(debugInfo));
      throw new Error('Add to cart button not found — this item may not be available for Whole Foods / Fresh delivery');
    }

    // Wait for confirmation
    const confirmed = await waitForElement(page, '#sw-atc-confirmation, #NATC_SMART_WAGON_CONF_MSG_SUCCESS, .a-alert-success, [data-testid="atc-confirmation"]', 5000);

    if (!confirmed) {
      // Give it a moment — sometimes the cart count updates without a visible confirmation
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    await saveAmazonSession(page).catch(() => {});

    return {
      success: true,
      message: `Added "${title}" to Whole Foods cart (quantity: ${quantity})`,
      data: { title, quantity },
    };
  } catch (error) {
    return {
      success: false,
      message: 'Failed to add item to Whole Foods cart',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function getWholeFoodsCart(): Promise<OperationResult> {
  try {
    const page = await getPage();

    await page.goto(WHOLEFOODS_CART, { waitUntil: 'domcontentloaded' });

    // Also try the regular cart with fresh filter
    // Amazon sometimes redirects fresh cart to the main cart page
    await new Promise(resolve => setTimeout(resolve, 2000));

    const currentUrl = page.url();

    // Check if cart is empty
    const empty = await page.evaluate(() => {
      const emptyIndicators = Array.from(document.querySelectorAll(
        '.sc-your-amazon-cart-is-empty, .a-spacing-mini h2, [data-testid="empty-cart"]'
      ));
      for (const el of emptyIndicators) {
        if (el.textContent?.toLowerCase().includes('empty')) return true;
      }
      return false;
    });

    if (empty) {
      return {
        success: true,
        message: 'Whole Foods / Fresh cart is empty',
        data: { items: [], subtotal: '$0.00' },
      };
    }

    // Extract cart items
    const items = await page.evaluate(() => {
      // Fresh cart items can be in different containers
      const selectors = [
        '.sc-list-item',
        '[data-testid="cart-item"]',
        '.a-section .sc-item-content-group',
      ];

      let cartItems: Element[] = [];
      for (const sel of selectors) {
        cartItems = Array.from(document.querySelectorAll(sel));
        if (cartItems.length > 0) break;
      }

      return cartItems.map((item: Element) => {
        const titleEl = item.querySelector('.sc-product-title, .a-truncate-cut, a.a-link-normal');
        const priceEl = item.querySelector('.sc-product-price, .a-price .a-offscreen, .sc-item-price');
        const quantityEl = item.querySelector('[name^="quantity"], select, .sc-quantity-textfield') as HTMLSelectElement | HTMLInputElement | null;
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
      const subtotalEl = document.querySelector(
        '#sc-subtotal-amount-activecart .sc-price, .a-price .a-offscreen, [data-testid="subtotal"]'
      );
      return subtotalEl?.textContent?.trim() || '$0.00';
    });

    return {
      success: true,
      message: `Whole Foods cart contains ${items.length} item(s)`,
      data: { items, subtotal, cartUrl: window?.location?.href || '' },
    };
  } catch (error) {
    return {
      success: false,
      message: 'Failed to get Whole Foods cart contents',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
