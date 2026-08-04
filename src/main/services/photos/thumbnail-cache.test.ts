import { describe, it, expect } from 'vitest';
import { mapLimit } from './thumbnail-cache';

// ThumbnailCache itself needs Electron's nativeImage (QuickLook), so it can't run headlessly.
// mapLimit is pure and is the part that would silently break: lose the cap and a fast scroll
// queues thousands of concurrent QuickLook calls, starving the UI thread trying to paint the
// very tiles being generated.
describe('mapLimit', () => {
  it('never exceeds the concurrency cap', async () => {
    let inFlight = 0, peak = 0;
    const items = Array.from({ length: 50 }, (_, i) => i);
    await mapLimit(items, 4, async () => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
    });
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);          // actually parallel, not accidentally serial
  });

  it('processes every item exactly once', async () => {
    const items = Array.from({ length: 37 }, (_, i) => i);
    const seen: number[] = [];
    await mapLimit(items, 5, async (n) => { seen.push(n); });
    expect(seen.sort((a, b) => a - b)).toEqual(items);
  });

  it('keeps going when a worker throws', async () => {
    // One unreadable/undecodable photo must not abort the whole pre-warm pass.
    const items = [1, 2, 3, 4, 5];
    const ok: number[] = [];
    await mapLimit(items, 2, async (n) => {
      if (n === 3) throw new Error('bad file');
      ok.push(n);
    });
    expect(ok.sort()).toEqual([1, 2, 4, 5]);
  });

  it('handles an empty list and a cap larger than the list', async () => {
    await expect(mapLimit([], 4, async () => {})).resolves.toBeUndefined();
    const seen: number[] = [];
    await mapLimit([1, 2], 99, async (n) => { seen.push(n); });
    expect(seen.sort()).toEqual([1, 2]);
  });
});
