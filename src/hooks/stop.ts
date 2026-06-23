// Stop hook handler — Claude finished a turn.
//
// Ignored when detached. Behavior depends on auto_nudge_stop + interactive:
//   - auto_nudge_stop on  → auto-send prompt (bump nudge_count).
//   - auto_nudge_stop off + interactive on → ask user "Nudge?" (block until
//     response/timeout); on action/timeout → send prompt; on close → no-op.
//   - auto_nudge_stop off + interactive off → no-op.

import type { StopEvent } from '../types.js';
import { mutateAgent } from '../state.js';
import { tmuxHasSession, tmuxSendText } from '../util.js';
import { logAgentEvent } from '../logger.js';
import { notify, notifyInteractive } from '../notify.js';
import { findBySession, reloadConfig, resolvePrompt } from './shared.js';

export async function handleStop(ev: StopEvent): Promise<void> {
  const agent = findBySession(ev.session_id);
  if (!agent) return;
  if (agent.cdog_status !== 'watching') return;
  if (!tmuxHasSession(agent.tmux_session)) return;

  if (agent.claude_status !== 'running') {
    logAgentEvent(agent.name, `Stop → claude_status was ${agent.claude_status}, marking running (user-recovered)`);
    mutateAgent(agent.name, (a) => {
      a.claude_status = 'running';
      a.stop_reason = null;
      a.ended_at = null;
    });
  }

  const cfg = reloadConfig(agent);
  const autoNudge = cfg?.watchdog?.auto_nudge_stop === true;
  const interactive = cfg?.notify?.interactive === true && cfg?.notify?.enabled === true;

  if (autoNudge) {
    const prompt = resolvePrompt(cfg);
    tmuxSendText(agent.tmux_session, prompt, true);
    const next = (agent.nudge_count ?? 0) + 1;
    mutateAgent(agent.name, (a) => {
      a.nudge_count = next;
    });
    logAgentEvent(agent.name, `Stop → nudge #${next} ("${prompt}")`);
    await notify(agent.name, 'nudge', agent.name, `Nudge #${next} ("${prompt}")`);
    return;
  }

  if (interactive) {
    const choice = await notifyInteractive(
      agent.name,
      'nudge',
      agent.name,
      'Agent stopped. Nudge it?',
      'Nudge',
      'Skip',
    );
    logAgentEvent(agent.name, `Stop → interactive ask: ${choice}`);
    if (choice === 'action' || choice === 'timeout') {
      const prompt = resolvePrompt(cfg);
      tmuxSendText(agent.tmux_session, prompt, true);
      const next = (agent.nudge_count ?? 0) + 1;
      mutateAgent(agent.name, (a) => {
        a.nudge_count = next;
      });
      logAgentEvent(agent.name, `Stop → nudge #${next} ("${prompt}") (${choice === 'timeout' ? 'timeout→auto' : 'user-approved'})`);
    }
    return;
  }
}
