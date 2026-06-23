// cdog auto-nudge enable <name|all>
// cdog auto-nudge disable <name|all>
//
// Toggle auto_nudge_stop in the agent's cdog.json config file directly.
// This is a persistent change — it survives restarts.
// Also updates state.json for immediate effect (running watchers read state).

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { loadState, mutateAgent } from '../state.js';
import { logAgentEvent } from '../logger.js';

function toggleAutoNudge(name: string, enable: boolean): void {
  const state = loadState();
  const agent = state[name];
  if (!agent) {
    console.error(`✗ agent not found: ${name}`);
    process.exit(1);
  }

  if (!agent.config_path || !existsSync(agent.config_path)) {
    console.error(`✗ config file not found for agent: ${name}`);
    process.exit(1);
  }

  // Read + parse config file
  let cfg: Record<string, unknown>;
  try {
    cfg = JSON.parse(readFileSync(agent.config_path, 'utf8'));
  } catch (e) {
    console.error(`✗ failed to parse config: ${(e as Error).message}`);
    process.exit(1);
  }

  // Update watchdog.auto_nudge_stop
  if (!cfg.watchdog || typeof cfg.watchdog !== 'object') {
    cfg.watchdog = {};
  }
  (cfg.watchdog as Record<string, unknown>).auto_nudge_stop = enable;

  // Write back
  try {
    writeFileSync(agent.config_path, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  } catch (e) {
    console.error(`✗ failed to write config: ${(e as Error).message}`);
    process.exit(1);
  }

  // Update state for immediate effect
  mutateAgent(name, (a) => {
    if (!a.watchdog) a.watchdog = {};
    a.watchdog.auto_nudge_stop = enable;
  });

  const status = enable ? 'enabled' : 'disabled';
  console.log(`✓ ${name}: auto-nudge ${status} (config updated)`);
  logAgentEvent(name, `auto-nudge ${status} (config updated via cdog auto-nudge)`);
}

export function autoNudgeCommand(args: string[]): void {
  const sub = args[0]; // enable | disable
  const name = args[1]; // agent name | all

  if (!sub || !name) {
    console.error('✗ usage: cdog auto-nudge <enable|disable> <name|all>');
    process.exit(1);
  }

  const enable: boolean = sub === 'enable';

  if (name === 'all') {
    const state = loadState();
    const names = Object.keys(state);
    if (names.length === 0) {
      console.log('No agents.');
      return;
    }
    for (const n of names) {
      try {
        toggleAutoNudge(n, enable);
      } catch (e) {
        console.error(`✗ ${n}: ${(e as Error).message}`);
      }
    }
  } else {
    toggleAutoNudge(name, enable);
  }
}
