// Apply a review pass: move the delete-marked files to the system Trash.
//
// THE SAFETY CONTEXT, because it is not the usual one. ~/Media is the SOLE COPY of this
// library — the source folders it was consolidated from have been deleted and there is no
// backup and no cloud. There is no "Recently Deleted" and no 30-day window behind this. So:
//
//   * files are TRASHED, never unlinked. shell.trashItem() is injected as `trash` — the same
//     move Finder performs, so the user can restore from the Trash by hand.
//   * a manifest is written BEFORE anything moves. It records the library-relative path, the
//     absolute path, size and mtime, so a file can be identified and put back even if the
//     Trash entry is later renamed.
//   * every path is resolved through resolveInLibrary() — the existing security boundary —
//     so a rel from the renderer can never make this trash something outside the library.
//   * it is idempotent: a rel that no longer resolves (already trashed, or moved by hand) is
//     reported as `missing`, not retried and not an error.

import { statSync } from 'fs';
import { resolveInLibrary } from './photo-library';

// dev/ino are recorded because trashing preserves the inode: they identify the file even after
// it has been renamed on a collision in the Trash, and they are the ThumbnailCache's key, so a
// future Trash view can find the cached thumbnail of a file that no longer exists.
export interface TrashItem { rel: string; abs: string; size: number; mtime: number; dev: number; ino: number }
export interface TrashResult {
  manifest: string;
  trashed: TrashItem[];
  missing: string[];
  failed: Array<{ rel: string; error: string }>;
  bytes: number;
}
export interface TrashDeps {
  /** shell.trashItem in production. Must reject on failure. */
  trash: (abs: string) => Promise<void>;
  /** Persist the manifest and return where it went. Called before the first move. */
  writeManifest: (text: string) => string;
  now?: () => Date;
}

/**
 * Resolve the marked paths against the library.
 *
 * `missing` is the idempotency channel: applying the same plan twice leaves everything there
 * the second time, which is a no-op, not a failure.
 */
export function planTrash(rels: string[], root: string): { items: TrashItem[]; missing: string[] } {
  const items: TrashItem[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const rel of rels) {
    if (typeof rel !== 'string' || seen.has(rel)) continue;
    seen.add(rel);
    const abs = resolveInLibrary(rel, root);
    if (!abs) { missing.push(rel); continue; }
    try {
      const st = statSync(abs);
      items.push({ rel, abs, size: st.size, mtime: Math.round(st.mtimeMs), dev: st.dev, ino: st.ino });
    } catch {
      missing.push(rel);
    }
  }
  return { items, missing };
}

/** TSV, one row per file, written before the first move. Enough to identify and restore. */
export function manifestText(ws: string, root: string, items: TrashItem[], when: Date): string {
  const ts = when.toISOString();
  const lines = [
    `# llamas-remote photo trash manifest`,
    `# written ${ts} BEFORE any file was moved`,
    `# workspace ${ws}  root ${root}`,
    `# ${items.length} file(s), ${items.reduce((n, i) => n + i.size, 0)} bytes -> system Trash`,
    `# restore: the app's Photos > Trash view, or drag the file out of the Trash to its abs_path`,
    ['rel_path', 'abs_path', 'size', 'mtime_ms', 'trashed_at', 'dev', 'ino'].join('\t'),
  ];
  for (const i of items) {
    // Tabs/newlines cannot occur in a path that resolveInLibrary accepted on macOS, but a
    // manifest that silently mis-parses is worse than one with an escaped byte.
    const clean = (s: string) => s.replace(/[\t\r\n]/g, ' ');
    lines.push([clean(i.rel), clean(i.abs), i.size, i.mtime, ts, i.dev, i.ino].join('\t'));
  }
  return lines.join('\n') + '\n';
}

/** Plan, write the manifest, then trash. Never unlinks. */
export async function applyTrash(
  ws: string, root: string, rels: string[], deps: TrashDeps,
): Promise<TrashResult> {
  const when = (deps.now ?? (() => new Date()))();
  const { items, missing } = planTrash(rels, root);
  // Manifest first, always — including for an empty plan, so "nothing happened" is on record.
  const manifest = deps.writeManifest(manifestText(ws, root, items, when));

  const trashed: TrashItem[] = [];
  const failed: Array<{ rel: string; error: string }> = [];
  for (const item of items) {
    try {
      await deps.trash(item.abs);
      trashed.push(item);
    } catch (e) {
      failed.push({ rel: item.rel, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { manifest, trashed, missing, failed, bytes: trashed.reduce((n, i) => n + i.size, 0) };
}
