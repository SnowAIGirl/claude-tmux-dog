// cdog restart <name>  — Re-watch a detached agent (never kills claude).
// cdog restart all      — Re-watch every detached agent.
//
// This is the counterpart to `cdog stop`:
//   - stop  → detach cdog (cdog_status = 'detached'), kill watchers
//   - restart → re-attach cdog (cdog_status = 'watching'), respawn watchers
//
// Never kills the claude process. Only manages cdog's monitoring state.

import { loadState, mutateAgent } from '../state.js';
import { tmuxHasSession } from '../util.js';
import { logAgentEvent } from '../logger.js';
import { spawnLogWatcher } from '../logwatcher.js';
import { spawnPaneWatcher } from '../panewatcher.js';
import { killLogWatcher } from '../logwatcher.js';
import { killPaneWatcher } from '../panewatcher.js';

/**
 * `cdog restart <name>` — re-watch a detached agent.
 *
 *   - Sets cdog_status back to 'watching'
 *   - Kills any existing watchers (in case they're orphaned)
 *   - Respawns fresh log + pane watchers
 *   - Never kills the claude process
 */
export async function restartCommand(name: string): Promise<void> {
  const state = loadState();
  const agent = state[name];
  if (!agent) {
    console.error(`✗ agent not found: ${name}`);
    process.exit(1);
  }

  const session = agent.tmux_session;
  if (!tmuxHasSession(session)) {
    console.error(`✗ ${name}: tmux session not running (${session})`);
    process.exit(1);
  }

  // Kill any existing watchers (in case they're orphaned)
  killLogWatcher(name);
  killPaneWatcher(name);

  // Re-attach cdog monitoring
  mutateAgent(name, (a) => {
    a.cdog_status = 'watching';
  });

  // Respawn watchers
  const freshAgent = loadState()[name]!;
  spawnLogWatcher(freshAgent);
  spawnPaneWatcher(freshAgent);

  logAgentEvent(name, `restart: re-watched (cdog_status=watching, watchers respawned)`);
  console.log(`✓ ${name} re-watched (watching)`);
}

/** `cdog restart all` — re-watch every agent. */
export async function restartAll(): Promise<void> {
  const names = Object.keys(loadState()).sort();
  if (names.length === 0) {
    console.log('No agents to restart.');
    return;
  }
  for (const name of names) {
    try {
      await restartCommand(name);
    } catch (e) {
      console.error(`✗ ${name}: ${(e as Error).message}`);
    }
  }
}
