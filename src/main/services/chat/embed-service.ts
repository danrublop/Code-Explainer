// Embeddings via Ollama's local /api/embed (model nomic-embed-text). On-device, private, free.
// Returns null per input on any failure (model not pulled, Ollama down) so callers fall back to
// BM25 — RAG degrades, chat never breaks. Thin runtime adapter; verified by running the app.

import axios from 'axios';

const BASE_URL = 'http://127.0.0.1:11434';
export const EMBED_MODEL = 'nomic-embed-text';
// Storage tag for embedded chunks — bump when the embedding recipe changes so backfill re-embeds
// every note under the new tag instead of searching a mix of incompatible vector spaces. Bumped to
// v2 when task prefixes were added below.
export const EMBED_TAG = 'nomic-embed-text/v2-taskprefix';
// nomic-embed-text is trained with task-instruction prefixes: documents and queries must each carry
// their matching prefix or a differently-worded query misses the note it should hit.
// https://huggingface.co/nomic-ai/nomic-embed-text-v1.5
export const DOC_PREFIX = 'search_document: ';
export const QUERY_PREFIX = 'search_query: ';

export class EmbedService {
  /** Embed a batch. Result[i] is the vector for texts[i], or null if embedding failed. */
  async embed(texts: string[]): Promise<(Float32Array | null)[]> {
    if (!texts.length) return [];
    try {
      const { data } = await axios.post(
        `${BASE_URL}/api/embed`,
        { model: EMBED_MODEL, input: texts },
        { timeout: 60000 },
      );
      const arr = data?.embeddings as number[][] | undefined;
      if (!Array.isArray(arr) || arr.length !== texts.length) return texts.map(() => null);
      return arr.map((e) => (Array.isArray(e) ? Float32Array.from(e) : null));
    } catch {
      return texts.map(() => null);
    }
  }

  /** True if the embed model responds — drives the Settings "RAG ready / needs model" badge. */
  async healthy(): Promise<boolean> {
    const [v] = await this.embed(['ping']);
    return !!v;
  }
}
