// Photo workspaces: several independent libraries, switched like separate accounts.
//
// Each workspace is just a name + a root directory. The grid's layout rules are unchanged —
// every root is still read as YYYY/YYYY-MM/<source>/ by photo-library.ts — so "Personal",
// "Work" and "Family" are three roots that never see each other's files.
//
//   [ { "id": "ws-<uuid>", "name": "Personal", "root": "/Users/me/Media" }, … ]
//
// The id doubles as the photo:// hostname (photo://ws-<uuid>/2024/2024-06/nikon/x.jpg), which
// is what keeps the roots isolated: the protocol handler resolves a request against that one
// workspace's root, so a URL minted for Work can never read a file under Personal.

import { existsSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { basename } from 'path';
import { DEFAULT_LIBRARY_ROOT } from './photo-library';

export interface PhotoWorkspace {
  id: string;
  name: string;
  root: string;
}

/**
 * Ids are main-generated and must survive being parsed as a URL hostname: lowercase, and
 * leading with 'ws-' so an all-digit uuid can never be canonicalised as an IPv4 literal.
 * A renderer-supplied id that doesn't match this is inert (rootOf returns null).
 */
export function isValidWorkspaceId(id: unknown): id is string {
  return typeof id === 'string' && /^ws-[a-z0-9-]{1,64}$/.test(id);
}

function cleanName(name: unknown, fallback: string): string {
  const n = typeof name === 'string' ? name.trim().slice(0, 60) : '';
  return n || fallback;
}

export class PhotoWorkspaceStore {
  private spaces: PhotoWorkspace[] = [];

  constructor(
    private readonly path: string,
    private readonly newId: () => string,
  ) {
    this.load();
  }

  private load(): void {
    if (!existsSync(this.path)) {
      // First run: adopt the library the consolidator writes to, so Photos isn't empty.
      this.spaces = [{ id: this.mintId(), name: 'Personal', root: DEFAULT_LIBRARY_ROOT }];
      this.save();
      return;
    }
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as unknown;
      this.spaces = (Array.isArray(raw) ? raw : []).filter(
        (w): w is PhotoWorkspace =>
          !!w && isValidWorkspaceId(w.id) && typeof w.name === 'string' && typeof w.root === 'string' && !!w.root,
      );
    } catch (e) {
      // This file is the only record of which folders the user attached. Losing it silently
      // would empty the Photos view with no explanation, so keep the bad copy for recovery.
      // Mirrors folder-store's corrupt-file handling. (No photos are ever at risk — a
      // workspace is a pointer, not a container.)
      try {
        const backup = `${this.path}.corrupt-${Date.now()}`;
        renameSync(this.path, backup);
        console.error(`photo-workspaces.json was unreadable; backed up to ${backup}.`, e);
      } catch (renameErr) {
        console.warn('photo-workspaces.json unreadable and could not be backed up.', e, renameErr);
      }
      this.spaces = [];
    }
  }

  private mintId(): string {
    return `ws-${this.newId()}`.toLowerCase();
  }

  private save(): void {
    try {
      // Atomic write — a crash mid-write must not cost the user their attached folders.
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.spaces, null, 2), 'utf8');
      renameSync(tmp, this.path);
    } catch (e) {
      console.warn('failed to write photo-workspaces.json:', e);
    }
  }

  list(): PhotoWorkspace[] {
    return this.spaces.map((w) => ({ ...w }));
  }

  /** The security lookup: an unknown or malformed id resolves to no root at all. */
  rootOf(id: unknown): string | null {
    if (!isValidWorkspaceId(id)) return null;
    return this.spaces.find((w) => w.id === id)?.root ?? null;
  }

  /** Attach a folder. Re-adding one that's already attached returns the existing workspace. */
  add(root: string, name?: string): PhotoWorkspace {
    const existing = this.spaces.find((w) => w.root === root);
    if (existing) return { ...existing };
    const ws: PhotoWorkspace = {
      id: this.mintId(),
      name: cleanName(name, basename(root) || 'Library'),
      root,
    };
    this.spaces.push(ws);
    this.save();
    return { ...ws };
  }

  /** Detach a folder from the app. Never touches the folder or the photos inside it. */
  remove(id: unknown): void {
    if (!isValidWorkspaceId(id)) return;
    const next = this.spaces.filter((w) => w.id !== id);
    if (next.length === this.spaces.length) return;
    this.spaces = next;
    this.save();
  }

  rename(id: unknown, name: string): void {
    if (!isValidWorkspaceId(id)) return;
    const ws = this.spaces.find((w) => w.id === id);
    if (!ws) return;
    ws.name = cleanName(name, ws.name);
    this.save();
  }
}
