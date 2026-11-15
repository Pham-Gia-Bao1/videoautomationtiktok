/**
 * Canonical error codes. Kept in one place so the API layer, workers and the
 * frontend can all branch on a stable string. See docs/08 §8.6 and docs/18 §18.1.
 */
export const ERROR_CODES = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',

  ELEVENLABS_BAD_REQUEST: 'ELEVENLABS_BAD_REQUEST',
  ELEVENLABS_UNAUTHORIZED: 'ELEVENLABS_UNAUTHORIZED',
  ELEVENLABS_UNPROCESSABLE: 'ELEVENLABS_UNPROCESSABLE',
  ELEVENLABS_PAYMENT_REQUIRED: 'ELEVENLABS_PAYMENT_REQUIRED',
  ELEVENLABS_RATE_LIMIT: 'ELEVENLABS_RATE_LIMIT',
  ELEVENLABS_API_ERROR: 'ELEVENLABS_API_ERROR',
  ELEVENLABS_TIMEOUT: 'ELEVENLABS_TIMEOUT',

  CHUNK_TOO_LARGE: 'CHUNK_TOO_LARGE',
  MISSING_VOICE_MAPPING: 'MISSING_VOICE_MAPPING',

  FFMPEG_FAILED: 'FFMPEG_FAILED',
  FFMPEG_TIMEOUT: 'FFMPEG_TIMEOUT',
  STORAGE_FAILED: 'STORAGE_FAILED',

  INVALID_STATE: 'INVALID_STATE',
  INTERNAL: 'INTERNAL',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/** Codes that are safe to retry automatically (docs/18 §18.1). */
const RETRYABLE_CODES = new Set<string>([
  ERROR_CODES.ELEVENLABS_RATE_LIMIT,
  ERROR_CODES.ELEVENLABS_API_ERROR,
  ERROR_CODES.ELEVENLABS_TIMEOUT,
  ERROR_CODES.FFMPEG_FAILED,
  ERROR_CODES.FFMPEG_TIMEOUT,
  ERROR_CODES.STORAGE_FAILED,
  ERROR_CODES.INTERNAL,
]);

export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  readonly meta?: Record<string, unknown>;
  /** Correlation id is attached by the HTTP layer when serialising. */
  correlationId?: string;

  constructor(code: string, message: string, status = 500, meta?: Record<string, unknown>) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.meta = meta;
    Object.setPrototypeOf(this, AppError.prototype);
  }

  get retryable(): boolean {
    return RETRYABLE_CODES.has(this.code);
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      status: this.status,
      meta: this.meta,
      retryable: this.retryable,
    };
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}

export const badRequest = (code: string, message: string, meta?: Record<string, unknown>) =>
  new AppError(code, message, 400, meta);

export const notFound = (what: string, id?: string) =>
  new AppError(ERROR_CODES.NOT_FOUND, `${what}${id ? ` '${id}'` : ''} not found`, 404);

export const conflict = (message: string, meta?: Record<string, unknown>) =>
  new AppError(ERROR_CODES.CONFLICT, message, 409, meta);
