import factory from "ggwave";

let ggwave: any = null;
let instance: any = null;

// ggwave's encode()/decode() exchange raw bytes through typed arrays whose
// element type doesn't match their real meaning (this is how the library's
// own official browser example does it — see ggwave/examples/buttons).
// This re-views the same underlying bytes as a different typed array type,
// it does NOT convert values.
function convertTypedArray<T extends Int8ArrayConstructor | Uint8ArrayConstructor | Float32ArrayConstructor>(
  src: ArrayBufferView,
  type: T
): InstanceType<T> {
  const buffer = new ArrayBuffer(src.byteLength);
  new (src.constructor as any)(buffer).set(src as any);
  return new type(buffer) as InstanceType<T>;
}

export async function initGgwave() {
  if (!ggwave) {
    ggwave = await factory();
    const params = ggwave.getDefaultParameters();
    instance = ggwave.init(params);
  }
  return instance;
}

/** Encode payload bytes to a playable audio waveform (Float32Array, mono). */
export function encodeAudio(payload: Uint8Array, protocol?: number): Float32Array {
  if (!instance) throw new Error("ggwave not initialized");
  const proto = protocol ?? ggwave.ProtocolId.GGWAVE_PROTOCOL_AUDIBLE_FAST;
  const raw = ggwave.encode(instance, payload, proto, 50);
  return convertTypedArray(raw, Float32Array);
}

/** Decode captured mic samples (Float32Array). Returns bytes, or null if no valid signal yet. */
export function decodeAudio(samples: Float32Array): Uint8Array | null {
  if (!instance) throw new Error("ggwave not initialized");
  const res = ggwave.decode(instance, convertTypedArray(samples, Int8Array));
  if (res && res.length > 0) {
    return convertTypedArray(res, Uint8Array);
  }
  return null;
}

export function getSampleRate(): number {
  return instance ? ggwave.getDefaultParameters().sampleRate : 48000;
}
