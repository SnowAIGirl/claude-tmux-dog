// Config loading, validation, and claude command assembly.

import { readFileSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import type { CdogConfig } from './types.js';
import { ALL_KEYWORD } from './types.js';
import { shellQuote } from './util.js';

/** Load and validate a cdog.json from an absolute or cwd-relative path. */
export function loadConfig(configPath: string): CdogConfig {
  const raw = readFileSync(configPath, 'utf8');
  const cfg = JSON.parse(raw) as CdogConfig;
  if (!cfg.name || typeof cfg.name !== 'string') {
    throw new Error(`cdog.json: "name" is required (in ${configPath})`);
  }
  if (cfg.name === ALL_KEYWORD) {
    throw new Error(`cdog.json: "name" must not be the reserved word "${ALL_KEYWORD}"`);
  }
  if (!cfg.cwd) cfg.cwd = process.cwd();
  cfg.cwd = isAbsolute(cfg.cwd) ? cfg.cwd : resolve(process.cwd(), cfg.cwd);
  return cfg;
}

/** Resolve a possibly-relative path against the config's cwd. */
export function resolveCwdPath(cfg: CdogConfig, p?: string): string | undefined {
  if (!p) return undefined;
  return isAbsolute(p) ? p : resolve(cfg.cwd, p);
}

/**
 * Resolve md config into an array of absolute paths.
 * Accepts: string (comma-separated), string[] (array), or undefined.
 * Returns [] if no md configured.
 */
export function resolveMdPaths(cfg: CdogConfig): string[] {
  if (!cfg.md) return [];
  const raw = Array.isArray(cfg.md)
    ? cfg.md
    : String(cfg.md).split(',').map((s) => s.trim()).filter(Boolean);
  return raw
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((p) => resolveCwdPath(cfg, p))
    .filter((p): p is string => !!p);
}

export interface BuiltCommand {
  /** Full shell command string to run inside the tmux pane. */
  cmd: string;
  /** Absolute md paths (if any). */
  mdPaths: string[];
  /** Absolute log path (if any). */
  logPath?: string;
}

/**
 * Assemble the claude command for `start`.
 *
 *   [cat <md1> <md2> ... | ] claude --session-id <sid> --name <name> [args...] [--debug-file <log>]
 *
 * Environment variables are NOT injected by cdog — set them in ~/.claude/settings.json or ~/.zshrc.
 */
export function buildStartCommand(cfg: CdogConfig, sessionId: string): BuiltCommand {
  const parts: string[] = [];
  const mdPaths = resolveMdPaths(cfg);
  if (mdPaths.length > 0) {
    parts.push('cat', ...mdPaths.map(shellQuote), '|');
  }

  parts.push('claude', '--session-id', shellQuote(sessionId), '--name', shellQuote(cfg.name));

  if (cfg.args && cfg.args.length > 0) {
    for (const a of cfg.args) parts.push(shellQuote(a));
  }

  // Always pass --debug-file. start.ts ensures cfg.log is always set
  // (defaults to <cwd>/logs/claude-debug.log if not configured).
  // This ensures the log watcher always has a file to tail.
  const logPath = resolveCwdPath(cfg, cfg.log) ?? resolve(cfg.cwd, 'logs', 'claude-debug.log');
  parts.push('--debug-file', shellQuote(logPath));

  return { cmd: parts.join(' '), mdPaths, logPath };
}

/**
 * Assemble the recovery command used by the cdog-recover flow:
 *
 *   [cat <md1> <md2> ... | ] claude --resume <sid> [args...] [--debug-file <log>]
 *
 * Includes `cat <md...> |` when md task files are configured, so a fresh
 * `/new` session picks the task back up on resume.
 *
 * Environment variables are NOT injected by cdog — set them in ~/.claude/settings.json or ~/.zshrc.
 */
export function buildRecoverCommand(cfg: CdogConfig, sessionId: string): string {
  const parts: string[] = [];
  const mdPaths = resolveMdPaths(cfg);
  if (mdPaths.length > 0) {
    parts.push('cat', ...mdPaths.map(shellQuote), '|');
  }

  parts.push('claude', '--resume', shellQuote(sessionId));
  if (cfg.args && cfg.args.length > 0) {
    for (const a of cfg.args) parts.push(shellQuote(a));
  }
  // Always pass --debug-file (same as buildStartCommand).
  const logPath = resolveCwdPath(cfg, cfg.log) ?? resolve(cfg.cwd, 'logs', 'claude-debug.log');
  parts.push('--debug-file', shellQuote(logPath));
  return parts.join(' ');
}
