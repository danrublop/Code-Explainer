// Building a photo:// URL is fiddly enough to be worth isolating and testing.
//
// `photo` is registered as a STANDARD scheme (main.ts), which means Chromium parses the token
// after '//' as a hostname, exactly like http. So photo:///2026/2026-07/x.jpg makes '2026' the
// host — and because it's all digits, Chromium canonicalises it to the IPv4 address 0.0.7.234
// and the year vanishes from the path. Every tile 404s, with nothing in the URL bar to explain
// why.
//
// The host is the workspace id ('ws-<uuid>'). That keeps the whole library-relative path in
// pathname, and scopes the file lookup to that one workspace's root — main resolves the request
// against that root alone, so a Work URL can't read a Personal file.

/** Workspace id + library-relative path -> photo:// URL. Each segment is encoded, so spaces,
 *  '#', '?', '%' and non-ASCII (e.g. the narrow no-break space macOS puts in "5.49 PM") survive
 *  intact. Hostnames are case-insensitive and ids are minted lowercase, so they round-trip. */
export function photoUrl(ws: string, rel: string): string {
  return `photo://${ws}/${rel.split('/').map(encodeURIComponent).join('/')}`;
}

/** Same file, but the cached 512px thumbnail — what grid tiles should use.
 *
 *  A tile is ~160px while the originals are 24MP/5.6MB, so serving originals to the grid reads
 *  ~18 GB for a 3,252-file month and decodes ~97 MB of RGBA per tile. The thumb is ~37 KB.
 *  Main falls back to the original if a file can't be thumbnailed, so this is always safe. */
export function thumbUrl(ws: string, rel: string): string {
  return `${photoUrl(ws, rel)}?thumb=1`;
}

/** Inverse of photoUrl — what the main-process handler does. Exported for round-trip testing. */
export function parsePhotoUrl(url: string): { ws: string; rel: string } | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'photo:' || !u.hostname) return null;
    return { ws: u.hostname, rel: decodeURIComponent(u.pathname).replace(/^\/+/, '') };
  } catch {
    return null;
  }
}
