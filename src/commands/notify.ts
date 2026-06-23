// cdog notify [json] — CLI command entry point.
//
// This is a thin wrapper that delegates to src/hooks/index.ts.
// The actual hook event handlers live in src/hooks/*.ts.

import { notifyCommand } from '../hooks/index.js';

export async function notifyCliCommand(argJson?: string): Promise<void> {
  await notifyCommand(argJson);
}
