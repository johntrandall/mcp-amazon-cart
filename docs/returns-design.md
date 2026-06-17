# Returns — MCP tool signatures

Design intent for the returns surface in `mcp-amazon-cart`. Companion to the user-global `amazon-returns` skill at `~/.claude/skills/amazon-returns/SKILL.md`. The skill is the policy layer; this doc is the tool surface.

Extends `src/server.ts` `TOOLS` array. Implementation lives in a new `src/returns.ts` module — one module, both account paths share the wizard logic (URL base differs via the existing `BUSINESS_BASE_URL` import). Account is selected by argument, matching the (newer) `place_order` convention; the older `_business`-suffix duplication used by `search_amazon`/`add_to_cart`/etc. is NOT extended to returns.

This PR introduces a new per-file-JSON audit log convention for the cart MCP. There is no pre-existing audit-log pattern in `place-order.ts` to mirror; consider retroactively applying the same convention to order placement.

## Memory citation — explicit divergence

The split into `start_return` + `finalize_return` is driven by memory `feedback-mcp-long-poll-looks-like-transport-drop`. We diverge from that memory's `still_awaiting` idempotent re-poll shape: `finalize_return` is a one-shot commit, not a re-pollable status check. `get_return_status` covers the polling need separately.

## Design constraints

- In-memory task state keyed by `task_id`. Server restart → task lost; caller re-runs `start_return`. Amazon does not record incomplete returns, so there is nothing to recover.
- `start_return` is fail-fast and read-only up to the eligibility check (see error codes below).
- v1 is refund-only. `replacement_available` is surfaced as a flag for caller awareness but not actionable.

## Shared types — single source of truth

```typescript
// types.ts additions

export const RETURN_REASONS = [
  'defective',
  'wrong_item',
  'damaged_both',
  'damaged_item_only',
  'missing_parts',
  'not_compatible',
  'arrived_late',
  'no_longer_needed',
  'better_price_available',
  'inaccurate_description',
  'bought_by_mistake',
] as const;
export type ReturnReason = typeof RETURN_REASONS[number];

export type ReturnAccount = 'personal' | 'business';

export type RefundMethod = 'original_payment' | 'amazon_balance' | 'gift_card';
// Future: | 'corporate_balance' (Amazon Business) — see Open questions

export type ReturnStep =
  | 'reason_selected'
  | 'refund_method_selected'
  | 'return_method_selected'
  | 'ready_to_submit';

// Read-side superset (start_return / finalize_return / cancel never report 'expired';
// only get_return_status does).
export type ReturnStepOrExpired = ReturnStep | 'expired';
```

Input schemas already use `snake_case` in the cart MCP (e.g. `confirm_total_max_usd` on `place_order`); returns extends snake_case to result-side fields as well. Existing result interfaces `CartItem` / `SearchResult` stay `camelCase` for backward compat.

## Tools to add to `TOOLS` array

