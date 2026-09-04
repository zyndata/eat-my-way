/**
 * Turning a photograph into something worth sending (PLAN.md Phase 12 task 2).
 *
 * A modern phone camera produces 3–12 MB, and the readable part of a package scan is a table
 * occupying a fraction of it. Resampling to at most 1024 px on the long edge and re-encoding as
 * JPEG keeps the digits legible, cuts the upload to a couple of hundred kilobytes and holds the
 * image cost near the per-image floor Google charges.
 *
 * The photograph is never stored: it exists as a `File` the browser handed us, becomes a
 * base64 string for exactly one request, and both are dropped when the call returns. Nothing
 * here writes to IndexedDB or to Drive.
 *
 * `fitWithin` is the only part that can be unit-tested — the rest is canvas, which the Node
 * test environment does not have. It is therefore the part that carries the arithmetic.
 */

/** An image as `generateContent` takes it: a MIME type and base64 without a data: prefix. */
export interface InlineImage {
  mimeType: string;
  /** Base64, no `data:…;base64,` prefix. */
  data: string;
}

/** Long edge of the image actually sent. A nutrition table is legible well below this. */
export const SCAN_MAX_EDGE = 1024;

/** JPEG quality. Below ~0.7 the thin digits of a nutrition table start to smear. */
export const SCAN_QUALITY = 0.8;

/** Thrown when the browser could not decode or re-encode what the user picked. */
export class ImageReadError extends Error {
  constructor() {
    super('Image could not be decoded');
    this.name = 'ImageReadError';
  }
}

/**
 * The size an image is drawn at so that neither edge exceeds `maxEdge`, keeping the aspect
 * ratio. An image already inside the box is left alone — upscaling a small photo adds bytes
 * and no detail.
 */
export function fitWithin(
  width: number,
  height: number,
  maxEdge: number = SCAN_MAX_EDGE
): { width: number; height: number } {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new ImageReadError();
  }
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width: Math.round(width), height: Math.round(height) };
  const scale = maxEdge / longest;
  return {
    // At least one pixel each way: a 4000×1 strip must not resample to a zero-height canvas.
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  };
}

/**
 * Decode a picked file. `createImageBitmap` is asked to apply the EXIF orientation, so a
 * photograph taken in portrait is not transcribed sideways; the `<img>` path is the fallback
 * for a browser without it and applies orientation itself by default.
 */
async function decode(file: Blob): Promise<{ image: CanvasImageSource; width: number; height: number }> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return { image: bitmap, width: bitmap.width, height: bitmap.height };
    } catch {
      throw new ImageReadError();
    }
  }

  const url = URL.createObjectURL(file);
  try {
    const element = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new ImageReadError());
      img.src = url;
    });
    return { image: element, width: element.naturalWidth, height: element.naturalHeight };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Base64 without the data: prefix. `FileReader` does the encoding, so no `btoa` chunking. */
async function toBase64(blob: Blob): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(new ImageReadError());
    reader.readAsDataURL(blob);
  });
  const comma = dataUrl.indexOf(',');
  if (comma === -1) throw new ImageReadError();
  return dataUrl.slice(comma + 1);
}

/**
 * Downscale and re-encode, entirely in the browser. Throws `ImageReadError` for anything that
 * is not a decodable image — a caller turns that into a Polish sentence.
 */
export async function downscaleToJpeg(
  file: Blob,
  options: { maxEdge?: number; quality?: number } = {}
): Promise<InlineImage> {
  const { image, width, height } = await decode(file);
  const size = fitWithin(width, height, options.maxEdge ?? SCAN_MAX_EDGE);

  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext('2d');
  if (context === null) throw new ImageReadError();
  context.drawImage(image, 0, 0, size.width, size.height);
  if (typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap) image.close();

  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, 'image/jpeg', options.quality ?? SCAN_QUALITY);
  });
  if (blob === null) throw new ImageReadError();

  return { mimeType: 'image/jpeg', data: await toBase64(blob) };
}
