import { describe, expect, it } from 'vitest';
import { ImageReadError, SCAN_MAX_EDGE, fitWithin } from './image';

/**
 * The arithmetic of the downscale. The canvas half needs a browser and is exercised end to end
 * by `e2e/scan.spec.ts`; what is worth pinning here is that the box is never exceeded, the
 * aspect ratio survives, and nothing ever resamples to zero pixels.
 */

describe('fitWithin', () => {
  it('leaves an image already inside the box alone', () => {
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 });
    expect(fitWithin(SCAN_MAX_EDGE, SCAN_MAX_EDGE)).toEqual({
      width: SCAN_MAX_EDGE,
      height: SCAN_MAX_EDGE
    });
  });

  it('scales a phone photograph down by its long edge, either orientation', () => {
    // 12 MP landscape and the same picture held upright.
    expect(fitWithin(4000, 3000)).toEqual({ width: 1024, height: 768 });
    expect(fitWithin(3000, 4000)).toEqual({ width: 768, height: 1024 });
  });

  it('keeps at least one pixel on the short edge', () => {
    expect(fitWithin(4000, 1)).toEqual({ width: 1024, height: 1 });
  });

  it('honours a maxEdge given explicitly', () => {
    expect(fitWithin(4000, 2000, 200)).toEqual({ width: 200, height: 100 });
  });

  it('refuses a size that is not a size', () => {
    for (const [width, height] of [
      [0, 100],
      [100, 0],
      [-4, 10],
      [Number.NaN, 10]
    ]) {
      expect(() => fitWithin(width as number, height as number)).toThrow(ImageReadError);
    }
  });
});
