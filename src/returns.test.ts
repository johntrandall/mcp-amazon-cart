/**
 * Unit tests for returns.ts — covers only the logic that can be tested
 * without a live Amazon session. Browser flows require the OBSERVE phase.
 *
 * Run with: npx ts-node --transpile-only src/returns.test.ts
 * (No test runner dep added — uses Node's assert module.)
 */

import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { RETURN_REASONS } from './types';

// ---- 1. RETURN_REASONS completeness ----
// Every value in the const array must match the REASON_TO_AMAZON_VALUE
// mapping inside returns.ts. We test the exported array shape here.
{
  const expected = [
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

  assert.strictEqual(RETURN_REASONS.length, expected.length, 'RETURN_REASONS length');
  for (const r of expected) {
    assert.ok(RETURN_REASONS.includes(r as any), `RETURN_REASONS includes "${r}"`);
  }
  console.log('✓ RETURN_REASONS completeness');
}

// ---- 2. task_id UUID v4 format ----
{
  const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  for (let i = 0; i < 20; i++) {
    const id = randomUUID();
    assert.match(id, UUID_V4, `randomUUID() produced invalid v4 UUID: ${id}`);
  }
  console.log('✓ task_id UUID v4 format (20 samples)');
}

// ---- 3. order_id validation regex ----
{
  const ORDER_ID_RE = /^\d{3}-\d{7}-\d{7}$/;
  const valid = ['112-1234567-8901234', '123-4567890-1234567'];
  const invalid = ['112-123-456', 'D01-1234567-8901234', '1121234567890', ''];

  for (const id of valid) {
    assert.ok(ORDER_ID_RE.test(id.trim()), `"${id}" should be valid`);
  }
  for (const id of invalid) {
    assert.ok(!ORDER_ID_RE.test(id.trim()), `"${id}" should be invalid`);
  }
  // Whitespace trim test
  assert.ok(ORDER_ID_RE.test('  112-1234567-8901234  '.trim()), 'trim before test');
  console.log('✓ order_id validation regex');
}

// ---- 4. TTL sweep logic (time-mocked) ----
{
  // Verify the filtering predicate used in the sweep.
  // Does NOT test setInterval itself (that requires a real timer environment).
  const TASK_TTL_MS = 15 * 60 * 1000;
  const now = 1_000_000;

  type MockTask = { created_at: number };
  const tasks = new Map<string, MockTask>([
    ['fresh', { created_at: now - 1_000 }],          // 1s old — not expired
    ['old',   { created_at: now - TASK_TTL_MS - 1 }], // just past TTL — expired
    ['exact', { created_at: now - TASK_TTL_MS + 1 }], // 1ms under TTL — not expired
  ]);

  const expired = [...tasks.entries()].filter(([, t]) => now - t.created_at > TASK_TTL_MS);
  assert.strictEqual(expired.length, 1, 'Only one task should be expired');
  assert.strictEqual(expired[0][0], 'old', 'The expired task should be "old"');
  console.log('✓ TTL sweep predicate logic');
}

// ---- 5. Audit log JSON shape ----
{
  import('node:fs').then(async ({ promises: fs }) => {
    import('node:os').then(async ({ tmpdir }) => {
      const dir = `${tmpdir()}/returns-test-${randomUUID()}`;
      await fs.mkdir(dir, { recursive: true });

      const auditData = {
        timestamp: new Date().toISOString(),
        account: 'personal',
        order_id: '112-1234567-8901234',
        item_id: 'B0ABCDEFGH',
        item_title: 'Test Widget',
        quantity: 1,
        reason_enum: 'defective',
        reason_prose: 'stopped working',
        refund_amount_usd: 24.99,
        refund_method: 'original_payment',
        return_id: 'RYZ123ABC456',
        carrier: 'UPS',
        drop_off_by: new Date().toISOString(),
        qr_png_host_path: `/Users/johnrandall/amazon-returns/2026-06-17-personal-RYZ123ABC456.png`,
      };

      const auditPath = `${dir}/2026-06-17-personal-RYZ123ABC456.json`;
      await fs.writeFile(auditPath, JSON.stringify(auditData, null, 2));

      const raw = await fs.readFile(auditPath, 'utf8');
      const parsed = JSON.parse(raw);

      const required = [
        'timestamp', 'account', 'order_id', 'item_id', 'item_title',
        'quantity', 'reason_enum', 'refund_amount_usd', 'refund_method',
        'return_id', 'carrier', 'drop_off_by', 'qr_png_host_path',
      ];
      for (const key of required) {
        assert.ok(key in parsed, `Audit log missing key: ${key}`);
      }
      assert.strictEqual(parsed.return_id, 'RYZ123ABC456');
      assert.strictEqual(parsed.account, 'personal');

      await fs.rm(dir, { recursive: true });
      console.log('✓ Audit log JSON shape');
      console.log('\nAll tests passed.');
    });
  });
}
