import { describe, expect, it } from 'vitest';
import { sha256, slugify, stableStringify, titleCase, unique } from '../src/utils';
import { AppError, ERROR_CODES, isAppError, notFound } from '../src/errors';

describe('slugify', () => {
  it('lowercases and replaces separators with underscores', () => {
    expect(slugify('Sarah Smith')).toBe('sarah_smith');
    expect(slugify('Dr. Smith')).toBe('dr_smith');
  });

  it('strips apostrophes rather than converting them to separators', () => {
    expect(slugify("O'Brien")).toBe('obrien');
  });

  it('removes diacritics', () => {
    expect(slugify('Renée')).toBe('renee');
    expect(slugify('Nguyễn')).toBe('nguyen');
  });

  it('collapses repeated separators and trims edges', () => {
    expect(slugify('  --Hello   World--  ')).toBe('hello_world');
  });
});

describe('titleCase', () => {
  it('humanises a slug', () => {
    expect(titleCase('sarah_smith')).toBe('Sarah Smith');
  });
});

describe('stableStringify', () => {
  it('is independent of key insertion order', () => {
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
  });

  it('preserves array order', () => {
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]));
  });

  it('drops undefined values', () => {
    expect(stableStringify({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('handles nested structures', () => {
    const value = { z: { b: 1, a: 2 }, a: [1, { d: 4, c: 3 }] };
    expect(stableStringify(value)).toBe(stableStringify(JSON.parse(JSON.stringify(value))));
  });

  it('serialises null and primitives', () => {
    expect(stableStringify(null)).toBe('null');
    expect(stableStringify(5)).toBe('5');
  });
});

describe('sha256', () => {
  it('returns a 64-character hex digest', () => {
    expect(sha256('hello')).toHaveLength(64);
  });

  it('is deterministic', () => {
    expect(sha256('hello')).toBe(sha256('hello'));
  });

  it('differs for different inputs', () => {
    expect(sha256('a')).not.toBe(sha256('b'));
  });
});

describe('unique', () => {
  it('removes duplicates while preserving order', () => {
    expect(unique([3, 1, 3, 2, 1])).toEqual([3, 1, 2]);
  });
});

describe('AppError', () => {
  it('is an instance of Error and AppError', () => {
    const err = new AppError('CODE', 'message');
    expect(err).toBeInstanceOf(Error);
    expect(isAppError(err)).toBe(true);
  });

  it('defaults to status 500', () => {
    expect(new AppError('CODE', 'message').status).toBe(500);
  });

  it('marks provider rate limits as retryable', () => {
    expect(new AppError(ERROR_CODES.ELEVENLABS_RATE_LIMIT, 'x').retryable).toBe(true);
    expect(new AppError(ERROR_CODES.ELEVENLABS_API_ERROR, 'x').retryable).toBe(true);
  });

  it('marks bad requests as non-retryable', () => {
    expect(new AppError(ERROR_CODES.ELEVENLABS_BAD_REQUEST, 'x').retryable).toBe(false);
    expect(new AppError(ERROR_CODES.VALIDATION_FAILED, 'x').retryable).toBe(false);
  });

  it('serialises to JSON with code, status and retryable', () => {
    const json = new AppError('X', 'boom', 422, { field: 'a' }).toJSON();
    expect(json).toEqual({
      code: 'X',
      message: 'boom',
      status: 422,
      meta: { field: 'a' },
      retryable: false,
    });
  });

  it('isAppError rejects plain errors', () => {
    expect(isAppError(new Error('plain'))).toBe(false);
    expect(isAppError(null)).toBe(false);
  });
});

describe('notFound', () => {
  it('builds a 404 with the resource in the message', () => {
    const err = notFound('Episode', 'abc');
    expect(err.status).toBe(404);
    expect(err.message).toBe("Episode 'abc' not found");
  });
});
