#!/bin/bash
# cdog-hook.sh — Universal hook script for all Claude Code hook events.
#
# Forwards the event JSON unchanged to `cdog notify`. cdog reads the
# hook_event_name from the JSON to determine how to handle it.
#
# Configured in ~/.claude/settings.json for: Stop, StopFailure, SessionStart, SessionEnd
cdog notify "$(cat)"