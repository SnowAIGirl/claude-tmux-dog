// cdog log                          — all agents' cdog operation logs, follow (tail -f)
// cdog log --all                    — same as above
// cdog log <name>                   — only that agent's cdog log lines, follow
// cdog log --no-follow <name>       — last N lines, then exit
// cdog log <name> --claude-log      — tail the claude debug log (config `log`)
// cdog log --no-follow <name> --claude-log — last N lines of claude log, exit

import { existsSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { loadState } from '../state.js';

// Colors for agent names — cycle through these for multi-agent output
const AGENT_COLORS = [
  (s: string) => `\x1b[32m${s}\x1b[39m`,   // green
  (s: string) => `\x1b[34m${s}\x1b[39m`,   // blue
  (s: string) => `\x1b[33m${s}\x1b[39m`,   // yellow
  (s: string) => `\x1b[35m${s}\x1b[39m`,   // magenta
  (s: string) => `\x1b[36m${s}\x1b[39m`,   // cyan
  (s: string) => `\x1b[31m${s}\x1b[39m`,   // red
  (s: string) => `\x1b[92m${s}\x1b[39m`,   // bright green
  (s: string) => `\x1b[94m${s}\x1b[39m`,   // bright blue
];

function colorAgent(name: string, index: number): string {
  return AGENT_COLORS[index % AGENT_COLORS.length](name);
}

// Regexes for claude debug log levels
const LOG_LEVEL_COLORS: Record<string, (s: string) => string> = {
  ERROR:   (s) => `\x1b[31m${s}\x1b[39m`, // red
  WARN:    (s) => `\x1b[33m${s}\x1b[39m`, // yellow
  INFO:    (s) => `\x1b[36m${s}\x1b[39m`, // cyan
  DEBUG:   (s) => `\x1b[90m${s}\x1b[39m`, // bright black (gray)
};

/** Colorize log levels like [ERROR] [WARN] [DEBUG] etc. */
function colorizeLogLevel(line: string): string {
  return line.replace(
    /\[(ERROR|WARN|INFO|DEBUG)\]/g,
    (_, level: string) => LOG_LEVEL_COLORS[level]?.(`[${level}]`) ?? `[${level}]`,
  );
}

/** Fixed label width for agent name alignment (matches cdog log format). */
const AGENT_LABEL_WIDTH = 26;

/**
 * Format an agent label: `[name]` padded/truncated to AGENT_LABEL_WIDTH chars,
 * then colorized. The plain-text width is always AGENT_LABEL_WIDTH so alignment
 * is consistent regardless of ANSI codes.
 *
 * Examples (width=26):
 *   [snow-agent]              |   ← 26 visible chars before |
 *   [a-very-long-agent-name]  |   ← truncated to 26
 */
function formatAgentLabel(name: string, colorIdx: number): string {
  const label = `[${name}]`;
  // Pad or truncate so visible width = AGENT_LABEL_WIDTH
  const padded = label.length >= AGENT_LABEL_WIDTH
    ? label.slice(0, AGENT_LABEL_WIDTH)
    : label + ' '.repeat(AGENT_LABEL_WIDTH - label.length);
  return `${colorAgent(padded, colorIdx)}|`;
}

/** Colorize the `[name] |` prefix at the start of a line. Uses fixed-width label. */
function colorizeCdogPrefix(line: string, nameColorMap: Map<string, number>): string {
  return line.replace(/^\[([^\]]+)\]\s+\|/, (match, name: string) => {
    const idx = nameColorMap.get(name) ?? 0;
    return formatAgentLabel(name, idx) + ' ';
  });
}

export interface LogArgs {
  name?: string; // agent name, or undefined for "all"
  all?: boolean;
  noFollow?: boolean;
  claudeLog?: boolean;
  lines?: number;
}

/** The cdog operation-log path for an agent (its configured log_file_path). Undefined if none. */
function cdogLogPath(agentName: string): string | undefined {
  const a = loadState()[agentName];
  return a?.log_file_path;
}

/** Agent names that have a readable cdog log. */
function agentsWithLogs(): string[] {
  return Object.keys(loadState())
    .filter((n) => {
      const p = cdogLogPath(n);
      return p && existsSync(p);
    })
    .sort();
}

/** Agents that have a readable claude debug log (config `log`). */
function agentsWithClaudeLogs(): { name: string; path: string }[] {
  const state = loadState();
  return Object.keys(state)
    .filter((n) => {
      const p = state[n].log_path;
      return p && existsSync(p);
    })
    .sort()
    .map((n) => ({ name: n, path: state[n].log_path! }));
}

/**
 * Tail a single file, coloring output.
 * For cdog logs, replaces the existing `[name]  |` prefix with a fixed-width
 * colored label. For claude logs, no prefix is added.
 */
function tailFile(path: string, lines: number, follow: boolean, claudeLog: boolean): void {
  const args = ['-n', String(lines)];
  if (follow) args.push('-f');
  args.push(path);
  const child = spawn('tail', args, { stdio: ['ignore', 'pipe', 'inherit'] });
  let buf = '';
  child.stdout!.on('data', (chunk: Buffer) => {
    buf += chunk.toString();
    const parts = buf.split('\n');
    buf = parts.pop() ?? '';
    for (const line of parts) {
      if (line === '') continue;
      if (claudeLog) {
        process.stdout.write(colorizeLogLevel(line) + '\n');
      } else {
        // Single-agent cdog log: replace the [name] prefix with fixed-width colored version
        const colored = line.replace(/^\[([^\]]+)\]\s+\|/, (_, name: string) => {
          return formatAgentLabel(name, 0) + ' ';
        });
        process.stdout.write(colored + '\n');
      }
    }
  });
  child.on('exit', (code) => process.exit(code ?? 0));
}

