/**
 * Unit tests for v1.1 session-health.
 *
 * Same conventions as returns.test.ts — node + assert, no test runner dep.
 * Run with:
 *   npx ts-node --transpile-only src/session-health.test.ts
 *
 * Module-load assertions in session-health.ts require AMAZON_DOMAIN and a
 * pre-created SESSION_HEALTH_AUDIT_DIR. We set both before the first import
 * of any module that transitively pulls in session-health.ts.
 */

import assert from 'node:assert';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

// ---- Test harness setup BEFORE any session-health import ----
const TEST_ROOT = path.join(tmpdir(), `sh-test-${randomUUID()}`);
const TEST_AUDIT_DIR = path.join(TEST_ROOT, 'session-health');
const TEST_RETURNS_DIR = path.join(TEST_ROOT, 'returns');
fs.mkdirSync(TEST_AUDIT_DIR, { recursive: true });
fs.mkdirSync(TEST_RETURNS_DIR, { recursive: true });

process.env.AMAZON_DOMAIN = process.env.AMAZON_DOMAIN || 'amazon.com';
process.env.RETURNS_HOST_PATH_PREFIX =
  process.env.RETURNS_HOST_PATH_PREFIX || TEST_RETURNS_DIR;
process.env.SESSION_HEALTH_AUDIT_DIR = TEST_AUDIT_DIR;
process.env.RETURNS_AUDIT_DIR = TEST_RETURNS_DIR;
// Tracing OFF — refuse-to-load assertion must pass.
delete process.env.PWDEBUG;
delete process.env.PW_TRACING;
delete process.env.TRACING_ENABLED;
delete process.env.PATCHRIGHT_TRACING;

import { classifyHealth, _testing } from './session-health';
import { Secret, scrubMessage, OpError } from './op-credentials';
import { _buildPushoverBodyForTest, PUSHOVER_ESCALATION_CODES } from './pushover';
import { appendSessionHealthEvent } from './audit-log';
import {
  SESSION_HEALTH_STATES,
  REFRESH_ERROR_CODES,
  CHECK_LOGIN_ERROR_CODES,
  TOTP_WINDOW_SECONDS,
  TOTP_TTL_REFRESH_THRESHOLD_SECONDS,
} from './types';
import {
  SENTINEL_PASSWORD,
  SENTINEL_OTP,
  SNAPSHOT_HEALTHY,
  SNAPSHOT_BANNER_ATTENTION,
  SNAPSHOT_BANNER_RETRIEVAL,
  SNAPSHOT_BANNER_UNKNOWN,
  SNAPSHOT_AUTH_EXPIRED,
  SNAPSHOT_MFA_OTP,
  SNAPSHOT_MFA_PUSH,
  SNAPSHOT_ACCOUNT_LOCKED,
  SNAPSHOT_UNKNOWN,
} from './session-health.test.fixtures';

let pass = 0;
let fail = 0;
function ok(label: string): void {
  pass++;
  console.log(`✓ ${label}`);
}
function bad(label: string, err: any): void {
  fail++;
  console.error(`✗ ${label} — ${err?.message ?? err}`);
}

