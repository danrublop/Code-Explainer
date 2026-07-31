import { describe, it, expect } from 'vitest';
import { photoUrl, parsePhotoUrl } from './photo-url';

const WS = 'ws-3f1c8a20-9d4e-4b7a-8c11-2e6b5d0a7f93';

// Real paths from the library — the year-as-host bug only shows up with a leading numeric
// directory, and the filenames genuinely contain '#' and a narrow no-break space (U+202F).
const CASES = [
  '2026/2026-07/photobooth/Photo on 7-26-26 at 5.49 PM #2.jpg',
  '2024/2024-06/nikon/DSC_0001.JPG',
  '_no-date/canon/MVI_9.MP4',
  '2019/2019-12/drone-dji/DJI_0001.MP4',
  '2025/2025-02/iphone-se-2nd-generation/IMG_100%.HEIC',
  '2023/2023-01/fotos/a?b&c=d.jpg',
];

describe('photoUrl', () => {
  it('round-trips every path unchanged, carrying the workspace', () => {
    for (const rel of CASES) expect(parsePhotoUrl(photoUrl(WS, rel))).toEqual({ ws: WS, rel });
  });

  // The regression this module exists for: a numeric first segment must stay in the path and
  // must NOT be swallowed as a hostname (Chromium would canonicalise '2026' -> '0.0.7.234').
  it('keeps a numeric year in the path, not the host', () => {
    const u = new URL(photoUrl(WS, '2026/2026-07/photobooth/x.jpg'));
    expect(u.hostname).toBe(WS);
    expect(u.hostname).not.toBe('0.0.7.234');
    expect(u.pathname).toBe('/2026/2026-07/photobooth/x.jpg');
  });

  it('encodes characters that would otherwise truncate or split the URL', () => {
    const u = photoUrl(WS, '2024/2024-06/nikon/a #1?x.jpg');
    expect(u).not.toContain(' ');
    expect(u).toContain('%23');            // '#' — would start a fragment
    expect(u).toContain('%3F');            // '?' — would start a query
    expect(parsePhotoUrl(u)!.rel).toBe('2024/2024-06/nikon/a #1?x.jpg');
  });

  // Two workspaces, same relative path: the URLs must differ, or the grid would show one
  // library's photos while claiming to be in the other.
  it('distinguishes the same path in different workspaces', () => {
    const a = photoUrl('ws-aaaa', '2024/2024-06/nikon/x.jpg');
    const b = photoUrl('ws-bbbb', '2024/2024-06/nikon/x.jpg');
    expect(a).not.toBe(b);
    expect(parsePhotoUrl(a)!.ws).toBe('ws-aaaa');
    expect(parsePhotoUrl(b)!.ws).toBe('ws-bbbb');
  });
});

describe('parsePhotoUrl', () => {
  it('rejects a foreign scheme or a hostless URL', () => {
    expect(parsePhotoUrl('file:///etc/passwd')).toBeNull();
    expect(parsePhotoUrl('not a url')).toBeNull();
  });

  // An unknown host parses fine here — it's main's workspace lookup that rejects it, so the
  // check lives in exactly one place rather than being half-enforced in the renderer.
  it('returns an unknown workspace verbatim for main to reject', () => {
    expect(parsePhotoUrl('photo://evil/2024/x.jpg')).toEqual({ ws: 'evil', rel: '2024/x.jpg' });
  });
});
