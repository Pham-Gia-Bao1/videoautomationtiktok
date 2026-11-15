import { describe, expect, it } from 'vitest';
import { buildPayload, validateModelId, validatePayload } from '../src/payload-mapper';
import { AppError } from '../src/errors';
import type { ScriptLine } from '@podcast/types';

const LINES: ScriptLine[] = [
  { sequence: 1, speaker: 'sarah', text: 'I thought you forgot about me.' },
  { sequence: 2, speaker: 'daniel', text: 'How could I forget?' },
  { sequence: 3, speaker: 'sarah', text: 'You have not called me for three months.' },
];

const MAPPINGS = { sarah: 'voice_sarah', daniel: 'voice_daniel' };

describe('buildPayload', () => {
  it('produces a valid eleven_v3 payload', () => {
    const { payload } = buildPayload({ lines: LINES, voiceMappings: MAPPINGS });
    expect(payload.model_id).toBe('eleven_v3');
    expect(payload.inputs).toHaveLength(3);
    expect(payload.inputs[0]).toEqual({
      text: 'I thought you forgot about me.',
      voice_id: 'voice_sarah',
    });
  });

  it('defaults language_code, seed and normalization', () => {
    const { payload } = buildPayload({ lines: LINES, voiceMappings: MAPPINGS });
    expect(payload.language_code).toBe('en');
    expect(payload.seed).toBeNull();
    expect(payload.apply_text_normalization).toBe('auto');
  });

  it('carries audio tags through into the input text', () => {
    const lines: ScriptLine[] = [{ sequence: 1, speaker: 'sarah', text: '[whispers] Be quiet.' }];
    const { payload } = buildPayload({ lines, voiceMappings: MAPPINGS });
    expect(payload.inputs[0].text).toBe('[whispers] Be quiet.');
  });

  it('reports unique voice count across the whole payload', () => {
    const { uniqueVoiceCount } = buildPayload({ lines: LINES, voiceMappings: MAPPINGS });
    expect(uniqueVoiceCount).toBe(2);
  });

  it('throws when a speaker has no mapping', () => {
    expect(() => buildPayload({ lines: LINES, voiceMappings: { sarah: 'v' } })).toThrowError(AppError);
  });

  it('rejects a model id outside the whitelist', () => {
    try {
      buildPayload({ lines: LINES, voiceMappings: MAPPINGS, modelId: 'gpt-4o-audio' });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as AppError).code).toBe('VALIDATION_FAILED');
    }
  });

  it('throws for an empty script', () => {
    expect(() => buildPayload({ lines: [], voiceMappings: {} })).toThrowError(AppError);
  });

  it('chunks a long script and keeps every chunk within limits', () => {
    const lines: ScriptLine[] = Array.from({ length: 60 }, (_, i) => ({
      sequence: i + 1,
      speaker: i % 2 === 0 ? 'sarah' : 'daniel',
      text: 'This is a reasonably long line of dialogue for testing purposes.',
    }));
    const { chunked } = buildPayload({ lines, voiceMappings: MAPPINGS });
    expect(chunked.length).toBeGreaterThan(1);
    for (const chunk of chunked) {
      expect(chunk.characterCount).toBeLessThanOrEqual(2000);
      expect(chunk.inputCount).toBeGreaterThan(0);
      expect(chunk.uniqueVoiceCount).toBeLessThanOrEqual(10);
    }
  });

  it('produces chunk payloads whose text lengths match characterCount', () => {
    const lines: ScriptLine[] = Array.from({ length: 40 }, (_, i) => ({
      sequence: i + 1,
      speaker: i % 2 === 0 ? 'sarah' : 'daniel',
      text: 'Short line of speech.',
    }));
    const { chunked } = buildPayload({ lines, voiceMappings: MAPPINGS });
    for (const chunk of chunked) {
      const actual = chunk.inputs.reduce((sum, i) => sum + i.text.length, 0);
      expect(actual).toBe(chunk.characterCount);
    }
  });

  it('assigns a stable payload hash independent of key order', () => {
    const a = buildPayload({ lines: LINES, voiceMappings: MAPPINGS });
    const b = buildPayload({ lines: LINES, voiceMappings: MAPPINGS });
    expect(a.chunked[0].payloadHash).toBe(b.chunked[0].payloadHash);
    expect(a.chunked[0].payloadHash).toHaveLength(64);
  });

  it('omits output_format unless provided', () => {
    const without = buildPayload({ lines: LINES, voiceMappings: MAPPINGS });
    expect(without.payload.output_format).toBeUndefined();

    const withFormat = buildPayload({
      lines: LINES,
      voiceMappings: MAPPINGS,
      outputFormat: 'mp3_44100_128',
    });
    expect(withFormat.payload.output_format).toBe('mp3_44100_128');
  });

  it('drops undefined settings keys from the payload', () => {
    const { payload } = buildPayload({
      lines: LINES,
      voiceMappings: MAPPINGS,
      settings: { stability: 0.5, similarity_boost: undefined },
    });
    expect(payload.settings).toEqual({ stability: 0.5 });
  });

  it('handles a script needing an oversized-line split end to end', () => {
    const lines: ScriptLine[] = [
      { sequence: 1, speaker: 'sarah', text: `${'Long sentence. '.repeat(200)}`.trim() },
    ];
    const { chunked } = buildPayload({ lines, voiceMappings: MAPPINGS });
    expect(chunked.length).toBeGreaterThan(1);
    for (const chunk of chunked) {
      expect(chunk.characterCount).toBeLessThanOrEqual(2000);
      const actual = chunk.inputs.reduce((sum, i) => sum + i.text.length, 0);
      expect(actual).toBe(chunk.characterCount);
    }
  });
});