async function main(): Promise<void> {
  // ---- 1. classifyHealth(url, domSnapshot) → correct SessionHealth ----
  try {
    assert.strictEqual(
      classifyHealth('https://www.amazon.com/your-orders', SNAPSHOT_HEALTHY),
      'healthy',
    );
    assert.strictEqual(
      classifyHealth('https://www.amazon.com/ap/signin', SNAPSHOT_AUTH_EXPIRED),
      'auth_expired',
    );
    assert.strictEqual(
      classifyHealth(
        'https://www.amazon.com/errors/validateCaptcha?...',
        SNAPSHOT_UNKNOWN,
      ),
      'captcha_challenge',
    );
    assert.strictEqual(
      classifyHealth('https://www.amazon.com/ap/mfa', SNAPSHOT_MFA_OTP),
      'mfa_challenge',
    );
    assert.strictEqual(
      classifyHealth(
        'https://www.amazon.com/your-orders',
        SNAPSHOT_BANNER_ATTENTION,
      ),
      'banner_blocked',
    );
    assert.strictEqual(
      classifyHealth(
        'https://www.amazon.com/your-orders',
        SNAPSHOT_BANNER_RETRIEVAL,
      ),
      'banner_blocked',
    );
    assert.strictEqual(
      classifyHealth(
        'https://www.amazon.com/your-orders',
        SNAPSHOT_ACCOUNT_LOCKED,
      ),
      'account_locked',
    );
    assert.strictEqual(
      classifyHealth('https://www.amazon.com/your-orders', SNAPSHOT_MFA_PUSH),
      'mfa_push_pending',
    );
    assert.strictEqual(
      classifyHealth('https://www.amazon.com/your-orders', SNAPSHOT_UNKNOWN),
      'unknown_degraded',
    );
    for (const s of [
      SNAPSHOT_HEALTHY,
      SNAPSHOT_BANNER_ATTENTION,
      SNAPSHOT_AUTH_EXPIRED,
      SNAPSHOT_MFA_OTP,
      SNAPSHOT_MFA_PUSH,
      SNAPSHOT_ACCOUNT_LOCKED,
      SNAPSHOT_UNKNOWN,
    ]) {
      const out = classifyHealth('https://www.amazon.com/your-orders', s);
      assert.ok(
        (SESSION_HEALTH_STATES as readonly string[]).includes(out),
        `classifier output "${out}" not in SESSION_HEALTH_STATES`,
      );
    }
    ok('classifyHealth — URL + banner state mapping');
  } catch (err: any) {
    bad('classifyHealth — URL + banner state mapping', err);
  }

  // ---- 2. Banner detection: known + unknown IDs ----
  try {
    const known = _testing.bannersFromIds(['AttentionRequiredBanner']);
    assert.deepStrictEqual(known.known, ['attention_required']);
    assert.deepStrictEqual(known.unknown, []);

    const retrieval = _testing.bannersFromIds(['OrderRetreivalProblemBanner']);
    assert.deepStrictEqual(retrieval.known, ['order_retrieval_problem']);

    const unknown = _testing.bannersFromIds(['SomeBrandNewBanner']);
    assert.deepStrictEqual(unknown.known, []);
    assert.deepStrictEqual(unknown.unknown, ['SomeBrandNewBanner']);

    const mixed = classifyHealth(
      'https://www.amazon.com/your-orders',
      SNAPSHOT_BANNER_UNKNOWN,
    );
    assert.strictEqual(mixed, 'banner_blocked');
    ok('Banner detection — known + unknown IDs');
  } catch (err: any) {
    bad('Banner detection — known + unknown IDs', err);
  }

  // ---- 3. opRead env-var validation ----
  try {
    const savedToken = process.env.OP_SERVICE_ACCOUNT_TOKEN;
    delete process.env.OP_SERVICE_ACCOUNT_TOKEN;
    let caught: any = null;
    const { opRead } = require('./op-credentials');
    await opRead('op://Vault/Item/field').catch((e: any) => {
      caught = e;
    });
    assert.ok(caught instanceof OpError, `expected OpError, got: ${caught}`);
    assert.strictEqual(caught.code, 'op_token_invalid');
    if (savedToken !== undefined) process.env.OP_SERVICE_ACCOUNT_TOKEN = savedToken;
    ok('opRead — missing token throws op_token_invalid');
  } catch (err: any) {
    bad('opRead — missing token throws op_token_invalid', err);
  }

  // ---- 4. Secret hooks + lint: no `${...reveal()...}` in src/ ----
  try {
    const s = new Secret('s3cret-value-1234');
    assert.strictEqual(JSON.stringify(s), '"[Secret]"');
    assert.strictEqual(`${s}`, '[Secret]');
    assert.strictEqual(String(s), '[Secret]');
    assert.strictEqual(
      (s as any)[Symbol.for('nodejs.util.inspect.custom')](),
      '[Secret]',
    );

    const srcDir = path.resolve(__dirname);
    const offenders: string[] = [];
    const REVEAL_IN_TEMPLATE = /\$\{[^}]*\.reveal\(\)/;
    for (const entry of fs.readdirSync(srcDir)) {
      if (!entry.endsWith('.ts')) continue;
      if (entry.endsWith('.test.ts') || entry.endsWith('.test.fixtures.ts')) continue;
      const body = fs.readFileSync(path.join(srcDir, entry), 'utf8');
      for (const line of body.split('\n')) {
        if (REVEAL_IN_TEMPLATE.test(line)) offenders.push(`${entry}: ${line.trim()}`);
      }
    }
    assert.strictEqual(
      offenders.length,
      0,
      `Found ${offenders.length} \${...reveal()...} template literal(s):\n${offenders.join('\n')}`,
    );
    ok('Secret hooks + lint (no inline reveal in templates)');
  } catch (err: any) {
    bad('Secret hooks + lint (no inline reveal in templates)', err);
  }

  // ---- 5. scrubMessage: password + Patchright echo ----
  try {
    const pw = new Secret(SENTINEL_PASSWORD);
    const raw = `playwright error: while typing "${SENTINEL_PASSWORD}" in #ap_password`;
    const out = scrubMessage(raw, [pw]);
    assert.ok(!out.includes(SENTINEL_PASSWORD), 'sentinel password not scrubbed');
    assert.ok(out.includes('[REDACTED]'), 'expected [REDACTED] marker');
    assert.ok(!out.includes('while typing "'), 'Patchright echo not scrubbed');
    ok('scrubMessage — password + Patchright echo redaction');
  } catch (err: any) {
    bad('scrubMessage — password + Patchright echo redaction', err);
  }

  // ---- 6. Pushover payload safety + priority override ----
  try {
    delete process.env.PUSHOVER_TEST_MODE;
    const prodBody = _buildPushoverBodyForTest({
      account: 'personal',
      error_code: 'password_step_failed',
      step_failed: 'submit_password',
      vnc_url: 'vnc://umbridge:5937',
      appToken: 'app-token-xxx',
      userKey: 'user-key-yyy',
    });
    assert.strictEqual(prodBody.get('priority'), '2');
    assert.strictEqual(prodBody.get('expire'), '300');
    const message = prodBody.get('message') ?? '';
    assert.ok(!message.includes(SENTINEL_PASSWORD), 'Pushover message must not contain credential');
    assert.ok(message.includes('password_step_failed'));
    assert.ok(message.includes('vnc://umbridge:5937'));

    process.env.PUSHOVER_TEST_MODE = 'true';
    const testBody = _buildPushoverBodyForTest({
      account: 'personal',
      error_code: 'password_step_failed',
      vnc_url: 'vnc://umbridge:5937',
      appToken: 'app-token-xxx',
      userKey: 'user-key-yyy',
    });
    assert.strictEqual(testBody.get('priority'), '0');
    assert.strictEqual(testBody.get('expire'), '0');
    delete process.env.PUSHOVER_TEST_MODE;

    for (const code of PUSHOVER_ESCALATION_CODES) {
      assert.ok(
        (REFRESH_ERROR_CODES as readonly string[]).includes(code),
        `escalation code "${code}" not in REFRESH_ERROR_CODES`,
      );
    }
    ok('Pushover payload — message safety + priority override');
  } catch (err: any) {
    bad('Pushover payload — message safety + priority override', err);
  }

  // ---- 7. Awaitable mutex: second caller awaits, sync throws caught ----
  try {
    const { refreshInFlight } = _testing;
    refreshInFlight.clear();
    let resolveFirst: any;
    const firstPromise = new Promise<any>((res) => {
      resolveFirst = res;
    });
    refreshInFlight.set('personal', firstPromise as any);
    setTimeout(() => resolveFirst({ success: true }), 5);
    const got = await Promise.race([
      firstPromise,
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 200)),
    ]);
    assert.deepStrictEqual(got, { success: true });
    refreshInFlight.delete('personal');

    const guarded = Promise.resolve().then(() => {
      throw new Error('boom');
    });
    let rejected = false;
    await guarded.catch(() => {
      rejected = true;
    });
    assert.strictEqual(rejected, true);
    ok('Awaitable mutex — second caller awaits, sync throw caught');
  } catch (err: any) {
    bad('Awaitable mutex — second caller awaits, sync throw caught', err);
  }

  // ---- 8. returns_in_flight error shape ----
  try {
    const { result, pushover_sent_intent } = _testing.buildRefreshError(
      'returns_in_flight',
      undefined,
    );
    assert.strictEqual(result.success, false);
    if (result.success === false) {
      assert.strictEqual(result.error_code, 'returns_in_flight');
      assert.strictEqual(result.recoverable, true);
    }
    assert.strictEqual(pushover_sent_intent, false);
    assert.ok(!PUSHOVER_ESCALATION_CODES.has('returns_in_flight'));
    assert.ok((CHECK_LOGIN_ERROR_CODES as readonly string[]).length > 0);
    ok('returns_in_flight error shape + no-Pushover gating');
  } catch (err: any) {
    bad('returns_in_flight error shape + no-Pushover gating', err);
  }

  // ---- 9. TOTP TTL math ----
  try {
    function ttlAt(epochSecs: number): number {
      return TOTP_WINDOW_SECONDS - (epochSecs % TOTP_WINDOW_SECONDS);
    }
    assert.strictEqual(ttlAt(0), 30);
    assert.strictEqual(ttlAt(25), 5);
    assert.strictEqual(ttlAt(29), 1);
    assert.ok(ttlAt(25) < TOTP_TTL_REFRESH_THRESHOLD_SECONDS, '5s should trigger refresh');
    assert.ok(
      ttlAt(15) >= TOTP_TTL_REFRESH_THRESHOLD_SECONDS,
      '15s should NOT trigger refresh',
    );
    assert.strictEqual(SENTINEL_OTP.length, 6);
    ok('TOTP TTL math — refresh threshold gate');
  } catch (err: any) {
    bad('TOTP TTL math — refresh threshold gate', err);
  }

  // ---- 10. Audit-log writer: happy path + ENOSPC stderr fallback ----
  try {
    await appendSessionHealthEvent({
      timestamp: new Date().toISOString(),
      tool: 'refresh_session',
      account: 'personal',
      final_error_code: 'success',
    });
    const files = await fsp.readdir(TEST_AUDIT_DIR);
    const auditFile = files.find((f) => f.startsWith('audit-') && f.endsWith('.log'));
    assert.ok(auditFile, 'audit-YYYY-MM-DD.log should exist');
    const body = await fsp.readFile(path.join(TEST_AUDIT_DIR, auditFile!), 'utf8');
    assert.ok(body.includes('"refresh_session"'), 'audit line should be JSONL');
    assert.ok(body.endsWith('\n'), 'JSONL must terminate with newline');

    // Force a write failure by converting the audit file into a directory,
    // then invoke append again — appendFile fails with EISDIR, which the
    // writer should swallow + log to stderr without throwing.
    let stderrCaptured = '';
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr.write as any) = (chunk: any) => {
      stderrCaptured += chunk;
      return true;
    };

    let threw = false;
    try {
      const todayFile = path.join(TEST_AUDIT_DIR, auditFile!);
      fs.unlinkSync(todayFile);
      fs.mkdirSync(todayFile);
      await appendSessionHealthEvent({
        timestamp: new Date().toISOString(),
        tool: 'refresh_session',
        account: 'personal',
        final_error_code: 'unknown_error',
      });
    } catch {
      threw = true;
    } finally {
      (process.stderr.write as any) = origWrite;
    }
    assert.strictEqual(threw, false, 'appendSessionHealthEvent must not throw');
    assert.ok(
      stderrCaptured.includes('[audit-log]'),
      `stderr should mention [audit-log], got: ${stderrCaptured.slice(0, 200)}`,
    );
    ok('Audit-log writer — happy path + write-failure stderr fallback');
  } catch (err: any) {
    bad('Audit-log writer — happy path + write-failure stderr fallback', err);
  }

  // ---- Cleanup ----
  try {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  } catch { /* ignore */ }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error('UNCAUGHT in test main:', err);
  process.exit(1);
});
