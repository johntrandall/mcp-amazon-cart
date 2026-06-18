import { opRead } from './op-credentials';
import { PUSHOVER_ESCALATION_CODES, type RefreshErrorCode, type RefreshStep } from './types';

// Re-export the canonical escalation set so call sites can choose between
// importing from types.ts (preferred) or pushover.ts (legacy spec wording).
export { PUSHOVER_ESCALATION_CODES };

export interface PushoverEscalationArgs {
  account: 'personal' | 'business';
  error_code: RefreshErrorCode;
  step_failed?: RefreshStep;
  vnc_url: string;
}

/**
 * Send an emergency Pushover escalation.
 *
 * Payload is ENUM-DERIVED ONLY:
 *   - title carries the account
 *   - message carries the error_code, optional step enum, and VNC URL
 *   - url carries the VNC URL for the deep-link
 * NEVER include free-form text, exception strings, or anything that could
 * contain a credential value.
 *
 * Priority 2 (emergency) requires retry + expire. In test mode the
 * priority is overridden to 0 so the channel can be exercised without
 * actually paging anyone.
 */
export async function sendPushoverEscalation(args: PushoverEscalationArgs): Promise<boolean> {
  if (!PUSHOVER_ESCALATION_CODES.has(args.error_code)) {
    // Caller violated the gating contract. Refuse to send.
    return false;
  }

  const appTokenPath = process.env.PUSHOVER_APP_TOKEN_1P_PATH;
  const userKeyPath = process.env.PUSHOVER_USER_KEY_1P_PATH;
  if (!appTokenPath || !userKeyPath) {
    process.stderr.write(
      '[pushover] PUSHOVER_APP_TOKEN_1P_PATH / PUSHOVER_USER_KEY_1P_PATH not set; ' +
        'cannot escalate.\n',
    );
    return false;
  }

  let appToken;
  let userKey;
  try {
    appToken = await opRead(appTokenPath);
    userKey = await opRead(userKeyPath);
  } catch (err: any) {
    process.stderr.write(
      `[pushover] op read failed: ${err?.code ?? err?.message ?? 'unknown'}\n`,
    );
    return false;
  }

  const testMode = process.env.PUSHOVER_TEST_MODE === 'true';
  const priority = testMode ? '0' : '2';

  const body = new URLSearchParams();
  body.set('token', appToken.reveal());
  body.set('user', userKey.reveal());
  body.set('title', `Amazon Cart MCP — ${args.account} session needs you`);
  const stepClause = args.step_failed ? ` (step: ${args.step_failed})` : '';
  body.set('message', `Error: ${args.error_code}${stepClause}\nVNC: ${args.vnc_url}`);
  body.set('priority', priority);
  if (!testMode) {
    body.set('retry', '60');
    body.set('expire', '300');
  } else {
    body.set('retry', '60');
    body.set('expire', '0');
  }
  body.set('url', args.vnc_url);
  body.set('url_title', 'VNC in');

  try {
    const res = await fetch('https://api.pushover.net/1/messages.json', {
      method: 'POST',
      body,
    });
    if (!res.ok) {
      process.stderr.write(`[pushover] HTTP ${res.status}\n`);
    }
    return res.ok;
  } catch (err: any) {
    process.stderr.write(`[pushover] fetch failed: ${err?.message ?? 'unknown'}\n`);
    return false;
  }
}

/**
 * Build the Pushover URLSearchParams body without sending. Exposed for
 * test #6 (priority + no-secret assertions).
 */
export function _buildPushoverBodyForTest(
  args: PushoverEscalationArgs & { appToken: string; userKey: string },
): URLSearchParams {
  const testMode = process.env.PUSHOVER_TEST_MODE === 'true';
  const priority = testMode ? '0' : '2';
  const body = new URLSearchParams();
  body.set('token', args.appToken);
  body.set('user', args.userKey);
  body.set('title', `Amazon Cart MCP — ${args.account} session needs you`);
  const stepClause = args.step_failed ? ` (step: ${args.step_failed})` : '';
  body.set('message', `Error: ${args.error_code}${stepClause}\nVNC: ${args.vnc_url}`);
  body.set('priority', priority);
  body.set('retry', '60');
  body.set('expire', testMode ? '0' : '300');
  body.set('url', args.vnc_url);
  body.set('url_title', 'VNC in');
  return body;
}