```typescript
// ---- Returns (both accounts) ----
{
  name: 'list_returnable_items',
  description:
    'List items from recent orders. Returns items up to lookback_days regardless of return eligibility — past-window items appear with negative days_remaining, so callers can resolve an item the user mentions even when it can no longer be returned. Read-only.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      account: {
        type: 'string',
        enum: ['personal', 'business'],
        description: 'Which Amazon account',
      },
      lookback_days: {
        type: 'integer',
        minimum: 1,
        maximum: 365,
        description: 'How far back to scan order history. Default 60; capped at 365 to bound scan latency.',
        default: 60,
      },
    },
    required: ['account'],
  },
},
{
  name: 'start_return',
  description:
    'Open the Amazon returns wizard for a specific item. Performs fail-fast eligibility checks (return window, non-returnable, account match, order ID format, auth, CAPTCHA) before any browser writes. On success returns a task_id, the agent-supplied reason echoed back (so caller can confirm before finalize), the offered refund methods, and whether replacement is also available (refund only for v1). Does NOT submit the return — call finalize_return for that.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      account: {
        type: 'string',
        enum: ['personal', 'business'],
        description: 'Which Amazon account',
      },
      order_id: {
        type: 'string',
        description: 'Amazon order ID, format ###-#######-#######. Implementation trims whitespace before regex match. See Open questions on digital (D-prefix) IDs.',
        pattern: '^[0-9]{3}-[0-9]{7}-[0-9]{7}$',
      },
      item_id: {
        type: 'string',
        description: 'ASIN of the item being returned. Resolve via list_returnable_items first.',
      },
      quantity: {
        type: 'integer',
        minimum: 1,
        description: 'Quantity to return. Omit to return the entire line item.',
      },
      reason: {
        type: 'string',
        enum: [...RETURN_REASONS], // single-sourced from the const above
        description:
          'Agent-inferred Amazon return reason enum. Required. The server will echo this back in the response so the caller can confirm or override in finalize_return.',
      },
      reason_prose: {
        type: 'string',
        description:
          'Optional: original user prose that drove the reason inference. Stored in the audit log.',
      },
    },
    required: ['account', 'order_id', 'item_id', 'reason'],
  },
},
{
  name: 'get_return_status',
  description:
    'Poll the current wizard step for a task_id. Use when start_return reported a slow step, or to confirm state before finalize_return. Read-only.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      task_id: { type: 'string', description: 'task_id from start_return' },
    },
    required: ['task_id'],
  },
},
{
  name: 'finalize_return',
  description:
    'Submit the return for a task_id from start_return. Optionally override the echoed reason. Returns return_id and a host-side path to the printable QR code PNG. After this call, the return is committed (cancelable via cancel_return only until carrier scan).',
  inputSchema: {
    type: 'object' as const,
    properties: {
      task_id: { type: 'string', description: 'task_id from start_return' },
      confirm_reason: {
        type: 'string',
        enum: [...RETURN_REASONS],
        description:
          'Optional: override the reason picked at start_return. Must be one of the RETURN_REASONS values.',
      },
    },
    required: ['task_id'],
  },
},
{
  name: 'list_returns',
  description:
    'List returns for an account, optionally filtered by status. Read-only. Use for "did the refund post?" and "did Amazon receive it?" queries.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      account: {
        type: 'string',
        enum: ['personal', 'business'],
        description: 'Which Amazon account',
      },
      status: {
        type: 'string',
        enum: ['open', 'completed', 'all'],
        description: 'Filter by return status. Default: all.',
        default: 'all',
      },
    },
    required: ['account'],
  },
},
{
  name: 'cancel_return',
  description:
    'Cancel a return that has not yet been physically dropped off (carrier-scanned). Returns success if cancelable, structured error if past scan or already refunded.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      account: {
        type: 'string',
        enum: ['personal', 'business'],
        description: 'Which Amazon account',
      },
      return_id: {
        type: 'string',
        description: 'return_id from finalize_return or list_returns',
      },
    },
    required: ['account', 'return_id'],
  },
},
```

## Switch cases in `server.ts`

```typescript
case 'list_returnable_items':
  result = await listReturnableItems(args as any);
  break;
case 'start_return':
  result = await startReturn(args as any);
  break;
case 'get_return_status':
  result = await getReturnStatus(args as any);
  break;
case 'finalize_return':
  result = await finalizeReturn(args as any);
  break;
case 'list_returns':
  result = await listReturns(args as any);
  break;
case 'cancel_return':
  result = await cancelReturn(args as any);
  break;
```

Import block:

```typescript
import {
  listReturnableItems,
  startReturn,
  getReturnStatus,
  finalizeReturn,
  listReturns,
  cancelReturn,
} from './returns';
```

## Result shapes (TypeScript)

