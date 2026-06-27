// Unit tests for hook dispatch — WS-B detached observe-only.
//
// When cdog_status === 'detached', hooks must not ACT (no nudge/recover/notify)
// but must still RECORD the truthful claude_status. Each test seeds a detached
// agent and asserts the status written, with no watching-mode side effects.

import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'cdog-hook-'));
process.env.CDOG_DIR = tmpDir;

const { saveState, loadState } = await import('../src/state.js');
const { notifyCommand } = await import('../src/hooks/index.js');
import type { AgentState } from '../src/types.js';

const SID = 'sid-detached';

function makeDetached(overrides: Partial<AgentState> = {}): AgentState {
  return {
    name: 'detached-agent',
    session_id: SID,
    tmux_session: 'detached-agent',
    claude_status: 'running',
    cdog_status: 'detached',
    stop_reason: null,
    ended_at: null,
    started_at: new Date().toISOString(),
    last_error: null,
    last_restart_at: null,
    restart_count: 0,
    nudge_count: 0,
    ...overrides,
  };
}

function ev(obj: Record<string, unknown>): string {
  return JSON.stringify(obj);
}

function agent(): AgentState {
  return loadState()['detached-agent']!;
}

describe('hook dispatch — detached observe-only (WS-B)', () => {
  beforeEach(() => {
    saveState({ 'detached-agent': makeDetached() });
  });
  afterEach(() => {
    saveState({});
  });
  afterAll(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('Stop → claude idle (waiting), no nudge', async () => {
    await notifyCommand(ev({ session_id: SID, hook_event_name: 'Stop' }));
    expect(agent().claude_status).toBe('waiting');
    expect(agent().nudge_count).toBe(0); // no nudge fired
  });

  it('UserPromptSubmit (detached) → running observed, no action', async () => {
    saveState({ 'detached-agent': makeDetached({ claude_status: 'waiting' }) });
    await notifyCommand(ev({ session_id: SID, hook_event_name: 'UserPromptSubmit', prompt: 'continue' }));
    expect(agent().claude_status).toBe('running');
  });

  it('UserPromptSubmit (watching) → running (turn-start signal)', async () => {
    saveState({ 'detached-agent': makeDetached({ cdog_status: 'watching', claude_status: 'waiting' }) });
    await notifyCommand(ev({ session_id: SID, hook_event_name: 'UserPromptSubmit', prompt: 'go' }));
    expect(agent().claude_status).toBe('running');
  });

  it('SessionStart → running observed', async () => {
    saveState({ 'detached-agent': makeDetached({ claude_status: 'waiting' }) });
    await notifyCommand(ev({ session_id: SID, hook_event_name: 'SessionStart' }));
    expect(agent().claude_status).toBe('running');
  });

  it('SessionEnd (clear) → stopped + ended_at recorded', async () => {
    await notifyCommand(ev({ session_id: SID, hook_event_name: 'SessionEnd', reason: 'clear' }));
    const a = agent();
    expect(a.claude_status).toBe('stopped');
    expect(a.stop_reason).toBe('stopped');
    expect(a.ended_at).not.toBeNull();
  });

  it('SessionEnd (no reason) → failed recorded', async () => {
    await notifyCommand(ev({ session_id: SID, hook_event_name: 'SessionEnd' }));
    expect(agent().claude_status).toBe('failed');
    expect(agent().stop_reason).toBe('failed');
  });

  it('SessionEnd (compact/resume) → NOT a real exit, status unchanged', async () => {
    await notifyCommand(ev({ session_id: SID, hook_event_name: 'SessionEnd', reason: 'compact' }));
    expect(agent().claude_status).toBe('running'); // unchanged
    expect(agent().ended_at).toBeNull();
  });

  it('StopFailure → failed + last_error, no recover', async () => {
    await notifyCommand(
      ev({ session_id: SID, hook_event_name: 'StopFailure', error: 'boom' }),
    );
    const a = agent();
    expect(a.claude_status).toBe('failed');
    expect(a.last_error).toBe('boom');
    expect(a.restart_count).toBe(0); // no auto-recover
  });

  it('PostCompact → clears stale compact flag, no nudge', async () => {
    saveState({
      'detached-agent': makeDetagedWithCompact(),
    });
    await notifyCommand(ev({ session_id: SID, hook_event_name: 'PostCompact' }));
    const a = agent();
    expect(a.compact_in_progress).toBe(false);
    expect(a.compact_pending_prompt).toBeNull();
    expect(a.nudge_count).toBe(0); // no post-compact nudge while detached
  });

  it('watching agent is NOT short-circuited (observe-only is detached-only)', async () => {
    saveState({ 'detached-agent': makeDetached({ cdog_status: 'watching' }) });
    // Stop on a watching agent with no auto-nudge: handler sets running (its
    // watching-mode semantic), NOT waiting — proves the detached path didn't run.
    await notifyCommand(ev({ session_id: SID, hook_event_name: 'Stop' }));
    expect(agent().claude_status).toBe('running');
  });
});

function makeDetagedWithCompact(): AgentState {
  return makeDetached({
    compact_in_progress: true,
    compact_sent_at: new Date().toISOString(),
    compact_pending_prompt: 'continue',
  });
}
