import QRCode from "qrcode";
import wasmUrl from "zxing-wasm/reader/zxing_reader.wasm?url";
import { prepareZXingModule, readBarcodes } from "zxing-wasm/reader";

prepareZXingModule({
  overrides: {
    locateFile: (path: string, prefix: string) =>
      path.endsWith(".wasm") ? wasmUrl : prefix + path,
  },
});

const MARGIN = 4;

/** Render one frame's bytes as a standalone downloadable PNG blob. */
export async function frameToPngBlob(bytes: Uint8Array, pixelsPerModule = 8): Promise<Blob> {
  const qr = QRCode.create([{ data: bytes, mode: "byte" } as any], {
    errorCorrectionLevel: "M",
  });
  const size = qr.modules.size;
  const data = qr.modules.data;
  const total = size + 2 * MARGIN;

  // Build the 1-pixel-per-module image in one pass via a raw pixel buffer —
  // thousands of individual fillRect() calls (one per module) is what made
  // this slow before; a single ImageData write plus one scaled draw is
  // dramatically faster, same approach the live grid render already uses.
  const small = document.createElement("canvas");
  small.width = total;
  small.height = total;
  const smallCtx = small.getContext("2d")!;
  const img = new ImageData(total, total);
  const px = new Uint32Array(img.data.buffer);
  px.fill(0xffffffff); // white, opaque (little-endian: 0xAABBGGRR)
  for (let y = 0; y < size; y++) {
    const row = (y + MARGIN) * total + MARGIN;
    const src = y * size;
    for (let x = 0; x < size; x++) {
      if (data[src + x]) px[row + x] = 0xff000000; // black, opaque
    }
  }
  smallCtx.putImageData(img, 0, 0);

  const canvas = document.createElement("canvas");
  canvas.width = total * pixelsPerModule;
  canvas.height = total * pixelsPerModule;
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = false; // keep QR edges crisp when upscaling
  ctx.drawImage(small, 0, 0, canvas.width, canvas.height);

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("PNG export failed"))), "image/png");
  });
}

/** Decode a single uploaded image file back to the frame bytes it encodes, or null if unreadable. */
export async function decodeImageFile(file: File): Promise<Uint8Array | null> {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0);
  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return decodeImageData(imgData);
}

/** Decode directly from already-captured ImageData (e.g. a video frame grab). */
export async function decodeImageData(imgData: ImageData): Promise<Uint8Array | null> {
  const results = await readBarcodes(imgData, { formats: ["QRCode"] });
  const hit = results.find((r) => r.isValid && r.bytes && r.bytes.length > 0);
  return hit ? hit.bytes : null;
}
