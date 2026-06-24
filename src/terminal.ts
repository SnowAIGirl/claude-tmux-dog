// terminal.ts — build the shell command fired when a cdog desktop notification
// is clicked. Opens or focuses the configured terminal app on the agent's tmux
// session. Cross-platform (macOS + Linux).
//
// Behavior:
//   - If a tmux client is already attached to the session (= someone is viewing
//     it in a terminal) → focus/activate THAT terminal window/tab.
//   - Otherwise → open a new terminal window running `tmux attach -t <session>`.
//
// "Is someone viewing it?" is detected via `tmux list-clients -t <session>`,
// which only counts real attached viewers (the watcher daemons tail files /
// use pipe-pane — they are NOT tmux clients).
//
// Focus precision:
//   - macOS Terminal.app / iTerm2: resolve the attached client's tty
//     (tmux list-clients -F '#{client_tty}'), then iterate the app's windows/
//     tabs to find the one whose tty matches, bring that window to front and
//     select the tab. Falls back to plain app-activate if the tty can't be
//     found (e.g. window closed since).
//   - macOS other terminals (Ghostty/Alacritty/kitty/…): app-level activate
//     only (no AppleScript tty API).
//   - Linux: focus by window title via wmctrl/xdotool (tmux `set-titles` makes
//     the session name appear in the terminal title — enabled by cdog on Linux).

import { execSync } from 'node:child_process';

/** Resolve the absolute tmux binary path once. The notification -execute runs
 *  in terminal-notifier's environment, which may lack the user's PATH, so we
 *  bake the absolute path in. Falls back to "tmux". */
