import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, symlinkSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { parseManifest, listTrashed, restoreOne, restoreMany, trashPathFor } from './trash-view';
import { manifestText, planTrash } from './trash-apply';

let root: string;
let manifests: string;
let trash: string;
let outside: string;
const rel = (n: string) => `2024/2024-06/nikon/${n}`;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'trashview-'));
  manifests = mkdtempSync(join(tmpdir(), 'manifests-'));
  trash = mkdtempSync(join(tmpdir(), 'faketrash-'));
  outside = mkdtempSync(join(tmpdir(), 'outside-'));
  mkdirSync(join(root, '2024/2024-06/nikon'), { recursive: true });
});
afterEach(() => {
  for (const d of [root, manifests, trash, outside]) rmSync(d, { recursive: true, force: true });
});

/** Write a manifest the way trash-apply does, then simulate the move into the Trash. */
function trashThese(names: string[], ws = 'ws-a', at = '2026-08-03T10:00:00.000Z') {
  for (const n of names) writeFileSync(join(root, rel(n)), n);
  const { items } = planTrash(names.map(rel), root);
  writeFileSync(join(manifests, `${at.replace(/[:.]/g, '-')}-${ws}.tsv`),
    manifestText(ws, root, items, new Date(at)), 'utf8');
  for (const n of names) {                       // the move shell.trashItem would perform
    writeFileSync(join(trash, n), readFileSync(join(root, rel(n))));
    rmSync(join(root, rel(n)));
  }
}

describe('parseManifest', () => {
  it('reads the rows trash-apply writes and ignores comments + header', () => {
    writeFileSync(join(root, rel('a.jpg')), 'aaaa');
    const { items } = planTrash([rel('a.jpg')], root);
    const rows = parseManifest(manifestText('ws-a', root, items, new Date('2026-08-03T10:00:00.000Z')));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ rel: rel('a.jpg'), size: 4, at: '2026-08-03T10:00:00.000Z' });
    expect(rows[0].abs).toBe(join(root, rel('a.jpg')));
  });

  it('skips malformed rows instead of throwing', () => {
    const rows = parseManifest([
      '# a comment',
      'rel_path\tabs_path\tsize\tmtime_ms\ttrashed_at\tdev\tino',
      'a/b.jpg\t/x/a/b.jpg\t10\t5\t2026-01-01\t1\t2',
      'too\tfew',
      '\tmissing-rel\t1\t1\tt',
      'a/c.jpg\t/x/a/c.jpg\tnotanumber\t1\tt',
      '',
    ].join('\n'));
    expect(rows.map((r) => r.rel)).toEqual(['a/b.jpg']);
  });
});

describe('listTrashed', () => {
  it('lists what was trashed, newest run first, with per-file state', () => {
    trashThese(['a.jpg', 'b.mov'], 'ws-a', '2026-08-01T10:00:00.000Z');
    trashThese(['c.jpg'], 'ws-a', '2026-08-02T10:00:00.000Z');
    const rows = listTrashed(manifests, 'ws-a', trash);
    expect(rows.map((r) => r.rel)).toEqual([rel('c.jpg'), rel('a.jpg'), rel('b.mov')]);
    expect(rows.every((r) => r.state === 'in-trash')).toBe(true);
    expect(rows[0].abs).toBe(join(root, rel('c.jpg')));
  });

  it('ignores other workspaces and a missing manifest dir', () => {
    trashThese(['a.jpg'], 'ws-a');
    trashThese(['z.jpg'], 'ws-b', '2026-08-04T10:00:00.000Z');
    expect(listTrashed(manifests, 'ws-a', trash).map((r) => r.rel)).toEqual([rel('a.jpg')]);
    expect(listTrashed(join(manifests, 'nope'), 'ws-a', trash)).toEqual([]);
  });

  it('marks a file gone when it has left the Trash, and restored once it is back', () => {
    trashThese(['a.jpg', 'b.mov']);
    rmSync(join(trash, 'a.jpg'));                                   // emptied the Trash
    writeFileSync(join(root, rel('b.mov')), 'back');                 // restored by hand
    const byRel = Object.fromEntries(listTrashed(manifests, 'ws-a', trash).map((r) => [r.rel, r.state]));
    expect(byRel[rel('a.jpg')]).toBe('gone');
    expect(byRel[rel('b.mov')]).toBe('restored');
  });

  it('keeps only the newest row when a path was trashed twice', () => {
    trashThese(['a.jpg'], 'ws-a', '2026-08-01T10:00:00.000Z');
    trashThese(['a.jpg'], 'ws-a', '2026-08-05T10:00:00.000Z');
    const rows = listTrashed(manifests, 'ws-a', trash);
    expect(rows).toHaveLength(1);
    expect(rows[0].at).toBe('2026-08-05T10:00:00.000Z');
  });
});

