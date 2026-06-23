// SessionEnd hook handler — Claude session exited.
//
// Ignored when detached. Determines final status:
//   - reason "compact" / "resume" → not a real exit, ignore.
//   - max_run deadline reached → completed (kill tmux session).
//   - reason "clear" → stopped (user manually cleared).
//   - otherwise → failed.

import type { SessionEndEvent } from '../types.js';
import { mutateAgent } from '../state.js';
import { tmuxHasSession, tmux, localISO } from '../util.js';
import { logAgentEvent } from '../logger.js';
import { notify } from '../notify.js';
import { findBySession } from './shared.js';

export async function handleSessionEnd(ev: SessionEndEvent): Promise<void> {
  const reason = ev.reason ?? '';
  if (reason === 'compact' || reason === 'resume') return;
  const agent = findBySession(ev.session_id);
  if (!agent) return;
  if (agent.cdog_status !== 'watching') return;

  const now = Date.now();
  let status: 'stopped' | 'failed' | 'completed' = reason === 'clear' ? 'stopped' : 'failed';

  if (agent.max_run_deadline && now >= agent.max_run_deadline) {
    status = 'completed';
    if (tmuxHasSession(agent.tmux_session)) {
      tmux(['kill-session', '-t', agent.tmux_session]);
      logAgentEvent(agent.name, 'SessionEnd: max_run reached, tmux session killed');
    }
  }

  mutateAgent(agent.name, (a) => {
    a.claude_status = status;
    a.stop_reason = status;
    a.ended_at = localISO();
  });
  logAgentEvent(agent.name, `SessionEnd (${reason}) → ${status}`);
  if (status === 'completed') {
    await notify(agent.name, 'max-run-reached', agent.name, `max_run reached → completed`);
  } else if (reason === 'clear') {
    await notify(agent.name, 'task-completed', agent.name, `Session ended (clear) → ${status}`);
  }
}
