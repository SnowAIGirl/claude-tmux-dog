// cdog drain <name>  — detach cdog WITHOUT interrupting claude's current turn.
// cdog drain all      — drain every agent.
//
// The graceful counterpart to `cdog stop`:
//   - stop  = Esc-abort the in-progress turn, then detach (abort_work default true).
//   - drain = detach NOW, let claude finish what it's working on, no Esc.
//
// cdog_status flips to 'detached' immediately (cdog stops acting), but hooks
// still flow: when claude's current turn ends naturally, the Stop hook fires
// and the detached observe path (hooks/observe.ts) sets claude_status='waiting'.
// No auto-nudge is sent while detached, so claude won't start a new turn — it
// coasts to a stop after the current task. No in-flight work is lost.

import { loadState, mutateAgent } from '../state.js';
import { tmuxHasSession } from '../util.js';
import { logAgentEvent } from '../logger.js';
import { killLogWatcher } from '../logwatcher.js';
import { killPaneWatcher } from '../panewatcher.js';

/**
 * Detach an agent without interrupting claude. claude keeps running its current
 * turn to completion; when it ends, the detached observe path records
 * claude_status='waiting'. Watchers are killed (respawned on `cdog restart`).
 *
 * NOTE: does NOT call clearQuotaNudge — that helper has a `pending→running`
 * side effect (meant for recovery) which would violate drain's "don't touch
 * claude_status" contract. The quota-nudge timer lives in the logwatcher
 * process, so killLogWatcher (process-group kill) already disposes of it.
 */
export async function drainCommand(name: string): Promise<void> {
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
    // Do NOT touch claude_status — claude is still working. The detached Stop
    // hook (observe) will flip it to 'waiting' when the current turn ends.
  });

  const alive = tmuxHasSession(agent.tmux_session);
  logAgentEvent(
    name,
    'drained (detached without interrupt; claude finishes current turn, observe sets waiting on Stop)',
  );
  console.log(
    `✓ ${name} drained — cdog detached, current turn will finish then idle (no interrupt)${alive ? ` in ${agent.tmux_session}` : ''}`,
  );
}

/** `cdog drain all` — drain every agent. One failure doesn't stop the rest. */
export async function drainAll(): Promise<void> {
  const names = Object.keys(loadState()).sort();
  if (names.length === 0) {
    console.log('No agents to drain.');
    return;
  }
  for (const name of names) {
    try {
      await drainCommand(name);
    } catch (e) {
      console.error(`✗ ${name}: ${(e as Error).message}`);
    }
  }
}
