// Unit tests for `cdog drain` (WS: graceful stop).
//
// drain detaches cdog WITHOUT sending Esc — claude_status must be left
// untouched (claude keeps working); cdog_status becomes 'detached'.

import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'cdog-drain-'));
process.env.CDOG_DIR = tmpDir;

const { saveState, loadState } = await import('../src/state.js');
const { drainCommand } = await import('../src/commands/drain.js');
import type { AgentState } from '../src/types.js';

function makeAgent(status: AgentState['claude_status']): AgentState {
  return {
    name: 'drain-test',
    session_id: 'sid',
    tmux_session: 'drain-test',
    claude_status: status,
    cdog_status: 'watching',
    stop_reason: null,
    ended_at: null,
    started_at: new Date().toISOString(),
    last_error: null,
    last_restart_at: null,
    restart_count: 0,
    nudge_count: 0,
  };
}

describe('cdog drain', () => {
  beforeEach(() => saveState({ 'drain-test': makeAgent('running') }));
  afterEach(() => saveState({}));
  afterAll(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('detaches cdog but leaves claude_status untouched (no interrupt)', async () => {
    await drainCommand('drain-test');
    const a = loadState()['drain-test']!;
    expect(a.cdog_status).toBe('detached');
    expect(a.claude_status).toBe('running'); // still working — observe updates it later
  });

  it('does not change claude_status regardless of starting status', async () => {
    for (const s of ['running', 'pending', 'waiting'] as AgentState['claude_status'][]) {
      saveState({ 'drain-test': makeAgent(s) });
      await drainCommand('drain-test');
      expect(loadState()['drain-test']!.claude_status).toBe(s);
      expect(loadState()['drain-test']!.cdog_status).toBe('detached');
    }
  });
});
