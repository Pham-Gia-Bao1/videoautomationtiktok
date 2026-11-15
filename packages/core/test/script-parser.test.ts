import { describe, expect, it } from 'vitest';
import { parseScript, parseScriptOrThrow } from '../src/script-parser';
import { AppError } from '../src/errors';

const SAMPLE = `Sarah: I thought you forgot about me.

Daniel: How could I forget?

Sarah: You haven't called me for three months.

Daniel: I was afraid.

Sarah: Afraid of what?

Daniel: Afraid that you had moved on.`;

describe('parseScript', () => {
  it('extracts characters in first-appearance order', () => {
    const result = parseScript(SAMPLE);
    expect(result.characters).toEqual([
      { key: 'sarah', name: 'Sarah' },
      { key: 'daniel', name: 'Daniel' },
    ]);
  });

  it('numbers lines sequentially starting at 1', () => {
    const result = parseScript(SAMPLE);
    expect(result.lines).toHaveLength(6);
    expect(result.lines.map((l) => l.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(result.lines[0]).toEqual({
      sequence: 1,
      speaker: 'sarah',
      text: 'I thought you forgot about me.',
    });
  });

  it('preserves audio tags verbatim (docs/09 §9.6)', () => {
    const result = parseScript('Sarah: [giggling] Knock knock\n\nDaniel: [curious] Who is there?');
    expect(result.lines[0].text).toBe('[giggling] Knock knock');
    expect(result.lines[1].text).toBe('[curious] Who is there?');
  });

  it('keeps punctuation inside dialogue text', () => {
    const result = parseScript('Sarah: Wait, what?! Really...');
    expect(result.lines[0].text).toBe('Wait, what?! Really...');
  });

  it('collapses multi-line dialogue into a single space-joined line', () => {
    const result = parseScript('Sarah: I thought\nyou forgot about me.');
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0].text).toBe('I thought you forgot about me.');
  });

  it('appends non-matching lines to the preceding turn and warns', () => {
    const result = parseScript('Sarah: Hello there\n(this is a stage direction)');
    expect(result.lines[0].text).toContain('(this is a stage direction)');
    expect(result.warnings.some((w) => w.code === 'UNPARSED_LINE')).toBe(true);
  });

  it('reports warnings for lines that match nothing at the start of a script', () => {
    const result = parseScript('Just some prose without a speaker.\n\nSarah: Hi.');
    expect(result.unparsed).toHaveLength(1);
    expect(result.unparsed[0].line).toBe(1);
    expect(result.lines).toHaveLength(1);
  });

  it('merges adjacent turns when mergeAdjacent is enabled', () => {
    const script = 'Sarah: First part.\n\nSarah: Second part.\n\nDaniel: Reply.';
    const merged = parseScript(script, { mergeAdjacent: true });
    expect(merged.lines).toHaveLength(2);
    expect(merged.lines[0].text).toBe('First part. Second part.');
    expect(merged.lines[0].sequence).toBe(1);

    const separate = parseScript(script, { mergeAdjacent: false });
    expect(separate.lines).toHaveLength(3);
  });

  it('slugifies names with diacritics and punctuation', () => {
    const result = parseScript("Renée O'Brien: Bonjour.\n\nDr. Smith: Hello.");
    expect(result.characters.map((c) => c.key)).toEqual(['renee_o_brien', 'dr_smith']);
  });

  it('collapses different spellings of the same speaker and warns', () => {
    const result = parseScript('SARAH: One.\n\nSarah: Two.');
    expect(result.characters).toHaveLength(1);
    expect(result.lines.map((l) => l.speaker)).toEqual(['sarah', 'sarah']);
    expect(result.warnings.some((w) => w.code === 'DUPLICATE_CHARACTER')).toBe(true);
  });

  it('handles an escaped colon inside a speaker name', () => {
    const result = parseScript('Time\\: Lord: Hello there.');
    expect(result.characters[0].name).toBe('Time: Lord');
    expect(result.lines[0].text).toBe('Hello there.');
  });

  it('warns when a speaker line has no dialogue text', () => {
    const result = parseScript('Sarah:\n\nDaniel: Hi.');
    expect(result.warnings.some((w) => w.code === 'EMPTY_TEXT')).toBe(true);
    expect(result.lines).toHaveLength(1);
  });

  it('handles a single-character script', () => {
    const result = parseScript('Sarah: Alone at last.');
    expect(result.characters).toHaveLength(1);
    expect(result.lines).toHaveLength(1);
  });

  it('returns an EMPTY_SCRIPT warning for blank input', () => {
    const result = parseScript('   \n\n  ');
    expect(result.lines).toEqual([]);
    expect(result.warnings[0].code).toBe('EMPTY_SCRIPT');
  });

  it('normalises CRLF line endings', () => {
    const result = parseScript('Sarah: One.\r\n\r\nDaniel: Two.\r\n');
    expect(result.lines).toHaveLength(2);
    expect(result.lines[1].text).toBe('Two.');
  });

  it('handles unicode dialogue text', () => {
    const result = parseScript('Sarah: Je suis désolée… 你好 🎙️');
    expect(result.lines[0].text).toBe('Je suis désolée… 你好 🎙️');
  });
});

describe('parseScriptOrThrow', () => {
  it('throws VALIDATION_FAILED when nothing parses', () => {
    expect(() => parseScriptOrThrow('no dialogue here')).toThrowError(AppError);
    try {
      parseScriptOrThrow('no dialogue here');
    } catch (err) {
      expect((err as AppError).code).toBe('VALIDATION_FAILED');
      expect((err as AppError).status).toBe(400);
    }
  });

  it('returns a result when at least one line parses', () => {
    expect(parseScriptOrThrow('Sarah: Hi.').lines).toHaveLength(1);
  });
});
