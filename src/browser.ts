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
        // --test-type suppresses Chrome's "You are using an unsupported
        // command-line flag: --no-sandbox. Stability and security will suffer."
        // infobar. In the container Chrome runs as root, so Playwright/patchright
        // auto-appends --no-sandbox, which triggers that yellow infobar; it
        // pollutes screenshots/automation and can shift element coordinates.
        // --test-type is the canonical Chromium flag to suppress these
        // unsupported-flag infobars. Cosmetic only — it does NOT re-enable the
        // sandbox or change the security posture. (2026-06-24)
        args: ['--disable-blink-features=AutomationControlled', '--test-type'],
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
  // Every tool that touches the singleton page comes through here, so this is
  // the one choke point where "the page is in use" can be observed. See the
  // idle-page reaper below.
  lastPageActivityMs = Date.now();

  const context = await getContext();
  const pages = context.pages();
  if (pages.length > 0) {
    return pages[0];
  }
  return await context.newPage();
}

/* ------------------------------------------------------------------ *
 * Idle-page parking
 * ------------------------------------------------------------------ *
 *
 * `getPage()` hands out the SAME singleton page for the life of the container,
 * and no tool navigates it away when it finishes. Whatever Amazon page the last
 * call landed on therefore stays loaded forever — a search-results or cart page
 * is ~0.8-1.0 MB of HTML with carousels, ad-refresh timers, lazy-load
 * observers and telemetry beacons still running. Chrome would normally throttle
 * those timers once the page is hidden, but Playwright/patchright launches with
 * --disable-background-timer-throttling and
 * --disable-backgrounding-occluded-windows, so a parked page keeps running at
 * full speed indefinitely with nothing watching it.
 *
 * Measured on Umbridge 2026-09-09, both containers idle for 4.75 days straight:
 *   personal — parked on /s?k=<a search from days earlier> (794 KB)
 *              → renderer burned 7h43m CPU = 6.8% of a core, lifetime average
 *   business — parked on /gp/cart/view.html (1.04 MB)
 *              → renderer burned 18h13m CPU = 16.0% of a core, lifetime average
 * The heavier the parked page, the more idle CPU — which is the signature of
 * page JS, not of the 5-minute session auto-save (that reads cookies off the
 * BrowserContext and never touches the page).
 *
 * IMPORTANT — those lifetime averages are NOT the steady-state rate. Re-measured
 * the same two renderers later the same day over a 181-second window (cgroup
 * cpuacct delta, both containers still idle):
 *   personal — 1.10% of a core   (vs 6.8% lifetime average)
 *   business — 2.21% of a core   (vs 16.0% lifetime average)
 *   whole containers: personal 2.28%, business 2.99%
 * So a parked page burns hard for a while and then largely quiesces — Amazon's
 * ad-refresh and carousel timers back off after a page has sat untouched for
 * long enough. The cost of NOT parking is therefore concentrated in the window
 * right after each tool call, not spread evenly across the container's life.
 * Two consequences worth remembering before anyone re-derives this:
 *   1. A "container is burning N% forever" reading taken shortly after activity
 *      will overstate the steady-state cost by roughly 5-7x. Always measure a
 *      delta over a fixed window; ps TIME and ps %CPU are lifetime averages.
 *   2. This affects BOTH containers and is a property of the image, not of one
 *      wedged instance. Business is consistently the worse of the two because
 *      it parks on a heavier page. Do not diagnose it as "one instance wedged".
 * Confidence: the two rate measurements are Verified (direct cgroup deltas over
 * a fixed window). That timer back-off is the mechanism behind the decay is
 * Inferred — not isolated experimentally.
 *
 * Fix: once the singleton page has gone IDLE_PAGE_PARK_MS without a getPage()
 * call, navigate it to about:blank. Cookies live on the BrowserContext and in
 * the persistent user-data dir, NOT on the page, so parking does not touch the
 * Amazon session. Every functional tool calls page.goto() before it reads
 * anything, so finding the page on about:blank is always safe.
 *
 * The window is deliberately generous (5 min default) for two reasons: the
 * debug_* tools read the CURRENT page without navigating, so selector-drift
 * triage after a failed call still works; and no single tool call comes close
 * to 5 minutes between getPage() and its last page access, so the reaper cannot
 * navigate out from under an in-flight call.
 *
 * Set IDLE_PAGE_PARK_MS=0 to disable.
 */

const DEFAULT_IDLE_PAGE_PARK_MS = 5 * 60 * 1000;

function resolveIdleParkMs(): number {
  const raw = process.env.IDLE_PAGE_PARK_MS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_IDLE_PAGE_PARK_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    console.warn(
      `Ignoring invalid IDLE_PAGE_PARK_MS=${raw}; using ${DEFAULT_IDLE_PAGE_PARK_MS}ms`,
    );
    return DEFAULT_IDLE_PAGE_PARK_MS;
  }
  return parsed;
}

let lastPageActivityMs = Date.now();
let reaperTimer: ReturnType<typeof setInterval> | null = null;
let parkInFlight = false;

/**
 * Arm the idle-page reaper. Idempotent; call once at startup.
 */
export function startIdlePageReaper(): void {
  if (reaperTimer) return;
  const idleMs = resolveIdleParkMs();
  if (idleMs === 0) {
    console.log('ℹ Idle-page reaper disabled (IDLE_PAGE_PARK_MS=0)');
    return;
  }
  const tickMs = Math.max(30_000, Math.floor(idleMs / 4));
  reaperTimer = setInterval(() => {
    void parkIdlePage(idleMs);
  }, tickMs);
  console.log(
    `✓ Idle-page reaper armed (park after ${Math.round(idleMs / 1000)}s idle, ` +
      `checked every ${Math.round(tickMs / 1000)}s)`,
  );
}

async function parkIdlePage(idleMs: number): Promise<void> {
  // Never launch a browser just to park a page.
  if (parkInFlight || !contextInstance) return;
  if (Date.now() - lastPageActivityMs < idleMs) return;

  parkInFlight = true;
  try {
    // Only ever touch the singleton page. returns.ts parks its wizard tabs on
    // their own context.newPage() handles and reaps them on its own TTL sweep.
    const page = contextInstance.pages()[0];
    if (!page || page.isClosed()) return;
    if (page.url() === 'about:blank') return;
    // Re-check: a tool call may have grabbed the page while we were awaiting.
    if (Date.now() - lastPageActivityMs < idleMs) return;

    const previousUrl = page.url();
    await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 15_000 });
    console.log(`✓ Idle page parked on about:blank (was ${previousUrl})`);
  } catch (error) {
    console.error(
      'Idle-page park failed (will retry next tick):',
      error instanceof Error ? error.message : error,
    );
  } finally {
    parkInFlight = false;
  }
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
