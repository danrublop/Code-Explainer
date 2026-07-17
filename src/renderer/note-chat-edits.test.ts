import { describe, it, expect } from 'vitest';
import { parseEdits, stripEdits, applyEdits } from './note-chat-edits';

describe('note-chat edit protocol', () => {
  it('parses find/replace blocks and strips them from prose', () => {
    const msg = 'Sure, tightening that up.\n<<<FIND>>>\nold line\n<<<REPLACE>>>\nnew line\n<<<END>>>\nDone.';
    const edits = parseEdits(msg);
    expect(edits).toEqual([{ find: 'old line', replace: 'new line' }]);
    expect(stripEdits(msg)).toBe('Sure, tightening that up.\n\nDone.');
  });

  it('replaces the first occurrence, appends on empty FIND, and reports misses', () => {
    const base = '# Title\n\nold line\n';
    const r = applyEdits(base, [
      { find: 'old line', replace: 'new line' },
      { find: '', replace: 'appended para' },
      { find: 'nowhere', replace: 'x' },
    ]);
    expect(r.md).toBe('# Title\n\nnew line\n\nappended para\n');
    expect(r.applied).toBe(2);
    expect(r.failed).toBe(1);
  });

  it('falls back to a whitespace-trimmed match', () => {
    expect(applyEdits('a  hello  b', [{ find: 'hello', replace: 'hi' }]).md).toBe('a  hi  b');
  });

  it('refuses a non-unique FIND instead of guessing which one', () => {
    const r = applyEdits('- milk\n- milk\n', [{ find: 'milk', replace: 'oat milk' }]);
    expect(r.md).toBe('- milk\n- milk\n'); // untouched
    expect(r.applied).toBe(0);
    expect(r.failed).toBe(1);
  });

  it('refuses a mid-word match instead of splicing inside a word', () => {
    const r = applyEdits('a concatenate function', [{ find: 'cat', replace: 'DOG' }]);
    expect(r.md).toBe('a concatenate function'); // untouched
    expect(r.applied).toBe(0);
    expect(r.failed).toBe(1);
  });

  it('applies multiple edits against the original offsets (no cross-shift)', () => {
    const r = applyEdits('alpha and omega', [
      { find: 'alpha', replace: 'FIRST' },
      { find: 'omega', replace: 'LAST' },
    ]);
    expect(r.md).toBe('FIRST and LAST');
    expect(r.applied).toBe(2);
    expect(r.failed).toBe(0);
  });
});
