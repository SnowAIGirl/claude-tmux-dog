// state.json read/write helpers.
//
// Concurrency safety: all mutations go through withStateLock(), which uses
// an exclusive file lock (O_EXCL create on a .lock file) with spin-wait +
// timeout. This prevents lost updates when multiple cdog processes (e.g.
// `cdog notify` triggered by concurrent hooks) write state simultaneously.

import { readFileSync, writeFileSync, existsSync, openSync, closeSync, unlinkSync } from 'node:fs';
import type { AgentState, StateMap } from './types.js';
import { STATE_PATH, ensureCdogDir, CDOG_DIR } from './util.js';
import { join } from 'node:path';

const LOCK_PATH = join(CDOG_DIR, 'state.json.lock');
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_POLL_MS = 50;

/**
 * Acquire an exclusive lock on state.json via O_EXCL on a .lock file.
 * Spin-waits up to LOCK_TIMEOUT_MS. Throws on timeout.
 *
 * Returns a release function that MUST be called in a finally block.
 */
function acquireLock(): () => void {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let fd: number | null = null;

  while (fd === null) {
    try {
      // O_EXCL: fails if file already exists → atomic on POSIX.
      fd = openSync(LOCK_PATH, 'wx');
    } catch (e: any) {
      if (e.code !== 'EEXIST') throw e;
      if (Date.now() >= deadline) {
        // Stale lock heuristic: if the lock file is older than the timeout,
        // it's likely from a crashed process — remove it and retry once.
        try {
          const stat = readFileSync(LOCK_PATH, 'utf8');
          const lockAge = Date.now() - parseInt(stat, 10);
          if (lockAge > LOCK_TIMEOUT_MS) {
            unlinkSync(LOCK_PATH);
            continue;
          }
        } catch {
          // Can't read lock file — break the stale lock.
          try { unlinkSync(LOCK_PATH); } catch { /* ignore */ }
          continue;
        }
        throw new Error(`state.json lock timeout after ${LOCK_TIMEOUT_MS}ms`);
      }
      // Spin-wait.
      const start = Date.now();
      while (Date.now() - start < LOCK_POLL_MS) {
        // Busy-wait is fine for 50ms intervals.
      }
    }
  }

  // Write our PID + timestamp into the lock file for stale detection.
  writeFileSync(LOCK_PATH, String(Date.now()));

  return () => {
    try { closeSync(fd!); } catch { /* ignore */ }
    try { unlinkSync(LOCK_PATH); } catch { /* ignore */ }
  };
}

/**
 * Execute a function while holding the state lock.
 * The function receives the current state and returns the new state to persist.
 */
function withStateLock<T>(fn: (state: StateMap) => T): T {
  const release = acquireLock();
  try {
    const state = loadStateRaw();
    const result = fn(state);
    if (result !== undefined && typeof result === 'object') {
      saveStateRaw(result as StateMap);
    }
    return result;
  } finally {
    release();
  }
}

/** Load the full state map (empty if missing/corrupt). No locking. */
function loadStateRaw(): StateMap {
  if (!existsSync(STATE_PATH)) return {};
  try {
    const raw = readFileSync(STATE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as StateMap) : {};
  } catch {
    return {};
  }
}

/** Persist the full state map atomically (write to temp + rename). No locking. */
function saveStateRaw(state: StateMap): void {
  ensureCdogDir();
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

/** Load the full state map (empty if missing/corrupt). Public, read-only. */
export function loadState(): StateMap {
  return loadStateRaw();
}

/** Persist the full state map atomically. Public, use withStateLock for mutations. */
export function saveState(state: StateMap): void {
  const release = acquireLock();
  try {
    saveStateRaw(state);
  } finally {
    release();
  }
}

/** Get one agent's state, or undefined. */
export function getAgent(name: string): AgentState | undefined {
  return loadStateRaw()[name];
}

/** Upsert a single agent and persist. Lock-protected. */
export function upsertAgent(agent: AgentState): void {
  withStateLock((state) => {
    state[agent.name] = agent;
    return state;
  });
}

/**
 * Update a single agent via a mutator; persists the result.
 * Returns the new state or undefined if agent missing.
 * The mutator may either mutate `a` in place (return void) or return a replacement object.
 * Lock-protected against concurrent cdog processes.
 */
export function mutateAgent(
  name: string,
  fn: (a: AgentState) => AgentState | void,
): AgentState | undefined {
  const release = acquireLock();
  try {
    const state = loadStateRaw();
    const a = state[name];
    if (!a) return undefined;
    const ret = fn(a);
    state[name] = ret ?? a;
    saveStateRaw(state);
    return state[name];
  } finally {
    release();
  }
}

/** Remove an agent from state. Lock-protected. */
export function removeAgent(name: string): void {
  withStateLock((state) => {
    delete state[name];
    return state;
  });
}
