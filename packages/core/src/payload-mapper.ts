import {
  ALLOWED_MODEL_IDS,
  ALLOWED_OUTPUT_FORMATS,
  ALLOWED_TEXT_NORMALIZATION,
  ELEVENLABS_LIMITS,
} from './constants';
import { buildChunkInputs, chunkScriptLines, lineLength, splitOversizedLine } from './chunking';
import { AppError, ERROR_CODES } from './errors';
import type {
  ApplyTextNormalization,
  ChunkedPayload,
  CreateDialogueRequest,
  DialogueInput,
  ScriptLine,
  ValidationIssue,
  ValidationResult,
} from '@podcast/types';
import { sha256, stableStringify } from './utils';

export interface PayloadMapperInput {
  lines: ScriptLine[];
  voiceMappings: Record<string, string>;
  modelId?: string;
  languageCode?: string;
  settings?: Record<string, unknown>;
  seed?: number | null;
  applyTextNormalization?: ApplyTextNormalization;
  outputFormat?: string;
  pronunciationDictionaryLocators?: unknown[];
  /** Overrides the 2000-char budget; mainly for tests. */
  charLimit?: number;
}

export interface PayloadMapperResult {
  /** The full, un-chunked payload covering every line. */
  payload: CreateDialogueRequest;
  chunked: ChunkedPayload[];
  missingMappings: string[];
  uniqueVoiceCount: number;
  warnings: ValidationIssue[];
  totalCharacters: number;
}

function normaliseSettings(settings?: Record<string, unknown>): Record<string, unknown> {
  if (!settings) return {};
  // Drop undefined values so the JSON snapshot stays clean.
  return Object.fromEntries(Object.entries(settings).filter(([, v]) => v !== undefined));
}

/**
 * Build the normalized multi-speaker payload and its chunked variants. The API
 * worker sends each turn as a separate ElevenLabs Text-to-Speech request.
 *
 * The full payload is useful for preview/inspection; the chunked array is what
 * actually gets enqueued, because each request must stay within the character
 * and voice-count limits (docs/09 §9.2).
 */
export function buildPayload(input: PayloadMapperInput): PayloadMapperResult {
  const {
    lines,
    voiceMappings,
    modelId = ELEVENLABS_LIMITS.DEFAULT_MODEL_ID,
    languageCode = 'en',
    settings,
    seed = null,
    applyTextNormalization = 'auto',
    outputFormat,
    pronunciationDictionaryLocators = [],
    charLimit = ELEVENLABS_LIMITS.MAX_CHARS_PER_REQUEST,
  } = input;

  if (lines.length === 0) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Cannot build a payload from an empty script.', 400);
  }

  const modelIdError = validateModelId(modelId);
  if (modelIdError) throw modelIdError;

  const { inputs, uniqueVoiceCount } = buildChunkInputs(lines, voiceMappings);

  const shared = {
    model_id: modelId,
    language_code: languageCode,
    settings: normaliseSettings(settings),
    pronunciation_dictionary_locators: pronunciationDictionaryLocators,
    seed,
    apply_text_normalization: applyTextNormalization,
    ...(outputFormat ? { output_format: outputFormat } : {}),
  };

  const payload: CreateDialogueRequest = { inputs, ...shared };

  const draft = chunkScriptLines(lines, { charLimit });
  const chunks: ChunkedPayload[] = [];
  const linesBySequence = new Map(lines.map((l) => [l.sequence, l]));

  for (const chunk of draft.chunks) {
    // When a single over-long turn was split, chunkScriptLines already carries
    // the exact text slice for this chunk in `splitText`, so we consume it
    // directly instead of re-deriving it (which was ambiguous when two slices
    // happened to have the same length).
    const isSplitTurn = chunk.splitText !== undefined;
    let chunkInputs: DialogueInput[];

    if (isSplitTurn) {
      const source = linesBySequence.get(chunk.lineSequences[0])!;
      const voiceId = voiceMappings[source.speaker];
      if (!voiceId) {
        throw new AppError(
          ERROR_CODES.MISSING_VOICE_MAPPING,
          `No voice assigned for character '${source.speaker}'.`,
          422,
          { characters: [source.speaker] },
        );
      }
      chunkInputs = [{ text: chunk.splitText!, voice_id: voiceId }];
    } else {
      const resolved = chunk.lineSequences
        .map((seq) => linesBySequence.get(seq))
        .filter((l): l is ScriptLine => Boolean(l));
      chunkInputs = buildChunkInputs(resolved, voiceMappings).inputs;
    }

    const chunkPayload: CreateDialogueRequest = { inputs: chunkInputs, ...shared };

    chunks.push({
      chunkIndex: chunk.chunkIndex,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      characterCount: chunk.characterCount,
      inputCount: chunkInputs.length,
      uniqueVoiceCount: new Set(chunkInputs.map((i) => i.voice_id)).size,
      inputs: chunkInputs,
      payload: chunkPayload,
      payloadHash: sha256(stableStringify(chunkPayload)),
    });
  }

  const warnings: ValidationIssue[] = draft.warnings.map((w) => ({
    code: w.code,
    message: w.message,
    chunkIndex: undefined,
  }));

  return {
    payload,
    chunked: chunks,
    missingMappings: [],
    uniqueVoiceCount,
    warnings,
    totalCharacters: lines.reduce((sum, l) => sum + lineLength(l), 0),
  };
}

