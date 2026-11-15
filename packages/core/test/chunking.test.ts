import { describe, expect, it } from 'vitest';
import {
  assertChunkWithinLimits,
  buildChunkInputs,
  chunkScriptLines,
  splitOversizedLine,
} from '../src/chunking';
import { ELEVENLABS_LIMITS } from '../src/constants';
import { AppError } from '../src/errors';
import type { ScriptLine } from '@podcast/types';

function makeLines(count: number, textLength: number): ScriptLine[] {
  return Array.from({ length: count }, (_, i) => ({
    sequence: i + 1,
    speaker: i % 2 === 0 ? 'sarah' : 'daniel',
    text: 'x'.repeat(textLength),
  }));
}

describe('chunkScriptLines', () => {
  it('returns a single chunk when everything fits', () => {
    const lines: ScriptLine[] = [
      { sequence: 1, speaker: 'sarah', text: 'Hello.' },
      { sequence: 2, speaker: 'daniel', text: 'Hi.' },
    ];
    const { chunks } = chunkScriptLines(lines);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      chunkIndex: 1,
      startLine: 1,
      endLine: 2,
      inputCount: 2,
    });
  });

  it('never produces a chunk above the character limit', () => {
    const lines = makeLines(40, 200);
    const { chunks } = chunkScriptLines(lines);
    for (const chunk of chunks) {
      expect(chunk.characterCount).toBeLessThanOrEqual(ELEVENLABS_LIMITS.MAX_CHARS_PER_REQUEST);
    }
  });

  it('never splits a turn across two chunks', () => {
    const lines = makeLines(30, 300);
    const { chunks } = chunkScriptLines(lines);
    const seen = new Set<number>();
    for (const chunk of chunks) {
      // A non-split chunk must not repeat a line sequence.
      expect(new Set(chunk.lineSequences).size).toBe(chunk.lineSequences.length);
      for (const seq of chunk.lineSequences) seen.add(seq);
    }
    expect(seen.size).toBe(lines.length);
  });

  it('produces contiguous, gapless line ranges', () => {
    const lines = makeLines(25, 250);
    const { chunks } = chunkScriptLines(lines);
    expect(chunks[0].startLine).toBe(1);
    expect(chunks[chunks.length - 1].endLine).toBe(lines.length);
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].startLine).toBe(chunks[i - 1].endLine + 1);
    }
  });

  it('splits an oversized single turn and warns LINE_HARD_CUT', () => {
    const long = `${'Sentence one. '.repeat(200)}`.trim();
    const lines: ScriptLine[] = [{ sequence: 1, speaker: 'sarah', text: long }];
    const { chunks, warnings } = chunkScriptLines(lines);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.characterCount).toBeLessThanOrEqual(ELEVENLABS_LIMITS.MAX_CHARS_PER_REQUEST);
      expect(chunk.inputCount).toBe(1);
    }
    expect(warnings.some((w) => w.code === 'LINE_HARD_CUT')).toBe(true);
  });

  it('honours a custom charLimit', () => {
    const lines: ScriptLine[] = [
      { sequence: 1, speaker: 'sarah', text: 'a'.repeat(60) },
      { sequence: 2, speaker: 'daniel', text: 'b'.repeat(60) },
    ];
    const { chunks } = chunkScriptLines(lines, { charLimit: 100 });
    expect(chunks).toHaveLength(2);
  });

  it('keeps a line exactly at the limit in one chunk', () => {
    const lines: ScriptLine[] = [{ sequence: 1, speaker: 'sarah', text: 'a'.repeat(2000) }];
    const { chunks, warnings } = chunkScriptLines(lines);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].characterCount).toBe(2000);
    expect(warnings).toHaveLength(0);
  });

  it('splits the line one character over the limit', () => {
    const lines: ScriptLine[] = [{ sequence: 1, speaker: 'sarah', text: 'a'.repeat(2001) }];
    const { chunks } = chunkScriptLines(lines);
    expect(chunks).toHaveLength(2);
    for (const chunk of chunks) {
      expect(chunk.characterCount).toBeLessThanOrEqual(2000);
    }
  });

  it('returns no chunks for empty input', () => {
    expect(chunkScriptLines([]).chunks).toEqual([]);
  });

  it('rejects a non-positive charLimit', () => {
    expect(() => chunkScriptLines([], { charLimit: 0 })).toThrowError(AppError);
  });
});

