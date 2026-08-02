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
    const results = await readBarcodes(img, { formats: ["QRCode"], maxNumberOfSymbols: 1 });
    const r = results.find(x => x.isValid && x.bytes.length > 0);
    ctx.postMessage({ id, bytes: r ? r.bytes : null });
  } catch {
    ctx.postMessage({ id, bytes: null });
  }
};

// warm
void readBarcodes(new ImageData(8,8), { formats: ["QRCode"] })
  .catch(() => undefined)
  .then(() => ctx.postMessage({ id: -1, bytes: null }));