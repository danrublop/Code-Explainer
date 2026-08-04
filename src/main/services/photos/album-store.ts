// Albums and per-photo rotation, persisted per workspace in userData.
//
// The offline gallery keeps both in localStorage, which is fine for a static file on a USB
// stick but wrong here: localStorage is per browser profile, so the same library viewed from a
// rebuilt renderer would silently lose every album. This is the same JSON-file-with-atomic-write
// shape as mark-store.
//
// Rotation is a *display* value (0/90/180/270), never baked into the file. Rewriting pixels is
// rotate-photos.py's job and it is destructive; the app only records how to show it.

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'fs';
import { dirname, join } from 'path';

export type Albums = Record<string, string[]>;         // album name -> rel paths
export type Rotations = Record<string, number>;        // rel path -> 90 | 180 | 270

interface Shape {
  albums: Record<string, Albums>;                      // workspace id -> albums
  rotations: Record<string, Rotations>;                // workspace id -> rotations
}

const EMPTY: Shape = { albums: {}, rotations: {} };

export class AlbumStore {
  private data: Shape = { albums: {}, rotations: {} };

  constructor(private file: string) {
    this.load();
  }

  private load(): void {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Shape>;
      this.data = {
        albums: raw.albums && typeof raw.albums === 'object' ? raw.albums : {},
        rotations: raw.rotations && typeof raw.rotations === 'object' ? raw.rotations : {},
      };
    } catch {
      this.data = { ...EMPTY, albums: {}, rotations: {} };   // missing or corrupt: start clean
    }
  }

  // Write to a sibling then rename: a crash mid-write leaves the previous file intact rather
  // than a truncated one, which would read as "you have no albums".
  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data));
    renameSync(tmp, this.file);
  }

  albums(ws: string): Albums {
    return this.data.albums[ws] ?? {};
  }

  /** Add rels to an album, creating it if new. Returns the updated album set. */
  addToAlbum(ws: string, name: string, rels: string[]): Albums {
    const clean = name.trim();
    if (!clean || !rels.length) return this.albums(ws);
    const all = this.data.albums[ws] ?? (this.data.albums[ws] = {});
    // A Set here, not concat: adding the same selection twice is a normal thing to do by
    // accident and must not double every entry.
    all[clean] = [...new Set([...(all[clean] ?? []), ...rels])];
    this.save();
    return all;
  }

  removeFromAlbum(ws: string, name: string, rels: string[]): Albums {
    const all = this.data.albums[ws];
    if (!all?.[name]) return this.albums(ws);
    const drop = new Set(rels);
    all[name] = all[name].filter((r) => !drop.has(r));
    if (!all[name].length) delete all[name];        // an empty album is just clutter in the rail
    this.save();
    return all;
  }

  deleteAlbum(ws: string, name: string): Albums {
    if (this.data.albums[ws]) { delete this.data.albums[ws][name]; this.save(); }
    return this.albums(ws);
  }

  rotations(ws: string): Rotations {
    return this.data.rotations[ws] ?? {};
  }

  /** Set absolute rotation for one photo. 0 removes the entry rather than storing a no-op. */
  setRotation(ws: string, rel: string, deg: number): Rotations {
    const d = ((Math.round(deg / 90) * 90) % 360 + 360) % 360;
    const r = this.data.rotations[ws] ?? (this.data.rotations[ws] = {});
    if (d === 0) delete r[rel]; else r[rel] = d;
    this.save();
    return r;
  }

  /** Drop state for paths that no longer exist — called after a trash apply. */
  forget(ws: string, rels: string[]): void {
    const gone = new Set(rels);
    const alb = this.data.albums[ws];
    if (alb) for (const k of Object.keys(alb)) {
      alb[k] = alb[k].filter((r) => !gone.has(r));
      if (!alb[k].length) delete alb[k];
    }
    const rot = this.data.rotations[ws];
    if (rot) for (const r of rels) delete rot[r];
    this.save();
  }
}

export function defaultAlbumFile(userData: string): string {
  return join(userData, 'photo-albums.json');
}

export { existsSync as _existsSync };   // re-exported for tests that stub fs presence
