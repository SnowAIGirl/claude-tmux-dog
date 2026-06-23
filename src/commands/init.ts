// cdog init — set up ~/.cdog/ and wire hooks into ~/.claude/settings.json.

import { installHookScripts, mergeHookSettings, hooksInstalled, hooksConfigured } from '../hooks.js';
import { CDOG_DIR } from '../util.js';

export function initCommand(): void {
  installHookScripts();
  const ok = mergeHookSettings();

  console.log(`✓ cdog directory: ${CDOG_DIR}`);
  console.log(`  hooks scripts:  ${hooksInstalled() ? 'installed' : 'FAILED'}`);
  console.log(`  hooks config:   ${hooksConfigured() ? 'configured' : ok ? 'configured' : 'FAILED'}`);
  if (!ok) {
    console.warn('⚠ could not update ~/.claude/settings.json — see error above');
    process.exit(1);
  }
  console.log('\nDone. Claude Code StopFailure / SessionStart / SessionEnd hooks are active.');
  console.log('Restart any running Claude Code sessions for the new hooks to take effect.');
}
