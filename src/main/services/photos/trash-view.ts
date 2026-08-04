// Read the trash manifests back, so the Photos view can show what this app deleted and put it
// back — without the user hunting through a Finder Trash holding thousands of unrelated items.
//
// The manifests written by trash-apply.ts ARE the record. Nothing here enumerates ~/.Trash:
// macOS TCC blocks readdir() on it (an unprivileged process gets EPERM), so a view built on
// listing that directory would show nothing. Probing one known path at a time still works.
//
// Nothing here deletes. Emptying the Trash stays Finder's job.

import { readdirSync, readFileSync, existsSync, statSync, mkdirSync, renameSync } from 'fs';
import { join, dirname, basename } from 'path';
import { resolveDestination } from './photo-library';

export interface TrashRow {
  rel: string;          // library-relative path it was trashed from
  abs: string;          // absolute original path — where Restore puts it back
  size: number;
  mtime: number;
  at: string;           // ISO timestamp of the apply run
  run: string;          // manifest filename, so the view can group by run
  /** Where we expect to find it now. Empty when the row can't be located. */
  trashPath: string;
  state: TrashState;
}
/**
 *  restored — the original path exists again, so it is back (this is also how a restore is
 *             remembered: no bookkeeping, the filesystem is the state)
 *  in-trash — found in the Trash, Restore should work
 *  gone     — not in the Trash under its own name; do not offer a Restore that will fail
 *  unknown  — the Trash refused to answer (TCC). Restore is still offered: the app may have
 *             access where this probe did not.
 */
export type TrashState = 'restored' | 'in-trash' | 'gone' | 'unknown';

/** Parse one manifest. Comment lines, the header and malformed rows are skipped, never thrown on. */
export function parseManifest(text: string): Array<Omit<TrashRow, 'run' | 'state' | 'trashPath'>> {
  const out: Array<Omit<TrashRow, 'run' | 'state' | 'trashPath'>> = [];
  for (const line of text.split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    const c = line.split('\t');
    if (c.length < 5 || c[0] === 'rel_path') continue;
    const size = Number(c[2]);
    const mtime = Number(c[3]);
    if (!c[0] || !c[1] || !Number.isFinite(size)) continue;
    out.push({ rel: c[0], abs: c[1], size, mtime: Number.isFinite(mtime) ? mtime : 0, at: c[4] ?? '' });
  }
  return out;
}

/**
 * Where a trashed file should now be sitting.
 *
 * ponytail: basename only. macOS renames on collision ("IMG_1.jpg" -> "IMG_1 2.jpg"), and those
 * rows read as `gone` rather than `in-trash`. The manifest records dev/ino, which would identify
 * them for certain — wire that up only if collisions turn out to be common, since resolving them
 * needs a readdir() that TCC does not allow anyway.
 */
export function trashPathFor(abs: string, trashDir: string): string {
  return join(trashDir, basename(abs));
}

function stateOf(abs: string, trashPath: string): TrashState {
  if (existsSync(abs)) return 'restored';
  try {
    statSync(trashPath);
    return 'in-trash';
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'gone' : 'unknown';
  }
}

/**
 * Every file this workspace trashed, newest run first.
 *
 * A path can appear in several runs (trashed, restored by hand, trashed again); only the newest
 * row survives, because that is the one whose state is current.
 */
export function listTrashed(manifestDir: string, ws: string, trashDir: string): TrashRow[] {
  let files: string[];
  try {
    files = readdirSync(manifestDir).filter((f) => f.endsWith(`-${ws}.tsv`));
  } catch {
    return [];                                     // no manifests yet: nothing was ever trashed
  }
  files.sort().reverse();                          // filenames lead with an ISO timestamp
  const seen = new Set<string>();
  const rows: TrashRow[] = [];
  for (const run of files) {
    let parsed;
    try { parsed = parseManifest(readFileSync(join(manifestDir, run), 'utf8')); } catch { continue; }
    for (const r of parsed) {
      if (seen.has(r.rel)) continue;
      seen.add(r.rel);
      const trashPath = trashPathFor(r.abs, trashDir);
      rows.push({ ...r, run, trashPath, state: stateOf(r.abs, trashPath) });
    }
  }
  return rows;
}

export interface RestoreResult { rel: string; ok: boolean; reason?: string }

/**
 * Move one file out of the Trash and back to where it came from.
 *
 * rename() is deliberate: it is atomic within a volume (~/.Trash and the library are both on the
 * user's volume), so there is no window in which the file exists in neither place or in both.
 * A copy+delete could leave exactly that half-moved state.
 */
export function restoreOne(row: TrashRow, root: string, trashDir: string): RestoreResult {
  // The manifest is a plain TSV the user could have edited, so the destination is re-derived
  // from the library-relative path and re-checked for containment rather than trusted.
  const dest = resolveDestination(row.rel, root);
  if (!dest) return { rel: row.rel, ok: false, reason: 'destination is outside the library' };
  if (existsSync(dest)) return { rel: row.rel, ok: false, reason: 'a file is already there' };
  const src = trashPathFor(row.abs, trashDir);
  if (!existsSync(src)) return { rel: row.rel, ok: false, reason: 'not in the Trash any more' };
  try {
    mkdirSync(dirname(dest), { recursive: true });
    renameSync(src, dest);
    return { rel: row.rel, ok: true };
  } catch (e) {
    return { rel: row.rel, ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/** Restore a selection. Every item is independent — one failure never stops the rest. */
export function restoreMany(rels: string[], rows: TrashRow[], root: string, trashDir: string): RestoreResult[] {
  const byRel = new Map(rows.map((r) => [r.rel, r]));
  const out: RestoreResult[] = [];
  for (const rel of rels) {
    const row = byRel.get(rel);
    if (!row) { out.push({ rel, ok: false, reason: 'not in the trash record' }); continue; }
    if (row.state === 'restored') { out.push({ rel, ok: true }); continue; }   // already back
    out.push(restoreOne(row, root, trashDir));
  }
  return out;
}