describe('validateModelId', () => {
  it('accepts eleven_v3', () => {
    expect(validateModelId('eleven_v3')).toBeNull();
  });

  it('rejects unknown models', () => {
    expect(validateModelId('eleven_v4')).toBeInstanceOf(AppError);
  });
});

describe('validatePayload', () => {
  const base = {
    model_id: 'eleven_v3',
    inputs: [{ text: 'Hello', voice_id: 'v1' }],
  };

  it('accepts a well-formed payload', () => {
    const result = validatePayload(base);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejects an empty inputs array', () => {
    const result = validatePayload({ model_id: 'eleven_v3', inputs: [] });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === 'INPUTS_EMPTY')).toBe(true);
  });

  it('rejects empty text and missing voice ids', () => {
    const result = validatePayload({
      model_id: 'eleven_v3',
      inputs: [{ text: '  ', voice_id: 'v1' }, { text: 'hi', voice_id: '' }],
    });
    expect(result.errors.some((e) => e.code === 'EMPTY_TEXT')).toBe(true);
    expect(result.errors.some((e) => e.code === 'EMPTY_VOICE_ID')).toBe(true);
  });

  it('allows more than 10 unique voices with per-turn TTS generation', () => {
    const inputs = Array.from({ length: 11 }, (_, i) => ({ text: 'hi', voice_id: `v${i}` }));
    const result = validatePayload({ model_id: 'eleven_v3', inputs });
    expect(result.valid).toBe(true);
  });

  it('rejects a payload over 2000 characters', () => {
    const result = validatePayload({
      model_id: 'eleven_v3',
      inputs: [{ text: 'a'.repeat(2001), voice_id: 'v1' }],
    });
    expect(result.errors.some((e) => e.code === 'CHUNK_TOO_LARGE')).toBe(true);
  });

  it('requires model_id', () => {
    const result = validatePayload({ inputs: [{ text: 'hi', voice_id: 'v1' }] } as never);
    expect(result.errors.some((e) => e.code === 'MISSING_MODEL_ID')).toBe(true);
  });

  it('rejects an invalid output_format and text normalization', () => {
    const result = validatePayload({
      model_id: 'eleven_v3',
      inputs: [{ text: 'hi', voice_id: 'v1' }],
      output_format: 'flac_999',
      apply_text_normalization: 'maybe' as never,
    });
    expect(result.errors.some((e) => e.code === 'INVALID_OUTPUT_FORMAT')).toBe(true);
    expect(result.errors.some((e) => e.code === 'INVALID_TEXT_NORMALIZATION')).toBe(true);
  });

  it('rejects PCM output formats that the MP3 audio pipeline cannot store or compose', () => {
    const result = validatePayload({
      model_id: 'eleven_v3',
      inputs: [{ text: 'hi', voice_id: 'v1' }],
      output_format: 'pcm_24000',
    });
    expect(result.errors.some((e) => e.code === 'INVALID_OUTPUT_FORMAT')).toBe(true);
  });

  it('flags chunks close to the limit as a warning, not an error', () => {
    const result = validatePayload(base, [
      {
        chunkIndex: 1,
        startLine: 1,
        endLine: 1,
        characterCount: 1950,
        inputCount: 1,
        uniqueVoiceCount: 1,
        inputs: [],
        payload: base,
        payloadHash: 'x',
      },
    ]);
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.code === 'NEAR_CHAR_LIMIT')).toBe(true);
  });

  it('detects non-contiguous chunk ranges', () => {
    const chunk = (index: number, start: number, end: number) => ({
      chunkIndex: index,
      startLine: start,
      endLine: end,
      characterCount: 100,
      inputCount: 1,
      uniqueVoiceCount: 1,
      inputs: [],
      payload: base,
      payloadHash: 'x',
    });
    const result = validatePayload(base, [chunk(1, 1, 5), chunk(2, 9, 12)]);
    expect(result.errors.some((e) => e.code === 'NON_CONTIGUOUS_CHUNKS')).toBe(true);
  });

  it('allows a split turn to share a boundary line', () => {
    const chunk = (index: number, start: number, end: number) => ({
      chunkIndex: index,
      startLine: start,
      endLine: end,
      characterCount: 100,
      inputCount: 1,
      uniqueVoiceCount: 1,
      inputs: [],
      payload: base,
      payloadHash: 'x',
    });
    const result = validatePayload(base, [chunk(1, 1, 1), chunk(2, 1, 1)]);
    expect(result.errors.some((e) => e.code === 'NON_CONTIGUOUS_CHUNKS')).toBe(false);
  });

  it('rejects a completely invalid payload object', () => {
    expect(validatePayload(null as never).valid).toBe(false);
  });
});
