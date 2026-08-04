// Full-screen photo viewer: zoom/pan, rotate, and a filmstrip — the offline gallery's viewer,
// ported into the app.
//
// The transform order is the part worth stating, because getting it wrong looks like a bug you
// cannot reason about:
//
//     translate(pan) scale(zoom) rotate(deg) scale(fit)
//
// `fit` is what makes a quarter-turned photo fit the stage: after a 90° turn the image's width
// occupies the stage's height, so it must be scaled by (stageH/imgW, stageW/imgH) — whichever
// is smaller. Applying rotate *after* zoom would spin the pan vector too, and dragging would
// move the photo diagonally.
//
// The filmstrip renders a window around the current index rather than every thumbnail: a 3.4k
// photo library would otherwise put 3.4k <img> in the DOM on every open.

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PhotoEntry } from './PhotosDoc';

const STRIP_WINDOW = 40;      // thumbnails kept in the DOM either side of the current one
const MAX_ZOOM = 8;
const MIN_ZOOM = 1;

export interface ViewerProps {
  items: PhotoEntry[];
  index: number;
  rotation: number;                       // degrees for the current photo
  srcFor: (rel: string) => string;
  thumbFor: (rel: string) => string;
  onIndex: (i: number) => void;
  onRotate: (deg: number) => void;
  onClose: () => void;
  onReveal: () => void;
  onOpen: () => void;
}

