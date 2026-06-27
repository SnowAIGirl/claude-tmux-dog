// Observe-only path for detached agents.
//
// Claude Code hooks always fire — they're wired into ~/.claude/settings.json and
// invoked regardless of cdog's monitoring state. When an agent is detached
// (`cdog stop` → cdog_status = 'detached'), cdog must not ACT (no nudge, no
// recover, no notify, no watcher respawn / session kill). But it SHOULD still
// RECORD the truthful claude_status from these events; otherwise state.json
// drifts away from reality (e.g. claude dying while detached leaves status
// stuck on 'running', so `cdog status` lies and `cdog restart` can't tell it
// needs --resume).
//
// This module is the single source of truth for "what a detached agent's hooks
// mean". It is invoked from the hook dispatcher (hooks/index.ts) as an early
// short-circuit, so every event type is covered in one place.

import type { HookEvent } from '../types.js';
import type { AgentState } from '../types.js';
import { mutateAgent } from '../state.js';
import { localISO } from '../util.js';
import { logAgentEvent } from '../logger.js';

/**
 * Record the truthful claude_status implied by a hook event for a detached
 * agent. Zero side effects: no tmux keys, no notify, no watcher/kill, no
 * nudge. Safe to call for every event type.
 */
export function observeDetached(agent: AgentState, ev: HookEvent): void {
  const name = agent.name;
  switch (ev.hook_event_name) {
    case 'Stop':
      // Turn finished; claude is alive but idle at its prompt.
      mutateAgent(name, (a) => {
        a.claude_status = 'waiting';
      });
      logAgentEvent(name, 'Stop (detached) → claude idle (waiting); no nudge (hands-off)');
      break;

    case 'StopFailure': {
      const msg = ev.error ?? 'unknown stop failure';
      mutateAgent(name, (a) => {
        a.claude_status = 'failed';
        a.last_error = msg;
        a.failed_at = localISO();
      });
      logAgentEvent(name, `StopFailure (detached) → failed ("${msg}"); no recover (hands-off)`);
      break;
    }

    case 'SessionStart':
      // Claude (re)started — it's working again.
      mutateAgent(name, (a) => {
        a.claude_status = 'running';
      });
      logAgentEvent(name, 'SessionStart (detached) → running observed; no action (hands-off)');
      break;

    case 'UserPromptSubmit':
      // A prompt was submitted (turn starting) — claude is working, even though
      // cdog is detached. Record the truth; don't act on it.
      mutateAgent(name, (a) => {
        a.claude_status = 'running';
      });
      break;

    case 'SessionEnd': {
      // compact/resume are not real exits — claude continues underneath.
      const reason = ev.reason ?? '';
      if (reason === 'compact' || reason === 'resume') break;
      const status: 'stopped' | 'failed' = reason === 'clear' ? 'stopped' : 'failed';
      mutateAgent(name, (a) => {
        a.claude_status = status;
        a.stop_reason = status;
        a.ended_at = localISO();
      });
      logAgentEvent(name, `SessionEnd (detached, reason=${reason}) → ${status}; recorded only`);
      break;
    }

    case 'PreCompact':
      // Manual compacts while detached are the user's business — nothing to record.
      break;

    case 'PostCompact':
      // Clear any stale compact flag (pure cleanup). Never nudge while detached.
      mutateAgent(name, (a) => {
        if (a.compact_in_progress) {
          a.compact_in_progress = false;
          a.compact_sent_at = null;
          a.compact_pending_prompt = null;
        }
      });
      break;
  }
}
