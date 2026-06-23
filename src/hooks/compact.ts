// PreCompact + PostCompact hook handlers.
//
// PreCompact fires before context compaction starts.
//   - If cdog initiated this compact (compact_in_progress is true), just log it.
//   - If the user manually ran /compact, set the flag so PostCompact knows to
//     send a nudge afterwards.
//
// PostCompact fires after context compaction completes.
//   - This is the event-driven signal that /compact is done (no hardcoded delays).
//   - If cdog initiated the compact, send the pending nudge prompt.
//   - Clears compact_in_progress so watchers can resume normal monitoring.

import type { PreCompactEvent, PostCompactEvent } from '../types.js';
import { mutateAgent } from '../state.js';
import { tmuxHasSession, tmuxSendText } from '../util.js';
import { logAgentEvent } from '../logger.js';
import { notify } from '../notify.js';
import { findBySession, reloadConfig, resolvePrompt } from './shared.js';

export function handlePreCompact(ev: PreCompactEvent): void {
  const agent = findBySession(ev.session_id);
  if (!agent) return;
  if (agent.cdog_status !== 'watching') return;

  const trigger = ev.trigger ?? 'unknown';
  logAgentEvent(agent.name, `PreCompact (trigger=${trigger}, cdog_initiated=${agent.compact_in_progress === true})`);

  if (trigger === 'manual' && !agent.compact_in_progress) {
    const cfg = reloadConfig(agent);
    const prompt = resolvePrompt(cfg);
    mutateAgent(agent.name, (a) => {
      a.compact_in_progress = true;
      a.compact_sent_at = new Date().toISOString();
      a.compact_pending_prompt = prompt;
    });
    logAgentEvent(agent.name, `PreCompact: user-initiated /compact detected, will nudge after PostCompact`);
  }
}

export async function handlePostCompact(ev: PostCompactEvent): Promise<void> {
  const agent = findBySession(ev.session_id);
  if (!agent) return;
  if (agent.cdog_status !== 'watching') return;

  const trigger = ev.trigger ?? 'unknown';
  logAgentEvent(agent.name, `PostCompact (trigger=${trigger})`);

  const pendingPrompt = agent.compact_pending_prompt;
  const wasCdogInitiated = agent.compact_in_progress === true;
  mutateAgent(agent.name, (a) => {
    a.compact_in_progress = false;
    a.compact_sent_at = null;
    a.compact_pending_prompt = null;
    a.api_error_count = 0;
  });

  if (wasCdogInitiated && pendingPrompt && tmuxHasSession(agent.tmux_session)) {
    tmuxSendText(agent.tmux_session, pendingPrompt, true);
    const next = (agent.nudge_count ?? 0) + 1;
    mutateAgent(agent.name, (a) => {
      a.nudge_count = next;
    });
    logAgentEvent(agent.name, `PostCompact → nudge #${next} ("${pendingPrompt}")`);
    await notify(agent.name, 'agent-recovered', agent.name, `Post-compact nudge #${next}`);
  }
}
