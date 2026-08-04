import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PhotoMarkStore } from './mark-store';

let dir: string;
let file: string;
const rel = (n: string) => `2024/2024-06/nikon/${n}`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'marks-'));
  file = join(dir, 'photo-marks.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('PhotoMarkStore', () => {
  it('starts empty and survives a restart', () => {
    const s = new PhotoMarkStore(file);
    expect(s.get('ws-a')).toEqual({});
    s.set('ws-a', [{ rel: rel('a.jpg'), size: 100 }, { rel: rel('b.jpg'), size: 200 }], 'delete');
    s.set('ws-a', [{ rel: rel('c.jpg'), size: 5 }], 'keep');

    // The whole point of living in main: a renderer reload must not lose the pass.
    const reopened = new PhotoMarkStore(file);
    expect(reopened.get('ws-a')).toEqual({
      [rel('a.jpg')]: { m: 'delete', s: 100 },
      [rel('b.jpg')]: { m: 'delete', s: 200 },
      [rel('c.jpg')]: { m: 'keep', s: 5 },
    });
    expect(reopened.totals('ws-a')).toEqual({ keep: 1, del: 2, delBytes: 300 });
    expect(reopened.deleteRels('ws-a').sort()).toEqual([rel('a.jpg'), rel('b.jpg')]);
  });

  it('keeps workspaces apart', () => {
    const s = new PhotoMarkStore(file);
    s.set('ws-a', [{ rel: rel('a.jpg'), size: 1 }], 'delete');
    s.set('ws-b', [{ rel: rel('a.jpg'), size: 1 }], 'keep');
    expect(s.deleteRels('ws-b')).toEqual([]);
    expect(s.deleteRels('ws-a')).toEqual([rel('a.jpg')]);
  });

  it('re-marks and unmarks', () => {
    const s = new PhotoMarkStore(file);
    s.set('ws-a', [{ rel: rel('a.jpg'), size: 100 }], 'delete');
    s.set('ws-a', [{ rel: rel('a.jpg'), size: 100 }], 'keep');       // flip
    expect(s.totals('ws-a')).toEqual({ keep: 1, del: 0, delBytes: 0 });
    s.set('ws-a', [{ rel: rel('a.jpg'), size: 0 }], null);           // unmark
    expect(s.get('ws-a')).toEqual({});
    expect(new PhotoMarkStore(file).get('ws-a')).toEqual({});        // and it persisted
  });

  it('drops junk records instead of throwing', () => {
    writeFileSync(file, JSON.stringify({
      'ws-a': { good: { m: 'delete', s: 7 }, bad: { m: 'maybe' }, worse: 3, nosize: { m: 'keep' } },
      'ws-bad': 'not an object',
    }), 'utf8');
    const s = new PhotoMarkStore(file);
    expect(s.get('ws-a')).toEqual({ good: { m: 'delete', s: 7 }, nosize: { m: 'keep', s: 0 } });
    expect(s.get('ws-bad')).toEqual({});
  });

  it('backs up an unreadable file rather than overwriting the pass', () => {
    writeFileSync(file, '{ not json', 'utf8');
    const s = new PhotoMarkStore(file);
    expect(s.get('ws-a')).toEqual({});
    expect(existsSync(file)).toBe(false);
    const backup = readdirSync(dir).find((f) => f.includes('.corrupt-'));
    expect(backup).toBeTruthy();
    expect(readFileSync(join(dir, backup!), 'utf8')).toBe('{ not json');
  });
});
