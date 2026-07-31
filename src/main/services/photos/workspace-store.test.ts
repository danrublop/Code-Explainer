import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PhotoWorkspaceStore, isValidWorkspaceId } from './workspace-store';

describe('PhotoWorkspaceStore', () => {
  let dir: string;
  let path: string;
  let n: number;
  const newId = () => `0000000${++n}`;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ws-store-'));
    path = join(dir, 'photo-workspaces.json');
    n = 0;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('seeds a Personal workspace on first run and persists it', () => {
    const s = new PhotoWorkspaceStore(path, newId);
    expect(s.list()).toHaveLength(1);
    expect(s.list()[0].name).toBe('Personal');
    expect(existsSync(path)).toBe(true);
    // Survives a restart with the same id.
    expect(new PhotoWorkspaceStore(path, newId).list()).toEqual(s.list());
  });

  it('keeps roots isolated: rootOf only answers for a known id', () => {
    const s = new PhotoWorkspaceStore(path, newId);
    const work = s.add('/tmp/work-photos', 'Work');
    expect(s.rootOf(work.id)).toBe('/tmp/work-photos');
    // The renderer supplies this id, so every rejection path matters.
    expect(s.rootOf('ws-nope')).toBeNull();
    expect(s.rootOf('../../etc')).toBeNull();
    expect(s.rootOf(undefined)).toBeNull();
    s.remove(work.id);
    expect(s.rootOf(work.id)).toBeNull();
  });

  it('mints ids that are safe as a photo:// hostname', () => {
    // An all-digit uuid must not canonicalise to an IPv4 literal, and URL lowercases hosts.
    const s = new PhotoWorkspaceStore(path, () => '1234-5678-ABCD');
    const ws = s.add('/tmp/x');
    expect(isValidWorkspaceId(ws.id)).toBe(true);
    expect(new URL(`photo://${ws.id}/2024/a.jpg`).hostname).toBe(ws.id);
  });

  it('names default to the folder, dedupes by root, and rename sticks', () => {
    const s = new PhotoWorkspaceStore(path, newId);
    const a = s.add('/tmp/Family Pics');
    expect(a.name).toBe('Family Pics');
    expect(s.add('/tmp/Family Pics').id).toBe(a.id);   // re-attaching is not a duplicate
    s.rename(a.id, '  Family  ');
    expect(s.list().find((w) => w.id === a.id)!.name).toBe('Family');
    s.rename(a.id, '   ');                             // blank keeps the old name
    expect(s.list().find((w) => w.id === a.id)!.name).toBe('Family');
  });

  it('backs up a corrupt file instead of silently dropping the workspaces', () => {
    writeFileSync(path, '{ not json', 'utf8');
    const s = new PhotoWorkspaceStore(path, newId);
    expect(s.list()).toEqual([]);
    const backup = require('fs').readdirSync(dir).find((f: string) => f.includes('.corrupt-'));
    expect(backup).toBeTruthy();
    expect(readFileSync(join(dir, backup!), 'utf8')).toBe('{ not json');
  });
});