```typescript
// All result interfaces are success/error discriminated unions.

export interface ReturnableItem {
  order_id: string;
  item_id: string;       // ASIN
  title: string;
  quantity_ordered: number;
  unit_price_usd: number;
  delivered_on: string;  // ISO date
  eligible_until: string; // ISO date — may be in the past
  days_remaining: number; // negative for past-window items
  non_returnable_reason?: string; // if present, item is in the list but cannot be returned
}

export interface ListReturnableItemsResult {
  success: true;
  account: ReturnAccount;
  items: ReturnableItem[];
}

// ---- start_return ----

export interface StartReturnSuccess {
  success: true;
  task_id: string;
  account: ReturnAccount;
  order_id: string;
  item_id: string;
  item_title: string;
  quantity: number;
  reason_echoed: ReturnReason;
  refund_methods_offered: RefundMethod[];
  refund_method_chosen: RefundMethod; // server picks original_payment when offered; see skill policy
  refund_amount_usd: number;
  replacement_available: boolean; // surfaced for caller awareness; not actionable in v1
  current_step: ReturnStep;
}

export interface StartReturnError {
  success: false;
  error_code:
    | 'return_window_expired'
    | 'non_returnable'
    | 'item_not_on_account'
    | 'order_id_malformed'
    | 'order_not_found'
    | 'item_not_in_order'
    | 'auth_expired'
    | 'captcha_required';
  message: string;
  // Optional fields populated by specific error codes:
  eligible_until?: string;
  expired_days_ago?: number;
  non_returnable_reason?: string;
}

export type StartReturnResult = StartReturnSuccess | StartReturnError;

// ---- get_return_status ----

export interface GetReturnStatusResult {
  success: true;
  task_id: string;
  current_step: ReturnStepOrExpired;
  age_seconds: number;
  ttl_seconds: number; // task auto-expires after N seconds; default 900
}

// ---- finalize_return ----

export interface FinalizeReturnSuccess {
  success: true;
  task_id: string;          // On success the task is consumed; a second finalize with this task_id returns FinalizeReturnError { error_code: 'task_not_found' }.
  return_id: string;
  refund_amount_usd: number;
  refund_method: RefundMethod;
  carrier: string;          // open set — "UPS" | "USPS" | "Whole Foods" | "Kohls" | "Amazon Hub" | "Staples" | "FedEx" | other
  drop_off_method: 'qr_code' | 'printed_label' | 'pickup_scheduled' | 'other';
  qr_png_host_path: string; // host-side absolute path the caller hands to the print-qr skill
  drop_off_by: string;      // ISO date — Amazon's deadline
  caption: string;          // server-authored printout caption: "Return <return_id> — drop at <carrier>". Callers MUST pass this through to print-qr verbatim, not reconstruct it.
}

export interface FinalizeReturnError {
  success: false;
  error_code:
    | 'task_not_found'
    | 'task_expired'
    | 'wizard_advanced_unexpectedly'
    | 'submit_failed'
    | 'auth_expired'
    | 'captcha_required';
  message: string;
  task_id?: string;
  recoverable: boolean; // true → caller should re-run start_return
}

export type FinalizeReturnResult = FinalizeReturnSuccess | FinalizeReturnError;

// ---- list_returns ----

export interface ListReturnsResult {
  success: true;
  account: ReturnAccount;
  returns: Array<{
    return_id: string;
    order_id: string;
    item_id: string;
    item_title: string;
    status: 'awaiting_drop_off' | 'in_transit' | 'received' | 'refunded' | 'cancelled' | 'expired_undelivered';
    refund_amount_usd: number;
    refund_method: RefundMethod;
    submitted_at: string; // ISO
    refunded_at?: string; // ISO
    drop_off_by?: string; // ISO, only if awaiting_drop_off
  }>;
}

// ---- cancel_return ----

export interface CancelReturnSuccess {
  success: true;
  return_id: string;
  cancelled_at: string;
}

export interface CancelReturnError {
  success: false;
  error_code: 'already_dropped_off' | 'already_refunded' | 'already_cancelled' | 'not_found';
  message: string;
  return_id?: string;
}

export type CancelReturnResult = CancelReturnSuccess | CancelReturnError;
```

## In-memory task table + per-task browser pages

