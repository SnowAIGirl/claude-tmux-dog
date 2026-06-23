// cdog stop <name>  — sets cdog_status to 'detached'. Does NOT kill the tmux/claude process.
//                     cdog stops responding to hooks; claude keeps running.
// cdog stop all      — detach every agent.

import { loadState, mutateAgent } from '../state.js';
import { tmuxHasSession } from '../util.js';
import { logAgentEvent } from '../logger.js';
import { killLogWatcher } from '../logwatcher.js';
import { killPaneWatcher } from '../panewatcher.js';

/**
 * Detach an agent: cdog_status → 'detached'. The claude process is left running
 * in tmux untouched; cdog will ignore all subsequent hook events for it.
 * Also kills the log watcher subprocess (it will be respawned on `cdog restart`).
 */
export async function stopCommand(name: string): Promise<void> {
  const state = loadState();
  const agent = state[name];
  if (!agent) {
    console.error(`✗ agent not found: ${name}`);
    process.exit(1);
  }

  killLogWatcher(name);
  killPaneWatcher(name);
  mutateAgent(name, (a) => {
    a.cdog_status = 'detached';
  });
  logAgentEvent(name, 'detached (cdog stopped watching, claude left running)');

  const alive = tmuxHasSession(agent.tmux_session);
  console.log(
    `✓ ${name} detached — cdog no longer watching${alive ? ` (claude still running in ${agent.tmux_session})` : ''}`,
  );
}

/** `cdog stop all` — detach every agent. One failure doesn't stop the rest. */
export async function stopAll(): Promise<void> {
  const names = Object.keys(loadState()).sort();
  if (names.length === 0) {
    console.log('No agents to stop.');
    return;
  }
  for (const name of names) {
    try {
      await stopCommand(name);
    } catch (e) {
      console.error(`✗ ${name}: ${(e as Error).message}`);
    }
  }
}
