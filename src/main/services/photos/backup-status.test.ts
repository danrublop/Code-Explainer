import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadBackedUp, CROSSCHECK_FILE } from './backup-status';

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'backup-'));
  writeFileSync(join(root, CROSSCHECK_FILE), [
    'verdict\tmethod\tincloud\tsize\tnlink\tuuid\trel',
    'in-photos\tsha256\tTrue\t100\t1\tU1\t2024/2024-06/nikon/a.jpg',
    'in-photos\tsha256\tFalse\t100\t1\tU2\t2024/2024-06/nikon/b.jpg',   // in Photos, not iCloud
    'maybe\tsize\tTrue\t100\t1\tU3\t2024/2024-06/nikon/c.jpg',          // guess — NOT backed up
    'no-match\t\t\t100\t1\t\t2024/2024-06/nikon/d.jpg',
  ].join('\n'));
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('loadBackedUp', () => {
  it('counts only proven Photos matches, never name+size guesses', () => {
    const s = loadBackedUp(root);
    expect(s.has('2024/2024-06/nikon/a.jpg')).toBe(true);
    expect(s.has('2024/2024-06/nikon/b.jpg')).toBe(true);   // in Photos counts even if not iCloud
    expect(s.has('2024/2024-06/nikon/c.jpg')).toBe(false);  // 'maybe' is unproven
    expect(s.has('2024/2024-06/nikon/d.jpg')).toBe(false);
    expect(s.size).toBe(2);
  });

  it('returns empty for a missing or malformed file instead of throwing', () => {
    expect(loadBackedUp(join(root, 'nope')).size).toBe(0);
    const bad = mkdtempSync(join(tmpdir(), 'backup-bad-'));
    writeFileSync(join(bad, CROSSCHECK_FILE), 'not\ta\theader\nx\ty\tz');
    expect(loadBackedUp(bad).size).toBe(0);
    rmSync(bad, { recursive: true, force: true });
  });

  it('keeps a path that itself contains a tab', () => {
    const d = mkdtempSync(join(tmpdir(), 'backup-tab-'));
    writeFileSync(join(d, CROSSCHECK_FILE),
      'verdict\trel\nin-photos\t2024/od\td name/x.jpg');
    expect(loadBackedUp(d).has('2024/od\td name/x.jpg')).toBe(true);
    rmSync(d, { recursive: true, force: true });
  });
});
