// cdog prune [name|all] — trim cdog's OWN logs + ~/.cdog housekeeping to a
// retention window. Auto-runs on `cdog start` for that agent too.
//
// Does NOT touch claude's debug log (the --debug-file / config `log`) — claude
// manages its own log lifecycle. Only cleans cdog-owned artifacts:
//   - per-agent cdog op-log (log_file): keep lines newer than `log_retention`.
//   - ~/.cdog/state.json.corrupt.* : delete if mtime older than retention.
//   - ~/.cdog/state-corrupt.log     : keep lines newer than retention.
//   - ~/.cdog/state.json.tmp.*      : delete stale orphan temp files (>1h, from
//                                     crashed atomic writes).

import { existsSync, readFileSync, writeFileSync, readdirSync, unlinkSync, statSync } from 'node:fs';
import { loadState } from '../state.js';
import { loadConfig } from '../config.js';
import { CDOG_DIR, parseDuration } from '../util.js';
import { join } from 'node:path';

const DEFAULT_RETENTION = '7d';
/** Stale temp-file threshold (crashed atomic writes). Shorter than retention. */
const TMP_MAX_AGE_MS = 3600_000; // 1h

// ISO-8601 anywhere in a line (cdog op-log: "[name] | <ISO> msg").
const ISO_RE = /(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/;

function lineTimestampMs(line: string): number | null {
  const m = line.match(ISO_RE);
  if (!m) return null;
  const t = Date.parse(m[1]);
  return Number.isNaN(t) ? null : t;
}

interface PruneResult {
  opLogPruned: number;
  corruptDeleted: number;
  corruptLogPruned: number;
  tmpDeleted: number;
}

function emptyResult(): PruneResult {
  return { opLogPruned: 0, corruptDeleted: 0, corruptLogPruned: 0, tmpDeleted: 0 };
}

/**
 * Trim a log file to lines newer than cutoffMs (by per-line ISO timestamp).
 * Lines with no parseable timestamp are kept (conservative). Rewrites in place
 * — safe because no daemon continuously tails cdog's op-log.
 * Returns the number of lines removed.
 */
function pruneFileLines(path: string, cutoffMs: number): number {
  if (!existsSync(path)) return 0;
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return 0;
  }
  const lines = raw.split('\n');
  const kept: string[] = [];
  let pruned = 0;
  for (const line of lines) {
    if (line === '') continue;
    const t = lineTimestampMs(line);
    if (t !== null && t < cutoffMs) {
      pruned++;
      continue;
    }
    kept.push(line);
  }
  if (pruned > 0) {
    writeFileSync(path, kept.join('\n') + '\n', 'utf8');
  }
  return pruned;
}

/** Delete a file if its mtime is older than maxAgeMs. Returns true if deleted. */
function deleteIfOlder(path: string, maxAgeMs: number): boolean {
  try {
    const st = statSync(path);
    if (Date.now() - st.mtimeMs > maxAgeMs) {
      unlinkSync(path);
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

/** Resolve log_retention (ms) for an agent from its config; default 7d. */
function retentionMsFor(agentName?: string): number {
  if (agentName) {
    const a = loadState()[agentName];
    if (a?.config_path && existsSync(a.config_path)) {
      try {
        const r = loadConfig(a.config_path).log_retention;
        const ms = parseDuration(r);
        if (ms > 0) return ms;
      } catch {
        /* fall through to default */
      }
    }
  }
  return parseDuration(DEFAULT_RETENTION);
}

/** Prune one agent's cdog op-log. Returns lines pruned. */
export function pruneAgent(name: string): number {
  const a = loadState()[name];
  if (!a?.log_file_path) return 0;
  const cutoff = Date.now() - retentionMsFor(name);
  return pruneFileLines(a.log_file_path, cutoff);
}

/**
 * Prune ~/.cdog housekeeping: corrupt backups, corrupt-log, stale temp files.
 * Uses the default retention (corrupt/temp artifacts aren't per-project).
 */
export function pruneHousekeeping(): Pick<PruneResult, 'corruptDeleted' | 'corruptLogPruned' | 'tmpDeleted'> {
  const cutoff = Date.now() - parseDuration(DEFAULT_RETENTION);
  const result = { corruptDeleted: 0, corruptLogPruned: 0, tmpDeleted: 0 };

  let entries: string[];
  try {
    entries = readdirSync(CDOG_DIR);
  } catch {
    return result;
  }
  for (const entry of entries) {
    const full = join(CDOG_DIR, entry);
    if (/^state\.json\.corrupt\./.test(entry)) {
      if (deleteIfOlder(full, cutoff)) result.corruptDeleted++;
    } else if (/^state\.json\.tmp\./.test(entry)) {
      if (deleteIfOlder(full, TMP_MAX_AGE_MS)) result.tmpDeleted++;
    }
  }
  // state-corrupt.log: prune by line timestamp.
  const corruptLog = join(CDOG_DIR, 'state-corrupt.log');
  result.corruptLogPruned = pruneFileLines(corruptLog, cutoff);
  return result;
}

/** Prune one agent + housekeeping. */
export function pruneCommand(target?: string): PruneResult {
  const result = emptyResult();
  if (target && target !== 'all') {
    result.opLogPruned = pruneAgent(target);
  } else {
    for (const name of Object.keys(loadState()).sort()) {
      result.opLogPruned += pruneAgent(name);
    }
  }
  const hk = pruneHousekeeping();
  return { ...result, ...hk };
}
