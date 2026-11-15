import { ELEVENLABS_LIMITS } from './constants';
import { AppError, ERROR_CODES } from './errors';
import type { DialogueInput, ParseWarning, ScriptLine } from '@podcast/types';

export interface ChunkingOptions {
  /** Max characters per chunk. Defaults to the ElevenLabs limit (2000). */
  charLimit?: number;
  /** Split oversized single lines on `;` and `,` as well as sentence ends. */
  splitOnClauses?: boolean;
}

export interface ChunkPiece {
  chunkIndex: number;
  startLine: number;
  endLine: number;
  characterCount: number;
  inputCount: number;
  /** 1-based line sequence numbers covered by this chunk. */
  lineSequences: number[];
  /**
   * Present only when a single over-long turn had to be split: the exact text
   * slice this chunk should send. When undefined the caller rebuilds the text
   * from the referenced lines.
   */
  splitText?: string;
}

export interface ChunkDraft {
  chunks: ChunkPiece[];
  warnings: ParseWarning[];
}

interface WorkingChunk {
  lines: ScriptLine[];
  chars: number;
  startLine: number | null;
  endLine: number | null;
}

function newChunk(): WorkingChunk {
  return { lines: [], chars: 0, startLine: null, endLine: null };
}

/**
 * Length of a line as it contributes to the API character budget. Audio tags
 * are part of `inputs[].text` and therefore count (docs/09 §9.2).
 */
export function lineLength(line: ScriptLine): number {
  return line.text.length;
}

/**
 * Split a single over-long line into pieces each within `charLimit`.
 * Strategy per docs/11 §11.3:
 *   1. sentence boundaries  2. clause boundaries  3. hard cut
 */
export function splitOversizedLine(
  line: ScriptLine,
  charLimit: number,
  splitOnClauses = true,
): { pieces: string[]; hardCut: boolean } {
  const pieces: string[] = [];
  let hardCut = false;

  const boundarySplit = (text: string, pattern: RegExp): string[] => {
    // Keep the delimiter attached to the preceding fragment.
    const parts = text.split(pattern).filter((p) => p !== '');
    const out: string[] = [];
    let buffer = '';
    for (const part of parts) {
      if (part.length > charLimit) {
        // A single fragment is already too large; fall through to hard cut.
        if (buffer) {
          out.push(buffer);
          buffer = '';
        }
        out.push(part);
        continue;
      }
      if ((buffer + part).length > charLimit) {
        out.push(buffer);
        buffer = part;
      } else {
        buffer += part;
      }
    }
    if (buffer) out.push(buffer);
    return out;
  };

  let segments = boundarySplit(line.text, /(?<=[.!?…])\s+/);

  if (splitOnClauses) {
    segments = segments.flatMap((seg) => (seg.length > charLimit ? boundarySplit(seg, /(?<=[;,]\s)/) : [seg]));
  }

  for (const seg of segments) {
    const trimmed = seg.trim();
    if (trimmed === '') continue;
    if (trimmed.length <= charLimit) {
      pieces.push(trimmed);
      continue;
    }
    // Final resort: hard cut on the limit, preferring whitespace.
    hardCut = true;
    let rest = trimmed;
    while (rest.length > charLimit) {
      let cut = rest.lastIndexOf(' ', charLimit);
      if (cut < Math.floor(charLimit * 0.5)) cut = charLimit;
      pieces.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) pieces.push(rest);
  }

  return { pieces: pieces.filter((p) => p.length > 0), hardCut };
}

/**
 * Group script lines into chunks that respect the character budget without
 * ever splitting a turn (line) across chunks — see docs/11 §11.1.
 *
 * The algorithm is the one specified in docs/11 §11.2, with the addition that
 * an oversized single line is split rather than rejected.
 */
