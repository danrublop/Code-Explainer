// The Photos view — a read-only browser over the attached libraries, each laid out as
// YYYY/YYYY-MM/<source>. Mirrors the Calendar's shape: one pinned singleton in the sidebar, a
// dependency-free React view riding in the renderer.
//
// Workspaces sit at the top of the rail: several independent library roots ("Personal", "Work",
// "Family"), switched like separate accounts. They share no state — picking one swaps the
// months, the grid and the photo:// host together, so nothing from one library can surface in
// another. The pick is remembered per-window in localStorage.
//
// Pixels never cross IPC: each tile points at a `photo://<ws>/<rel>` URL that main serves
// straight off disk. Grid tiles append `?thumb=1` and get a cached 512px JPEG (~37 KB) instead
// of the original (~5.6 MB, decoding to ~97 MB of RGBA) — without that, one 3,252-file month
// asks the renderer for ~18 GB. The lightbox still loads the full-resolution original.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Viewer } from './Viewer';
import { photoUrl, thumbUrl } from './photo-url';

type PhotoKind = 'image' | 'raw' | 'video';
export interface PhotoEntry {
  rel: string; name: string; month: string; source: string;
  kind: PhotoKind; size: number; mtime: number;
}
interface PhotoIndex {
  root: string; exists: boolean; total: number;
  months: Array<{ month: string; year: string; count: number }>;
  sources: string[];
}
interface PhotoWorkspace { id: string; name: string; root: string }
type Mark = 'keep' | 'delete';
interface PhotoMarks {
  marks: Record<string, { m: Mark; s: number }>;
  totals: { keep: number; del: number; delBytes: number };
}
interface PhotoTrashReport {
  error?: string; trashed?: number; missing?: number;
  failed?: Array<{ rel: string; error: string }>;
  bytes?: number; manifest?: string;
  totals?: { keep: number; del: number; delBytes: number };
}
type TrashState = 'restored' | 'in-trash' | 'gone' | 'unknown';
interface TrashRow {
  rel: string; abs: string; size: number; mtime: number;
  at: string; run: string; trashPath: string; state: TrashState;
}
interface RestoreResult { rel: string; ok: boolean; reason?: string }
interface PhotosApi {
  photosWorkspaces: () => Promise<PhotoWorkspace[]>;
  photosWorkspaceAdd: () => Promise<PhotoWorkspace | null>;
  photosWorkspaceRemove: (ws: string) => Promise<void>;
  photosWorkspaceRename: (ws: string, name: string) => Promise<void>;
  photosIndex: (ws: string) => Promise<PhotoIndex>;
  photosList: (ws: string, month: string) => Promise<PhotoEntry[]>;
  photosLargest: (ws: string, limit?: number) => Promise<PhotoEntry[]>;
  photosBackedUp: (ws: string) => Promise<string[]>;
  photosMarks: (ws: string) => Promise<PhotoMarks>;
  photosMark: (ws: string, rels: string[], mark: Mark | null) => Promise<PhotoMarks | null>;
  photosApplyTrash: (ws: string) => Promise<PhotoTrashReport>;
  photosTrashList: (ws: string) => Promise<TrashRow[]>;
  photosTrashRestore: (ws: string, rels: string[]) => Promise<RestoreResult[]>;
  photosReveal: (ws: string, rel: string) => Promise<void>;
  photosOpen: (ws: string, rel: string) => Promise<void>;
  photosAlbums: (ws: string) => Promise<{ albums: Record<string, string[]>; rotations: Record<string, number> }>;
  photosAlbumAdd: (ws: string, name: string, rels: string[]) => Promise<Record<string, string[]>>;
  photosAlbumRemove: (ws: string, name: string, rels: string[]) => Promise<Record<string, string[]>>;
  photosAlbumDelete: (ws: string, name: string) => Promise<Record<string, string[]>>;
  photosRotate: (ws: string, rel: string, deg: number) => Promise<Record<string, number>>;
}
function api(): PhotosApi { return (window as unknown as { notebookAPI: PhotosApi }).notebookAPI; }

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const SIZE_KEY = 'nb-photos-size';
const WS_KEY = 'nb-photos-workspace';
// A pseudo-month: the biggest files across the WHOLE library rather than one month's worth.
// Reclaiming space is the whole reason this screen has a delete button, and the bytes are not
// distributed the way the tiles suggest — in the reference library 75% of 245 GB is 4,483 video
// files scattered over 60+ months, and 15,074 images are the other 25%. Browsing month by month
// can't find them; this can.
const LARGEST = '@largest';
const LARGEST_LIMIT = 800;
// Another pseudo-month: what this app has moved to ~/.Trash, read back from the apply manifests.
// The point is that Finder's Trash holds thousands of unrelated items — this shows only what
// came out of THIS library, and puts it back where it came from.
const TRASH = '@trash';
// The whole library in one grid. Month-at-a-time is the wrong shape for browsing 19k files when
// you don't already know the date — and the 'Not in iCloud' filter is only useful across
// everything at once, since unbacked files are scattered over 60+ months.
//
// ponytail: renders every entry as a real DOM node (~19.6k here — a second of layout on first
// paint, then smooth, because thumbnails already load lazily through IntersectionObserver).
// Virtualise the grid if a library ever gets big enough for that to hurt.
const ALL = '@all';
// Albums are a pseudo-month too: '@album:<name>' selects that album's rels out of the library.
const ALBUM_PREFIX = '@album:';
const EMPTY_MARKS: PhotoMarks = { marks: {}, totals: { keep: 0, del: 0, delBytes: 0 } };

