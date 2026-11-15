import { describe, expect, it } from 'vitest';
import {
  enforceCueDurations,
  fromSrtTime,
  generateSrt,
  generateVtt,
  mergeShortSegments,
  parseSrt,
  toSrtTime,
  wrapText,
} from '../src/srt';
import type { TranscriptionSegment } from '@podcast/types';

describe('toSrtTime', () => {
  it('formats zero', () => {
    expect(toSrtTime(0)).toBe('00:00:00,000');
  });

  it('formats sub-second values', () => {
    expect(toSrtTime(2.34)).toBe('00:00:02,340');
  });

  it('formats minutes and hours', () => {
    expect(toSrtTime(63.5)).toBe('00:01:03,500');
    expect(toSrtTime(3725.007)).toBe('01:02:05,007');
  });

  it('clamps negative input', () => {
    expect(toSrtTime(-5)).toBe('00:00:00,000');
  });

  it('round-trips through fromSrtTime', () => {
    for (const value of [0, 1.5, 61.25, 3599.999]) {
      expect(fromSrtTime(toSrtTime(value))).toBeCloseTo(value, 3);
    }
  });

  it('rejects a malformed timestamp', () => {
    expect(() => fromSrtTime('nope')).toThrow();
  });
});

describe('wrapText', () => {
  it('keeps short text on one line', () => {
    expect(wrapText('Hello there', 42, 2)).toEqual(['Hello there']);
  });

  it('wraps onto two lines without splitting words', () => {
    const lines = wrapText('The quick brown fox jumps over the lazy dog again', 20, 2);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(20);
    }
    expect(lines.join(' ')).toBe('The quick brown fox jumps over the lazy dog again');
  });

  it('never drops text when it cannot fit in the line budget', () => {
    const text = 'alpha beta gamma delta epsilon zeta eta theta iota kappa';
    const lines = wrapText(text, 10, 2);
    expect(lines.join(' ')).toBe(text);
  });
});

describe('mergeShortSegments', () => {
  it('merges a sub-second cue into its neighbour', () => {
    const segments: TranscriptionSegment[] = [
      { start: 0, end: 2, text: 'Hello' },
      { start: 2.1, end: 2.5, text: 'there' },
    ];
    const merged = mergeShortSegments(segments);
    expect(merged).toHaveLength(1);
    expect(merged[0].text).toBe('Hello there');
    expect(merged[0].end).toBe(2.5);
  });

  it('leaves comfortably-sized cues alone', () => {
    const segments: TranscriptionSegment[] = [
      { start: 0, end: 2, text: 'First.' },
      { start: 2.5, end: 5, text: 'Second.' },
    ];
    expect(mergeShortSegments(segments)).toHaveLength(2);
  });

  it('absorbs a short trailing cue', () => {
    const segments: TranscriptionSegment[] = [
      { start: 0, end: 3, text: 'Main content here.' },
      { start: 3.2, end: 3.5, text: 'ok' },
    ];
    const merged = mergeShortSegments(segments);
    expect(merged).toHaveLength(1);
    expect(merged[0].text).toBe('Main content here. ok');
  });

  it('returns an empty array for empty input', () => {
    expect(mergeShortSegments([])).toEqual([]);
  });

  it('sorts out-of-order input', () => {
    const segments: TranscriptionSegment[] = [
      { start: 5, end: 7, text: 'Second.' },
      { start: 0, end: 4, text: 'First.' },
    ];
    expect(mergeShortSegments(segments)[0].text).toBe('First.');
  });
});

describe('enforceCueDurations', () => {
  it('extends a cue shorter than one second', () => {
    const result = enforceCueDurations([{ start: 0, end: 0.3, text: 'Hi' }]);
    expect(result[0].end - result[0].start).toBeCloseTo(1);
  });

  it('truncates a cue longer than seven seconds', () => {
    const result = enforceCueDurations([{ start: 0, end: 20, text: 'Long' }]);
    expect(result[0].end - result[0].start).toBeCloseTo(7);
  });

  it('prevents overlapping the next cue', () => {
    const result = enforceCueDurations([
      { start: 0, end: 6.9, text: 'A' },
      { start: 5, end: 9, text: 'B' },
    ]);
    expect(result[0].end).toBeLessThanOrEqual(5);
  });
});

describe('generateSrt', () => {
  it('returns an empty string for no segments', () => {
    expect(generateSrt([])).toBe('');
  });

  it('renders the documented SRT shape', () => {
    const srt = generateSrt(
      [
        { start: 0, end: 2.34, text: 'I thought you forgot about me.' },
        { start: 2.5, end: 4.12, text: 'How could I forget?' },
      ],
      { skipMerge: true },
    );
    expect(srt).toContain('1\n00:00:00,000 --> 00:00:02,340\nI thought you forgot about me.');
    expect(srt).toContain('2\n00:00:02,500 --> 00:00:04,120\nHow could I forget?');
    expect(srt.endsWith('\n')).toBe(true);
  });

  it('splits long subtitles into cues of at most two lines without dropping text', () => {
    const text = 'This is a fairly long sentence that should be wrapped across at most two subtitle lines without splitting words.';
    const srt = generateSrt(
      [
        {
          start: 0,
          end: 6,
          text,
        },
      ],
      { skipMerge: true },
    );
    const cues = srt.trimEnd().split('\n\n').map((block) => block.split('\n'));
    expect(cues.length).toBeGreaterThan(1);
    for (const [, , ...textLines] of cues) {
      expect(textLines.length).toBeLessThanOrEqual(2);
      for (const line of textLines) expect(line.length).toBeLessThanOrEqual(42);
    }
    expect(cues.flatMap(([, , ...textLines]) => textLines).join(' ')).toBe(text);
  });

  it('skips empty-text segments', () => {
    const srt = generateSrt([{ start: 0, end: 2, text: '   ' }], { skipMerge: true });
    expect(srt).toBe('');
  });
});

describe('parseSrt', () => {
  it('round-trips a generated document', () => {
    const original: TranscriptionSegment[] = [
      { start: 0, end: 2.5, text: 'First line.' },
      { start: 3, end: 5, text: 'Second line.' },
    ];
    const srt = generateSrt(original, { skipMerge: true });
    const parsed = parseSrt(srt);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].text).toBe('First line.');
    expect(parsed[0].start).toBeCloseTo(0);
    expect(parsed[1].end).toBeCloseTo(5);
  });

  it('handles CRLF input', () => {
    const srt = '1\r\n00:00:00,000 --> 00:00:02,000\r\nHello\r\n';
    expect(parseSrt(srt)).toHaveLength(1);
  });

  it('returns an empty array for blank input', () => {
    expect(parseSrt('   ')).toEqual([]);
  });

  it('ignores malformed blocks', () => {
    expect(parseSrt('garbage without a timing line')).toEqual([]);
  });
});

describe('generateVtt', () => {
  it('emits a WEBVTT header', () => {
    expect(generateVtt([])).toBe('WEBVTT\n');
  });

  it('uses a dot as the millisecond separator', () => {
    const vtt = generateVtt([{ start: 0, end: 2.34, text: 'Hello.' }]);
    expect(vtt).toContain('00:00:00.000 --> 00:00:02.340');
  });
});