/**
 * Tail multiple cdog log files, merging them. cdog log files already carry their
 * `[name] | ` prefix per line, so we stream them verbatim (no re-prefixing).
 * Follow mode runs until Ctrl-C; snapshot mode exits when all tails finish.
 */
function tailMultiple(
  files: { name: string; path: string }[],
  lines: number,
  follow: boolean,
): void {
  const children: ChildProcess[] = [];
  let pending = files.length;

  // Build a name→color index so each agent gets a consistent color
  const nameColorMap = new Map<string, number>();
  files.forEach((f, i) => nameColorMap.set(f.name, i));

  for (const { path } of files) {
    const args = ['-n', String(lines)];
    if (follow) args.push('-f');
    args.push(path);
    const child = spawn('tail', args, { stdio: ['ignore', 'pipe', 'inherit'] });
    let buf = '';
    child.stdout!.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      const parts = buf.split('\n');
      buf = parts.pop() ?? '';
      for (const line of parts) {
        if (line === '') continue;
        process.stdout.write(colorizeCdogPrefix(colorizeLogLevel(line), nameColorMap) + '\n');
      }
    });
    child.on('exit', () => {
      if (buf) {
        const last = colorizeCdogPrefix(colorizeLogLevel(buf), nameColorMap);
        process.stdout.write(last + '\n');
      }
      if (--pending === 0 && !follow) process.exit(0);
    });
    children.push(child);
  }

  if (follow) {
    process.on('SIGINT', () => {
      for (const c of children) c.kill();
      process.exit(0);
    });
  }
}

/**
 * Tail multiple claude debug log files, merging them. Claude debug logs don't
 * carry agent name prefixes, so we prepend `[name] | ` to each line.
 */
function tailMultipleClaude(
  files: { name: string; path: string }[],
  lines: number,
  follow: boolean,
): void {
  const children: ChildProcess[] = [];
  let pending = files.length;

  const nameColorMap = new Map<string, number>();
  files.forEach((f, i) => nameColorMap.set(f.name, i));

  for (const { name, path } of files) {
    const args = ['-n', String(lines)];
    if (follow) args.push('-f');
    args.push(path);
    const child = spawn('tail', args, { stdio: ['ignore', 'pipe', 'inherit'] });
    let buf = '';
    child.stdout!.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      const parts = buf.split('\n');
      buf = parts.pop() ?? '';
      for (const line of parts) {
        if (line === '') continue;
        const idx = nameColorMap.get(name) ?? 0;
        process.stdout.write(`${formatAgentLabel(name, idx)} ${colorizeLogLevel(line)}\n`);
      }
    });
    child.on('exit', () => {
      if (buf) {
        const idx = nameColorMap.get(name) ?? 0;
        process.stdout.write(`${formatAgentLabel(name, idx)} ${colorizeLogLevel(buf)}\n`);
      }
      if (--pending === 0 && !follow) process.exit(0);
    });
    children.push(child);
  }

  if (follow) {
    process.on('SIGINT', () => {
      for (const c of children) c.kill();
      process.exit(0);
    });
  }
}

export async function logCommand(args: LogArgs): Promise<void> {
  const lines = args.lines ?? 50;

  // Single named agent.
  if (args.name && !args.all) {
    const agent = loadState()[args.name];
    if (!agent) {
      console.error(`✗ agent not found: ${args.name}`);
      process.exit(1);
    }

    if (args.claudeLog) {
      const p = agent.log_path;
      if (!p) {
        console.error(`✗ ${args.name} has no claude debug log (config 'log' not set)`);
        process.exit(1);
      }
      if (!existsSync(p)) {
        console.error(`✗ claude log not found: ${p}`);
        process.exit(1);
      }
      tailFile(p, lines, !args.noFollow, true);
      return new Promise(() => {}); // stay alive for follow
    }

    const p = cdogLogPath(args.name);
    if (!p || !existsSync(p)) {
      console.error(`✗ no cdog log for ${args.name} (log_file not configured)`);
      process.exit(1);
    }
    tailFile(p, lines, !args.noFollow, false);
    return new Promise(() => {});
  }

  // All agents — claude debug log or cdog log.
  if (args.claudeLog) {
    const files = agentsWithClaudeLogs();
    if (files.length === 0) {
      console.log('No claude debug logs found (configure log in cdog.json).');
      return;
    }
    tailMultipleClaude(files, lines, !args.noFollow);
    if (!args.noFollow) return new Promise(() => {});
    return;
  }
  const names = agentsWithLogs();
  if (names.length === 0) {
    console.log('No cdog logs found (configure log_file in cdog.json).');
    return;
  }
  tailMultiple(
    names.map((n) => ({ name: n, path: cdogLogPath(n)! })),
    lines,
    !args.noFollow,
  );
  if (!args.noFollow) return new Promise(() => {});
}
