import { afterEach, describe, expect, it, vi } from 'vitest';
import { errorMessage, toolErrorResult } from './tool-error.js';

const circular: Record<string, unknown> = {};
circular.self = circular;

describe('errorMessage', () => {
  it.each<[string, unknown, string]>([
    ['Error with a message', new Error('x'), 'x'],
    ['Error with an empty message', new Error(''), 'Error'],
    ['TypeError with an empty message', new TypeError(''), 'TypeError'],
    ['non-empty string', 'boom', 'boom'],
    ['empty string', '', 'unknown error'],
    ['undefined', undefined, 'unknown error (undefined)'],
    ['null', null, 'unknown error (null)'],
    ['plain object', { code: 1 }, '{"code":1}'],
    ['circular object', circular, '[object Object]'],
    ['number', 42, '42'],
    ['Error whose message is the string "undefined"', new Error('undefined'), 'undefined'],
  ])('%s', (_label, input, expected) => {
    expect(errorMessage(input)).toBe(expected);
  });
});

describe('toolErrorResult', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('builds an MCP error response, logs the exception once, and keeps the stack out of the text', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const error = new Error('boom');

    const result = toolErrorResult('Sync failed', error);

    expect(result).toEqual({
      isError: true,
      content: [{ type: 'text', text: 'Sync failed: boom' }],
    });
    expect(result.content[0]?.text).not.toContain('at ');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toBe('[aegis] Sync failed:');
    expect(spy.mock.calls[0]?.[1]).toBe(error);
  });
});
