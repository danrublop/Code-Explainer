// FIND/REPLACE edit protocol for the note-side chat panel (adapted from odysseus' document tools).
// The model emits blocks; we apply them as plain-string edits to the note's Markdown, then hand
// the result back to the editor's markdown setContent (which re-parses through the XSS-safe
// ProseMirror schema). Kept pure + separate from React so it's unit-testable.

export interface NoteEdit { find: string; replace: string }

const BLOCK = /<<<FIND>>>\r?\n?([\s\S]*?)\r?\n?<<<REPLACE>>>\r?\n?([\s\S]*?)\r?\n?<<<END>>>/g;

/** Extract every FIND/REPLACE block from a model message. */
export function parseEdits(text: string): NoteEdit[] {
  const edits: NoteEdit[] = [];
  for (const m of text.matchAll(BLOCK)) edits.push({ find: m[1], replace: m[2] });
  return edits;
}

/** The message with its edit blocks removed — the prose the model wrote around them. */
export function stripEdits(text: string): string {
  return text.replace(BLOCK, '').replace(/\n{3,}/g, '\n\n').trim();
}

const isWord = (c: string) => /\w/.test(c);
// A match is mid-word when a word-char abuts a word-char edge of the needle — e.g. FIND "cat"
// landing inside "concatenate". Splicing there silently mangles an unrelated word, so we refuse it.
function isMidWord(hay: string, start: number, end: number): boolean {
  return (start > 0 && isWord(hay[start - 1]) && isWord(hay[start]))
    || (end < hay.length && isWord(hay[end - 1]) && isWord(hay[end]));
}

/**
 * Apply edits to `base` Markdown. Empty FIND ⇒ append REPLACE to the end. Otherwise the FIND must
 * occur EXACTLY ONCE (exact match preferred, else a whitespace-trimmed needle) and not mid-word:
 * a missing, ambiguous (>1 occurrence), or mid-word target is refused and counted in `failed` — we
 * never guess which "milk" the model meant, and never splice into the middle of a word. All matches
 * are located against the original `base` and spliced last-to-first so edits don't shift each
 * other's offsets; overlapping edits drop the later one. Nothing is ever silently corrupted.
 */
export function applyEdits(base: string, edits: NoteEdit[]): { md: string; applied: number; failed: number } {
  let applied = 0;
  let failed = 0;
  const appends: string[] = [];
  const spans: { start: number; end: number; replace: string }[] = [];

  for (const e of edits) {
    if (!e.find.trim()) { appends.push(e.replace.trim()); applied++; continue; }
    let needle = e.find;
    let first = base.indexOf(needle);
    if (first < 0) { needle = e.find.trim(); first = base.indexOf(needle); }
    // Miss, ambiguous, or mid-word → refuse (never a silent wrong-target splice).
    if (first < 0 || base.indexOf(needle, first + 1) >= 0 || isMidWord(base, first, first + needle.length)) {
      failed++;
      continue;
    }
    spans.push({ start: first, end: first + needle.length, replace: e.replace });
  }

  // Drop any span overlapping an earlier-kept one (can't apply both cleanly), then splice
  // last-to-first so earlier offsets stay valid against the original base.
  spans.sort((a, b) => a.start - b.start);
  const kept: typeof spans = [];
  let lastEnd = -1;
  for (const s of spans) {
    if (s.start < lastEnd) { failed++; continue; }
    kept.push(s); lastEnd = s.end; applied++;
  }
  let md = base;
  for (let i = kept.length - 1; i >= 0; i--) md = md.slice(0, kept[i].start) + kept[i].replace + md.slice(kept[i].end);
  if (appends.length) md = md.replace(/\s*$/, '') + '\n\n' + appends.join('\n\n') + '\n';
  return { md, applied, failed };
}
