// Passive update check for the published npm package.
//
// At most once per day, fetch the latest version from the npm registry, cache
// it in ~/.cdog/update-check.json, and if newer than the running version print
// a one-line hint to stderr. Never blocks for long (1.5s fetch timeout), never
// auto-installs, silent on failure/offline. Disable with CDOG_NO_UPDATE_CHECK=1.
//
// Only invoked from user-facing commands (start/stop/status/...), NOT from the
// hot internal paths (notify, __watch, __panewatch) where latency matters.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { CDOG_DIR } from './util.js';
import { join } from 'node:path';

const PKG_NAME = 'claude-tmux-dog';
const REGISTRY_URL = `https://registry.npmjs.org/${PKG_NAME}/latest`;
const CHECK_INTERVAL_MS = 24 * 3600_000; // once per day
const FETCH_TIMEOUT_MS = 1500;
const CACHE_PATH = join(CDOG_DIR, 'update-check.json');

interface UpdateCache {
  lastCheck: string; // ISO
  latest: string | null;
}

/** Disabled via env (global off switch — no per-project config for this). */
function isDisabled(): boolean {
  const v = process.env.CDOG_NO_UPDATE_CHECK;
  return v === '1' || v === 'true' || v === 'TRUE';
}

function readCache(): UpdateCache | null {
  try {
    const c = JSON.parse(readFileSync(CACHE_PATH, 'utf8'));
    if (typeof c?.lastCheck === 'string') return c as UpdateCache;
  } catch {
    /* missing/corrupt — treat as unchecked */
  }
  return null;
}

function writeCache(c: UpdateCache): void {
  try {
    if (!existsSync(CDOG_DIR)) mkdirSync(CDOG_DIR, { recursive: true });
    writeFileSync(CACHE_PATH, JSON.stringify(c, null, 2) + '\n', 'utf8');
  } catch {
    /* best effort */
  }
}

/** Compare semver "a.b.c" strings; true if `latest` is newer than `current`. */
export function isNewer(latest: string, current: string): boolean {
  const la = latest.split('.').map((x) => parseInt(x, 10));
  const cu = current.split('.').map((x) => parseInt(x, 10));
  for (let i = 0; i < 3; i++) {
    const l = la[i] ?? 0;
    const c = cu[i] ?? 0;
    if (l > c) return true;
    if (l < c) return false;
  }
  return false;
}

async function fetchLatestVersion(): Promise<string | null> {
  try {
    const res = await fetch(REGISTRY_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    const json = (await res.json()) as { version?: string };
    return typeof json.version === 'string' ? json.version : null;
  } catch {
    return null; // offline / timeout / blocked — silent
  }
}

/**
 * Show a cached update hint if one is available — INSTANT, no network. Safe to
 * call on every user-facing command (status/log/-v/...): it only reads the
 * cache and prints a one-line stderr hint when a newer version is known.
 */
export function showCachedUpdateHint(currentVersion: string): void {
  if (isDisabled()) return;
  const cached = readCache();
  const latest = cached?.latest ?? null;
  if (latest && latest !== currentVersion && isNewer(latest, currentVersion)) {
    process.stderr.write(
      `cdog: update available ${currentVersion} → ${latest}  (npm update -g ${PKG_NAME}, or set CDOG_NO_UPDATE_CHECK=1 to mute)\n`,
    );
  }
}

/**
 * Refresh the update check from the npm registry if the cache is older than a
 * day, then show the hint. Does a network fetch (1.5s timeout) — call only from
 * commands where a brief delay is acceptable (start/restart/init), NOT from
 * quick commands (status/log/-v). Silent on offline/timeout. The daily cache
 * means this fetches at most once per day.
 */
export async function refreshUpdateCheck(currentVersion: string): Promise<void> {
  if (isDisabled()) return;
  const now = Date.now();
  const cached = readCache();
  const lastMs = cached ? Date.parse(cached.lastCheck) : NaN;
  const due = !cached || !Number.isFinite(lastMs) || now - lastMs > CHECK_INTERVAL_MS;
  if (!due) {
    showCachedUpdateHint(currentVersion);
    return;
  }
  const latest = await fetchLatestVersion();
  writeCache({ lastCheck: new Date(now).toISOString(), latest });
  if (latest && latest !== currentVersion && isNewer(latest, currentVersion)) {
    process.stderr.write(
      `cdog: update available ${currentVersion} → ${latest}  (npm update -g ${PKG_NAME}, or set CDOG_NO_UPDATE_CHECK=1 to mute)\n`,
    );
  }
}
