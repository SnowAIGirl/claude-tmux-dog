// Error classification constants and helpers for StopFailure recovery.
//
// Claude Code StopFailure events carry an `error` field with a known set of
// values. We classify them into three buckets:
//
//   fatal       → never recover, mark failed immediately
//   transient   → claude is alive → C-c + send prompt (resume not needed)
//   context-suspect → may include context-window overflow; escalate by count

/** Fatal errors: never recover, mark failed. */
export const FATAL_ERRORS = new Set([
  'authentication_failed',
  'oauth_org_not_allowed',
  'billing_error',
  'model_not_found',
]);

/** Transient errors: claude is alive → C-c + send prompt; resume not needed. */
export const TRANSIENT_ERRORS = new Set([
  'rate_limit',
  'overloaded',
  'server_error',
  'max_output_tokens',
]);

/**
 * Context-suspect errors (invalid_request / unknown): may include context-window
 * overflow (which has no dedicated error name). Use failure count to escalate:
 *   1st failure → C-c + send prompt (try continuing)
 *   2nd failure → C-c + /compact (suspect context overflow)
 *   3rd failure → failed (circuit breaker)
 */
export const CONTEXT_SUSPECT_ERRORS = new Set(['invalid_request', 'unknown']);

/** Circuit breaker: >=3 recoverable StopFailures within this window → failed. */
export const CIRCUIT_WINDOW_MS = 5 * 60 * 1000;
export const CIRCUIT_MAX_FAILURES = 3;
