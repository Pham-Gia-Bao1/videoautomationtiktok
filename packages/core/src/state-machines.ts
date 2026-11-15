import { AppError, ERROR_CODES } from './errors';
import type { BatchStatus, ChunkStatus, CompositionStatus, TranscriptionStatus } from '@podcast/types';

/* -------------------------------------------------------------------------- */
/* Transition tables (docs/16-state-machines.md)                              */
/* -------------------------------------------------------------------------- */

export const BATCH_TRANSITIONS: Record<BatchStatus, BatchStatus[]> = {
  DRAFT: ['QUEUED', 'CANCELLED'],
  QUEUED: ['RUNNING', 'CANCELLED', 'FAILED'],
  RUNNING: ['COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED'],
  PARTIAL: ['RUNNING', 'QUEUED', 'COMPLETED', 'FAILED', 'CANCELLED'],
  COMPLETED: [],
  FAILED: ['QUEUED'],
  CANCELLED: [],
};

export const CHUNK_TRANSITIONS: Record<ChunkStatus, ChunkStatus[]> = {
  PENDING: ['QUEUED', 'CANCELLED'],
  QUEUED: ['RUNNING', 'FAILED', 'CANCELLED'],
  RUNNING: ['COMPLETED', 'FAILED'],
  COMPLETED: [],
  FAILED: ['QUEUED'],
  CANCELLED: [],
};

export const COMPOSITION_TRANSITIONS: Record<CompositionStatus, CompositionStatus[]> = {
  DRAFT: ['MERGING'],
  MERGING: ['READY', 'FAILED'],
  READY: [],
  FAILED: ['MERGING'],
};

export const TRANSCRIPTION_TRANSITIONS: Record<TranscriptionStatus, TranscriptionStatus[]> = {
  PENDING: ['RUNNING', 'FAILED'],
  RUNNING: ['COMPLETED', 'FAILED'],
  COMPLETED: [],
  FAILED: ['RUNNING'],
};

function assertTransition<T extends string>(
  transitions: Record<T, T[]>,
  from: T,
  to: T,
  entity: string,
): void {
  if (from === to) return;
  const allowed = transitions[from] ?? [];
  if (!allowed.includes(to)) {
    throw new AppError(
      ERROR_CODES.INVALID_STATE,
      `Cannot transition ${entity} from ${from} to ${to}. Allowed: ${allowed.join(', ') || 'none'}.`,
      409,
      { entity, from, to, allowed },
    );
  }
}

export const canTransitionBatch = (from: BatchStatus, to: BatchStatus) =>
  from === to || (BATCH_TRANSITIONS[from] ?? []).includes(to);
export const assertBatchTransition = (from: BatchStatus, to: BatchStatus) =>
  assertTransition(BATCH_TRANSITIONS, from, to, 'generation batch');

export const canTransitionChunk = (from: ChunkStatus, to: ChunkStatus) =>
  from === to || (CHUNK_TRANSITIONS[from] ?? []).includes(to);
export const assertChunkTransition = (from: ChunkStatus, to: ChunkStatus) =>
  assertTransition(CHUNK_TRANSITIONS, from, to, 'generation chunk');

export const canTransitionComposition = (from: CompositionStatus, to: CompositionStatus) =>
  from === to || (COMPOSITION_TRANSITIONS[from] ?? []).includes(to);
export const assertCompositionTransition = (from: CompositionStatus, to: CompositionStatus) =>
  assertTransition(COMPOSITION_TRANSITIONS, from, to, 'composition');

export const canTransitionTranscription = (from: TranscriptionStatus, to: TranscriptionStatus) =>
  from === to || (TRANSCRIPTION_TRANSITIONS[from] ?? []).includes(to);
export const assertTranscriptionTransition = (from: TranscriptionStatus, to: TranscriptionStatus) =>
  assertTransition(TRANSCRIPTION_TRANSITIONS, from, to, 'transcription');

/* -------------------------------------------------------------------------- */
/* Batch status recomputation (docs/16 §16.5)                                 */
/* -------------------------------------------------------------------------- */

export interface ChunkStatusCounts {
  total: number;
  completed: number;
  failed: number;
  running: number;
  pending: number;
  cancelled: number;
}

export function countChunkStatuses(statuses: ChunkStatus[]): ChunkStatusCounts {
  const counts: ChunkStatusCounts = {
    total: statuses.length,
    completed: 0,
    failed: 0,
    running: 0,
    pending: 0,
    cancelled: 0,
  };
  for (const status of statuses) {
    switch (status) {
      case 'COMPLETED':
        counts.completed++;
        break;
      case 'FAILED':
        counts.failed++;
        break;
      case 'RUNNING':
      case 'QUEUED':
        counts.running++;
        break;
      case 'CANCELLED':
        counts.cancelled++;
        break;
      default:
        counts.pending++;
    }
  }
  return counts;
}

/**
 * Derive the batch status from its chunks. Mirrors docs/16 §16.5 exactly:
 * in-flight work wins, then all-complete, then all-failed, then partial.
 */
export function recomputeBatchStatus(statuses: ChunkStatus[]): BatchStatus {
  const counts = countChunkStatuses(statuses);

  if (counts.total === 0) return 'DRAFT';
  if (counts.running > 0) return 'RUNNING';

  const settled = counts.completed + counts.failed + counts.cancelled;

  if (counts.completed === counts.total) return 'COMPLETED';
  if (counts.failed === counts.total) return 'FAILED';
  if (counts.cancelled === counts.total) return 'CANCELLED';
  if (counts.completed > 0 && settled === counts.total) return 'PARTIAL';
  if (settled === counts.total) return 'FAILED';
  return 'QUEUED';
}

/** Exponential retry delay: 3s → 9s → 27s (docs/18 §18.2). */
export function backoffDelayMs(attempt: number, baseMs = 3000): number {
  const exponent = Math.max(0, attempt - 1);
  return baseMs * 3 ** exponent;
}
