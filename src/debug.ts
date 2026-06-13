import { getPage } from './browser';
import { OperationResult } from './types';

/**
 * Diagnostic tools for selector debt. These tools let an out-of-container
 * caller (e.g. a Claude session over the MCP) inspect the live Amazon DOM
 * without needing VNC into the headed Chrome.
 *
 * Use cases:
 * - Confirm which selectors actually exist on the current page
 * - Retrieve a slice of HTML around a selector to find unique attributes
 * - Find any text matching a regex (e.g. "Hello John") and report nearby DOM
 *
 * These are NOT removed after debug — keeping them deployed makes
 * selector-drift triage minutes-of-work instead of hours-of-VNC.
 */

export interface DumpDomParams {
  url?: string;
  maxBytes?: number;
}

export async function dumpDom(params: DumpDomParams): Promise<OperationResult> {
  try {
    const page = await getPage();
    if (params.url) {
      await page.goto(params.url, { waitUntil: 'domcontentloaded' });
    }
    const html = await page.content();
    const maxBytes = params.maxBytes ?? 200_000;
    const truncated = html.length > maxBytes;
    return {
      success: true,
      message: `Dumped DOM from ${page.url()} (${html.length} bytes${truncated ? `, truncated to ${maxBytes}` : ''})`,
      data: {
        url: page.url(),
        bytes: html.length,
        truncated,
        html: truncated ? html.slice(0, maxBytes) : html,
      },
    };
  } catch (error) {
    return {
      success: false,
      message: 'Failed to dump DOM',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface InspectSelectorsParams {
  url?: string;
  selectors: string[];
}

export async function inspectSelectors(
  params: InspectSelectorsParams,
): Promise<OperationResult> {
  try {
    const page = await getPage();
    if (params.url) {
      await page.goto(params.url, { waitUntil: 'domcontentloaded' });
    }

    const results = await page.evaluate((selectors: string[]) => {
      return selectors.map((sel) => {
        let matched: Element[] = [];
        let queryError: string | null = null;
        try {
          matched = Array.from(document.querySelectorAll(sel));
        } catch (e: any) {
          queryError = e?.message || String(e);
        }
        const first = matched[0];
        return {
          selector: sel,
          matches: matched.length,
          queryError,
          firstText: first?.textContent?.trim().slice(0, 200) || null,
          firstTag: first?.tagName?.toLowerCase() || null,
          firstId: first?.id || null,
          firstClass: (first as HTMLElement)?.className || null,
          firstHref: (first as HTMLAnchorElement)?.href || null,
          firstOuterHtml: first?.outerHTML?.slice(0, 500) || null,
        };
      });
    }, params.selectors);

    return {
      success: true,
      message: `Inspected ${params.selectors.length} selector(s) on ${page.url()}`,
      data: { url: page.url(), results },
    };
  } catch (error) {
    return {
      success: false,
      message: 'Failed to inspect selectors',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface FindTextParams {
  url?: string;
  pattern: string;
  flags?: string;
}

/**
 * Scan the entire page for a regex match and return the DOM element(s) containing it.
 * Useful for "find the element with the text 'Hello John'" type queries.
 */
export async function findText(params: FindTextParams): Promise<OperationResult> {
  try {
    const page = await getPage();
    if (params.url) {
      await page.goto(params.url, { waitUntil: 'domcontentloaded' });
    }

    const results = await page.evaluate(
      ({ pattern, flags }) => {
        let re: RegExp;
        try {
          re = new RegExp(pattern, flags || 'i');
        } catch (e: any) {
          return { error: `Bad regex: ${e?.message || e}`, matches: [] };
        }

        const matches: Array<{
          text: string;
          tag: string;
          id: string;
          className: string;
          path: string;
          outerHtml: string;
        }> = [];

        function buildPath(el: Element): string {
          const parts: string[] = [];
          let cur: Element | null = el;
          while (cur && parts.length < 6) {
            let part = cur.tagName.toLowerCase();
            if (cur.id) part += `#${cur.id}`;
            else if (cur.className && typeof cur.className === 'string') {
              const cls = cur.className.split(/\s+/).filter(Boolean).slice(0, 2).join('.');
              if (cls) part += `.${cls}`;
            }
            parts.unshift(part);
            cur = cur.parentElement;
          }
          return parts.join(' > ');
        }

        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        const seen = new Set<Element>();
        while (walker.nextNode()) {
          const node = walker.currentNode as Text;
          const text = node.textContent || '';
          if (re.test(text)) {
            const el = node.parentElement;
            if (el && !seen.has(el)) {
              seen.add(el);
              matches.push({
                text: text.trim().slice(0, 300),
                tag: el.tagName.toLowerCase(),
                id: el.id || '',
                className: (el as HTMLElement).className || '',
                path: buildPath(el),
                outerHtml: el.outerHTML.slice(0, 400),
              });
              if (matches.length >= 20) break;
            }
          }
        }
        return { matches };
      },
      { pattern: params.pattern, flags: params.flags },
    );

    return {
      success: true,
      message: `Searched for /${params.pattern}/${params.flags || 'i'} on ${page.url()}`,
      data: { url: page.url(), ...results },
    };
  } catch (error) {
    return {
      success: false,
      message: 'Failed to find text',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
