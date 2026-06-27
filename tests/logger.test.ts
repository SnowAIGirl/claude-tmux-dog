// Unit tests for logger.ts — markDead status correction (WS-E #6).

import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'cdog-logger-'));
process.env.CDOG_DIR = tmpDir;

const { saveState, loadState } = await import('../src/state.js');
const { markDead } = await import('../src/logger.js');
import type { AgentState, ClaudeStatus } from '../src/types.js';

function makeAgent(status: ClaudeStatus): AgentState {
  return {
    name: 'dead-test',
    session_id: 'sid',
    tmux_session: 'dead-test',
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

describe('markDead (WS-E #6)', () => {
  beforeEach(() => saveState({ 'dead-test': makeAgent('running') }));
  afterEach(() => saveState({}));
  afterAll(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('flips every non-terminal status to stopped', () => {
    for (const s of ['running', 'pending', 'starting', 'waiting'] as ClaudeStatus[]) {
      saveState({ 'dead-test': makeAgent(s) });
      markDead('dead-test');
      const a = loadState()['dead-test']!;
      expect(a.claude_status).toBe('stopped');
      expect(a.stop_reason).toBe('stopped');
      expect(a.ended_at).not.toBeNull();
    }
  });

  it('does not touch already-terminal statuses', () => {
    for (const s of ['stopped', 'failed', 'completed'] as ClaudeStatus[]) {
      saveState({ 'dead-test': makeAgent(s) });
      markDead('dead-test');
      expect(loadState()['dead-test']!.claude_status).toBe(s);
    }
  });
});
