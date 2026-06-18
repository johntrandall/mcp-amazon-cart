import { promises as fsp } from 'node:fs';
import fs from 'node:fs';
import path from 'node:path';
import {
  SESSION_HEALTH_AUDIT_RETENTION_DAYS,
  type ReturnAuditRecord,
  type SessionHealthAuditRecord,
} from './types';

// v1.0 returns audit lives next to the QR PNGs. Path semantics MUST stay
// identical to the inline writer at returns.ts ~line 869 (per-event JSON
// files with `${dateStr}-${account}-${return_id}.json`).
const RETURNS_DIR =
  process.env.RETURNS_AUDIT_DIR || '/var/lib/amazon-cart/returns';

// v1.1 session-health audit is a daily-rotated JSONL stream. Env-override
// lets the test harness redirect into tmpdir without root.
const SESSION_HEALTH_DIR =
  process.env.SESSION_HEALTH_AUDIT_DIR || '/var/lib/amazon-cart/session-health';

/**
 * mkdir -p with quiet fallback. Audit-write failure must never propagate
 * past this module — a tool that already succeeded on Amazon's side
 * cannot fail because we couldn't log it.
 */
async function ensureDir(dir: string): Promise<void> {
  try {
    await fsp.mkdir(dir, { recursive: true });
  } catch (err: any) {
    // ENOSPC / EACCES / EROFS — log and continue; the per-write fsp.writeFile
    // call below will hit the same condition and we'll surface to stderr
    // there instead of crashing the caller.
    process.stderr.write(
      `[audit-log] mkdir ${dir} failed: ${err?.code ?? err?.message ?? 'unknown'}\n`,
    );
  }
}

/**
 * v1.0 returns audit writer. Preserves the existing path semantics
 * (per-event JSON file). Caller supplies the filename so the existing
 * tests + skill expectations don't drift.
 */
export async function writeReturnEvent(
  filename: string,
  event: ReturnAuditRecord,
): Promise<void> {
  await ensureDir(RETURNS_DIR);
  const filePath = path.join(RETURNS_DIR, filename);
  try {
    await fsp.writeFile(filePath, JSON.stringify(event, null, 2));
  } catch (err: any) {
    process.stderr.write(
      `[audit-log] writeReturnEvent ${filePath} failed: ${err?.code ?? err?.message ?? 'unknown'}\n`,
    );
  }
}

function jsonlPathForDate(d: Date): string {
  const dateStr = d.toISOString().slice(0, 10);
  return path.join(SESSION_HEALTH_DIR, `audit-${dateStr}.log`);
}

/**
 * v1.1 session-health audit writer. Daily-rotated JSONL — one line per
 * event, append-only. Rotation triggers naturally on the dateStr changing
 * (midnight UTC). On ENOSPC / write failure, escalates to stderr and
 * swallows.
 */
export async function appendSessionHealthEvent(
  event: SessionHealthAuditRecord,
): Promise<void> {
  await ensureDir(SESSION_HEALTH_DIR);
  const filePath = jsonlPathForDate(new Date());
  try {
    await fsp.appendFile(filePath, JSON.stringify(event) + '\n');
  } catch (err: any) {
    process.stderr.write(
      `[audit-log] appendSessionHealthEvent ${filePath} failed: ` +
        `${err?.code ?? err?.message ?? 'unknown'}\n`,
    );
  }
}

/**
 * Synchronous module-load prune of session-health logs older than
 * SESSION_HEALTH_AUDIT_RETENTION_DAYS. Sync is fine — runs once at
 * boot, before any tools are wired up.
 *
 * The 14-day window is intentionally tighter than the 30-day proposal:
 * the JSONL records credential-rotation history, so a shorter window
 * beats a longer one in the hash-cracking timeline.
 */
export function pruneSessionHealthLogs(): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(SESSION_HEALTH_DIR, { withFileTypes: true });
  } catch (err: any) {
    if (err?.code !== 'ENOENT') {
      process.stderr.write(
        `[audit-log] pruneSessionHealthLogs readdir failed: ${err?.code ?? err?.message}\n`,
      );
    }
    return;
  }
  const cutoffMs = Date.now() - SESSION_HEALTH_AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith('audit-') || !entry.name.endsWith('.log')) {
      continue;
    }
    const full = path.join(SESSION_HEALTH_DIR, entry.name);
    try {
      const stat = fs.statSync(full);
      if (stat.mtimeMs < cutoffMs) {
        fs.unlinkSync(full);
      }
    } catch (err: any) {
      process.stderr.write(
        `[audit-log] prune ${full} failed: ${err?.code ?? err?.message}\n`,
      );
    }
  }
}

export const PATHS_FOR_TEST = { RETURNS_DIR, SESSION_HEALTH_DIR, jsonlPathForDate };
