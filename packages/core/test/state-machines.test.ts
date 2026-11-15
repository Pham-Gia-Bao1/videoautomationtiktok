import { describe, expect, it } from 'vitest';
import {
  assertBatchTransition,
  assertChunkTransition,
  backoffDelayMs,
  canTransitionBatch,
  canTransitionChunk,
  countChunkStatuses,
  recomputeBatchStatus,
} from '../src/state-machines';
import { AppError } from '../src/errors';
import type { ChunkStatus } from '@podcast/types';

describe('countChunkStatuses', () => {
  it('buckets QUEUED and RUNNING together as in-flight', () => {
    const counts = countChunkStatuses(['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'PENDING']);
    expect(counts).toEqual({
      total: 5,
      completed: 1,
      failed: 1,
      running: 2,
      pending: 1,
      cancelled: 0,
    });
  });

  it('handles an empty list', () => {
    expect(countChunkStatuses([]).total).toBe(0);
  });
});

describe('recomputeBatchStatus', () => {
  const all = (...statuses: ChunkStatus[]) => statuses;

  it('is DRAFT with no chunks', () => {
    expect(recomputeBatchStatus([])).toBe('DRAFT');
  });

  it('is RUNNING while any chunk is in flight', () => {
    expect(recomputeBatchStatus(all('COMPLETED', 'RUNNING'))).toBe('RUNNING');
    expect(recomputeBatchStatus(all('COMPLETED', 'QUEUED'))).toBe('RUNNING');
  });

  it('is COMPLETED when every chunk succeeded', () => {
    expect(recomputeBatchStatus(all('COMPLETED', 'COMPLETED'))).toBe('COMPLETED');
  });

  it('is FAILED when every chunk failed', () => {
    expect(recomputeBatchStatus(all('FAILED', 'FAILED'))).toBe('FAILED');
  });

  it('is CANCELLED when every chunk was cancelled', () => {
    expect(recomputeBatchStatus(all('CANCELLED', 'CANCELLED'))).toBe('CANCELLED');
  });

  it('is PARTIAL when some succeeded and some failed', () => {
    expect(recomputeBatchStatus(all('COMPLETED', 'FAILED'))).toBe('PARTIAL');
  });

  it('is PARTIAL when some succeeded and the rest were cancelled', () => {
    expect(recomputeBatchStatus(all('COMPLETED', 'CANCELLED'))).toBe('PARTIAL');
  });

  it('is QUEUED when all chunks are still pending', () => {
    expect(recomputeBatchStatus(all('PENDING', 'PENDING'))).toBe('QUEUED');
  });
});

describe('batch transitions', () => {
  it('allows DRAFT -> QUEUED', () => {
    expect(canTransitionBatch('DRAFT', 'QUEUED')).toBe(true);
    expect(() => assertBatchTransition('DRAFT', 'QUEUED')).not.toThrow();
  });

  it('allows RUNNING -> PARTIAL', () => {
    expect(canTransitionBatch('RUNNING', 'PARTIAL')).toBe(true);
  });

  it('forbids COMPLETED -> RUNNING', () => {
    expect(canTransitionBatch('COMPLETED', 'RUNNING')).toBe(false);
    expect(() => assertBatchTransition('COMPLETED', 'RUNNING')).toThrowError(AppError);
  });

  it('allows FAILED -> QUEUED for a batch-level retry', () => {
    expect(canTransitionBatch('FAILED', 'QUEUED')).toBe(true);
  });

  it('treats a self-transition as valid', () => {
    expect(canTransitionBatch('RUNNING', 'RUNNING')).toBe(true);
  });
});

describe('chunk transitions', () => {
  it('allows the happy path', () => {
    expect(canTransitionChunk('PENDING', 'QUEUED')).toBe(true);
    expect(canTransitionChunk('QUEUED', 'RUNNING')).toBe(true);
    expect(canTransitionChunk('RUNNING', 'COMPLETED')).toBe(true);
  });

  it('allows retry from FAILED back to QUEUED', () => {
    expect(canTransitionChunk('FAILED', 'QUEUED')).toBe(true);
  });

  it('forbids completing a PENDING chunk', () => {
    expect(canTransitionChunk('PENDING', 'COMPLETED')).toBe(false);
    expect(() => assertChunkTransition('PENDING', 'COMPLETED')).toThrowError(AppError);
  });

  it('reports the invalid transition in the error meta', () => {
    try {
      assertChunkTransition('COMPLETED', 'RUNNING');
    } catch (err) {
      const appError = err as AppError;
      expect(appError.code).toBe('INVALID_STATE');
      expect(appError.status).toBe(409);
      expect(appError.meta).toMatchObject({ entity: 'generation chunk', from: 'COMPLETED', to: 'RUNNING' });
    }
  });
});

describe('backoffDelayMs', () => {
  it('produces 3s, 9s, 27s', () => {
    expect(backoffDelayMs(1)).toBe(3000);
    expect(backoffDelayMs(2)).toBe(9000);
    expect(backoffDelayMs(3)).toBe(27000);
  });

  it('honours a custom base delay', () => {
    expect(backoffDelayMs(2, 1000)).toBe(3000);
  });

  it('clamps attempt 0 to the base delay', () => {
    expect(backoffDelayMs(0)).toBe(3000);
  });
});