export function Viewer(props: ViewerProps): React.JSX.Element | null {
  const { items, index, rotation, srcFor, thumbFor, onIndex, onRotate, onClose } = props;
  const it = items[index];

  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [fit, setFit] = useState(1);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);

  // A new photo (or a turn) resets the view — carrying a 6x zoom onto the next image leaves you
  // staring at a random pixel with no way to tell what you are looking at.
  useEffect(() => { setZoom(1); setPan({ x: 0, y: 0 }); }, [index, rotation]);

  // Rotation fit factor. Measured after layout so the natural size is known.
  const recomputeFit = useCallback(() => {
    const st = stageRef.current, im = imgRef.current;
    if (!st || !im || !im.naturalWidth) { setFit(1); return; }
    const quarter = rotation === 90 || rotation === 270;
    if (!quarter) { setFit(1); return; }
    // The rendered (unrotated) box, already letterboxed into the stage by object-fit: contain.
    const box = im.getBoundingClientRect();
    const w = box.width / (zoom || 1), h = box.height / (zoom || 1);
    if (!w || !h) { setFit(1); return; }
    setFit(Math.min(st.clientHeight / w, st.clientWidth / h));
  }, [rotation, zoom]);

  useLayoutEffect(() => { recomputeFit(); }, [recomputeFit, index]);
  useEffect(() => {
    const on = () => recomputeFit();
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, [recomputeFit]);

  const step = useCallback((d: number) => {
    const n = index + d;
    if (n >= 0 && n < items.length) onIndex(n);
  }, [index, items.length, onIndex]);

  // Keys. Arrows step photos when not zoomed in; once zoomed they would fight with panning, so
  // they still step — panning is pointer-driven only, which keeps the mapping predictable.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return; }
      if (e.key === 'ArrowRight') { step(1); return; }
      if (e.key === 'ArrowLeft') { step(-1); return; }
      if (e.key === 'r' || e.key === 'R') { onRotate((rotation + (e.shiftKey ? 270 : 90)) % 360); return; }
      if (e.key === '0') { setZoom(1); setPan({ x: 0, y: 0 }); return; }
      if (e.key === '+' || e.key === '=') { setZoom((z) => Math.min(MAX_ZOOM, z * 1.25)); return; }
      if (e.key === '-') { setZoom((z) => Math.max(MIN_ZOOM, z / 1.25)); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, step, onRotate, rotation]);

  // Wheel/trackpad. ctrlKey is what macOS sets for a pinch on a trackpad, so pinch zooms and a
  // plain two-finger scroll pans — the same split every image app uses.
  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    if (e.ctrlKey) {
      const st = stageRef.current;
      const factor = Math.exp(-e.deltaY / 200);
      setZoom((z) => {
        const nz = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z * factor));
        // Anchor the zoom at the pointer: without this the image drifts away from the cursor
        // and you chase the detail you were trying to inspect.
        if (st && nz !== z) {
          const r = st.getBoundingClientRect();
          const cx = e.clientX - r.left - r.width / 2;
          const cy = e.clientY - r.top - r.height / 2;
          const k = nz / z;
          setPan((p) => ({ x: cx - (cx - p.x) * k, y: cy - (cy - p.y) * k }));
        }
        if (nz === MIN_ZOOM) setPan({ x: 0, y: 0 });
        return nz;
      });
      return;
    }
    if (zoom > 1) setPan((p) => ({ x: p.x - e.deltaX, y: p.y - e.deltaY }));
  }, [zoom]);

  const onPointerDown = (e: React.PointerEvent) => {
    if (zoom <= 1) return;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    setPan({ x: d.px + (e.clientX - d.x), y: d.py + (e.clientY - d.y) });
  };
  const endDrag = () => { drag.current = null; };

  if (!it) return null;

  const transform =
    `translate(${pan.x}px, ${pan.y}px) scale(${zoom}) rotate(${rotation}deg) scale(${fit})`;

  const lo = Math.max(0, index - STRIP_WINDOW);
  const hi = Math.min(items.length, index + STRIP_WINDOW + 1);
  const strip = items.slice(lo, hi);

  return (
    <div className="ph-viewer" onClick={onClose}>
      <div className="ph-vw-head" onClick={(e) => e.stopPropagation()}>
        <span className="ph-vw-name">{it.name}</span>
        <span className="ph-vw-meta">{index + 1} / {items.length} · {it.source}</span>
        <div className="ph-spacer" />
        <button className="ph-icon" title="Rotate left (shift-R)" onClick={() => onRotate((rotation + 270) % 360)}>⟲</button>
        <button className="ph-icon" title="Rotate right (R)" onClick={() => onRotate((rotation + 90) % 360)}>⟳</button>
        <button className="ph-icon" title="Reset zoom (0)" onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}>⤢</button>
        <button className="ph-icon" title="Reveal in Finder" onClick={props.onReveal}>◫</button>
        <button className="ph-icon" title="Open in default app" onClick={props.onOpen}>↗</button>
        <button className="ph-icon" title="Close (Esc)" onClick={onClose}>✕</button>
      </div>

      <button className="ph-vw-nav left" title="Previous (←)"
        onClick={(e) => { e.stopPropagation(); step(-1); }} disabled={index === 0}>‹</button>
      <button className="ph-vw-nav right" title="Next (→)"
        onClick={(e) => { e.stopPropagation(); step(1); }} disabled={index === items.length - 1}>›</button>

      <div
        ref={stageRef}
        className={`ph-vw-stage${zoom > 1 ? ' zoomed' : ''}`}
        onClick={(e) => e.stopPropagation()}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={() => (zoom > 1 ? (setZoom(1), setPan({ x: 0, y: 0 })) : setZoom(2.5))}
      >
        {it.kind === 'video' ? (
          <video src={srcFor(it.rel)} controls autoPlay style={{ transform }} />
        ) : it.kind === 'raw' ? (
          <div className="ph-lb-raw">
            <p>{it.name}</p>
            <p className="dim">RAW needs an external viewer.</p>
            <button className="ph-btn" onClick={props.onOpen}>Open in default app</button>
          </div>
        ) : (
          <img ref={imgRef} src={srcFor(it.rel)} alt="" style={{ transform }}
            onLoad={recomputeFit} draggable={false} />
        )}
      </div>

      <div className="ph-vw-strip" onClick={(e) => e.stopPropagation()}>
        {/* Spacers stand in for the thumbnails outside the window so the strip's scroll length
            and the current item's position stay honest. */}
        {lo > 0 && <div className="ph-vw-pad" style={{ width: lo * 56 }} />}
        {strip.map((s, k) => {
          const real = lo + k;
          return (
            <button
              key={s.rel}
              className={`ph-vw-thumb${real === index ? ' on' : ''}`}
              title={s.name}
              onClick={() => onIndex(real)}
            >
              <img src={thumbFor(s.rel)} loading="lazy" alt="" draggable={false} />
            </button>
          );
        })}
        {hi < items.length && <div className="ph-vw-pad" style={{ width: (items.length - hi) * 56 }} />}
      </div>
    </div>
  );
}