```typescript
// returns.ts — module-local

import type { Page } from 'patchright';

interface ReturnTask {
  task_id: string;  // MUST be UUID v4 / 128-bit cryptographic random — never sequential, never reused even after sweep
  account: ReturnAccount;
  order_id: string;
  item_id: string;
  quantity: number;
  reason: ReturnReason;
  reason_prose?: string;
  refund_method_chosen: RefundMethod;
  refund_amount_usd: number;  // captured at start_return; compared at finalize for the TOCTOU guard
  replacement_available: boolean;
  created_at: number; // ms epoch
  current_step: ReturnStep;
  wizardPage: Page;  // per-task Page from context.newPage() — see Browser context model
}

const TASKS = new Map<string, ReturnTask>();
const TASK_TTL_MS = 15 * 60 * 1000; // 15 min — bounds wizard-tab lifetime

// Sweep expired tasks every minute.
// Memory hygiene only; tasks don't survive process restart (Map is in-memory).
// Server restart between start_return and finalize_return loses the task; caller
// re-runs start_return per the in-memory-only constraint.
//
// allSettled + per-close timeout: a stuck page.close() must not stall the sweep
// or queue overlapping setInterval ticks. sweepRunning guard prevents overlap if
// the sweep itself takes >60s (e.g. many simultaneously expired tasks).
let sweepRunning = false;
setInterval(async () => {
  if (sweepRunning) return;
  sweepRunning = true;
  try {
    const now = Date.now();
    const expired = [...TASKS.entries()].filter(([, t]) => now - t.created_at > TASK_TTL_MS);
    await Promise.allSettled(
      expired.map(async ([id, t]) => {
        try {
          await Promise.race([
            t.wizardPage.close(),
            new Promise((_, rej) => setTimeout(() => rej(new Error('close timeout')), 5_000)),
          ]);
        } catch { /* page already gone or close hung */ }
        TASKS.delete(id);
      }),
    );
  } finally {
    sweepRunning = false;
  }
}, 60_000);
```

## Browser context model

The existing `getPage()` in `browser.ts` returns `context.pages()[0]` — a singleton. The returns flow diverges from that convention: each `start_return` call gets its own Page via `context.newPage()`, stored as `task.wizardPage`. This:

- Keeps the wizard tab alive for up to TASK_TTL_MS while other tools (`view_cart`, `search_amazon`) continue using the singleton page without interference.
- Allows concurrent `start_return` calls (each task is independent). `context.newPage()` is internally synchronized by Playwright; no module-level lock required.
- Means `closeBrowser()` still wipes all pages — task pages die on container shutdown. Tasks are in-memory anyway, so this is consistent.
- All pages share BrowserContext cookies. Cross-account contention can't occur in practice because each compose file runs a separate container (one personal, one business) with its own context — the MCP only knows about one account at a time.

`finalize_return` finds the task by `task_id`, uses `task.wizardPage` to click Submit. If the page has been closed (TTL sweep or browser shutdown), return `FinalizeReturnError { error_code: 'task_expired', recoverable: true }`.

## Wizard-flow phases (returns.ts implementation sketch)

Phases are lettered A–H to avoid collision with the skill's numbered workflow steps 1–8. Phases A–G happen INSIDE skill step 4 (`start_return`); phase H happens INSIDE skill step 6 (`finalize_return`).

Entry point is **selector-driven, not URL-driven.** Navigate to `/your-orders`, find the "Return or replace items" button on the target row, click it. The wizard URL is an implementation detail — Amazon may change `/spr/returns` at any time.