function monthLabel(m: string): string {
  if (m.startsWith(ALBUM_PREFIX)) return m.slice(ALBUM_PREFIX.length);
  if (m === ALL) return 'All photos';
  if (m === LARGEST) return 'Largest files';
  if (m === TRASH) return 'Trash';
  if (m === '_no-date') return 'No date';
  const [y, mm] = m.split('-');
  return `${MONTH_NAMES[Number(mm) - 1] ?? mm} ${y}`;
}
function fmtSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

/**
 * Poster frame for a video tile.
 *
 * <img> can't render a video frame, so the tile stays black. Rather than shelling out to
 * ffmpeg and maintaining a thumbnail cache, let the <video> element decode its own first frame:
 * `preload="metadata"` + a `#t=` media fragment seeks there on load and paints it. macOS
 * decodes both H.264 and HEVC, which is everything in this library.
 *
 * The IntersectionObserver matters — <video> has no `loading="lazy"`, so without it every clip
 * in the month (4K drone footage included) would fetch metadata at once. src is attached only
 * once the tile scrolls into view, and stays attached after.
 *
 * ponytail: a codec macOS can't decode just stays black behind the play badge — same as before,
 * no regression. Generate real thumbs in main only if that turns out to be common.
 */
function VideoThumb({ src, poster }: { src: string; poster?: string }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  const [show, setShow] = useState(false);
  // With a cached poster there is nothing to decode: the still paints immediately and the video
  // is never fetched for the grid at all. Only clips QuickLook can't thumbnail fall back to the
  // seek-a-frame path below.
  const [posterFailed, setPosterFailed] = useState(false);
  const usePoster = !!poster && !posterFailed;

  // Hooks must run on every render, so this cannot sit behind an early return for the poster
  // case -- flipping posterFailed would change the hook count and crash the tree. It no-ops
  // instead: with a poster there is no <video> for ref to attach to, so `el` is null.
  useEffect(() => {
    const el = ref.current;
    if (!el || show) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { setShow(true); io.disconnect(); }
    }, { rootMargin: '200px' });   // start a little before it's on screen
    io.observe(el);
    return () => io.disconnect();
  }, [show, usePoster]);

  if (usePoster) {
    return (
      <img src={poster} loading="lazy" decoding="async" alt="" draggable={false}
           onError={() => setPosterFailed(true)} />
    );
  }

  return (
    <video
      ref={ref}
      // #t=0.5 lands past any black leader frame; falls back to frame 0 on very short clips.
      src={show ? `${src}#t=0.5` : undefined}
      preload="metadata"
      muted
      playsInline
      tabIndex={-1}
    />
  );
}