export function validateModelId(modelId: string): AppError | null {
  if (!(ALLOWED_MODEL_IDS as readonly string[]).includes(modelId)) {
    return new AppError(
      ERROR_CODES.VALIDATION_FAILED,
      `model_id '${modelId}' is not allowed. Allowed: ${ALLOWED_MODEL_IDS.join(', ')}.`,
      400,
      { field: 'model_id' },
    );
  }
  return null;
}

/**
 * Full payload validation. Returns issues rather than throwing so the Payload
 * Editor can highlight every problem at once (docs/04 FR-05).
 */
export function validatePayload(
  payload: CreateDialogueRequest,
  chunked?: ChunkedPayload[],
): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const limit = ELEVENLABS_LIMITS.MAX_CHARS_PER_REQUEST;

  if (!payload || typeof payload !== 'object') {
    return {
      valid: false,
      errors: [{ code: 'VALIDATION_FAILED', message: 'Payload must be an object.' }],
      warnings,
    };
  }

  if (!Array.isArray(payload.inputs) || payload.inputs.length === 0) {
    errors.push({ code: 'INPUTS_EMPTY', message: 'inputs must contain at least one dialogue entry.' });
  } else {
    payload.inputs.forEach((entry, index) => {
      if (typeof entry?.text !== 'string' || entry.text.trim() === '') {
        errors.push({
          code: 'EMPTY_TEXT',
          message: `inputs[${index}].text is empty.`,
          field: `inputs[${index}].text`,
        });
      }
      if (!entry?.voice_id) {
        errors.push({
          code: 'EMPTY_VOICE_ID',
          message: `inputs[${index}].voice_id is missing.`,
          field: `inputs[${index}].voice_id`,
        });
      }
    });

    const totalChars = payload.inputs.reduce((sum, i) => sum + (i.text?.length ?? 0), 0);
    if (totalChars > limit) {
      errors.push({
        code: ERROR_CODES.CHUNK_TOO_LARGE,
        message: `Payload totals ${totalChars} characters, limit is ${limit}.`,
      });
    }
  }

  const modelError = payload.model_id ? validateModelId(payload.model_id) : null;
  if (!payload.model_id) {
    errors.push({ code: 'MISSING_MODEL_ID', message: 'model_id is required.', field: 'model_id' });
  } else if (modelError) {
    errors.push({ code: modelError.code, message: modelError.message, field: 'model_id' });
  }

  if (
    payload.apply_text_normalization &&
    !(ALLOWED_TEXT_NORMALIZATION as readonly string[]).includes(payload.apply_text_normalization)
  ) {
    errors.push({
      code: 'INVALID_TEXT_NORMALIZATION',
      message: `apply_text_normalization must be one of ${ALLOWED_TEXT_NORMALIZATION.join(', ')}.`,
      field: 'apply_text_normalization',
    });
  }

  if (payload.output_format && !(ALLOWED_OUTPUT_FORMATS as readonly string[]).includes(payload.output_format)) {
    errors.push({
      code: 'INVALID_OUTPUT_FORMAT',
      message: `output_format '${payload.output_format}' is not supported.`,
      field: 'output_format',
    });
  }

  if (chunked) {
    if (chunked.length === 0) {
      errors.push({ code: 'NO_CHUNKS', message: 'Chunking produced no chunks.' });
    }
    chunked.forEach((chunk) => {
      if (chunk.characterCount > limit) {
        errors.push({
          code: ERROR_CODES.CHUNK_TOO_LARGE,
          message: `Chunk ${chunk.chunkIndex} has ${chunk.characterCount} characters (limit ${limit}).`,
          chunkIndex: chunk.chunkIndex,
        });
      }
      if (chunk.inputCount < 1) {
        errors.push({
          code: 'EMPTY_CHUNK',
          message: `Chunk ${chunk.chunkIndex} has no inputs.`,
          chunkIndex: chunk.chunkIndex,
        });
      }
      if (chunk.characterCount > limit * 0.9) {
        warnings.push({
          code: 'NEAR_CHAR_LIMIT',
          message: `Chunk ${chunk.chunkIndex} is close to the ${limit}-character limit.`,
          chunkIndex: chunk.chunkIndex,
        });
      }
    });

    // Chunk boundaries must be contiguous and non-overlapping.
    for (let i = 1; i < chunked.length; i++) {
      const prev = chunked[i - 1];
      const curr = chunked[i];
      const isContinuation = curr.startLine === prev.endLine;
      if (!isContinuation && curr.startLine !== prev.endLine + 1) {
        errors.push({
          code: 'NON_CONTIGUOUS_CHUNKS',
          message: `Chunk ${curr.chunkIndex} starts at line ${curr.startLine} but previous chunk ended at ${prev.endLine}.`,
          chunkIndex: curr.chunkIndex,
        });
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}
