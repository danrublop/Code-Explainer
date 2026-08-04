import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { AlbumStore } from './album-store';

let dir: string;
let file: string;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'albums-')); file = join(dir, 'a.json'); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('AlbumStore albums', () => {
  it('creates, dedupes on re-add, and persists across instances', () => {
    const s = new AlbumStore(file);
    s.addToAlbum('ws1', 'Trip', ['a.jpg', 'b.jpg']);
    s.addToAlbum('ws1', 'Trip', ['b.jpg', 'c.jpg']);      // b repeated on purpose
    expect(s.albums('ws1').Trip).toEqual(['a.jpg', 'b.jpg', 'c.jpg']);
    expect(new AlbumStore(file).albums('ws1').Trip).toHaveLength(3);
  });

  it('keeps workspaces apart', () => {
    const s = new AlbumStore(file);
    s.addToAlbum('ws1', 'X', ['a.jpg']);
    s.addToAlbum('ws2', 'X', ['b.jpg']);
    expect(s.albums('ws1').X).toEqual(['a.jpg']);
    expect(s.albums('ws2').X).toEqual(['b.jpg']);
  });

  it('ignores an empty name or empty selection', () => {
    const s = new AlbumStore(file);
    s.addToAlbum('ws1', '   ', ['a.jpg']);
    s.addToAlbum('ws1', 'Real', []);
    expect(Object.keys(s.albums('ws1'))).toEqual([]);
  });

  it('drops an album once its last photo is removed', () => {
    const s = new AlbumStore(file);
    s.addToAlbum('ws1', 'Trip', ['a.jpg', 'b.jpg']);
    s.removeFromAlbum('ws1', 'Trip', ['a.jpg']);
    expect(s.albums('ws1').Trip).toEqual(['b.jpg']);
    s.removeFromAlbum('ws1', 'Trip', ['b.jpg']);
    expect(s.albums('ws1').Trip).toBeUndefined();
  });
});

describe('AlbumStore rotation', () => {
  it('normalises to 0/90/180/270 and drops the no-op', () => {
    const s = new AlbumStore(file);
    s.setRotation('ws1', 'a.jpg', 450);        // 450 -> 90
    expect(s.rotations('ws1')['a.jpg']).toBe(90);
    s.setRotation('ws1', 'a.jpg', -90);        // -90 -> 270, not a negative
    expect(s.rotations('ws1')['a.jpg']).toBe(270);
    s.setRotation('ws1', 'a.jpg', 360);        // back to upright: entry removed, not stored as 0
    expect(s.rotations('ws1')['a.jpg']).toBeUndefined();
  });
});

describe('AlbumStore durability', () => {
  it('starts clean on a corrupt file instead of throwing', () => {
    writeFileSync(file, '{not json');
    const s = new AlbumStore(file);
    expect(s.albums('ws1')).toEqual({});
    s.addToAlbum('ws1', 'A', ['x.jpg']);       // and is still usable
    expect(s.albums('ws1').A).toEqual(['x.jpg']);
  });

  it('leaves no .tmp behind after a write', () => {
    const s = new AlbumStore(file);
    s.addToAlbum('ws1', 'A', ['x.jpg']);
    expect(() => readFileSync(`${file}.tmp`)).toThrow();
  });

  it('forget() strips trashed paths from albums and rotations', () => {
    const s = new AlbumStore(file);
    s.addToAlbum('ws1', 'A', ['x.jpg', 'y.jpg']);
    s.setRotation('ws1', 'x.jpg', 90);
    s.forget('ws1', ['x.jpg']);
    expect(s.albums('ws1').A).toEqual(['y.jpg']);
    expect(s.rotations('ws1')['x.jpg']).toBeUndefined();
  });
});