let _tmuxBin: string | null = null;
function tmuxBin(): string {
  if (_tmuxBin !== null) return _tmuxBin;
  try {
    const p = execSync('command -v tmux', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    _tmuxBin = p || 'tmux';
  } catch {
    _tmuxBin = 'tmux';
  }
  return _tmuxBin;
}

/** Shell-single-quote a string for safe embedding as one shell argument. */
function shq(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/** Wrap a constant string in AppleScript double-quotes (escape " and \). */
function appleStr(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

interface FocusCtx {
  session: string;
  tmux: string;
}

interface TerminalHandler {
  /** Shell command that opens a NEW window/tab running `cmd`. */
  open(cmd: string): string;
  /** Shell command that focuses/activates the terminal window viewing the session. */
  focus(ctx: FocusCtx): string;
}

// ---------------- macOS ----------------

/**
 * Build the macOS tty-precision focus command for an AppleScript-able terminal
 * (Terminal.app / iTerm2). Fetches the attached client's tty via `do shell
 * script` inside AppleScript, iterates windows/tabs to find the matching tty,
 * brings that window to front + selects the tab. The `finder` lines are the
 * app-specific "find the tab/session by tty" loop body.
 */
function macTtyFocus(app: string, session: string, tmux: string, finder: string[]): string {
  const lines = [
    'on run {theSession}',
    // Fetch first attached client's tty. quoted form handles any session name.
    `set theTty to do shell script ${appleStr(`${tmux} list-clients -t `)} & quoted form of theSession & ${appleStr(` -F '#{client_tty}' 2>/dev/null | head -1`)}`,
    `tell application ${appleStr(app)}`,
    '  if theTty is equal to "" then',
    '    activate',
    '    return',
    '  end if',
    '  set foundWindow to missing value',
    ...finder,
    '  if foundWindow is not missing value then set index of foundWindow to 1',
    '  activate',
    'end tell',
    'end run',
  ];
  const eOpts = lines.map((l) => '-e ' + shq(l)).join(' ');
  // Pass the session name as the run-handler argument (no escaping needed).
  return `osascript ${eOpts} ${shq(session)}`;
}

// Terminal.app: tabs expose a `tty` property.
const terminalFinder = [
  '  repeat with w in windows',
  '    try',
  '      repeat with t in tabs of w',
  '        if tty of t is equal to theTty then',
  '          set foundWindow to w',
  '          set selected of t to true',
  '          exit repeat',
  '        end if',
  '      end repeat',
  '    end try',
  '    if foundWindow is not missing value then exit repeat',
  '  end repeat',
];

// iTerm2: tabs contain sessions; sessions expose a `tty` property.
const itermFinder = [
  '  repeat with w in windows',
  '    try',
  '      repeat with t in tabs of w',
  '        repeat with s in sessions of t',
  '          if tty of s is equal to theTty then',
  '            set foundWindow to w',
  '            select t',
  '            exit repeat',
  '          end if',
  '        end repeat',
  '        if foundWindow is not missing value then exit repeat',
  '      end repeat',
  '    end try',
  '    if foundWindow is not missing value then exit repeat',
  '  end repeat',
];

const macHandlers: Record<string, TerminalHandler> = {
  Terminal: {
    // `do script` runs the command in a new window. cmd passed as run-arg.
    open: (cmd) =>
      `osascript -e 'on run {c}' -e 'tell application "Terminal" to do script c' -e 'tell application "Terminal" to activate' -e 'end run' ${shq(cmd)}`,
    focus: ({ session, tmux }) => macTtyFocus('Terminal', session, tmux, terminalFinder),
  },
  iTerm2: {
    open: (cmd) =>
      `osascript -e 'on run {c}' -e 'tell application "iTerm2"' -e 'create window with default profile' -e 'tell current session of current window to write text c' -e 'activate' -e 'end tell' -e 'end run' ${shq(cmd)}`,
    focus: ({ session, tmux }) => macTtyFocus('iTerm2', session, tmux, itermFinder),
  },
  // These terminals don't expose a per-tab tty via AppleScript → app-level only.
  Ghostty: {
    open: (cmd) => `open -na "Ghostty" --args -e ${shq(cmd)}`,
    focus: () => `open -a "Ghostty"`,
  },
  Alacritty: {
    open: (cmd) => `open -na "Alacritty" --args -e ${shq(cmd)}`,
    focus: () => `open -a "Alacritty"`,
  },
  kitty: {
    open: (cmd) => `open -na "kitty" --args ${shq(cmd)}`,
    focus: () => `open -a "kitty"`,
  },
};

/** Generic macOS fallback for unlisted apps: best-effort `-e` launch + activate. */
function macGenericHandler(app: string): TerminalHandler {
  return {
    open: (cmd) => `open -na "${app}" --args -e ${shq(cmd)}`,
    focus: () => `open -a "${app}"`,
  };
}

function macHandler(app: string): TerminalHandler {
  return macHandlers[app] ?? macGenericHandler(app);
}

// ---------------- Linux ----------------
// tmux `set-titles` (enabled by cdog on Linux via enableTmuxTitles) puts the
// session name in the terminal window title; focus by title via wmctrl/xdotool.

function linuxFocus(session: string): string {
  return `wmctrl -a ${shq(session)} 2>/dev/null || xdotool search --name ${shq(session)} windowactivate 2>/dev/null || true`;
}

const linuxHandlers: Record<string, TerminalHandler> = {
  'gnome-terminal': { open: (cmd) => `gnome-terminal -- bash -lc ${shq(cmd)}`, focus: ({ session }) => linuxFocus(session) },
  konsole: { open: (cmd) => `konsole -e bash -lc ${shq(cmd)}`, focus: ({ session }) => linuxFocus(session) },
  xterm: { open: (cmd) => `xterm -e bash -lc ${shq(cmd)}`, focus: ({ session }) => linuxFocus(session) },
  alacritty: { open: (cmd) => `alacritty -e bash -lc ${shq(cmd)}`, focus: ({ session }) => linuxFocus(session) },
  kitty: { open: (cmd) => `kitty bash -lc ${shq(cmd)}`, focus: ({ session }) => linuxFocus(session) },
};

function linuxGenericHandler(bin: string): TerminalHandler {
  return {
    open: (cmd) => `${bin} -e bash -lc ${shq(cmd)}`,
    focus: ({ session }) => linuxFocus(session),
  };
}

/** Pick a default Linux terminal: first installed of the common ones. */
function defaultLinuxTerminal(): string {
  for (const bin of ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xterm']) {
    try {
      execSync(`command -v ${bin}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      return bin;
    } catch { /* not installed */ }
  }
  return 'xterm';
}

/** Normalize common aliases (case-insensitive) to a canonical registry key. */
function normalizeApp(app: string): string {
  const lower = app.toLowerCase();
  if (lower === 'iterm' || lower === 'iterm2') return 'iTerm2';
  return app;
}

/**
 * Build the click-to-open shell command for an agent's tmux session.
 *
 * @param app    terminal app name from `notify.terminal` (undefined → platform
 *               default: "Terminal" on macOS, auto-detected on Linux)
 * @param session  tmux session name (= agent name)
 * @returns a single shell command (`if … then … else … fi`) to pass to the
 *          notification's -execute handler
 */
export function buildTerminalClickCommand(app: string | undefined, session: string): string {
  const isMac = process.platform === 'darwin';
  const resolved = normalizeApp(app ?? (isMac ? 'Terminal' : defaultLinuxTerminal()));
  const handler = isMac
    ? macHandler(resolved)
    : (linuxHandlers[resolved] ?? linuxGenericHandler(resolved));

  const tmux = tmuxBin();
  const attachCmd = `${tmux} attach -t ${shq(session)}`;
  // A non-empty client list means a real viewer is attached → focus; else open.
  const hasClient = `${tmux} list-clients -t ${shq(session)} 2>/dev/null | grep -q .`;
  return `if ${hasClient}; then ${handler.focus({ session, tmux })}; else ${handler.open(attachCmd)}; fi`;
}

/**
 * Enable tmux `set-titles` for a session so the terminal window title contains
 * the session name. On Linux this lets the click-to-focus (wmctrl/xdotool by
 * title) actually find the right window. No-op on macOS (focus uses tty, and
 * changing the titlebar would be unwanted noise). Best-effort, never throws.
 */
export function enableTmuxTitles(session: string): void {
  if (process.platform === 'darwin') return;
  try {
    execSync(`tmux set-option -t ${shq(session)} set-titles on`, { stdio: 'ignore' });
  } catch { /* session may not exist yet */ }
}
