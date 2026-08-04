import wasmUrl from "zxing-wasm/reader/zxing_reader.wasm?url";
import { prepareZXingModule, readBarcodes } from "zxing-wasm/reader";

prepareZXingModule({
  overrides: {
    locateFile: (path: string, prefix: string) =>
      path.endsWith(".wasm") ? wasmUrl : prefix + path,
  },
});

const ctx = self as any;
ctx.onmessage = async (e: MessageEvent) => {
  const { id, buf, w, h } = e.data;
  try {
    const img = new ImageData(new Uint8ClampedArray(buf), w, h);
    // formats + tryHarder is enough; maxNumberOfSymbols already defaults to 255,
    // comfortably covering any grid size we'd realistically show on screen
    const results = await readBarcodes(img, { formats: ["QRCode"] });
    const bytesList = results
      .filter(r => r.isValid && r.bytes.length > 0)
      .map(r => r.bytes);
    ctx.postMessage({ id, bytesList }, bytesList.map(b => b.buffer)); // transfer buffers
  } catch {
    ctx.postMessage({ id, bytesList: [] });
  }
};

// warm
void readBarcodes(new ImageData(8, 8), { formats: ["QRCode"] })
  .catch(() => undefined)
  .then(() => ctx.postMessage({ id: -1, bytesList: [] }));