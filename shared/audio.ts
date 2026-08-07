import factory from "ggwave";

let ggwave: any = null;
let instance: any = null;
let currentSampleRate = 48000;

// Real, verified frequency ranges (from ggwave's own source): audible
// protocols use ~1875-6375 Hz (a fast electronic chirp, clearly audible to
// normal human hearing — like an old modem or fax tone). Ultrasound
// protocols use a ~15000 Hz base, at or beyond most adult hearing and many
// phone speaker/mic frequency responses — by design, not a bug, if it seems
// silent.
export interface AudioProtocolOption {
  label: string;
  hint: string;
}

// Populated after initGgwave() since the real IDs come from the loaded module.
export let AUDIO_PROTOCOLS: Record<string, AudioProtocolOption> = {};
let protocolIds: Record<string, number> = {};

/**
 * Initialize (or re-configure) ggwave. If you're about to play or record
 * through a real AudioContext, pass its ACTUAL sample rate — read AFTER
 * creating the context (audioContext.sampleRate), never a value you merely
 * requested. Browsers don't always honor a requested AudioContext sample
 * rate, and if ggwave's generated waveform doesn't match what actually
 * plays it back, the result can be silent or badly pitch-shifted. This is
 * the same pattern ggwave's own official browser example uses.
 */
export async function initGgwave(targetSampleRate?: number) {
  if (!ggwave) {
    ggwave = await factory();
    protocolIds = {
      AUDIBLE_NORMAL: ggwave.ProtocolId.GGWAVE_PROTOCOL_AUDIBLE_NORMAL,
      AUDIBLE_FAST: ggwave.ProtocolId.GGWAVE_PROTOCOL_AUDIBLE_FAST,
      AUDIBLE_FASTEST: ggwave.ProtocolId.GGWAVE_PROTOCOL_AUDIBLE_FASTEST,
      ULTRASOUND_FAST: ggwave.ProtocolId.GGWAVE_PROTOCOL_ULTRASOUND_FAST,
    };
    AUDIO_PROTOCOLS = {
      AUDIBLE_NORMAL: { label: "Normal (clearest, slowest)", hint: "Most reliable over distance/noise" },
      AUDIBLE_FAST: { label: "Fast (default)", hint: "Good balance of speed and reliability" },
      AUDIBLE_FASTEST: { label: "Fastest (higher pitch)", hint: "Quickest, needs a quiet room and close range" },
      ULTRASOUND_FAST: { label: "Ultrasound (silent to most people)", hint: "Needs speaker/mic hardware that supports ~15kHz+" },
    };
  }

  const desired = targetSampleRate ?? currentSampleRate;
  if (instance && desired === currentSampleRate) {
    return instance; // already configured for this rate
  }
  if (instance) {
    try { ggwave.free(instance); } catch { /* best effort */ }
  }

  const params = ggwave.getDefaultParameters();
  params.sampleRateInp = desired;
  params.sampleRateOut = desired;
  params.sampleRate = desired;
  instance = ggwave.init(params);
  currentSampleRate = desired;
  return instance;
}

export function protocolIdFor(key: string): number {
  return protocolIds[key] ?? protocolIds.AUDIBLE_FAST!;
}

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

/** Encode payload bytes to a playable audio waveform (Float32Array, mono).
 *  Note: the receiver does NOT need to know which protocolKey was used —
 *  ggwave's decoder auto-detects among its known protocols by scanning for
 *  each one's marker frequency. The picker only affects the sender. */
export function encodeAudio(payload: Uint8Array, protocolKey?: string): Float32Array {
  if (!instance) throw new Error("ggwave not initialized");
  const proto = protocolKey ? protocolIdFor(protocolKey) : protocolIdFor("AUDIBLE_FAST");
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
  return currentSampleRate;
}
