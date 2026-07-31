// Hook installation checks and the init command's setup logic.

import {
  existsSync,
  readFileSync,
  copyFileSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HOOKS_DIR,
  CDOG_DIR,
  CLAUDE_DIR,
  ensureCdogDir,
} from './util.js';

/**
 * Project-level `.claude/settings.json` path. cdog writes hook config here
 * (NOT global `~/.claude/settings.json`) so user's global hooks stay untouched.
 * The hook *script* itself still lives at `~/.claude/hooks/cdog-hook.sh` (global),
 * only the settings wiring is project-scoped. Defaults to `process.cwd()` for
 * `cdog init`; callers with a known agent cwd (e.g. `cdog start`) should pass it.
 */
export function projectSettingsPath(projectCwd: string = process.cwd()): string {
  return join(projectCwd, '.claude', 'settings.json');
}

// Single universal hook script handles all events. cdog differentiates by
// reading hook_event_name from the forwarded JSON.
export const HOOK_NAMES = ['cdog-hook.sh'] as const;

/** Where bundled hook scripts live: npm package root `hooks/` or project source `hooks/`. */
export function bundledHooksDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // When installed (dist/commands/hooks.js): ../../hooks = package-root/hooks/
  // When run via tsx (src/commands/hooks.ts): ../../hooks = project-root/hooks/
  // Both resolve to the same thing: the hooks/ dir at the repo or package root.
  return join(here, '..', '..', 'hooks');
}

/** Is the hook script present in ~/.cdog/hooks/? */
export function hooksInstalled(): boolean {
  return HOOK_NAMES.every((n) => existsSync(join(HOOKS_DIR, n)));
}

/** Are the hooks wired into the project's .claude/settings.json? */
export function hooksConfigured(projectCwd: string = process.cwd()): boolean {
  const settingsPath = projectSettingsPath(projectCwd);
  if (!existsSync(settingsPath)) return false;
  try {
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    const hooks = settings?.hooks ?? {};
    return (
      Array.isArray(hooks.Stop) &&
      Array.isArray(hooks.StopFailure) &&
      Array.isArray(hooks.SessionStart) &&
      Array.isArray(hooks.SessionEnd) &&
      Array.isArray(hooks.PreCompact) &&
      Array.isArray(hooks.PostCompact) &&
      Array.isArray(hooks.UserPromptSubmit)
    );
  } catch {
    return false;
  }
}

/** Warn (non-blocking) if hooks aren't set up. */
export function warnIfHooksMissing(): void {
  if (hooksInstalled() && hooksConfigured()) return;
  console.warn('⚠ hooks not installed — run `cdog init` to set up auto-recovery');
}

/** Copy bundled hook scripts into ~/.cdog/hooks/. */
export function installHookScripts(): void {
  ensureCdogDir();
  if (!existsSync(HOOKS_DIR)) mkdirSync(HOOKS_DIR, { recursive: true });
  const src = bundledHooksDir();
  for (const n of HOOK_NAMES) {
    const from = join(src, n);
    if (!existsSync(from)) {
      // Fallback: write the canonical content directly if bundle missing.
      writeFileSync(join(HOOKS_DIR, n), `#!/bin/bash\ncdog notify "$(cat)"\n`, { mode: 0o755 });
      continue;
    }
    copyFileSync(from, join(HOOKS_DIR, n));
  }
  // ensure executable
  for (const n of HOOK_NAMES) {
    const p = join(HOOKS_DIR, n);
    try {
      chmodSync(p, 0o755);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Merge cdog hook config into the project's `.claude/settings.json` (backing up first).
 *
 * Project-scoped (NOT global `~/.claude/settings.json`) so user's global hooks
 * are never touched. The hook *script* path stays global (`~/.claude/hooks/cdog-hook.sh`).
 *
 * Incremental: for each hook type, push the cdog entry to the existing array
 * only if no entry already references `cdog-hook.sh` (idempotent — re-running
 * `cdog init` never duplicates or overwrites user hooks). Returns true on success.
 */
export function mergeHookSettings(projectCwd: string = process.cwd()): boolean {
  const settingsPath = projectSettingsPath(projectCwd);
  const dir = dirname(settingsPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
      // backup
      writeFileSync(
        settingsPath + '.cdog.bak',
        readFileSync(settingsPath, 'utf8'),
      );
    } catch {
      // corrupt — start fresh but keep a backup
      writeFileSync(
        settingsPath + '.cdog.bak',
        readFileSync(settingsPath, 'utf8'),
      );
      settings = {};
    }
  }

  const hooks = (settings.hooks as Record<string, unknown>) ?? {};
  const hookCmd = join(CLAUDE_DIR, 'hooks') + '/';
  const block = (script: string) => ({
    hooks: [{ type: 'command', command: hookCmd + script }],
  });

  // Incremental update: push cdog-hook entry to each hook type's array,
  // but skip if a cdog-hook.sh entry already exists (don't overwrite user hooks).
  const HOOK_TYPES = [
    'Stop',
    'StopFailure',
    'SessionStart',
    'SessionEnd',
    'PreCompact',
    'PostCompact',
    'UserPromptSubmit',
  ] as const;
  for (const hookType of HOOK_TYPES) {
    const arr = Array.isArray(hooks[hookType]) ? (hooks[hookType] as unknown[]) : [];
    const alreadyHas = arr.some((entry) => {
      try {
        const cmd = (entry as { hooks?: Array<{ command?: string }> })?.hooks?.[0]?.command;
        return typeof cmd === 'string' && cmd.includes('cdog-hook.sh');
      } catch {
        return false;
      }
    });
    if (!alreadyHas) {
      arr.push(block('cdog-hook.sh'));
    }
    hooks[hookType] = arr;
  }
  settings.hooks = hooks;

  try {
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
    // validate it parses
    JSON.parse(readFileSync(settingsPath, 'utf8'));
    return true;
  } catch (e) {
    console.error('✗ failed to write settings.json:', (e as Error).message);
    return false;
  }
}
