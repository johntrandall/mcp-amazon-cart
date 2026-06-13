import { chromium, BrowserContext, Page } from 'patchright';
import path from 'path';

let contextInstance: BrowserContext | null = null;
let contextInflight: Promise<BrowserContext> | null = null;

/**
 * Get or create the persistent Patchright browser context.
 *
 * Patchright is a drop-in for Playwright with built-in stealth patches —
 * the browser-fingerprint anti-detection that the legacy Puppeteer factory
 * applied manually (webdriver, plugins, languages overrides) is handled by
 * patchright internally.
 *
 * channel: 'chrome' uses real Google Chrome (not Chromium) because Amazon's
 * bot detection is more lenient with the real Chrome user agent + binary.
 */
export async function getContext(): Promise<BrowserContext> {
  if (contextInstance) {
    return contextInstance;
  }
  // In-flight dedup: when the app starts, server.ts's app.listen callback
  // calls getContext() in parallel with the first tools/call. Without this
  // guard, two chromium.launchPersistentContext invocations race on the same
  // --user-data-dir and the second one bails with "Opening in existing
  // browser session" — leaving contextInstance stuck null forever.
  // Pattern lifted from feedback-authinflight-iife-race-needs-yield.
  if (contextInflight) {
    return contextInflight;
  }

  const userDataDir = path.resolve(process.env.USER_DATA_DIR || './user-data');
  const headless = process.env.HEADLESS === 'true';

  console.log('Launching browser with config:', {
    headless,
    userDataDir,
    channel: 'chrome',
  });

  contextInflight = (async () => {
    // Yield once so any same-tick callers see contextInflight set
    // before we await the launch.
    await Promise.resolve();
    try {
      const created = await chromium.launchPersistentContext(userDataDir, {
        channel: 'chrome',
        headless,
        viewport: { width: 1366, height: 900 },
        // Patchright already handles AutomationControlled; keep the flag for belt-and-suspenders.
        args: ['--disable-blink-features=AutomationControlled'],
        // x11vnc bootstrap path: when HEADLESS=false in the container, Xvfb is on :99
        // and the launched Chrome reads $DISPLAY from the env automatically.
      });
      contextInstance = created;

      // Inspect existing cookies for logging only — useful first-boot signal.
      const cookies = await created.cookies('https://www.amazon.com');
      console.log('✓ Browser launched successfully');
      console.log('✓ User data dir:', userDataDir);
      console.log(`✓ Loaded ${cookies.length} existing Amazon cookies from profile`);

      const hasSessionCookies = cookies.some(
        (c) => c.name === 'session-id' || c.name === 'session-token',
      );
      if (hasSessionCookies) {
        console.log('✓ Found Amazon session cookies - you may already be logged in');
      } else {
        console.log('ℹ No Amazon session cookies found - you will need to log in');
      }

      return created;
    } catch (error) {
      console.error('Failed to launch browser:', error);
      if (error instanceof Error && error.message.includes('already running')) {
        console.error('\n⚠️  Another browser instance is using the user data directory.');
        console.error('   Please close any other instances or use a different USER_DATA_DIR.\n');
      }
      throw error;
    } finally {
      contextInflight = null;
    }
  })();
  return contextInflight;
}

/**
 * Get the active page from the persistent context. Reuses the first page
 * if one already exists (typical: the persistent context restores the
 * about:blank page from the prior session), otherwise creates a new one.
 */
export async function getPage(): Promise<Page> {
  const context = await getContext();
  const pages = context.pages();
  if (pages.length > 0) {
    return pages[0];
  }
  return await context.newPage();
}

export async function closeBrowser(): Promise<void> {
  if (contextInstance) {
    console.log('\nClosing browser and saving session data...');

    try {
      const cookies = await contextInstance.cookies();
      console.log(`Saving ${cookies.length} total cookies`);

      const amazonCookies = cookies.filter((c) => c.domain.includes('amazon'));
      console.log(`Amazon cookies: ${amazonCookies.length}`);

      const sessionCookies = amazonCookies.filter((c) => !c.expires || c.expires === -1);
      if (sessionCookies.length > 0) {
        console.log(`⚠️  Warning: ${sessionCookies.length} session-only Amazon cookies will be lost on browser close`);
        console.log('Session cookies:', sessionCookies.map((c) => c.name).join(', '));
      }
    } catch (error) {
      console.error('Error while inspecting cookies:', error);
    }

    await contextInstance.close();
    contextInstance = null;
    contextInflight = null;
    console.log('✓ Browser closed, session data saved to user-data directory');
  }
}
