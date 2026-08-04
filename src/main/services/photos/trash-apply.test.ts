import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, symlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { planTrash, manifestText, applyTrash, TrashDeps } from './trash-apply';

let root: string;
let outside: string;
const rel = (n: string) => `2024/2024-06/nikon/${n}`;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'trashlib-'));
  outside = mkdtempSync(join(tmpdir(), 'secret-'));
  writeFileSync(join(outside, 'id_rsa'), 'PRIVATE KEY');
  mkdirSync(join(root, '2024/2024-06/nikon'), { recursive: true });
  writeFileSync(join(root, '2024/2024-06/nikon/a.jpg'), 'aaaa');
  writeFileSync(join(root, '2024/2024-06/nikon/b.mov'), 'bbbbbbbb');
  writeFileSync(join(root, '2024/2024-06/nikon/notes.txt'), 'not media');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

/** Records what was asked to be trashed; never actually moves anything. */
function fakeDeps(overrides: Partial<TrashDeps> = {}) {
  const moved: string[] = [];
  const manifests: string[] = [];
  const deps: TrashDeps = {
    trash: async (abs) => { moved.push(abs); },
    writeManifest: (text) => { manifests.push(text); return join(root, `manifest-${manifests.length}.tsv`); },
    now: () => new Date('2026-08-03T10:00:00.000Z'),
    ...overrides,
  };
  return { deps, moved, manifests };
}

describe('planTrash', () => {
  it('resolves in-library media and stats it', () => {
    const { items, missing } = planTrash([rel('a.jpg'), rel('b.mov')], root);
    expect(missing).toEqual([]);
    expect(items.map((i) => i.size)).toEqual([4, 8]);
    expect(items[0].abs).toBe(join(root, rel('a.jpg')));
  });

  it('refuses anything resolveInLibrary refuses — traversal, absolutes, non-media, escapes', () => {
    symlinkSync(join(outside, 'id_rsa'), join(root, '2024/2024-06/nikon/escape.jpg'));
    const { items, missing } = planTrash([
      '../../../etc/passwd',
      join(outside, 'id_rsa'),
      rel('notes.txt'),
      rel('escape.jpg'),
      'a\0b',
    ], root);
    expect(items).toEqual([]);
    expect(missing).toHaveLength(5);
    // the point of the assertion: nothing outside the library got a plan entry
    expect(existsSync(join(outside, 'id_rsa'))).toBe(true);
  });

  it('treats an already-gone file as missing, not an error (idempotency)', () => {
    const { items, missing } = planTrash([rel('a.jpg'), rel('ghost.jpg')], root);
    expect(items.map((i) => i.rel)).toEqual([rel('a.jpg')]);
    expect(missing).toEqual([rel('ghost.jpg')]);
  });

  it('de-dupes repeated paths', () => {
    const { items } = planTrash([rel('a.jpg'), rel('a.jpg')], root);
    expect(items).toHaveLength(1);
  });
});

describe('manifestText', () => {
  it('records path, size and mtime for every file', () => {
    const { items } = planTrash([rel('a.jpg')], root);
    const text = manifestText('ws-x', root, items, new Date('2026-08-03T10:00:00.000Z'));
    const rows = text.trim().split('\n');
    expect(rows.find((r) => r.startsWith('rel_path')))
      .toBe('rel_path\tabs_path\tsize\tmtime_ms\ttrashed_at\tdev\tino');
    const data = rows[rows.length - 1].split('\t');
    expect(data[0]).toBe(rel('a.jpg'));
    expect(data[1]).toBe(join(root, rel('a.jpg')));
    expect(data[2]).toBe('4');
    expect(data[4]).toBe('2026-08-03T10:00:00.000Z');
    // inode is what identifies the file after it has been renamed in the Trash
    expect(Number(data[6])).toBeGreaterThan(0);
    expect(text).toContain('ws-x');
  });
});

describe('applyTrash', () => {
  it('writes the manifest BEFORE moving anything', async () => {
    const order: string[] = [];
    const { deps } = fakeDeps({
      writeManifest: () => { order.push('manifest'); return '/tmp/m.tsv'; },
      trash: async () => { order.push('trash'); },
    });
    await applyTrash('ws-x', root, [rel('a.jpg'), rel('b.mov')], deps);
    expect(order).toEqual(['manifest', 'trash', 'trash']);
  });

  it('trashes resolved files and reports bytes', async () => {
    const { deps, moved, manifests } = fakeDeps();
    const r = await applyTrash('ws-x', root, [rel('a.jpg'), rel('b.mov')], deps);
    expect(moved).toEqual([join(root, rel('a.jpg')), join(root, rel('b.mov'))]);
    expect(r.trashed).toHaveLength(2);
    expect(r.bytes).toBe(12);
    expect(r.missing).toEqual([]);
    expect(manifests[0]).toContain(rel('b.mov'));
  });

  it('never touches a path outside the library', async () => {
    const { deps, moved } = fakeDeps();
    const r = await applyTrash('ws-x', root, [join(outside, 'id_rsa'), '../../../etc/passwd'], deps);
    expect(moved).toEqual([]);
    expect(r.trashed).toEqual([]);
    expect(r.missing).toHaveLength(2);
  });

  it('keeps going when one file fails and reports it', async () => {
    const { deps } = fakeDeps({
      trash: async (abs) => { if (abs.endsWith('a.jpg')) throw new Error('locked'); },
    });
    const r = await applyTrash('ws-x', root, [rel('a.jpg'), rel('b.mov')], deps);
    expect(r.failed).toEqual([{ rel: rel('a.jpg'), error: 'locked' }]);
    expect(r.trashed.map((i) => i.rel)).toEqual([rel('b.mov')]);
  });

  it('is idempotent: a second run over the same plan is a no-op', async () => {
    const first = fakeDeps({ trash: async (abs) => { rmSync(abs); } });
    const r1 = await applyTrash('ws-x', root, [rel('a.jpg')], first.deps);
    expect(r1.trashed).toHaveLength(1);

    const second = fakeDeps();
    const r2 = await applyTrash('ws-x', root, [rel('a.jpg')], second.deps);
    expect(r2.trashed).toEqual([]);
    expect(r2.failed).toEqual([]);
    expect(r2.missing).toEqual([rel('a.jpg')]);
    expect(second.moved).toEqual([]);
  });

  it('writes a manifest even for an empty plan, so "nothing happened" is on record', async () => {
    const { deps, manifests } = fakeDeps();
    const r = await applyTrash('ws-x', root, [], deps);
    expect(manifests).toHaveLength(1);
    expect(r.trashed).toEqual([]);
    expect(r.manifest).toBeTruthy();
  });
});
