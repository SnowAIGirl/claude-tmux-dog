// Shared helpers for hook event handlers.
//
// These are extracted from the original commands/notify.ts to allow each
// handler (stop, stop-failure, session-end, compact) to be in its own file
// without duplicating utility code.

import { existsSync, readFileSync } from 'node:fs';
import type { AgentState, CdogConfig, HookEvent } from '../types.js';
import { loadState } from '../state.js';
import { loadConfig } from '../config.js';

/** Read the hook event JSON from argv or stdin. */
export function readEvent(argJson?: string): HookEvent | null {
  let raw = argJson;
  if (!raw) {
    try {
      raw = readFileSync(0, 'utf8');
    } catch {
      return null;
    }
  }
  raw = raw.trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw) as HookEvent;
  } catch {
    return null;
  }
}

/** Find an agent in state by session_id. */
export function findBySession(sessionId: string): AgentState | undefined {
  const state = loadState();
  return Object.values(state).find((a) => a.session_id === sessionId);
}

/** Reload the agent's cdog.json config (may have changed since start). */
export function reloadConfig(agent: AgentState): CdogConfig | null {
  if (!agent.config_path || !existsSync(agent.config_path)) return null;
  try {
    return loadConfig(agent.config_path);
  } catch {
    return null;
  }
}

/** Resolve the nudge prompt: config.prompt ?? "continue". */
export function resolvePrompt(cfg: CdogConfig | null): string {
  return cfg?.watchdog?.prompt?.trim() || 'continue';
}
