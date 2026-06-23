// Unit tests for util.ts — parseTokenCount, formatTokenCount, shellQuote.

import { describe, it, expect } from 'vitest';
import {
  parseTokenCount,
  formatTokenCount,
  shellQuote,
} from '../src/util.js';

describe('util.ts', () => {
  describe('parseTokenCount', () => {
    it('parses plain number', () => {
      expect(parseTokenCount(200000)).toBe(200000);
    });

    it('parses string number', () => {
      expect(parseTokenCount('200000')).toBe(200000);
    });

    it('parses k suffix', () => {
      expect(parseTokenCount('200k')).toBe(200000);
      expect(parseTokenCount('1k')).toBe(1000);
      expect(parseTokenCount('15.5k')).toBe(15500);
    });

    it('parses m suffix', () => {
      expect(parseTokenCount('1m')).toBe(1000000);
      expect(parseTokenCount('2m')).toBe(2000000);
      expect(parseTokenCount('1.5m')).toBe(1500000);
    });

    it('parses uppercase K and M', () => {
      expect(parseTokenCount('200K')).toBe(200000);
      expect(parseTokenCount('1M')).toBe(1000000);
    });

    it('parses with spaces', () => {
      expect(parseTokenCount(' 200k ')).toBe(200000);
    });

    it('returns 0 for undefined', () => {
      expect(parseTokenCount(undefined)).toBe(0);
    });

    it('returns 0 for null', () => {
      expect(parseTokenCount(null as any)).toBe(0);
    });

    it('returns 0 for invalid string', () => {
      expect(parseTokenCount('abc')).toBe(0);
    });
  });

  describe('formatTokenCount', () => {
    it('formats millions as m', () => {
      expect(formatTokenCount(1000000)).toBe('1m');
      expect(formatTokenCount(2000000)).toBe('2m');
    });

    it('formats decimal millions', () => {
      expect(formatTokenCount(1500000)).toBe('1.5m');
    });

    it('formats thousands as k', () => {
      expect(formatTokenCount(200000)).toBe('200k');
      expect(formatTokenCount(1000)).toBe('1k');
    });

    it('formats decimal thousands', () => {
      expect(formatTokenCount(15500)).toBe('15.5k');
    });

    it('formats small numbers as-is', () => {
      expect(formatTokenCount(500)).toBe('500');
      expect(formatTokenCount(0)).toBe('0');
    });
  });

  describe('shellQuote', () => {
    it('does not quote safe strings (alphanumeric + common safe chars)', () => {
      expect(shellQuote('hello')).toBe('hello');
      expect(shellQuote('test-agent')).toBe('test-agent');
      expect(shellQuote('/path/to/file.md')).toBe('/path/to/file.md');
    });

    it('quotes strings with spaces', () => {
      expect(shellQuote('hello world')).toBe("'hello world'");
    });

    it('escapes single quotes', () => {
      expect(shellQuote("it's")).toBe("'it'\\''s'");
    });

    it('quotes empty string', () => {
      expect(shellQuote('')).toBe("''");
    });
  });
});
