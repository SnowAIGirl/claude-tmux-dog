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
  CLAUDE_SETTINGS_PATH,
  ensureCdogDir,
} from './util.js';

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

/** Are the hooks wired into ~/.claude/settings.json? */
export function hooksConfigured(): boolean {
  if (!existsSync(CLAUDE_SETTINGS_PATH)) return false;
  try {
    const settings = JSON.parse(readFileSync(CLAUDE_SETTINGS_PATH, 'utf8'));
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

/** Merge hook config into ~/.claude/settings.json (backing up first). Returns true on success. */
export function mergeHookSettings(): boolean {
  const dir = dirname(CLAUDE_SETTINGS_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  let settings: Record<string, unknown> = {};
  if (existsSync(CLAUDE_SETTINGS_PATH)) {
    try {
      settings = JSON.parse(readFileSync(CLAUDE_SETTINGS_PATH, 'utf8'));
      // backup
      writeFileSync(
        CLAUDE_SETTINGS_PATH + '.cdog.bak',
        readFileSync(CLAUDE_SETTINGS_PATH, 'utf8'),
      );
    } catch {
      // corrupt — start fresh but keep a backup
      writeFileSync(
        CLAUDE_SETTINGS_PATH + '.cdog.bak',
        readFileSync(CLAUDE_SETTINGS_PATH, 'utf8'),
      );
      settings = {};
    }
  }

  const hooks = (settings.hooks as Record<string, unknown>) ?? {};
  const hookCmd = join(CLAUDE_DIR, 'hooks') + '/';
  const block = (script: string) => [
    { hooks: [{ type: 'command', command: hookCmd + script }] },
  ];

  hooks.Stop = block('cdog-hook.sh');
  hooks.StopFailure = block('cdog-hook.sh');
  hooks.SessionStart = block('cdog-hook.sh');
  hooks.SessionEnd = block('cdog-hook.sh');
  hooks.PreCompact = block('cdog-hook.sh');
  hooks.PostCompact = block('cdog-hook.sh');
  hooks.UserPromptSubmit = block('cdog-hook.sh');
  settings.hooks = hooks;

  try {
    writeFileSync(CLAUDE_SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n', 'utf8');
    // validate it parses
    JSON.parse(readFileSync(CLAUDE_SETTINGS_PATH, 'utf8'));
    return true;
  } catch (e) {
    console.error('✗ failed to write settings.json:', (e as Error).message);
    return false;
  }
}
