// Stop hook handler — Claude finished a turn.
//
// Ignored when detached. Behavior depends on auto_nudge_stop + interactive:
//   - auto_nudge_stop on  → auto-send prompt (bump nudge_count).
//   - auto_nudge_stop off + interactive on → ask user "Nudge?" (block until
//     response/timeout); on action/timeout → send prompt; on close → no-op.
//   - auto_nudge_stop off + interactive off → no-op.
//
// Per-watch duration check: if deadline reached, stop nudge, kill watchers,
// mark completed, but keep tmux alive (claude context preserved).

import { existsSync } from 'node:fs';
import type { StopEvent, AgentState, CdogConfig } from '../types.js';
import { loadState, mutateAgent } from '../state.js';
import { tmux, tmuxHasSession, tmuxSendText, localISO, parseDuration } from '../util.js';
import { logAgentEvent } from '../logger.js';
import { notify, notifyInteractive } from '../notify.js';
import { findBySession, reloadConfig, resolvePrompt } from './shared.js';
import { killLogWatcher, spawnLogWatcher } from '../logwatcher.js';
import { killPaneWatcher, spawnPaneWatcher } from '../panewatcher.js';
import { buildRecoverCommand, loadConfig } from '../config.js';
import { enableTmuxTitles } from '../terminal.js';

// ---- Death-loop detection defaults ----
const DEATH_LOOP_THRESHOLD = 8; // consecutive fast Stops → nuclear rebuild
const DEATH_LOOP_INTERVAL_MS = 120_000; // "fast" = within 2min of the previous Stop

