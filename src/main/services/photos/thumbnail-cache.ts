// Disk-backed thumbnail cache for the Photos grid.
//
// Why this exists: a tile is ~160px, but the originals are 24MP JPEGs (median 5.6 MB in the
// reference library). Painting one tile from an original means reading 5.6 MB and decoding it
// to ~97 MB of RGBA. Across a 3,252-file month that is ~18 GB of reads. A 512px thumbnail is
// ~37 KB -- about 157x less I/O and ~100x less decode -- so the grid serves thumbs and only the
// lightbox touches the original.
//
// Generation is Electron's own nativeImage.createThumbnailFromPath, which goes through macOS
// QuickLook: no ffmpeg, no sharp, no new dependency. It also decodes HEIC/RAW and video posters,
// which the renderer cannot display at all, so those tiles start working for free.

import { createHash } from 'crypto';
import { mkdirSync, existsSync, readFileSync, writeFileSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { nativeImage } from 'electron';

// Target ~512px on the long edge: 1.6x the largest tile (320px), sharp on Retina without
// storing pixels the grid can never show.
//
// The request is in POINTS, and macOS returns the thumbnail at 2x for Retina -- so asking for
// 256 yields ~512 actual pixels. Measured, not assumed: requesting 512 produced 1024px/169 KB
// files (~3.4 GB across the library). Note getSize() also reports points, so it cannot be used
// to detect the real pixel size.
export const THUMB_REQUEST_PT = 256;
export const THUMB_PX = 512;

export class ThumbnailCache {
  private dir: string;
  private inflight = new Map<string, Promise<Buffer | null>>();
  private failed = new Set<string>();   // don't retry a file that can't be decoded

  /** @param dir cache root (one per app, entries are keyed by workspace+inode+mtime+size) */
  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(this.dir, { recursive: true });
  }

  // Key on workspace + INODE + mtime + size -- deliberately not the path.
  //
  // A rename changes the path but keeps the inode, so path-keying threw away the entire cache
  // the moment 14,888 files were renamed. Inode survives renames and moves within a volume, so
  // the thumbnails stay valid. mtime+size still cover edits, and cover inode reuse after a
  // delete. Workspace stays in the key because two libraries can hold the same file.
  //
  // Sharded into 256 subdirs so no single directory holds 10k+ entries.
  private pathFor(ws: string, dev: number, ino: number, mtimeMs: number, size: number): string {
    const h = createHash('sha1').update(`${ws}\0${dev}\0${ino}\0${mtimeMs}\0${size}`).digest('hex');
    return join(this.dir, h.slice(0, 2), `${h}.jpg`);
  }

  /** Cached thumbnail bytes, generating on first request. null if the file can't be thumbnailed. */
  async get(ws: string, abs: string): Promise<Buffer | null> {
    let st;
    try { st = statSync(abs); } catch { return null; }

    const cachePath = this.pathFor(ws, st.dev, st.ino, st.mtimeMs, st.size);
    if (existsSync(cachePath)) {
      try { return readFileSync(cachePath); } catch { /* fall through and regenerate */ }
    }
    if (this.failed.has(cachePath)) return null;

    // Collapse concurrent requests for the same file — the grid fires many at once while
    // scrolling, and QuickLook is expensive enough that duplicate work is worth avoiding.
    const existing = this.inflight.get(cachePath);
    if (existing) return existing;

    const job = (async (): Promise<Buffer | null> => {
      try {
        const img = await nativeImage.createThumbnailFromPath(
          abs, { width: THUMB_REQUEST_PT, height: THUMB_REQUEST_PT });
        if (img.isEmpty()) throw new Error('empty thumbnail');
        const buf = img.toJPEG(80);
        mkdirSync(dirname(cachePath), { recursive: true });
        writeFileSync(cachePath, buf);
        return buf;
      } catch {
        this.failed.add(cachePath);   // unsupported codec / unreadable — stop asking
        return null;
      } finally {
        this.inflight.delete(cachePath);
      }
    })();
    this.inflight.set(cachePath, job);
    return job;
  }

  /** True if this file's thumbnail is already on disk (used to skip work during pre-warm). */
  has(ws: string, abs: string): boolean {
    try {
      const st = statSync(abs);
      return existsSync(this.pathFor(ws, st.dev, st.ino, st.mtimeMs, st.size));
    } catch {
      return false;
    }
  }
}

/**
 * Run `worker` over `items` with at most `limit` in flight.
 *
 * Without a cap, scrolling fast queues thousands of QuickLook calls and starves the UI thread
 * that is trying to paint the very tiles being generated. Also used to keep the pre-warm pass
 * politely in the background.
 */
export async function mapLimit<T>(items: T[], limit: number,
                                  worker: (item: T, i: number) => Promise<unknown>): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      try { await worker(items[i], i); } catch { /* one bad file must not stop the pass */ }
    }
  });
  await Promise.all(runners);
}
