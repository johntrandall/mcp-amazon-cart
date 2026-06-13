import { BrowserContext, Page, Cookie } from 'patchright';
import fs from 'fs';
import path from 'path';

const USER_DATA_DIR = path.resolve(process.env.USER_DATA_DIR || './user-data');
const COOKIES_FILE = path.join(USER_DATA_DIR, 'amazon-session-cookies.json');

/**
 * Save current Amazon cookies to a JSON file with extended expiration.
 * This works around session-only cookies that expire when the browser closes.
 *
 * Note: with launchPersistentContext, the user-data dir already persists cookies
 * across restarts; this explicit JSON export is a belt-and-suspenders backup
 * (and a way to convert session cookies → persistent ones).
 */
export async function saveAmazonSession(context: BrowserContext): Promise<void> {
  try {
    const cookies = await context.cookies();
    const amazonCookies = cookies.filter((c) => c.domain.includes('amazon'));

    // Convert session cookies (expires === -1 in Playwright) to persistent
    // ones by setting expiration to 1 year out.
    const oneYearFromNow = Date.now() / 1000 + 365 * 24 * 60 * 60;
    const persistentCookies = amazonCookies.map((cookie) => ({
      ...cookie,
      expires: cookie.expires && cookie.expires > 0 ? cookie.expires : oneYearFromNow,
    }));

    fs.writeFileSync(COOKIES_FILE, JSON.stringify(persistentCookies, null, 2));
    console.log(`✓ Saved ${persistentCookies.length} Amazon cookies to ${COOKIES_FILE}`);

    const sessionCookies = amazonCookies.filter((c) => !c.expires || c.expires === -1);
    if (sessionCookies.length > 0) {
      console.log(`  Converted ${sessionCookies.length} session cookies to persistent cookies`);
    }
  } catch (error) {
    console.error('Failed to save Amazon session:', error);
  }
}

/**
 * Restore Amazon cookies from the saved JSON file.
 * Call this after browser launch to restore the session.
 */
export async function restoreAmazonSession(context: BrowserContext): Promise<boolean> {
  try {
    if (!fs.existsSync(COOKIES_FILE)) {
      console.log('ℹ No saved Amazon session found');
      return false;
    }

    const cookiesData = fs.readFileSync(COOKIES_FILE, 'utf-8');
    const cookies: Cookie[] = JSON.parse(cookiesData);

    const now = Date.now() / 1000;
    const validCookies = cookies.filter((c) => !c.expires || c.expires > now);

    if (validCookies.length === 0) {
      console.log('⚠️  All saved Amazon cookies have expired');
      return false;
    }

    await context.addCookies(validCookies);
    console.log(`✓ Restored ${validCookies.length} Amazon cookies from saved session`);

    if (validCookies.length < cookies.length) {
      console.log(`  (${cookies.length - validCookies.length} expired cookies were skipped)`);
    }

    return true;
  } catch (error) {
    console.error('Failed to restore Amazon session:', error);
    return false;
  }
}

/**
 * Check if the user is currently logged in to Amazon (via DOM probe).
 */
export async function isLoggedIn(page: Page): Promise<boolean> {
  try {
    const accountText = await page.evaluate(() => {
      const accountList = document.querySelector('#nav-link-accountList-nav-line-1');
      return accountList?.textContent?.trim() || '';
    });

    return accountText.includes('Hello');
  } catch {
    return false;
  }
}