- **A. Pre-flight auth check.** After navigation, detect `/ap/signin` redirect, presence of identity-verification banners (text match "verify your identity" / "sign in again"), or absence of expected order-list selector while the "Your Orders" heading is also absent. On detection → `StartReturnError { error_code: 'auth_expired' }`. Cheap and prevents a confusing "selector not found" failure mode.
- **B. CAPTCHA / challenge detection.** Detect Amazon's challenge pages by any of: URL contains `/errors/validateCaptcha` or `/ap/cvf/`; selector `#captchacharacters` or `[data-test="captcha"]` or any `<form action*="captcha">`; text match "Enter the characters" or "verify your identity". On detection → `StartReturnError { error_code: 'captcha_required' }`. This MCP is already patchright + real Chrome — no further stealth tier to escalate to. Detect, report, stop is the v1 contract.
- **C. Item selection page.** Checkboxes for each line + quantity dropdown. Fail-fast checks against this page's DOM (eligible_until banner → `return_window_expired`; non-returnable badge → `non_returnable`; account header mismatch → `item_not_on_account`).
- **D. Reason page.** Radio list. Set `reason` enum mapped to Amazon's radio value. Click Continue.
- **E. Refund method page.** Sometimes present, sometimes auto. Sometimes folded into return-method. **Skip-able.**
- **F. Return method page.** Pick UPS QR drop-off when offered. Skip-able when only one option.
- **G. Confirm page.** Don't click Submit. Store task at `current_step='ready_to_submit'`, return `task_id`.
- **H. `finalize_return`:** Three sub-checks before clicking Submit, then submit + capture:
  1. **Selector liveness:** verify the Submit button and confirm-page header are still present (selector check, NOT URL match — Amazon may A/B-route confirm-page paths). If not → `FinalizeReturnError { error_code: 'wizard_advanced_unexpectedly', recoverable: true }` — return NOT committed; safe to retry.
  2. **Eligibility freshness (TOCTOU guard):** re-scrape `refund_amount_usd` from the confirm page and compare against the value stored at `start_return`. State can change in the 15-min window (seller-initiated refund elsewhere, order edit, item flipped non-returnable). Mismatch → `FinalizeReturnError { error_code: 'submit_failed', recoverable: false }` and tell the user to check Your Orders before any retry.
  3. **Click Submit, then verify success-page transition** within a timeout. If the confirm page never transitions (interstitial hijack, network blip) → `submit_failed, recoverable: false` — commit status UNKNOWN. Do NOT silently retry; could create a duplicate return.

  On success: scrape `return_id` from the success page FIRST, then construct the QR filename (it depends on `return_id`), then capture the QR PNG (see below), then return.

**Distinguishing the two pre-vs-post Submit error codes is load-bearing:**
- `wizard_advanced_unexpectedly` — pre-Submit. Return NOT committed. Safe to retry from scratch.
- `submit_failed` — post-Submit or commit-state-unknown. The return may have committed on Amazon's side. Caller MUST verify via Your Orders before considering a retry — otherwise risks creating a duplicate return.

### Step detection across skip-able pages (E + F)

Use `detectCurrentWizardStep(page)` to detect which page actually loaded based on DOM selectors and advance accordingly — don't assume a linear path. Stub:

```typescript
type DetectedStep =
  | 'item_selection'
  | 'reason'
  | 'refund_method'
  | 'return_method'
  | 'confirm'
  | 'unknown';

async function detectCurrentWizardStep(page: Page): Promise<DetectedStep> {
  // Empirically discover selectors during implementation; each step has a
  // unique heading or form id. Return 'unknown' rather than guessing.
}
```

Treat `'unknown'` as `wizard_advanced_unexpectedly` and fail fast — better to surface the unexpected state than guess.

## QR PNG capture

Amazon's confirm/success page surfaces the QR via one of three mechanisms — discover empirically before committing to a single path:

- **Download event** (likely primary path): the success page has a "Print return label" or "Download QR" button. The canonical Playwright pattern is **`waitForEvent('download')` BEFORE clicking** — attaching after the click races with fast downloads. `return_id` must be scraped BEFORE constructing the filename (the filename depends on it):

  ```typescript
  // return_id has already been scraped from the success page (see phase H).
  const filename = `${dateStr}-${account}-${return_id}.png`;
  const targetPath = `/var/lib/amazon-cart/returns/${filename}`;

  const downloadPromise = page.waitForEvent('download');
  await printButton.click();
  const download = await downloadPromise;
  await download.saveAs(targetPath);
  ```

  `download.saveAs()` copies from Playwright's temp dir to the target. Failure modes: disk full (`ENOSPC`), perms (`EACCES`), parent dir missing. On any failure → `FinalizeReturnError { error_code: 'submit_failed', recoverable: false }`. **The return is already submitted on Amazon's side at this point** — the agent must still surface the `return_id` even without the QR; user can re-download from Your Orders.
- **Inline `<img>` with data: URL**: scrape the `src`, base64-decode, write to `targetPath`.
- **Inline `<img>` with CDN URL**: `page.request.get(url)` (carries session cookies); write the body to `targetPath`.

