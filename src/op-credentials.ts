import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

/**
 * Opaque secret wrapper. The four interpolation hooks below catch every
 * common path by which a secret value could escape into a log line, a
 * tool response, or an exception message.
 *
 * .reveal() is the explicit unwrap. The test suite enforces that no
 * source file interpolates a Secret value into a template literal via an
 * inline reveal call — reveal() is a speed bump after the value escapes
 * the wrapper, lint is the primary defense.
 */
export class Secret {
  constructor(private readonly value: string) {}
  reveal(): string {
    return this.value;
  }
  toString(): string {
    return '[Secret]';
  }
  toJSON(): string {
    return '[Secret]';
  }
  [Symbol.toPrimitive](): string {
    return '[Secret]';
  }
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return '[Secret]';
  }
}

export type OpErrorCode =
  | 'op_binary_missing'
  | 'op_token_invalid'
  | 'creds_missing';

export class OpError extends Error {
  constructor(public readonly code: OpErrorCode, message: string) {
    super(message);
    this.name = 'OpError';
  }
}

function buildChildEnv(): Record<string, string> {
  const token = process.env.OP_SERVICE_ACCOUNT_TOKEN;
  if (!token) {
    throw new OpError(
      'op_token_invalid',
      'OP_SERVICE_ACCOUNT_TOKEN not set in container env.',
    );
  }
  const childEnv: Record<string, string> = {
    OP_SERVICE_ACCOUNT_TOKEN: token,
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
  };
  if (process.env.HOME) childEnv.HOME = process.env.HOME;
  if (process.env.OP_CONFIG_DIR) childEnv.OP_CONFIG_DIR = process.env.OP_CONFIG_DIR;
  if (process.env.OP_ACCOUNT) childEnv.OP_ACCOUNT = process.env.OP_ACCOUNT;
  return childEnv;
}

function mapOpError(err: any): OpError {
  if (err?.code === 'ENOENT') {
    return new OpError('op_binary_missing', 'op CLI not in container. Rebuild image.');
  }
  const stderr = String(err?.stderr ?? '');
  if (/UNAUTHORIZED|unauthorized|authentication required/i.test(stderr)) {
    return new OpError(
      'op_token_invalid',
      'op service-account token expired or wrong scope. Rotate mcp-amazon-cart-op-token.',
    );
  }
  if (/not found|does not exist|no item/i.test(stderr)) {
    // Path omitted from message — non-secret, but reveals vault structure.
    return new OpError('creds_missing', '1P path resolved no item.');
  }
  return new OpError('op_token_invalid', 'op read failed with unknown error');
}

/**
 * Read a secret value from 1Password. Path is `op://Vault/Item/field`.
 * Returns a Secret wrapper — call .reveal() ONLY at the call site that
 * passes the value to its consumer (page.fill, URLSearchParams.set).
 */
export async function opRead(path: string): Promise<Secret> {
  const childEnv = buildChildEnv();
  try {
    const { stdout } = await execFileP('op', ['read', path], {
      env: childEnv,
      // stdio default is fine; execFile collects stdout/stderr into strings.
      timeout: 15_000,
    });
    return new Secret(stdout.trim());
  } catch (err: any) {
    throw mapOpError(err);
  }
}

/**
 * Read a TOTP one-time code. `op read --otp op://...` returns the current
 * 6-digit code on stdout. The CLI does NOT expose the remaining-window TTL;
 * callers compute it client-side using the standard TOTP RFC 6238 30s window
 * (see TOTP_WINDOW_SECONDS in types.ts).
 */
export async function opReadOtp(path: string): Promise<Secret> {
  const childEnv = buildChildEnv();
  try {
    const { stdout } = await execFileP('op', ['read', '--otp', path], {
      env: childEnv,
      timeout: 15_000,
    });
    return new Secret(stdout.trim());
  } catch (err: any) {
    throw mapOpError(err);
  }
}

/**
 * Scrub a free-form string against a list of known secrets and known
 * Patchright/Playwright echo patterns. Run before any field that may
 * surface to audit, tool response, or Pushover.
 */
export function scrubMessage(raw: string, secrets: Secret[]): string {
  let scrubbed = raw;
  for (const s of secrets) {
    const v = s.reveal();
    if (v.length >= 4) {
      scrubbed = scrubbed.split(v).join('[REDACTED]');
    }
  }
  // Playwright/Patchright likes to echo input back into error messages.
  scrubbed = scrubbed.replace(/while typing "[^"]*"/g, 'while typing [REDACTED]');
  scrubbed = scrubbed.replace(/calling fill\("[^"]*"\)/g, 'calling fill("[REDACTED]")');
  return scrubbed;
}
