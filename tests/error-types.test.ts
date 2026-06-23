// Unit tests for hooks/error-types.ts — error classification constants.

import { describe, it, expect } from 'vitest';
import {
  FATAL_ERRORS,
  TRANSIENT_ERRORS,
  CONTEXT_SUSPECT_ERRORS,
  CIRCUIT_WINDOW_MS,
  CIRCUIT_MAX_FAILURES,
} from '../src/hooks/error-types.js';

describe('hooks/error-types.ts', () => {
  describe('FATAL_ERRORS', () => {
    it('includes authentication_failed', () => {
      expect(FATAL_ERRORS.has('authentication_failed')).toBe(true);
    });

    it('includes billing_error', () => {
      expect(FATAL_ERRORS.has('billing_error')).toBe(true);
    });

    it('includes model_not_found', () => {
      expect(FATAL_ERRORS.has('model_not_found')).toBe(true);
    });

    it('includes oauth_org_not_allowed', () => {
      expect(FATAL_ERRORS.has('oauth_org_not_allowed')).toBe(true);
    });

    it('does not include rate_limit', () => {
      expect(FATAL_ERRORS.has('rate_limit')).toBe(false);
    });
  });

  describe('TRANSIENT_ERRORS', () => {
    it('includes rate_limit', () => {
      expect(TRANSIENT_ERRORS.has('rate_limit')).toBe(true);
    });

    it('includes overloaded', () => {
      expect(TRANSIENT_ERRORS.has('overloaded')).toBe(true);
    });

    it('includes server_error', () => {
      expect(TRANSIENT_ERRORS.has('server_error')).toBe(true);
    });

    it('does not include authentication_failed', () => {
      expect(TRANSIENT_ERRORS.has('authentication_failed')).toBe(false);
    });
  });

  describe('CONTEXT_SUSPECT_ERRORS', () => {
    it('includes invalid_request', () => {
      expect(CONTEXT_SUSPECT_ERRORS.has('invalid_request')).toBe(true);
    });

    it('includes unknown', () => {
      expect(CONTEXT_SUSPECT_ERRORS.has('unknown')).toBe(true);
    });

    it('does not include rate_limit', () => {
      expect(CONTEXT_SUSPECT_ERRORS.has('rate_limit')).toBe(false);
    });
  });

  describe('circuit breaker constants', () => {
    it('CIRCUIT_WINDOW_MS is 5 minutes', () => {
      expect(CIRCUIT_WINDOW_MS).toBe(5 * 60 * 1000);
    });

    it('CIRCUIT_MAX_FAILURES is 3', () => {
      expect(CIRCUIT_MAX_FAILURES).toBe(3);
    });
  });

  describe('error sets are mutually exclusive', () => {
    it('FATAL and TRANSIENT do not overlap', () => {
      for (const e of FATAL_ERRORS) {
        expect(TRANSIENT_ERRORS.has(e)).toBe(false);
      }
    });

    it('FATAL and CONTEXT_SUSPECT do not overlap', () => {
      for (const e of FATAL_ERRORS) {
        expect(CONTEXT_SUSPECT_ERRORS.has(e)).toBe(false);
      }
    });

    it('TRANSIENT and CONTEXT_SUSPECT do not overlap', () => {
      for (const e of TRANSIENT_ERRORS) {
        expect(CONTEXT_SUSPECT_ERRORS.has(e)).toBe(false);
      }
    });
  });
});
