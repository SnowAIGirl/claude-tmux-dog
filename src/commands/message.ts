// cdog message send --to <name> --message <text> [--from <from>] [--reply-method <rm>]
//
// Pure concatenation, no validation/escaping:
//   tmuxSendText = from ? `${from}: ${message}` : message
//   tmuxSendText += replyMethod ? `\nReply Method: ${replyMethod}` : ''
// Then `tmux send-keys -t <session> -l <text>` + Enter.

import { getAgent } from '../state.js';
import { tmuxHasSession, tmuxSendText } from '../util.js';
import { logAgentEvent } from '../logger.js';

export interface MessageSendArgs {
  to: string;
  message: string;
  from?: string;
  replyMethod?: string;
}

export function messageSend(args: MessageSendArgs): void {
  const agent = getAgent(args.to);
  if (!agent) {
    console.error(`✗ agent not found: ${args.to}`);
    process.exit(1);
  }
  if (!tmuxHasSession(agent.tmux_session)) {
    console.error(`✗ tmux session not running: ${agent.tmux_session}`);
    process.exit(1);
  }

  let text = args.from ? `${args.from}: ${args.message}` : args.message;
  if (args.replyMethod) text += `\nReply Method: ${args.replyMethod}`;

  tmuxSendText(agent.tmux_session, text, true);
  logAgentEvent(args.to, `message sent: ${text.replace(/\n/g, ' ⏎ ')}`);
  console.log(`✓ sent to ${args.to}`);
}
