// cdog stop <name>  — sets cdog_status to 'detached'. Does NOT kill the tmux/claude process.
//                     cdog stops responding to hooks; claude keeps running.
// cdog stop all      — detach every agent.
//
// Optional `stop.abort_work` (cdog.json): when true AND claude is actively
// working (claude_status running/pending), send a single Esc to abort the
// in-progress turn and set claude_status='waiting' — the process stays alive
// (suspend, don't exit). Esc is used (not C-c) so the process isn't at risk of
// exiting; C-c is reserved for the recovery flow (breakToShell).

import { existsSync } from 'node:fs';
import { loadState, mutateAgent } from '../state.js';
import { tmuxHasSession, tmuxChecked, sleep } from '../util.js';
import { loadConfig } from '../config.js';
import { logAgentEvent, logSwallow } from '../logger.js';
import { killLogWatcher, clearQuotaNudge } from '../logwatcher.js';
import { killPaneWatcher } from '../panewatcher.js';
import type { AgentState, ClaudeStatus } from '../types.js';

/**
 * Resolve the raw `stop.abort_work` config value to its effective boolean.
 * DEFAULT TRUE: `cdog stop` aborts the in-progress turn unless explicitly
 * disabled with `stop.abort_work: false`. Only an explicit false opts out;
 * undefined (field absent / no config) and true both mean "abort".
 */
export function resolveAbortWork(raw: boolean | undefined): boolean {
  return raw !== false;
}

/** Read stop.abort_work from the agent's cdog.json, defaulting to true. */
function shouldAbortWork(agent: AgentState): boolean {
  let raw: boolean | undefined;
  if (agent.config_path && existsSync(agent.config_path)) {
    try {
      raw = loadConfig(agent.config_path).stop?.abort_work;
    } catch {
      /* fall through to default */
    }
  }
  return resolveAbortWork(raw);
}

/** claude is mid-turn (worth interrupting)? */
export function isWorking(status: ClaudeStatus): boolean {
  return status === 'running' || status === 'pending';
}

/**
 * Pure decision: should `cdog stop` send an Esc to abort claude's in-progress
 * turn? True only when the session is alive, abort_work is enabled, and claude
 * is actively working (running/pending). Extracted so the decision matrix is
 * unit-testable without tmux.
 */
export function decideAbort(opts: {
  abortWork: boolean;
  status: ClaudeStatus;
  sessionAlive: boolean;
}): boolean {
  return opts.sessionAlive && opts.abortWork && isWorking(opts.status);
}

/**
 * Detach an agent: cdog_status → 'detached'. The claude process is left running
 * in tmux untouched; cdog will ignore all subsequent hook events for it
 * (observe-only status recording still happens — see hooks/observe.ts).
 * Also kills the log watcher subprocess (it will be respawned on `cdog restart`).
 *
 * With stop.abort_work enabled and claude actively working, sends Esc to abort
 * the current turn. The process stays alive; claude_status is NOT set here —
 * the truthful Stop hook (detached observe path) flips it to 'waiting' once
 * claude actually goes idle, so a failed Esc leaves status at 'running' and a
 * repeated `cdog stop` will retry.
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
  clearQuotaNudge(name);

  const session = agent.tmux_session;
  const wantAbort = decideAbort({
    abortWork: shouldAbortWork(agent),
    status: agent.claude_status,
    sessionAlive: tmuxHasSession(session),
  });

  // Detach BEFORE the Esc so the interrupted turn's Stop hook lands in the
  // detached branch (→ waiting), not the watching branch (→ running).
  mutateAgent(name, (a) => {
    a.cdog_status = 'detached';
  });

  let confirmed = false;
  if (wantAbort) {
    // Esc×2 (200ms gap): a single Esc can land mid-tool and get consumed; the
    // second catches claude at a turn boundary. Esc on an idle prompt is
    // harmless, so over-sending is safe.
    try {
      tmuxChecked(['send-keys', '-t', session, 'Escape']);
      await sleep(200);
      tmuxChecked(['send-keys', '-t', session, 'Escape']);
    } catch (e) {
      logSwallow(name, 'stop abort (Esc)', e);
    }
    // VERIFY via the hook (the trusted source): the Esc-interrupted turn ends
    // → Stop hook → detached observe sets claude_status='waiting'. Poll for it.
    // If it doesn't flip, Esc didn't take — tell the user, don't lie.
    confirmed = await waitForClaudeStatus(name, 'waiting', 4000);
  }

  const alive = tmuxHasSession(session);
  if (wantAbort && confirmed) {
    logAgentEvent(name, 'detached + aborted in-progress turn (Esc×2); claude confirmed idle (waiting via Stop hook)');
    console.log(`✓ ${name} detached — in-progress turn aborted, claude suspended (waiting)${alive ? ` in ${session}` : ''}`);
  } else if (wantAbort && !confirmed) {
    logAgentEvent(name, 'detached; Esc×2 sent but could NOT confirm claude stopped (no Stop hook / still working) — status left as-is, retryable');
    console.log(`⚠ ${name} detached — Esc sent but could NOT confirm claude stopped within 4s; it may still be working. Re-run \`cdog stop ${name}\` to retry.`);
  } else {
    logAgentEvent(name, 'detached (cdog stopped watching, claude left as-is)');
    console.log(`✓ ${name} detached — cdog no longer watching${alive ? ` (claude still running in ${session})` : ''}`);
  }
}

/**
 * Poll state.json until claude_status === target, or timeout. Used by stop to
 * confirm (via the Stop hook) that claude actually went idle after Esc.
 */
async function waitForClaudeStatus(name: string, target: ClaudeStatus, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (loadState()[name]?.claude_status === target) return true;
    await sleep(250);
  }
  return false;
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
