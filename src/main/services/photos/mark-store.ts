// Keep/delete decisions from the Photos review pass.
//
// These live in the main process (userData/photo-marks.json), not localStorage, for one reason:
// they are the user's only record of a long review over ~20k files, and a renderer rebuild,
// reload or profile reset would silently throw them away. The file is the truth; the grid
// re-reads it on mount.
//
//   { "ws-<uuid>": { "2024/2024-06/nikon/DSC_0001.JPG": { "m": "delete", "s": 5601234 } } }
//
// The size is stored alongside the mark so "12.4 GB marked for deletion" is answerable from
// this file alone, without stat()-ing every marked file in every month the grid isn't showing.
// It is a display figure only — the apply path re-stats from disk and records that in the
// manifest.

import { existsSync, readFileSync, writeFileSync, renameSync } from 'fs';

export type PhotoMark = 'keep' | 'delete';
export interface MarkRecord { m: PhotoMark; s: number }
/** ws id -> library-relative path -> record */
type MarkFile = Record<string, Record<string, MarkRecord>>;

function isMark(v: unknown): v is PhotoMark {
  return v === 'keep' || v === 'delete';
}

export class PhotoMarkStore {
  private marks: MarkFile = {};

  constructor(private readonly path: string) {
    this.load();
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as unknown;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
      for (const [ws, entries] of Object.entries(raw as Record<string, unknown>)) {
        if (!entries || typeof entries !== 'object' || Array.isArray(entries)) continue;
        const clean: Record<string, MarkRecord> = {};
        for (const [rel, rec] of Object.entries(entries as Record<string, unknown>)) {
          const r = rec as { m?: unknown; s?: unknown };
          if (!r || !isMark(r.m)) continue;
          clean[rel] = { m: r.m, s: typeof r.s === 'number' && r.s >= 0 ? r.s : 0 };
        }
        this.marks[ws] = clean;
      }
    } catch (e) {
      // A review pass over 20k files is hours of work. If the file is unreadable, keep the bad
      // copy rather than overwriting it with an empty one — same policy as workspace-store.
      try {
        const backup = `${this.path}.corrupt-${Date.now()}`;
        renameSync(this.path, backup);
        console.error(`photo-marks.json was unreadable; backed up to ${backup}.`, e);
      } catch (renameErr) {
        console.warn('photo-marks.json unreadable and could not be backed up.', e, renameErr);
      }
      this.marks = {};
    }
  }

  private save(): void {
    try {
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.marks), 'utf8');
      renameSync(tmp, this.path);           // atomic: a crash mid-write must not lose the pass
    } catch (e) {
      console.warn('failed to write photo-marks.json:', e);
    }
  }

  /** Every mark for one workspace. The renderer gets this whole map on mount. */
  get(ws: string): Record<string, MarkRecord> {
    return { ...(this.marks[ws] ?? {}) };
  }

  /** Mark files, or clear them when `mark` is null. Unknown rels are simply dropped on clear. */
  set(ws: string, entries: Array<{ rel: string; size: number }>, mark: PhotoMark | null): void {
    if (!entries.length) return;
    const bucket = this.marks[ws] ?? (this.marks[ws] = {});
    for (const { rel, size } of entries) {
      if (mark) bucket[rel] = { m: mark, s: Math.max(0, Math.round(size) || 0) };
      else delete bucket[rel];
    }
    if (!Object.keys(bucket).length) delete this.marks[ws];
    this.save();
  }

  /** Paths marked for deletion — the input to the apply step. */
  deleteRels(ws: string): string[] {
    return Object.entries(this.marks[ws] ?? {}).filter(([, r]) => r.m === 'delete').map(([rel]) => rel);
  }

  /** Counts + the byte total behind the Apply button. */
  totals(ws: string): { keep: number; del: number; delBytes: number } {
    let keep = 0, del = 0, delBytes = 0;
    for (const r of Object.values(this.marks[ws] ?? {})) {
      if (r.m === 'keep') keep++;
      else { del++; delBytes += r.s; }
    }
    return { keep, del, delBytes };
  }
}