Implementation plan: try the download-event path first (matches the user's mental model — "there's a print button on the page"). Fall back to inline scrape if the button isn't present on a given account type. Use the existing `debug_inspect_selectors` family during implementation to confirm the actual DOM.

## Host path for the QR file

The container writes to `/var/lib/amazon-cart/returns/<dateStr>-<account>-<return_id>.png` (date+account-prefixed filename matches the audit-log JSON pattern, making `ls -lt` triage usable).

The host-side path is computed from a required env var. `returns.ts` fails fast at module load if it's missing — silent fallback to `''` would produce malformed root-relative paths that fail at print time, AFTER the return has been committed on Amazon's side:

```typescript
const hostPrefix = process.env.RETURNS_HOST_PATH_PREFIX;
if (!hostPrefix) {
  throw new Error('RETURNS_HOST_PATH_PREFIX env var is required for the returns module');
}

const filename = `${dateStr}-${account}-${return_id}.png`;
const qr_png_host_path = `${hostPrefix}/${filename}`;
```

## Compose changes required

Both `compose-personal.yml` and `compose-business.yml` must be updated as part of this PR:

```yaml
services:
  amazon-cart:
    environment:
      - RETURNS_HOST_PATH_PREFIX=/Users/johnrandall/amazon-returns
    volumes:
      - /Users/johnrandall/amazon-returns:/var/lib/amazon-cart/returns
```

Without the bind mount, finalize_return writes to an ephemeral container path and the host-side `print-qr` skill can't find the file. Without the env var, the server fails to start.

Create the host directory if it doesn't exist:

```bash
mkdir -p ~/amazon-returns
```

## Audit log

**Per-file JSON** at `/var/lib/amazon-cart/returns/YYYY-MM-DD-<account>-<return_id>.json` inside the container (`~/amazon-returns/YYYY-MM-DD-<account>-<return_id>.json` on the host via the bind mount). Per-file (not JSONL) so `ls -lt ~/amazon-returns/` shows pending drop-offs at a glance.

```json
{
  "timestamp": "2026-06-17T15:32:11Z",
  "account": "personal",
  "order_id": "112-1234567-8901234",
  "item_id": "B0ABCDEFGH",
  "item_title": "Foo Widget Pro",
  "quantity": 1,
  "reason_enum": "defective",
  "reason_prose": "stopped working after 3 days",
  "refund_amount_usd": 24.99,
  "refund_method": "original_payment",
  "return_id": "RYZ123ABC456",
  "carrier": "UPS",
  "drop_off_by": "2026-07-15T23:59:59Z",
  "qr_png_host_path": "/Users/johnrandall/amazon-returns/2026-06-17-personal-RYZ123ABC456.png"
}
```

QR PNGs accumulate next to the JSON files. Manual cleanup for v1; v2 could add `prune_completed_returns(older_than_days)`.

## Open questions

- **Digital order IDs.** Some Amazon order IDs have a `D` prefix (digital purchases). The current `pattern` regex rejects them. Decision: accept or reject at the `order_id_malformed` gate? Digital purchases are typically non-returnable anyway, so rejecting at the schema layer is defensible.
- **Amazon Business `corporate_balance` refund method.** Business may add a corporate-balance option to `refund_methods_offered`. Adding `'corporate_balance'` to the `RefundMethod` type is a one-edit-point change thanks to the extracted type — verify with a real Business return.
- **Business approval workflow.** Some Amazon Business setups require an approver before a return is finalized. `start_return` should detect "request pending approval" state on the confirm page and return a distinct `error_code: 'approval_required'` if encountered. TBD until a real Business return surfaces this.
- **Wizard step ordering.** Amazon sometimes folds phases E+F into one page. `detectCurrentWizardStep(page)` is the planned mitigation; confirm the DOM signature for each step during implementation.
- **Same-ASIN multi-line orders.** v1 assumes Amazon shows multi-packs as a single line with `quantity_ordered > 1`, never as N separate same-ASIN lines. `item_id` (= ASIN) cannot distinguish them with the v1 schema. Verify during implementation that no real order shows multiple lines with the same ASIN. If found, escalate to a schema change (promote `item_id` to a per-line return token; ASIN becomes a search-only field).

## Counterpart docs

- Skill: `~/.claude/skills/amazon-returns/SKILL.md`
- `print-qr` skill — QR printing pipeline (`mailing-label` is text-only and is NOT used here)
- Memory: `feedback-mcp-long-poll-looks-like-transport-drop.md` — why the wizard write is split, plus the explicit divergence note above
