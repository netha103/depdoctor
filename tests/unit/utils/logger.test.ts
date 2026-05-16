import { describe, it, expect, vi, beforeEach } from 'vitest';
import { logger } from '../../../src/utils/logger.js';

beforeEach(() => {
  // Reset logger state between tests by re-enabling modes
  vi.restoreAllMocks();
});

describe('logger', () => {
  it('calls console.log for info messages', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    logger.info('test message');
    expect(spy).toHaveBeenCalled();
    const output = spy.mock.calls[0]?.join(' ') ?? '';
    expect(output).toContain('test message');
  });

  it('calls console.log for success messages', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    logger.success('all good');
    expect(spy).toHaveBeenCalled();
  });

  it('calls console.warn for warn messages', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    logger.warn('be careful');
    expect(spy).toHaveBeenCalled();
  });

  it('calls console.error for error messages', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    logger.error('something broke');
    expect(spy).toHaveBeenCalled();
  });

  it('does not emit debug messages when debug is disabled', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    logger.debug('hidden debug');
    // debug should be silent by default
    const calls = spy.mock.calls.map((c) => c.join(' '));
    expect(calls.some((c) => c.includes('hidden debug'))).toBe(false);
  });
});
