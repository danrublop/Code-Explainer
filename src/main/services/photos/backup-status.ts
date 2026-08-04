// Which files in the library are already in Apple Photos / iCloud.
//
// The answer is precomputed by photo-consolidate/icloud-crosscheck.py (content hashing against
// the Photos library) and dropped in the library root as `.icloud-crosscheck.tsv`. This module
// only reads it, so the app never touches the Photos database.
//
// The distinction that matters, and the reason `maybe` is NOT treated as backed up: the
// cross-check can only prove a match for assets whose bytes are on this Mac. iCloud-only
// placeholders are matched on filename+size, which is a guess. Counting those as "safe" would
// mark files as backed up on the strength of a coincidence — so only `in-photos` counts.

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

export const CROSSCHECK_FILE = '.icloud-crosscheck.tsv';

/**
 * Rel paths that are confirmed present in Apple Photos (in iCloud or not).
 * Empty set when the file is absent — the UI then simply offers no filter.
 */
export function loadBackedUp(root: string): Set<string> {
  const f = join(root, CROSSCHECK_FILE);
  if (!existsSync(f)) return new Set();
  let text: string;
  try { text = readFileSync(f, 'utf8'); } catch { return new Set(); }

  const out = new Set<string>();
  const lines = text.split('\n');
  const header = (lines[0] ?? '').split('\t');
  const vi = header.indexOf('verdict');
  const ri = header.indexOf('rel');
  if (vi < 0 || ri < 0) return out;                 // not the file we expect — ignore it

  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const c = lines[i].split('\t');
    // 'rel' is last, so a path containing a tab would be split — rejoin the tail.
    if (c[vi] === 'in-photos' && c.length > ri) out.add(c.slice(ri).join('\t'));
  }
  return out;
}
