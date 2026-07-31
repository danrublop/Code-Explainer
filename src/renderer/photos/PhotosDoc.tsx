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
import { photoUrl, thumbUrl } from './photo-url';

type PhotoKind = 'image' | 'raw' | 'video';
interface PhotoEntry {
  rel: string; name: string; month: string; source: string;
  kind: PhotoKind; size: number; mtime: number;
}
interface PhotoIndex {
  root: string; exists: boolean; total: number;
  months: Array<{ month: string; year: string; count: number }>;
  sources: string[];
}
interface PhotoWorkspace { id: string; name: string; root: string }
interface PhotosApi {
  photosWorkspaces: () => Promise<PhotoWorkspace[]>;
  photosWorkspaceAdd: () => Promise<PhotoWorkspace | null>;
  photosWorkspaceRemove: (ws: string) => Promise<void>;
  photosWorkspaceRename: (ws: string, name: string) => Promise<void>;
  photosIndex: (ws: string) => Promise<PhotoIndex>;
  photosList: (ws: string, month: string) => Promise<PhotoEntry[]>;
  photosReveal: (ws: string, rel: string) => Promise<void>;
  photosOpen: (ws: string, rel: string) => Promise<void>;
}
function api(): PhotosApi { return (window as unknown as { notebookAPI: PhotosApi }).notebookAPI; }

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const SIZE_KEY = 'nb-photos-size';
const WS_KEY = 'nb-photos-workspace';

function monthLabel(m: string): string {
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
  const [size, setSize] = useState<number>(() => Number(localStorage.getItem(SIZE_KEY)) || 160);
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
    setMonth((cur) => (cur && ix.months.some((m) => m.month === cur) ? cur : ix.months[0]?.month ?? null));
  }, [ws]);
  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    if (!ws || !month) { setItems([]); return; }
    let cancelled = false;
    setLoading(true);
    api().photosList(ws, month)
      .then((r) => { if (!cancelled) { setItems(r); setSource('all'); } })
      .catch(() => { if (!cancelled) setItems([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [ws, month]);

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
  const shown = useMemo(
    () => (source === 'all' ? items : items.filter((i) => i.source === source)),
    [items, source],
  );

  // Lightbox arrow-key navigation over the currently filtered set.
  const shownRef = useRef(shown);
  shownRef.current = shown;
  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setLightbox(null); return; }
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const list = shownRef.current;
      const i = list.findIndex((x) => x.rel === lightbox.rel);
      if (i < 0) return;
      const next = list[e.key === 'ArrowRight' ? i + 1 : i - 1];
      if (next) setLightbox(next);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightbox]);

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
          <div className="ph-spacer" />
          <input
            type="range" min={90} max={320} step={10} value={size}
            onChange={(e) => setSize(Number(e.target.value))}
            title="Thumbnail size" className="ph-size"
          />
        </div>

        {loading ? (
          <div className="photos-status">Loading…</div>
        ) : shown.length === 0 ? (
          <div className="photos-status">Nothing here.</div>
        ) : (
          <div className="photos-grid" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${size}px, 1fr))` }}>
            {shown.map((it) => (
              <button
                key={it.rel}
                className="ph-tile"
                style={{ height: size }}
                onClick={() => setLightbox(it)}
                onContextMenu={(e) => { e.preventDefault(); void api().photosReveal(ws, it.rel); }}
                title={`${it.name}\n${it.source} · ${fmtSize(it.size)}\nTwo-finger click to reveal in Finder`}
              >
                {it.kind === 'raw' ? (
                  <span className="ph-raw">RAW<small>{it.name.split('.').pop()}</small></span>
                ) : it.kind === 'video' ? (
                  <VideoThumb src={photoUrl(ws, it.rel)} poster={thumbUrl(ws, it.rel)} />
                ) : (
                  <img src={thumbUrl(ws, it.rel)} loading="lazy" decoding="async" alt="" draggable={false} />
                )}
                {it.kind === 'video' && <span className="ph-play">▶</span>}
              </button>
            ))}
          </div>
        )}
        </>
        )}
      </div>

      {lightbox && (
        <div className="ph-lightbox" onClick={() => setLightbox(null)}>
          <div className="ph-lb-body" onClick={(e) => e.stopPropagation()}>
            {lightbox.kind === 'video' ? (
              <video src={photoUrl(ws, lightbox.rel)} controls autoPlay />
            ) : lightbox.kind === 'raw' ? (
              <div className="ph-lb-raw">
                <p>{lightbox.name}</p>
                <p className="dim">RAW files need an external viewer.</p>
                <button className="ph-btn" onClick={() => void api().photosOpen(ws, lightbox.rel)}>Open in default app</button>
              </div>
            ) : (
              <img src={photoUrl(ws, lightbox.rel)} alt="" />
            )}
            <div className="ph-lb-bar">
              <span>{lightbox.name}</span>
              <span className="dim">{lightbox.source} · {fmtSize(lightbox.size)}</span>
              <div className="ph-spacer" />
              <button className="ph-btn" onClick={() => void api().photosReveal(ws, lightbox.rel)}>Reveal</button>
              <button className="ph-btn" onClick={() => void api().photosOpen(ws, lightbox.rel)}>Open</button>
              <button className="ph-btn" onClick={() => setLightbox(null)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