export default function PhotosDoc() {
  const [spaces, setSpaces] = useState<PhotoWorkspace[] | null>(null);
  const [ws, setWs] = useState<string>(() => localStorage.getItem(WS_KEY) ?? '');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [index, setIndex] = useState<PhotoIndex | null>(null);
  const [month, setMonth] = useState<string | null>(null);
  const [items, setItems] = useState<PhotoEntry[]>([]);
  const [source, setSource] = useState<string>('all');
  const [loading, setLoading] = useState(false);
  const [lightbox, setLightbox] = useState<PhotoEntry | null>(null);
  const [albums, setAlbums] = useState<Record<string, string[]>>({});
  const [rotations, setRotations] = useState<Record<string, number>>({});
  const albumsRef = useRef<Record<string, string[]>>({});
  albumsRef.current = albums;
  const [albumOpen, setAlbumOpen] = useState(false);
  const [albumName, setAlbumName] = useState('');
  const [size, setSize] = useState<number>(() => Number(localStorage.getItem(SIZE_KEY)) || 160);
  const [sort, setSort] = useState<'newest' | 'largest'>('newest');
  const [onlyUnbacked, setOnlyUnbacked] = useState(false);
  const [backedUp, setBackedUp] = useState<Set<string>>(new Set());
  // Review state. `marks` is main's copy, re-fetched on every mutation, so two windows can't
  // drift; `sel` is a transient selection that lives only until it's marked.
  const [marks, setMarks] = useState<PhotoMarks>(EMPTY_MARKS);
  const [sel, setSel] = useState<Set<string>>(() => new Set());
  const [anchor, setAnchor] = useState<number>(-1);
  const [confirming, setConfirming] = useState(false);
  const [applying, setApplying] = useState(false);
  const [report, setReport] = useState<PhotoTrashReport | null>(null);
  const [reloadToken, setReloadToken] = useState(0);   // bumped after Apply to re-read the month
  const [trashRows, setTrashRows] = useState<TrashRow[]>([]);
  const [restoring, setRestoring] = useState(false);
  const [restoreResults, setRestoreResults] = useState<RestoreResult[] | null>(null);
  useEffect(() => { localStorage.setItem(SIZE_KEY, String(size)); }, [size]);
  useEffect(() => { if (ws) localStorage.setItem(WS_KEY, ws); }, [ws]);

  // Load the attached libraries and settle on one. The remembered pick is honoured only if it
  // still exists — a workspace removed in another window would otherwise leave the grid stuck
  // on an id main no longer resolves.
  const loadSpaces = useCallback(async () => {
    const list = await api().photosWorkspaces().catch(() => null);
    if (!list) return;
    setSpaces(list);
    setWs((cur) => (list.some((w) => w.id === cur) ? cur : list[0]?.id ?? ''));
  }, []);
  useEffect(() => { void loadSpaces(); }, [loadSpaces]);

  const refresh = useCallback(async () => {
    if (!ws) { setIndex(null); setMonth(null); return; }
    const ix = await api().photosIndex(ws).catch(() => null);
    if (!ix) return;
    setIndex(ix);
    setMonth((cur) => (cur && (cur === LARGEST || cur === TRASH || ix.months.some((m) => m.month === cur))
      ? cur : ix.months[0]?.month ?? null));
  }, [ws]);
  useEffect(() => { void refresh(); }, [refresh]);

  // Marks belong to the workspace, not the month: a delete mark set in 2019 still counts toward
  // the Apply total while the grid is showing 2026.
  const reloadMarks = useCallback(async () => {
    if (!ws) { setMarks(EMPTY_MARKS); return; }
    setMarks(await api().photosMarks(ws).catch(() => EMPTY_MARKS));
  }, [ws]);
  useEffect(() => { void reloadMarks(); }, [reloadMarks]);

  // Loaded regardless of the current scope: the rail entry shows a count and byte total, which
  // is how the user learns the view exists at all.
  const reloadTrash = useCallback(async () => {
    if (!ws) { setTrashRows([]); return; }
    setTrashRows(await api().photosTrashList(ws).catch(() => []));
  }, [ws]);
  useEffect(() => { void reloadTrash(); }, [reloadTrash, reloadToken]);

  useEffect(() => {
    if (!ws) { setAlbums({}); setRotations({}); return; }
    let cancelled = false;
    api().photosAlbums(ws)
      .then((r) => { if (!cancelled) { setAlbums(r.albums ?? {}); setRotations(r.rotations ?? {}); } })
      .catch(() => { if (!cancelled) { setAlbums({}); setRotations({}); } });
    return () => { cancelled = true; };
  }, [ws, reloadToken]);

  useEffect(() => {
    if (!ws) { setBackedUp(new Set()); return; }
    let cancelled = false;
    api().photosBackedUp(ws)
      .then((r) => { if (!cancelled) setBackedUp(new Set(r)); })
      .catch(() => { if (!cancelled) setBackedUp(new Set()); });
    return () => { cancelled = true; };
  }, [ws]);

  useEffect(() => {
    if (!ws || !month) { setItems([]); return; }
    let cancelled = false;
    setLoading(true);
    setSel(new Set());
    setAnchor(-1);
    if (month === TRASH) { setItems([]); setLoading(false); return; }
    // ALL and LARGEST are the same whole-library walk — they differ only in how many entries come
    // back and how `sort` orders them, so one call serves both.
    const p = month.startsWith(ALBUM_PREFIX)
      ? api().photosLargest(ws, 200_000).then((r) => {
          const want = new Set(albumsRef.current[month.slice(ALBUM_PREFIX.length)] ?? []);
          return r.filter((x) => want.has(x.rel));
        })
      : month === ALL ? api().photosLargest(ws, 200_000)
      : month === LARGEST ? api().photosLargest(ws, LARGEST_LIMIT)
        : api().photosList(ws, month);
    p.then((r) => { if (!cancelled) { setItems(r); setSource('all'); } })
      .catch(() => { if (!cancelled) setItems([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [ws, month, reloadToken]);

  const addSpace = useCallback(async () => {
    const added = await api().photosWorkspaceAdd().catch(() => null);
    if (!added) return;                       // cancelled the picker
    await loadSpaces();
    setWs(added.id);
    setLightbox(null);
  }, [loadSpaces]);

  // Detach only — the folder and every photo in it stay on disk untouched.
  const removeSpace = useCallback(async (id: string) => {
    await api().photosWorkspaceRemove(id).catch(() => {});
    setLightbox(null);
    if (id === ws) { setIndex(null); setMonth(null); setItems([]); setWs(''); }
    await loadSpaces();
  }, [ws, loadSpaces]);

  const commitRename = useCallback(async (id: string, name: string) => {
    setRenaming(null);
    if (!name.trim()) return;
    await api().photosWorkspaceRename(id, name).catch(() => {});
    await loadSpaces();
  }, [loadSpaces]);

  const sourcesHere = useMemo(() => {
    const s = new Set(items.map((i) => i.source));
    return [...s].sort();
  }, [items]);
  const shown = useMemo(() => {
    let list = source === 'all' ? items : items.filter((i) => i.source === source);
    // Only proven Photos matches are hidden. 'maybe' rows stay visible: they were matched on
    // filename+size alone, and treating a coincidence as a backup is how originals get deleted.
    if (onlyUnbacked) list = list.filter((i) => !backedUp.has(i.rel));
    return sort === 'largest' ? [...list].sort((a, b) => b.size - a.size) : list;
  }, [items, source, sort, onlyUnbacked, backedUp]);

  // --- review: selection + marking ---------------------------------------------------------
  // Click routing, mirroring the HTML gallery (make-gallery.py's `data-act="sel"` corner
  // control): the hover checkbox always selects, shift/⌘ select, and once anything is selected
  // every plain click selects too. Only a plain click on a tile with nothing selected opens the
  // lightbox. ⌘-click alone was the entry point before and nobody found it — the visible circle
  // is the discoverable one, the modifiers stay for people who already know them.
  const onTileClick = useCallback((e: React.MouseEvent, it: PhotoEntry, idx: number) => {
    const viaCheckbox = !!(e.target as HTMLElement).closest('[data-act="sel"]');
    const range = e.shiftKey && anchor >= 0;
    if (!viaCheckbox && !range && !e.metaKey && sel.size === 0) { setLightbox(it); return; }
    setSel((cur) => {
      const next = new Set(cur);
      if (range) {
        const [a, b] = anchor < idx ? [anchor, idx] : [idx, anchor];
        for (let i = a; i <= b; i++) if (shown[i]) next.add(shown[i].rel);
      } else if (next.has(it.rel)) next.delete(it.rel);
      else next.add(it.rel);
      return next;
    });
    if (!range) setAnchor(idx);
  }, [anchor, sel.size, shown]);

  const clearSel = useCallback(() => { setSel(new Set()); setAnchor(-1); }, []);

  // --- trash view ---------------------------------------------------------------------------
  // 'restored' rows are history: they are back in the library, so they don't count toward what
  // is still recoverable.
  const trashPending = useMemo(() => trashRows.filter((r) => r.state !== 'restored'), [trashRows]);
  const trashBytes = useMemo(() => trashPending.reduce((n, r) => n + r.size, 0), [trashPending]);

  const doRestore = useCallback(async (rels: string[]) => {
    if (!ws || !rels.length) return;
    setRestoring(true);
    const res = await api().photosTrashRestore(ws, rels).catch(() => [] as RestoreResult[]);
    setRestoring(false);
    setRestoreResults(res);
    clearSel();
    await reloadTrash();
    setReloadToken((t) => t + 1);   // the files are back in the library, so the grid is stale
    void refresh();
  }, [ws, clearSel, reloadTrash, refresh]);

  const applyMark = useCallback(async (mark: Mark | null) => {
    if (!ws || sel.size === 0) return;
    const next = await api().photosMark(ws, [...sel], mark).catch(() => null);
    if (next) setMarks(next); else void reloadMarks();
    clearSel();
  }, [ws, sel, reloadMarks, clearSel]);

  const selBytes = useMemo(
    () => shown.filter((i) => sel.has(i.rel)).reduce((n, i) => n + i.size, 0),
    [shown, sel],
  );

  const doApplyTrash = useCallback(async () => {
    if (!ws) return;
    setApplying(true);
    const r = await api().photosApplyTrash(ws)
      .catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }));
    setApplying(false);
    setConfirming(false);
    setReport(r);
    await reloadMarks();
    // Files have left the library, so both the month counts and the current list are stale.
    setReloadToken((t) => t + 1);
    void refresh();
  }, [ws, reloadMarks, refresh]);

  // K / D / U act on the selection — the same keys as the sibling tool, minus album handling.
  useEffect(() => {
    if (sel.size === 0) return;
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement;
      if (el && /^(INPUT|TEXTAREA)$/.test(el.tagName)) return;
      if (e.key === 'Escape') { clearSel(); return; }
      // The Trash view shares `sel`, but marking a file that is no longer in the library is
      // meaningless — only Escape and select-all apply there.
      if (month === TRASH) return;
      const k = e.key.toLowerCase();
      if (k === 'd') void applyMark('delete');
      else if (k === 'k') void applyMark('keep');
      else if (k === 'u') void applyMark(null);
      else if (k === 'a' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setSel(new Set(shown.map((i) => i.rel)));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sel.size, applyMark, clearSel, shown, month]);

  // The viewer owns arrow-key navigation now; it needs the index, not the entry.
  const lbIndex = useMemo(
    () => (lightbox ? shown.findIndex((x) => x.rel === lightbox.rel) : -1),
    [lightbox, shown],
  );

  const byYear = useMemo(() => {
    const g = new Map<string, Array<{ month: string; count: number }>>();
    for (const m of index?.months ?? []) {
      if (!g.has(m.year)) g.set(m.year, []);
      g.get(m.year)!.push({ month: m.month, count: m.count });
    }
    return [...g.entries()];
  }, [index]);

  const active = spaces?.find((w) => w.id === ws) ?? null;

  return (
    <div className="photos-doc">
      <div className="photos-rail">
        {/* Workspaces: each is its own library root, so switching swaps the whole grid.
            Double-click a name to rename it. */}
        <div className="ph-ws-bar">
          {(spaces ?? []).map((w) => (
            renaming === w.id ? (
              <input
                key={w.id}
                className="ph-ws-input"
                defaultValue={w.name}
                autoFocus
                onBlur={(e) => void commitRename(w.id, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                  else if (e.key === 'Escape') setRenaming(null);
                }}
              />
            ) : (
              <button
                key={w.id}
                className={`ph-ws${w.id === ws ? ' on' : ''}`}
                onClick={() => setWs(w.id)}
                onDoubleClick={() => setRenaming(w.id)}
                title={`${w.root}\nDouble-click to rename`}
              >
                {w.name}
              </button>
            )
          ))}
          <button className="ph-ws-add" onClick={() => void addSpace()} title="Add a library folder">+</button>
        </div>

        <div className="photos-rail-head">
          <span>{!ws ? '' : index ? `${index.total.toLocaleString()} items` : 'Loading…'}</span>
          {active && (
            <button
              className="ph-icon"
              onClick={() => void removeSpace(active.id)}
              title={`Detach "${active.name}" from Llamas Remote.\nNothing on disk is deleted.`}
            >
              ⊖
            </button>
          )}
          <button className="ph-icon" onClick={() => void refresh()} title="Rescan library">⟳</button>
        </div>
        {index?.exists && (
          <button
            className={`ph-month ph-largest${month === ALL ? ' selected' : ''}`}
            onClick={() => { setMonth(ALL); setSort('newest'); }}
            title="Every photo and video in the library, in one continuous grid"
          >
            <span>All photos</span>
            <span className="ph-count">{index.total.toLocaleString()}</span>
          </button>
        )}
        {index?.exists && (
          <button
            className={`ph-month ph-largest${month === LARGEST ? ' selected' : ''}`}
            onClick={() => { setMonth(LARGEST); setSort('largest'); }}
            title="The biggest files in the whole library, every month at once"
          >
            <span>Largest files</span>
            <span className="ph-count">top {LARGEST_LIMIT}</span>
          </button>
        )}
        {Object.keys(albums).length > 0 && (
          <div className="ph-year">
            <div className="ph-year-label">Albums</div>
            {Object.entries(albums).sort(([a], [b]) => a.localeCompare(b)).map(([name, rels]) => (
              <button
                key={name}
                className={`ph-month${month === ALBUM_PREFIX + name ? ' selected' : ''}`}
                onClick={() => setMonth(ALBUM_PREFIX + name)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  if (!confirm(`Delete the album "${name}"? The photos stay on disk.`)) return;
                  void api().photosAlbumDelete(ws, name).then(setAlbums).catch(() => {});
                  if (month === ALBUM_PREFIX + name) setMonth(ALL);
                }}
                title={`${rels.length} photos · two-finger click to delete the album (photos stay)`}
              >
                <span>{name}</span>
                <span className="ph-count">{rels.length.toLocaleString()}</span>
              </button>
            ))}
          </div>
        )}
        {byYear.map(([year, months]) => (
          <div key={year} className="ph-year">
            <div className="ph-year-label">{year === '_no-date' ? 'Undated' : year}</div>
            {months.map((m) => (
              <button
                key={m.month}
                className={`ph-month${month === m.month ? ' selected' : ''}`}
                onClick={() => setMonth(m.month)}
              >
                <span>{monthLabel(m.month)}</span>
                <span className="ph-count">{m.count}</span>
              </button>
            ))}
          </div>
        ))}
      </div>

      <div className="photos-main">
        {!ws ? (
          <div className="photos-empty">
            <h2>No photo folders yet</h2>
            <p className="dim">
              Add a folder laid out as <code>YYYY/YYYY-MM/source/</code>. Each one is its own
              library — personal, work and family never mix.
            </p>
            <button className="ph-btn" onClick={() => void addSpace()}>Add a folder</button>
          </div>
        ) : index && !index.exists ? (
          <div className="photos-empty">
            <h2>Nothing in {active?.name ?? 'this library'}</h2>
            <p>Couldn&apos;t read <code>{index.root}</code>.</p>
            <p className="dim">Once photos are there as <code>YYYY/YYYY-MM/source/</code>, they show up here.</p>
            <button className="ph-btn" onClick={() => void refresh()}>Check again</button>
          </div>
        ) : month === TRASH ? (
        /* Trash view. A list, not a grid: the files are gone from the library, so photo:// has
           nothing to serve and a wall of broken tiles would be worse than rows that say exactly
           what each file was and where it came from.
           ponytail: no thumbnails here. The cache is keyed on (ws, dev, inode, mtime, size) and
           trashing preserves the inode, so the bytes very likely still exist — but reaching them
           needs a new protocol route AND the dev/ino columns that only manifests written from
           now on carry. Wire it up if browsing the Trash visually turns out to matter. */
        <>
        <div className="photos-toolbar">
          <strong>Trash</strong>
          <span className="ph-dim">
            {trashPending.length.toLocaleString()} recoverable · {fmtSize(trashBytes)}
          </span>
          <div className="ph-spacer" />
          {sel.size > 0 && (
            <button className="ph-btn" disabled={restoring} onClick={() => void doRestore([...sel])}>
              {restoring ? 'Restoring…' : `Restore ${sel.size.toLocaleString()}`}
            </button>
          )}
        </div>
        <div className="ph-selbar ph-hint">
          <span>
            Moved here by this app — Finder&apos;s Trash also holds everything else you have deleted.
            Restore puts a file back at its original path; it never overwrites anything, and it
            never empties the Trash. <b>Emptying the Trash is final — there is no other copy.</b>
          </span>
        </div>
        {restoreResults && (
          <div className="ph-selbar ph-restore-report">
            <span>
              <b>{restoreResults.filter((r) => r.ok).length} restored.</b>
              {restoreResults.filter((r) => !r.ok).length > 0 && (
                <> {restoreResults.filter((r) => !r.ok).length} could not be:{' '}
                  {restoreResults.filter((r) => !r.ok).slice(0, 3)
                    .map((r) => `${r.rel.split('/').pop()} (${r.reason})`).join(', ')}
                </>
              )}
            </span>
            <div className="ph-spacer" />
            <button className="ph-btn" onClick={() => setRestoreResults(null)}>Dismiss</button>
          </div>
        )}
        <div className="ph-trash-list">
          {trashRows.map((r) => (
            <div
              key={r.rel}
              className={`ph-trash-row${sel.has(r.rel) ? ' picked' : ''}`}
              onClick={() => {
                if (r.state === 'gone' || r.state === 'restored') return;
                setSel((cur) => {
                  const next = new Set(cur);
                  if (next.has(r.rel)) next.delete(r.rel); else next.add(r.rel);
                  return next;
                });
              }}
            >
              <span className={`ph-trash-state ${r.state}`}>
                {r.state === 'restored' ? 'restored' : r.state === 'gone' ? 'gone' : r.state === 'unknown' ? '?' : '↩'}
              </span>
              <span className="ph-trash-name">{r.rel.split('/').pop()}</span>
              <span className="ph-trash-size">{fmtSize(r.size)}</span>
              <span className="ph-trash-path" title={r.abs}>{r.rel}</span>
              <span className="ph-trash-at">{r.at.slice(0, 16).replace('T', ' ')}</span>
              {r.state === 'gone' ? (
                <span className="ph-dim" title="Not in the Trash under this name — emptied, or renamed on a collision">not in Trash</span>
              ) : r.state === 'restored' ? (
                <span className="ph-dim">back in the library</span>
              ) : (
                <button
                  className="ph-btn"
                  disabled={restoring}
                  onClick={(e) => { e.stopPropagation(); void doRestore([r.rel]); }}
                >
                  Restore
                </button>
              )}
            </div>
          ))}
          {trashRows.length === 0 && <div className="photos-status">Nothing has been trashed from this library.</div>}
        </div>
        </>
        ) : (
        <>
        <div className="photos-toolbar">
          <strong>{month ? monthLabel(month) : ''}</strong>
          {sourcesHere.length > 1 && (
            <div className="ph-sources">
              <button className={`ph-chip${source === 'all' ? ' on' : ''}`} onClick={() => setSource('all')}>All</button>
              {sourcesHere.map((s) => (
                <button key={s} className={`ph-chip${source === s ? ' on' : ''}`} onClick={() => setSource(s)}>{s}</button>
              ))}
            </div>
          )}
          <div className="ph-sources">
            <button className={`ph-chip${sort === 'newest' ? ' on' : ''}`} onClick={() => setSort('newest')}>Newest</button>
            <button className={`ph-chip${sort === 'largest' ? ' on' : ''}`} onClick={() => setSort('largest')}>Largest</button>
          </div>
          {backedUp.size > 0 && (
            <div className="ph-sources">
              <button
                className={`ph-chip${onlyUnbacked ? ' on' : ''}`}
                title="Hide anything confirmed present in Apple Photos. What remains exists only here."
                onClick={() => setOnlyUnbacked((v) => !v)}
              >
                Not in iCloud
              </button>
            </div>
          )}
          <div className="ph-spacer" />
          {marks.totals.del > 0 && (
            <button className="ph-btn ph-danger" onClick={() => { setReport(null); setConfirming(true); }}>
              Move {marks.totals.del.toLocaleString()} to Trash · {fmtSize(marks.totals.delBytes)}
            </button>
          )}
          {marks.totals.keep > 0 && <span className="ph-dim">{marks.totals.keep.toLocaleString()} kept</span>}
          <input
            type="range" min={90} max={320} step={10} value={size}
            onChange={(e) => setSize(Number(e.target.value))}
            title="Thumbnail size" className="ph-size"
          />
        </div>

        {sel.size > 0 && (
          <div className="ph-selbar">
            <strong>{sel.size.toLocaleString()} selected · {fmtSize(selBytes)}</strong>
            <button className="ph-btn ph-danger" onClick={() => void applyMark('delete')}>Delete (D)</button>
            <button className="ph-btn" onClick={() => void applyMark('keep')}>Keep (K)</button>
            <button className="ph-btn" onClick={() => void applyMark(null)}>Unmark (U)</button>
            <div className="ph-spacer" />
            <button className="ph-btn" onClick={() => setSel(new Set(shown.map((i) => i.rel)))}>Select all shown</button>
            <button className="ph-btn" onClick={() => { setAlbumName(''); setAlbumOpen(true); }}>Add to album…</button>
            <button className="ph-btn" onClick={clearSel}>Cancel (Esc)</button>
          </div>
        )}

        {loading ? (
          <div className="photos-status">Loading…</div>
        ) : shown.length === 0 ? (
          <div className="photos-status">Nothing here.</div>
        ) : (
          <div className="photos-grid" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${size}px, 1fr))` }}>
            {shown.map((it, idx) => {
              const mark = marks.marks[it.rel]?.m;
              const picked = sel.has(it.rel);
              return (
              <button
                key={it.rel}
                className={`ph-tile${picked ? ' picked' : ''}${mark ? ` mk-${mark}` : ''}${it.kind === 'video' ? ' is-video' : ''}`}
                onClick={(e) => onTileClick(e, it, idx)}
                // Space toggles selection on the focused tile; without this a keyboard user has
                // no way to START a selection (Enter/Space on a <button> fires the plain-click
                // path, which opens the lightbox).
                onKeyDown={(e) => {
                  if (e.key !== ' ') return;
                  e.preventDefault();
                  setSel((cur) => {
                    const next = new Set(cur);
                    if (next.has(it.rel)) next.delete(it.rel); else next.add(it.rel);
                    return next;
                  });
                  setAnchor(idx);
                }}
                onContextMenu={(e) => { e.preventDefault(); void api().photosReveal(ws, it.rel); }}
                title={`${it.name}\n${it.source} · ${fmtSize(it.size)}${mark ? `\nmarked ${mark}` : ''}\nTwo-finger click to reveal in Finder`}
              >
                {/* The discoverable entry point into selection. Always rendered; CSS fades it in
                    on hover and pins it visible once the tile is picked. */}
                <span className="ph-sel" data-act="sel" title="Select (or ⌘-click · shift-click for a range)" />
                {it.kind === 'raw' ? (
                  <span className="ph-raw">RAW<small>{it.name.split('.').pop()}</small></span>
                ) : it.kind === 'video' ? (
                  <VideoThumb src={photoUrl(ws, it.rel)} poster={thumbUrl(ws, it.rel)} />
                ) : (
                  <img src={thumbUrl(ws, it.rel)} loading="lazy" decoding="async" alt="" draggable={false}
                       style={rotations[it.rel] ? { transform: `rotate(${rotations[it.rel]}deg)` } : undefined} />
                )}
                {it.kind === 'video' && <span className="ph-play">▶</span>}
                {/* Size is on every tile, not just the video ones: it is the only number on this
                    screen that tells you whether deleting something is worth doing. */}
                <span className="ph-size-badge">{fmtSize(it.size)}</span>
                {mark && <span className={`ph-mark ${mark}`}>{mark === 'delete' ? 'DELETE' : 'KEEP'}</span>}
                {/* Filename on hover, as the gallery does it — the grid is otherwise anonymous
                    once you are looking at 3k near-identical thumbnails. */}
                <span className="ph-cap">{it.name}</span>
              </button>
              );
            })}
          </div>
        )}
        </>
        )}
      </div>

      {/* Add-to-album: existing albums to click, plus a new-name field at the bottom — the same
          shape as the offline gallery's dialog. */}
      {albumOpen && (
        <div className="ph-lightbox" onClick={() => setAlbumOpen(false)}>
          <div className="ph-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Add {sel.size.toLocaleString()} to album</h3>
            {Object.keys(albums).length > 0 && (
              <div className="ph-alb-list">
                {Object.entries(albums).sort(([a], [b]) => a.localeCompare(b)).map(([name, rels]) => (
                  <button
                    key={name}
                    className="ph-alb-row"
                    onClick={() => {
                      void api().photosAlbumAdd(ws, name, [...sel]).then(setAlbums).catch(() => {});
                      setAlbumOpen(false); clearSel();
                    }}
                  >
                    <span>{name}</span>
                    <span className="ph-count">{rels.length.toLocaleString()}</span>
                  </button>
                ))}
              </div>
            )}
            <div className="ph-alb-new">
              <input
                autoFocus
                placeholder="New album name"
                value={albumName}
                onChange={(e) => setAlbumName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') { setAlbumOpen(false); return; }
                  if (e.key !== 'Enter' || !albumName.trim()) return;
                  void api().photosAlbumAdd(ws, albumName, [...sel]).then(setAlbums).catch(() => {});
                  setAlbumOpen(false); clearSel();
                }}
              />
              <button
                className="ph-btn"
                disabled={!albumName.trim()}
                onClick={() => {
                  void api().photosAlbumAdd(ws, albumName, [...sel]).then(setAlbums).catch(() => {});
                  setAlbumOpen(false); clearSel();
                }}
              >Create</button>
            </div>
            <div className="ph-modal-actions">
              <button className="ph-btn" onClick={() => setAlbumOpen(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {lightbox && lbIndex >= 0 && (
        <Viewer
          items={shown}
          index={lbIndex}
          rotation={rotations[lightbox.rel] ?? 0}
          srcFor={(rel) => photoUrl(ws, rel)}
          thumbFor={(rel) => thumbUrl(ws, rel)}
          onIndex={(i) => setLightbox(shown[i] ?? null)}
          onRotate={(deg) => {
            setRotations((r) => ({ ...r, [lightbox.rel]: deg }));   // optimistic: the turn is instant
            void api().photosRotate(ws, lightbox.rel, deg).then(setRotations).catch(() => {});
          }}
          onClose={() => setLightbox(null)}
          onReveal={() => void api().photosReveal(ws, lightbox.rel)}
          onOpen={() => void api().photosOpen(ws, lightbox.rel)}
        />
      )}

      {/* The confirm. This library is the only copy that exists — the folders it was built from
          are gone and there is no backup — so the dialog says so rather than implying the usual
          safety net. Trash is recoverable; emptying it is not. */}
      {confirming && (
        <div className="ph-lightbox" onClick={() => !applying && setConfirming(false)}>
          <div className="ph-modal" onClick={(e) => e.stopPropagation()}>
            <h2>Move {marks.totals.del.toLocaleString()} files to the Trash?</h2>
            <p className="ph-big">{fmtSize(marks.totals.delBytes)} reclaimed</p>
            <p>
              They go to <code>~/.Trash</code> and can be dragged back out from there. A manifest
              recording every path, size and modified time is written first.
            </p>
            <p className="ph-warn">
              <b>There is no other copy.</b> This library is not backed up and not in iCloud —
              there is no “Recently Deleted” and no 30-day window behind it. Once you empty the
              Trash, these files are gone for good.
            </p>
            <div className="ph-modal-bar">
              <div className="ph-spacer" />
              <button className="ph-btn" disabled={applying} onClick={() => setConfirming(false)}>Cancel</button>
              <button className="ph-btn ph-danger" disabled={applying} onClick={() => void doApplyTrash()}>
                {applying ? 'Moving…' : 'Move to Trash'}
              </button>
            </div>
          </div>
        </div>
      )}

      {report && (
        <div className="ph-lightbox" onClick={() => setReport(null)}>
          <div className="ph-modal" onClick={(e) => e.stopPropagation()}>
            {report.error ? (
              <>
                <h2>Nothing was moved</h2>
                <p className="ph-warn">{report.error}</p>
              </>
            ) : (
              <>
                <h2>{(report.trashed ?? 0).toLocaleString()} files in the Trash</h2>
                <p className="ph-big">{fmtSize(report.bytes ?? 0)} reclaimed</p>
                {!!report.missing && <p className="ph-dim">{report.missing} already gone — skipped.</p>}
                {!!report.failed?.length && (
                  <p className="ph-warn">
                    {report.failed.length} could not be moved and keep their mark:{' '}
                    {report.failed.slice(0, 3).map((f) => f.rel).join(', ')}
                  </p>
                )}
                <p className="ph-dim">Manifest: <code>{report.manifest}</code></p>
              </>
            )}
            <div className="ph-modal-bar">
              <div className="ph-spacer" />
              <button className="ph-btn" onClick={() => setReport(null)}>Done</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