describe('splitOversizedLine', () => {
  it('prefers sentence boundaries', () => {
    const line: ScriptLine = {
      sequence: 1,
      speaker: 'sarah',
      text: 'First sentence here. Second sentence here. Third sentence here.',
    };
    const { pieces } = splitOversizedLine(line, 30);
    expect(pieces.every((p) => p.length <= 30)).toBe(true);
    // Joined back together the original text is preserved (modulo whitespace).
    expect(pieces.join(' ').replace(/\s+/g, ' ')).toBe(line.text);
  });

  it('falls back to clause boundaries when a sentence is too long', () => {
    const line: ScriptLine = {
      sequence: 1,
      speaker: 'sarah',
      text: `${'word, '.repeat(30)}end.`,
    };
    const { pieces } = splitOversizedLine(line, 40);
    expect(pieces.every((p) => p.length <= 40)).toBe(true);
  });

  it('hard-cuts when no boundary is available and flags it', () => {
    const line: ScriptLine = { sequence: 1, speaker: 'sarah', text: 'a'.repeat(500) };
    const { pieces, hardCut } = splitOversizedLine(line, 100);
    expect(hardCut).toBe(true);
    expect(pieces).toHaveLength(5);
    expect(pieces.join('')).toBe(line.text);
  });

  it('prefers whitespace when hard cutting', () => {
    const line: ScriptLine = {
      sequence: 1,
      speaker: 'sarah',
      text: `${'word '.repeat(60).trim()}`,
    };
    const { pieces } = splitOversizedLine(line, 50);
    for (const piece of pieces) {
      expect(piece).not.toMatch(/^\s|\s$/);
    }
  });
});

describe('buildChunkInputs', () => {
  const lines: ScriptLine[] = [
    { sequence: 1, speaker: 'sarah', text: 'Hello.' },
    { sequence: 2, speaker: 'daniel', text: 'Hi.' },
  ];

  it('maps speakers to voice ids', () => {
    const { inputs, uniqueVoiceCount } = buildChunkInputs(lines, {
      sarah: 'voice_a',
      daniel: 'voice_b',
    });
    expect(inputs).toEqual([
      { text: 'Hello.', voice_id: 'voice_a' },
      { text: 'Hi.', voice_id: 'voice_b' },
    ]);
    expect(uniqueVoiceCount).toBe(2);
  });

  it('throws MISSING_VOICE_MAPPING rather than inventing a voice id', () => {
    expect(() => buildChunkInputs(lines, { sarah: 'voice_a' })).toThrowError(AppError);
    try {
      buildChunkInputs(lines, { sarah: 'voice_a' });
    } catch (err) {
      expect((err as AppError).code).toBe('MISSING_VOICE_MAPPING');
    }
  });

  it('counts unique voices, not inputs', () => {
    const { uniqueVoiceCount } = buildChunkInputs(lines, {
      sarah: 'same',
      daniel: 'same',
    });
    expect(uniqueVoiceCount).toBe(1);
  });
});

describe('assertChunkWithinLimits', () => {
  it('accepts a valid chunk', () => {
    expect(() =>
      assertChunkWithinLimits({ chunkIndex: 1, characterCount: 2000, inputCount: 5, uniqueVoiceCount: 3 }),
    ).not.toThrow();
  });

  it('rejects an oversized chunk with CHUNK_TOO_LARGE', () => {
    try {
      assertChunkWithinLimits({ chunkIndex: 2, characterCount: 2001, inputCount: 5 });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as AppError).code).toBe('CHUNK_TOO_LARGE');
      expect((err as AppError).status).toBe(422);
    }
  });

  it('allows more than 10 unique voices because each turn is a separate TTS request', () => {
    expect(() =>
      assertChunkWithinLimits({ chunkIndex: 1, characterCount: 10, inputCount: 11, uniqueVoiceCount: 11 }),
    ).not.toThrow();
  });

  it('rejects an empty chunk', () => {
    expect(() =>
      assertChunkWithinLimits({ chunkIndex: 1, characterCount: 0, inputCount: 0 }),
    ).toThrowError(AppError);
  });
});
