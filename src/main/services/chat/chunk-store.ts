// Persistent store for note chunk-embeddings, backing RAG's brute-force cosine search.
//
// ponytail: a single JSON file (whole-file rewrite on change), loaded into memory once. At
// personal-notebook scale (hundreds–low-thousands of chunks) this is a few MB and a full-scan
// query is sub-millisecond. Kept OUT of the native sqlite index on purpose — no schema/ABI
// surface, and it works identically on machines that fall back to the in-memory note index.
// Upgrade path if a corpus ever gets huge: sqlite BLOB column + sqlite-vec.

import { readFileSync, writeFileSync, renameSync, existsSync } from 'fs';
import type { Chunk } from './rag';

export interface StoredChunk { noteId: string; idx: number; text: string; vec: number[]; model: string }

export class ChunkStore {
  private chunks: StoredChunk[] = [];

  constructor(private readonly path: string) {
    try {
      if (existsSync(path)) {
        const parsed = JSON.parse(readFileSync(path, 'utf8'));
        if (Array.isArray(parsed)) this.chunks = parsed;
      }
    } catch {
      this.chunks = []; // corrupt file → start empty; sync will re-embed
    }
  }

  private persist(): void {
    // Write to a temp file then rename — an atomic swap, so a crash mid-write can't leave a
    // truncated JSON that fails to parse on next launch (dropping the whole embedding index).
    try {
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.chunks));
      renameSync(tmp, this.path);
    } catch { /* best effort */ }
  }

  /** Replace all chunks for a note (delete + insert), then persist. */
  replaceNote(noteId: string, chunks: Omit<StoredChunk, 'noteId'>[]): void {
    this.chunks = this.chunks.filter((c) => c.noteId !== noteId);
    for (const c of chunks) this.chunks.push({ ...c, noteId });
    this.persist();
  }

  /** Drop a note's chunks (note deleted). */
  deleteNote(noteId: string): void {
    const before = this.chunks.length;
    this.chunks = this.chunks.filter((c) => c.noteId !== noteId);
    if (this.chunks.length !== before) this.persist();
  }

  /** Keep only chunks whose note is still live — drops orphans from notes deleted off-disk while
   *  the app was closed (otherwise RAG keeps quoting and citing a note that no longer exists). */
  retain(liveIds: Set<string>): void {
    const before = this.chunks.length;
    this.chunks = this.chunks.filter((c) => liveIds.has(c.noteId));
    if (this.chunks.length !== before) this.persist();
  }

  /** All chunks as rag.Chunk (vectors inflated to Float32Array). With `model`, only that tag's
   *  chunks — so a search never compares vectors from two different (incompatible) embedding
   *  spaces, e.g. during a re-embed backfill after the recipe changed. */
  all(model?: string): Chunk[] {
    const src = model ? this.chunks.filter((c) => c.model === model) : this.chunks;
    return src.map((c) => ({ noteId: c.noteId, idx: c.idx, text: c.text, vec: Float32Array.from(c.vec) }));
  }

  /** Note ids already embedded with `model` — for resumable backfill (skip done notes). */
  embeddedNotes(model: string): Set<string> {
    return new Set(this.chunks.filter((c) => c.model === model).map((c) => c.noteId));
  }

  count(model?: string): number {
    return model ? this.chunks.filter((c) => c.model === model).length : this.chunks.length;
  }
}
