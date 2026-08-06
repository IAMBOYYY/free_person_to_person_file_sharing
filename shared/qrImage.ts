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

  const canvas = document.createElement("canvas");
  canvas.width = total * pixelsPerModule;
  canvas.height = total * pixelsPerModule;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#000";
  for (let y = 0; y < size; y++) {
    const src = y * size;
    for (let x = 0; x < size; x++) {
      if (data[src + x]) {
        ctx.fillRect(
          (x + MARGIN) * pixelsPerModule,
          (y + MARGIN) * pixelsPerModule,
          pixelsPerModule,
          pixelsPerModule
        );
      }
    }
  }

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