export function chunkScriptLines(
  lines: ScriptLine[],
  options: ChunkingOptions = {},
): ChunkDraft {
  const charLimit = options.charLimit ?? ELEVENLABS_LIMITS.MAX_CHARS_PER_REQUEST;
  const splitOnClauses = options.splitOnClauses ?? true;

  if (!Number.isFinite(charLimit) || charLimit < 1) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'charLimit must be a positive number.', 400);
  }

  const chunks: ChunkDraft['chunks'] = [];
  const warnings: ParseWarning[] = [];
  let current = newChunk();

  const flush = () => {
    if (current.lines.length === 0) return;
    chunks.push({
      chunkIndex: chunks.length + 1,
      startLine: current.startLine ?? current.lines[0].sequence,
      endLine: current.endLine ?? current.lines[current.lines.length - 1].sequence,
      characterCount: current.chars,
      inputCount: current.lines.length,
      lineSequences: current.lines.map((l) => l.sequence),
    });
    current = newChunk();
  };

  for (const line of lines) {
    const len = lineLength(line);

    // Oversized single turn: split it, each piece becomes its own chunk.
    if (len > charLimit) {
      flush();
      const { pieces, hardCut } = splitOversizedLine(line, charLimit, splitOnClauses);
      for (const piece of pieces) {
        chunks.push({
          chunkIndex: chunks.length + 1,
          startLine: line.sequence,
          endLine: line.sequence,
          characterCount: piece.length,
          inputCount: 1,
          lineSequences: [line.sequence],
          splitText: piece,
        });
      }
      warnings.push({
        code: 'LINE_HARD_CUT',
        line: line.sequence,
        raw: line.text.slice(0, 80),
        message: hardCut
          ? `Turn ${line.sequence} exceeded ${charLimit} characters and was hard-cut mid-sentence.`
          : `Turn ${line.sequence} exceeded ${charLimit} characters and was split into ${pieces.length} chunks.`,
      });
      continue;
    }

    const wouldExceed = current.chars + len > charLimit;
    if (wouldExceed && current.lines.length > 0) {
      flush();
    }

    current.lines.push(line);
    current.chars += len;
    if (current.startLine === null) current.startLine = line.sequence;
    current.endLine = line.sequence;
  }

  flush();

  return { chunks, warnings };
}

/**
 * Build the ElevenLabs `inputs[]` array from chunk lines plus voice mappings.
 * Throws when a speaker has no voice assigned — we never invent a voice_id
 * (docs/09 §9.6).
 */
export function buildChunkInputs(
  lines: ScriptLine[],
  voiceMappings: Record<string, string>,
): { inputs: DialogueInput[]; missingMappings: string[]; uniqueVoiceCount: number } {
  const missing = new Set<string>();
  const inputs: DialogueInput[] = [];

  for (const line of lines) {
    const voiceId = voiceMappings[line.speaker];
    if (!voiceId) {
      missing.add(line.speaker);
      continue;
    }
    inputs.push({ text: line.text, voice_id: voiceId });
  }

  if (missing.size > 0) {
    throw new AppError(
      ERROR_CODES.MISSING_VOICE_MAPPING,
      `No voice assigned for character(s): ${Array.from(missing).join(', ')}.`,
      422,
      { characters: Array.from(missing) },
    );
  }

  const uniqueVoiceCount = new Set(inputs.map((i) => i.voice_id)).size;
  return { inputs, missingMappings: [], uniqueVoiceCount };
}

/** Guard used before enqueueing; mirrors docs/11 §11.4. */
export function assertChunkWithinLimits(chunk: {
  chunkIndex: number;
  characterCount: number;
  inputCount: number;
  uniqueVoiceCount?: number;
}): void {
  const limit = ELEVENLABS_LIMITS.MAX_CHARS_PER_REQUEST;
  if (chunk.characterCount > limit) {
    throw new AppError(
      ERROR_CODES.CHUNK_TOO_LARGE,
      `Chunk ${chunk.chunkIndex} is ${chunk.characterCount} characters (limit ${limit}).`,
      422,
      { chunkIndex: chunk.chunkIndex, characterCount: chunk.characterCount, limit },
    );
  }
  if (chunk.inputCount < 1) {
    throw new AppError(
      ERROR_CODES.VALIDATION_FAILED,
      `Chunk ${chunk.chunkIndex} has no dialogue inputs.`,
      422,
      { chunkIndex: chunk.chunkIndex },
    );
  }
}
