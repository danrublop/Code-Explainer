// Read-only view over the consolidated photo library on disk (~/Media), laid out as
//   <root>/YYYY/YYYY-MM/<source>/<file>      e.g. 2024/2024-06/nikon/DSC_0001.JPG
//   <root>/_no-date/<source>/<file>          anything with no usable EXIF/filename date
//
// The renderer never touches fs: it asks for an index (cheap counts) and then one month at a
// time, and loads pixels through the `photo://` protocol. Everything here is read-only —
// nothing in this module writes, moves, or deletes.

import { readdirSync, statSync, existsSync, realpathSync } from 'fs';
import { join, resolve, sep, extname } from 'path';
import { homedir } from 'os';

export const DEFAULT_LIBRARY_ROOT = join(homedir(), 'Media');

const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'heic', 'heif', 'gif', 'webp', 'tif', 'tiff', 'bmp']);
// RAW needs a decoder the renderer doesn't have; list it so counts are honest, but the grid
// shows a placeholder rather than a broken <img>.
const RAW_EXT = new Set(['dng', 'nef', 'cr2', 'cr3', 'arw', 'raf', 'orf', 'rw2', 'psd']);
const VIDEO_EXT = new Set(['mov', 'mp4', 'm4v', 'avi', 'mts', 'm2ts', 'mkv', 'mpg', 'mpeg', '3gp']);

export type PhotoKind = 'image' | 'raw' | 'video';
export interface PhotoEntry {
  rel: string;        // path relative to root, always '/'-joined — the photo:// key
  name: string;
  month: string;      // '2024-06' | '_no-date'
  source: string;     // 'nikon' | 'canon' | 'iphone-14' | …
  kind: PhotoKind;
  size: number;
  mtime: number;
}
export interface MonthBucket { month: string; year: string; count: number }
export interface PhotoIndex {
  root: string;
  exists: boolean;
  total: number;
  months: MonthBucket[];   // newest first
  sources: string[];
}

export function kindOf(name: string): PhotoKind | null {
  const ext = extname(name).slice(1).toLowerCase();
  if (IMAGE_EXT.has(ext)) return 'image';
  if (RAW_EXT.has(ext)) return 'raw';
  if (VIDEO_EXT.has(ext)) return 'video';
  return null;
}

function dirsIn(p: string): string[] {
  try {
    return readdirSync(p, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name);
  } catch {
    return [];
  }
}

// A month lives at <root>/<year>/<year>-<mm>/ except '_no-date', which sits at the top level.
function monthDir(root: string, month: string): string {
  return month === '_no-date' ? join(root, '_no-date') : join(root, month.slice(0, 4), month);
}

/** Cheap structural scan: directory names + per-month file counts. No stat() per file. */
export function buildIndex(root: string = DEFAULT_LIBRARY_ROOT): PhotoIndex {
  if (!existsSync(root)) return { root, exists: false, total: 0, months: [], sources: [] };

  const months: MonthBucket[] = [];
  const sources = new Set<string>();
  let total = 0;

  const addMonth = (month: string, year: string) => {
    let count = 0;
    const md = monthDir(root, month);
    for (const src of dirsIn(md)) {
      sources.add(src);
      try {
        for (const f of readdirSync(join(md, src))) {
          if (!f.startsWith('.') && kindOf(f)) count++;
        }
      } catch { /* unreadable source dir — skip */ }
    }
    if (count) { months.push({ month, year, count }); total += count; }
  };

  for (const top of dirsIn(root)) {
    if (top === '_no-date') { addMonth('_no-date', '_no-date'); continue; }
    if (!/^\d{4}$/.test(top)) continue;                       // ignore stray dirs
    for (const m of dirsIn(join(root, top))) {
      if (/^\d{4}-\d{2}$/.test(m)) addMonth(m, top);
    }
  }

  // Newest first; '_no-date' always last so it never buries real months.
  months.sort((a, b) => {
    if (a.month === '_no-date') return 1;
    if (b.month === '_no-date') return -1;
    return b.month.localeCompare(a.month);
  });
  return { root, exists: true, total, months, sources: [...sources].sort() };
}

/** Entries for one month, newest file first. */
export function listMonth(month: string, root: string = DEFAULT_LIBRARY_ROOT): PhotoEntry[] {
  if (!/^\d{4}-\d{2}$/.test(month) && month !== '_no-date') return [];
  const md = monthDir(root, month);
  if (!existsSync(md)) return [];

  const out: PhotoEntry[] = [];
  for (const source of dirsIn(md)) {
    const sd = join(md, source);
    let names: string[] = [];
    try { names = readdirSync(sd); } catch { continue; }
    for (const name of names) {
      if (name.startsWith('.')) continue;
      const kind = kindOf(name);
      if (!kind) continue;
      let size = 0, mtime = 0;
      try { const st = statSync(join(sd, name)); size = st.size; mtime = st.mtimeMs; } catch { continue; }
      const rel = month === '_no-date'
        ? ['_no-date', source, name].join('/')
        : [month.slice(0, 4), month, source, name].join('/');
      out.push({ rel, name, month, source, kind, size, mtime });
    }
  }
  out.sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name));
  return out;
}

/**
 * Map a photo:// relative path to a real file, or null.
 *
 * This is the security boundary for the protocol handler: the renderer supplies `rel`, so it is
 * untrusted. Reject anything that escapes the library root ('../', absolute paths, symlink
 * hops) or isn't a media file — otherwise photo:///../../.ssh/id_rsa would read fine.
 */
export function resolveInLibrary(rel: string, root: string = DEFAULT_LIBRARY_ROOT): string | null {
  if (!rel || rel.includes('\0')) return null;
  const rootAbs = resolve(root);
  const abs = resolve(rootAbs, rel);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + sep)) return null;   // traversal
  if (!kindOf(abs)) return null;                                        // not media
  let st;
  try { st = statSync(abs); } catch { return null; }                    // statSync follows symlinks
  if (!st.isFile()) return null;
  // Re-check after following symlinks: a link inside the root may still point outside it.
  // Both sides must be realpath'd — on macOS the root itself often sits under a symlink
  // (/var -> /private/var, /tmp -> /private/tmp), so comparing real vs non-real rejects
  // every legitimate file.
  try {
    const real = realpathSync(abs);
    const rootReal = realpathSync(rootAbs);
    if (real !== rootReal && !real.startsWith(rootReal + sep)) return null;
  } catch { return null; }
  return abs;
}
