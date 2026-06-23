// cdog delete <name>  — if the agent is still running (watching or detached with a live
//                       tmux session), kill the tmux session, then remove the agent from state.
// cdog delete all      — delete every agent.

import { loadState, removeAgent } from '../state.js';
import { tmuxHasSession, tmux } from '../util.js';
import { logAgentEvent } from '../logger.js';
import { killLogWatcher } from '../logwatcher.js';
import { killPaneWatcher } from '../panewatcher.js';

export async function deleteCommand(name: string): Promise<void> {
  const agent = loadState()[name];
  if (!agent) {
    console.error(`✗ agent not found: ${name}`);
    process.exit(1);
  }

  killLogWatcher(name);
  killPaneWatcher(name);
  if (tmuxHasSession(agent.tmux_session)) {
    tmux(['kill-session', '-t', agent.tmux_session]);
    logAgentEvent(name, `tmux session killed`);
  }
  removeAgent(name);
  console.log(`✓ ${name} deleted`);
}

/** `cdog delete all` — delete every agent. One failure doesn't stop the rest. */
export async function deleteAll(): Promise<void> {
  const names = Object.keys(loadState()).sort();
  if (names.length === 0) {
    console.log('No agents to delete.');
    return;
  }
  for (const name of names) {
    try {
      await deleteCommand(name);
    } catch (e) {
      console.error(`✗ ${name}: ${(e as Error).message}`);
    }
  }
}