describe('restore', () => {
  it('puts a file back where it came from', () => {
    trashThese(['a.jpg']);
    const [row] = listTrashed(manifests, 'ws-a', trash);
    expect(restoreOne(row, root, trash)).toEqual({ rel: rel('a.jpg'), ok: true });
    expect(readFileSync(join(root, rel('a.jpg')), 'utf8')).toBe('a.jpg');
    expect(existsSync(trashPathFor(row.abs, trash))).toBe(false);
    // and the row now reads as restored, with no bookkeeping of its own
    expect(listTrashed(manifests, 'ws-a', trash)[0].state).toBe('restored');
  });

  it('recreates the month directory if it was cleaned up', () => {
    trashThese(['a.jpg']);
    rmSync(join(root, '2024'), { recursive: true });
    const [row] = listTrashed(manifests, 'ws-a', trash);
    expect(restoreOne(row, root, trash).ok).toBe(true);
    expect(existsSync(join(root, rel('a.jpg')))).toBe(true);
  });

  it('refuses to overwrite a file already at the destination', () => {
    trashThese(['a.jpg']);
    writeFileSync(join(root, rel('a.jpg')), 'SOMETHING ELSE');
    const rows = listTrashed(manifests, 'ws-a', trash);
    const r = restoreOne({ ...rows[0], state: 'in-trash' }, root, trash);
    expect(r).toEqual({ rel: rel('a.jpg'), ok: false, reason: 'a file is already there' });
    expect(readFileSync(join(root, rel('a.jpg')), 'utf8')).toBe('SOMETHING ELSE');
    expect(existsSync(join(trash, 'a.jpg'))).toBe(true);      // still safely in the Trash
  });

  it('refuses a tampered manifest that points outside the library', () => {
    trashThese(['a.jpg']);
    const [row] = listTrashed(manifests, 'ws-a', trash);
    const evil = { ...row, rel: '../../../etc/evil.jpg' };
    expect(restoreOne(evil, root, trash).reason).toBe('destination is outside the library');
    expect(existsSync(join(outside, 'evil.jpg'))).toBe(false);
  });

  it('refuses a destination whose parent symlinks out of the library', () => {
    trashThese(['a.jpg']);
    symlinkSync(outside, join(root, '2099'));
    const [row] = listTrashed(manifests, 'ws-a', trash);
    const evil = { ...row, rel: '2099/2099-01/nikon/a.jpg' };
    // the parent chain resolves outside the root, so it is refused even though the literal
    // path is inside it
    expect(restoreOne(evil, root, trash).ok).toBe(false);
  });

  it('reports a file that is no longer in the Trash rather than pretending', () => {
    trashThese(['a.jpg']);
    rmSync(join(trash, 'a.jpg'));
    const [row] = listTrashed(manifests, 'ws-a', trash);
    expect(restoreOne(row, root, trash)).toEqual({ rel: rel('a.jpg'), ok: false, reason: 'not in the Trash any more' });
  });

  it('restoreMany keeps going past a failure and reports each item', () => {
    trashThese(['a.jpg', 'b.mov', 'c.jpg']);
    rmSync(join(trash, 'b.mov'));                                    // this one is unrecoverable
    const rows = listTrashed(manifests, 'ws-a', trash);
    const res = restoreMany([rel('a.jpg'), rel('b.mov'), rel('c.jpg'), rel('ghost.jpg')], rows, root, trash);
    expect(res.filter((r) => r.ok).map((r) => r.rel)).toEqual([rel('a.jpg'), rel('c.jpg')]);
    expect(res.find((r) => r.rel === rel('b.mov'))?.reason).toBe('not in the Trash any more');
    expect(res.find((r) => r.rel === rel('ghost.jpg'))?.reason).toBe('not in the trash record');
    expect(existsSync(join(root, rel('a.jpg')))).toBe(true);
    expect(existsSync(join(root, rel('c.jpg')))).toBe(true);
  });

  it('never removes anything from the Trash on a failed restore', () => {
    trashThese(['a.jpg']);
    writeFileSync(join(root, rel('a.jpg')), 'blocking');
    const rows = listTrashed(manifests, 'ws-a', trash);
    restoreMany([rel('a.jpg')], rows.map((r) => ({ ...r, state: 'in-trash' as const })), root, trash);
    expect(existsSync(join(trash, 'a.jpg'))).toBe(true);
  });
});
