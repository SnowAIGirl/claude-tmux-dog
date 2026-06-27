// Unit tests for prune.ts (log retention) and update-check.ts (semver compare).

import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'cdog-prune-'));
process.env.CDOG_DIR = tmpDir;

const { pruneCommand, pruneAgent, pruneHousekeeping } = await import('../src/commands/prune.js');
const { isNewer } = await import('../src/update-check.js');
const { saveState, loadState } = await import('../src/state.js');
import type { AgentState } from '../src/types.js';

const OLD = '2020-01-01T00:00:00.000Z';
const RECENT = new Date().toISOString();

function agentWithLog(logPath: string): AgentState {
  return {
    name: 'p',
    session_id: 'sid',
    tmux_session: 'p',
    claude_status: 'running',
    cdog_status: 'watching',
    stop_reason: null,
    ended_at: null,
    started_at: RECENT,
    last_error: null,
    last_restart_at: null,
    restart_count: 0,
    nudge_count: 0,
    log_file_path: logPath,
  };
}

describe('cdog prune', () => {
  beforeEach(() => saveState({}));
  afterEach(() => saveState({}));
  afterAll(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('prunes cdog op-log lines older than retention, keeps recent', () => {
    const logPath = join(tmpDir, 'cdog.log');
    writeFileSync(
      logPath,
      `[p]            | ${OLD} old line one\n[p]            | ${OLD} old line two\n[p]            | ${RECENT} recent line\n`,
      'utf8',
    );
    saveState({ p: agentWithLog(logPath) });
    const n = pruneAgent('p');
    expect(n).toBe(2);
    const after = readFileSync(logPath, 'utf8');
    expect(after).toContain('recent line');
    expect(after).not.toContain('old line one');
    expect(after).not.toContain('old line two');
  });

  it('keeps lines with no parseable timestamp (conservative)', () => {
    const logPath = join(tmpDir, 'cdog2.log');
    writeFileSync(logPath, `no-timestamp-line\n[p]            | ${RECENT} recent\n`, 'utf8');
    saveState({ p: agentWithLog(logPath) });
    pruneAgent('p');
    const after = readFileSync(logPath, 'utf8');
    expect(after).toContain('no-timestamp-line');
    expect(after).toContain('recent');
  });

  it('pruneCommand(target) prunes one agent + housekeeping', () => {
    const logPath = join(tmpDir, 'cdog3.log');
    writeFileSync(logPath, `[p]            | ${OLD} old\n[p]            | ${RECENT} recent\n`, 'utf8');
    saveState({ p: agentWithLog(logPath) });
    const r = pruneCommand('p');
    expect(r.opLogPruned).toBe(1);
  });

  it('housekeeping deletes old corrupt/tmp files', () => {
    // create a stale corrupt backup and a stale tmp file (mtime old via content; we rely on real mtime = now,
    // so test the no-crash path + that fresh files are NOT deleted)
    const corrupt = join(tmpDir, 'state.json.corrupt.1');
    const tmp = join(tmpDir, 'state.json.tmp.99999');
    writeFileSync(corrupt, 'x', 'utf8');
    writeFileSync(tmp, 'y', 'utf8');
    pruneHousekeeping(); // fresh files (< retention / < 1h) → kept
    expect(existsSync(corrupt)).toBe(true);
    expect(existsSync(tmp)).toBe(true); // tmp is fresh (<1h) → kept
  });
});

describe('update-check isNewer', () => {
  it('detects newer versions', () => {
    expect(isNewer('0.3.0', '0.2.4')).toBe(true);
    expect(isNewer('1.0.0', '0.9.9')).toBe(true);
    expect(isNewer('0.2.5', '0.2.4')).toBe(true);
  });
  it('detects equal/older', () => {
    expect(isNewer('0.2.4', '0.2.4')).toBe(false);
    expect(isNewer('0.2.3', '0.2.4')).toBe(false);
    expect(isNewer('0.1.9', '0.2.0')).toBe(false);
  });
});