export async function handleStop(ev: StopEvent): Promise<void> {
  const agent = findBySession(ev.session_id);
  if (!agent) return;
  if (agent.cdog_status !== 'watching') return;
  if (!tmuxHasSession(agent.tmux_session)) return;

  // Per-watch duration check: if deadline reached, stop nudging
  if (agent.per_watch_deadline && Date.now() >= agent.per_watch_deadline) {
    logAgentEvent(agent.name, `Stop → per_watch_duration reached, stopping auto-nudge`);
    // Kill watchers (stop monitoring)
    killLogWatcher(agent.name);
    killPaneWatcher(agent.name);
    // Mark completed but keep tmux alive
    mutateAgent(agent.name, (a) => {
      a.claude_status = 'completed';
      a.cdog_status = 'detached';
      a.stop_reason = 'completed';
      a.ended_at = localISO();
    });
    await notify(agent.name, 'max-run-reached', agent.name, `per_watch_duration reached → completed (tmux kept alive)`);
    return; // don't nudge
  }

  // Quota-exceeded wait: claude_status='pending' means a quota nudge is
  // scheduled for the reset time. Bail out entirely — DON'T auto-nudge (it
  // would just trigger 429 churn until reset) and DON'T flip status back to
  // 'running' (it's genuinely waiting for quota). Let the scheduled quota
  // timer resume claude at reset time. (Storm state clearing is not done here
  // at all — only stream/tool success or manual stop/restart/nudge clear it.)
  if (agent.claude_status === 'pending') {
    logAgentEvent(agent.name, `Stop → quota nudge pending, not nudging (waiting for reset)`);
    return;
  }

  if (agent.claude_status !== 'running') {
    logAgentEvent(agent.name, `Stop → claude_status was ${agent.claude_status}, marking running (user-recovered)`);
    mutateAgent(agent.name, (a) => {
      a.claude_status = 'running';
      a.stop_reason = null;
      a.ended_at = null;
    });
    // NOTE: do NOT clear rate_limit storm state here. A Stop event isn't a
    // recovery signal (could be a C-c mid-storm). Storm state is cleared only
    // by stream/tool success (logwatcher) or user takeover (stop/restart/nudge).
  }

  const cfg = reloadConfig(agent);
  const autoNudge = cfg?.watchdog?.auto_nudge_stop === true;
  const interactive = cfg?.notify?.interactive === true && cfg?.notify?.enabled === true;

  // ── Death-loop detection ──
  // A "death loop" = N consecutive Stops each within `interval` of the previous,
  // with no real success (stream/tool) in between. The logwatcher clears
  // fast_stop_count on REAL_SUCCESS_RE, so if claude is actually working the
  // counter never accumulates. Reaching the threshold means every nudge dies
  // instantly → nuclear rebuild (kill session + claude --resume + respawn
  // watchers). Backstops the 08:12→09:12 case (46 nudges, 58min wasted).
  const dlCfg = cfg?.watchdog?.death_loop;
  const dlThreshold = dlCfg?.threshold ?? DEATH_LOOP_THRESHOLD;
  const dlIntervalMs = parseDuration(dlCfg?.interval) || DEATH_LOOP_INTERVAL_MS;
  const nowMs = Date.now();
  const lastStopMs = agent.last_stop_at ? Date.parse(agent.last_stop_at) : 0;
  const prevCount = agent.fast_stop_count ?? 0;
  const isFast = lastStopMs > 0 && (nowMs - lastStopMs) < dlIntervalMs;
  const newCount = isFast ? prevCount + 1 : 1;
  mutateAgent(agent.name, (a) => {
    a.last_stop_at = new Date().toISOString();
    a.fast_stop_count = newCount;
  });
  if (newCount >= dlThreshold) {
    logAgentEvent(agent.name,
      `DEATH LOOP detected: ${newCount} fast Stops (threshold=${dlThreshold}, interval=${Math.round(dlIntervalMs / 1000)}s, no real success between) — nuclear rebuild`);
    await nuclearRebuild(agent);
    return;
  }

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

/**
 * Nuclear rebuild: kill the tmux session + respawn claude via `claude --resume`,
 * then respawn both watchers. Used when a death loop is detected (claude keeps
 * Stop-ing without progress — nudges are futile).
 *
 * Unlike rebuildClaudeInSession (stall + dead claude, shell alive), here claude
 * is still running but spinning, so we MUST kill the session to break the loop.
 * Watchers are killed too (pipe-pane/tail bound to the old session) and
 * respawned fresh against the new session.
 *
 * Failure path: if config/tmux fails, mark the agent `failed` + `detached` so
 * the user can intervene — never leave the agent in an ambiguous state.
 */
async function nuclearRebuild(agent: AgentState): Promise<void> {
  const session = agent.tmux_session;
  const sessionId = agent.session_id;

  // 1. Kill watchers (bound to old session/process)
  killLogWatcher(agent.name);
  killPaneWatcher(agent.name);

  // 2. Kill tmux session (kills the spinning claude inside)
  if (tmuxHasSession(session)) {
    try { tmux(['kill-session', '-t', session]); } catch { /* best effort */ }
  }

  // 3. Load config + build recover command (includes `cat md |` re-feed)
  let cfg: CdogConfig;
  let recoverCmd: string;
  try {
    if (!agent.config_path || !existsSync(agent.config_path)) {
      throw new Error('no config_path');
    }
    cfg = loadConfig(agent.config_path);
    recoverCmd = buildRecoverCommand(cfg, sessionId);
  } catch (e) {
    const msg = (e as Error).message;
    logAgentEvent(agent.name, `nuclear rebuild FAILED (config): ${msg}`);
    mutateAgent(agent.name, (a) => {
      a.claude_status = 'failed';
      a.cdog_status = 'detached';
      a.stop_reason = 'failed';
      a.fatal_error = `death-loop rebuild failed: ${msg}`;
      a.failed_at = localISO();
      a.ended_at = localISO();
      a.fast_stop_count = 0; // don't re-trigger on next Start
    });
    await notify(agent.name, 'agent-failed', agent.name, `Death-loop rebuild FAILED: ${msg}`);
    return;
  }

  // 4. New session with `claude --resume` (re-feeds md, resumes conversation)
  try {
    tmux(['new-session', '-d', '-s', session, '-c', cfg.cwd, recoverCmd]);
    enableTmuxTitles(session);
  } catch (e) {
    const msg = (e as Error).message;
    logAgentEvent(agent.name, `nuclear rebuild FAILED (tmux): ${msg}`);
    mutateAgent(agent.name, (a) => {
      a.claude_status = 'failed';
      a.cdog_status = 'detached';
      a.stop_reason = 'failed';
      a.fatal_error = `death-loop rebuild tmux failed: ${msg}`;
      a.failed_at = localISO();
      a.ended_at = localISO();
      a.fast_stop_count = 0;
    });
    await notify(agent.name, 'agent-failed', agent.name, `Death-loop rebuild FAILED (tmux): ${msg}`);
    return;
  }

  // 5. Update state: reset all transient counters, mark running
  mutateAgent(agent.name, (a) => {
    a.claude_status = 'running';
    a.cdog_status = 'watching';
    a.stop_reason = null;
    a.ended_at = null;
    a.fatal_error = null;
    a.failed_at = null;
    a.restart_count = (a.restart_count ?? 0) + 1;
    a.last_restart_at = localISO();
    a.fast_stop_count = 0;
    a.last_stop_at = null;
    a.api_error_count = 0;
    a.compact_in_progress = false;
    a.compact_sent_at = null;
    a.compact_pending_prompt = null;
  });

  // 6. Respawn watchers (fresh against the new session)
  const fresh = loadState()[agent.name];
  if (fresh) {
    spawnLogWatcher(fresh);
    spawnPaneWatcher(fresh);
  }

  logAgentEvent(agent.name,
    `nuclear rebuild complete: session=${session}, claude --resume ${sessionId.slice(0, 8)}, restart #${(agent.restart_count ?? 0) + 1}`);
  await notify(agent.name, 'agent-recovered', agent.name,
    `Death loop — rebuilt (claude --resume, restart #${(agent.restart_count ?? 0) + 1})`);
}
