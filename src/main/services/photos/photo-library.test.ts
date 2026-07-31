import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { buildIndex, listMonth, resolveInLibrary, kindOf } from './photo-library';

let root: string;
let outside: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'photolib-'));
  outside = mkdtempSync(join(tmpdir(), 'secret-'));
  writeFileSync(join(outside, 'id_rsa'), 'PRIVATE KEY');

  mkdirSync(join(root, '2024/2024-06/nikon'), { recursive: true });
  writeFileSync(join(root, '2024/2024-06/nikon/DSC_0001.JPG'), 'x');
  writeFileSync(join(root, '2024/2024-06/nikon/DSC_0002.JPG'), 'x');
  writeFileSync(join(root, '2024/2024-06/nikon/notes.txt'), 'x');     // non-media: ignored

  mkdirSync(join(root, '2024/2024-07/iphone-14'), { recursive: true });
  writeFileSync(join(root, '2024/2024-07/iphone-14/IMG_1.HEIC'), 'x');
  writeFileSync(join(root, '2024/2024-07/iphone-14/clip.mov'), 'x');

  mkdirSync(join(root, '_no-date/canon'), { recursive: true });
  writeFileSync(join(root, '_no-date/canon/MVI_9.MP4'), 'x');

  mkdirSync(join(root, 'junk-dir'), { recursive: true });             // not YYYY: ignored
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe('kindOf', () => {
  it('classifies by extension and rejects non-media', () => {
    expect(kindOf('a.JPG')).toBe('image');
    expect(kindOf('a.nef')).toBe('raw');
    expect(kindOf('a.mp4')).toBe('video');
    expect(kindOf('a.txt')).toBeNull();
    expect(kindOf('noext')).toBeNull();
  });
});

describe('buildIndex', () => {
  it('counts media per month, newest first, _no-date last', () => {
    const ix = buildIndex(root);
    expect(ix.exists).toBe(true);
    expect(ix.total).toBe(5);                       // notes.txt excluded
    expect(ix.months.map((m) => m.month)).toEqual(['2024-07', '2024-06', '_no-date']);
    expect(ix.months[1].count).toBe(2);
    expect(ix.sources).toEqual(['canon', 'iphone-14', 'nikon']);
  });

  it('reports a missing root instead of throwing', () => {
    const ix = buildIndex(join(root, 'nope'));
    expect(ix.exists).toBe(false);
    expect(ix.total).toBe(0);
  });
});

describe('listMonth', () => {
  it('returns entries with rel paths and kinds', () => {
    const items = listMonth('2024-07', root);
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.kind).sort()).toEqual(['image', 'video']);
    expect(items.every((i) => i.rel.startsWith('2024/2024-07/iphone-14/'))).toBe(true);
  });

  it('handles _no-date and rejects a malformed month', () => {
    expect(listMonth('_no-date', root)).toHaveLength(1);
    expect(listMonth('../../etc', root)).toEqual([]);
    expect(listMonth('2024-6', root)).toEqual([]);
  });
});

describe('resolveInLibrary (security boundary)', () => {
  it('resolves a real in-library media file', () => {
    expect(resolveInLibrary('2024/2024-06/nikon/DSC_0001.JPG', root))
      .toBe(join(root, '2024/2024-06/nikon/DSC_0001.JPG'));
  });

  it('refuses traversal, absolute paths, and nulls', () => {
    expect(resolveInLibrary('../../../etc/passwd', root)).toBeNull();
    expect(resolveInLibrary('2024/../../..' + outside + '/id_rsa', root)).toBeNull();
    expect(resolveInLibrary(join(outside, 'id_rsa'), root)).toBeNull();
    expect(resolveInLibrary('a\0b', root)).toBeNull();
    expect(resolveInLibrary('', root)).toBeNull();
  });

  it('refuses non-media and missing files', () => {
    expect(resolveInLibrary('2024/2024-06/nikon/notes.txt', root)).toBeNull();
    expect(resolveInLibrary('2024/2024-06/nikon/ghost.jpg', root)).toBeNull();
  });

  it('refuses a symlink that escapes the root', () => {
    const link = join(root, '2024/2024-06/nikon/escape.jpg');
    symlinkSync(join(outside, 'id_rsa'), link);
    expect(resolveInLibrary('2024/2024-06/nikon/escape.jpg', root)).toBeNull();
  });
});
