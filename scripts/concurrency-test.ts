// Concurrency test for state.ts file locking.
// Spawns N processes that each increment a counter, checks no lost updates.
//
// Uses CDOG_DIR env var to point at a temp directory — never touches the
// user's real ~/.cdog/state.json.

import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync, unlinkSync, existsSync, mkdtempSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const N = 10;

const tmpDir = mkdtempSync(join(tmpdir(), 'cdog-test-'));
const testStatePath = join(tmpDir, 'state.json');

writeFileSync(testStatePath, JSON.stringify({
  test: {
    name: 'test',
    session_id: 's1',
    tmux_session: 'test',
    claude_status: 'running',
    cdog_status: 'watching',
    stop_reason: null,
    ended_at: null,
    started_at: new Date().toISOString(),
    restart_count: 0,
    nudge_count: 0,
    last_error: null,
    last_restart_at: null,
  }
}, null, 2));

const childScript = `
  const { mutateAgent } = require('./dist/state.js');
  mutateAgent('test', (a) => {
    a.nudge_count = (a.nudge_count || 0) + 1;
  });
`;

const procs: Promise<void>[] = [];
for (let i = 0; i < N; i++) {
  const p = spawn('node', ['-e', childScript], {
    cwd: process.cwd(),
    env: { ...process.env, CDOG_DIR: tmpDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  procs.push(new Promise((resolve, reject) => {
    p.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`exit ${code}`)));
  }));
}

Promise.all(procs).then(() => {
  const state = JSON.parse(readFileSync(testStatePath, 'utf8'));
  const final = state.test?.nudge_count ?? 0;
  console.log(`Final nudge_count: ${final} (expected ${N})`);
  if (final === N) {
    console.log('PASS: no lost updates');
  } else {
    console.log('FAIL: lost updates detected!');
    process.exit(1);
  }
  // Cleanup
  if (existsSync(testStatePath)) unlinkSync(testStatePath);
  const lockPath = testStatePath + '.lock';
  if (existsSync(lockPath)) unlinkSync(lockPath);
  try { rmdirSync(tmpDir); } catch {}
}).catch((err) => {
  console.error('Test error:', err);
  process.exit(1);
});
