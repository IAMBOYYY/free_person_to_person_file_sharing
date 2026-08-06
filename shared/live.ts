// Live mode sends the CURRENT text as a single, complete, immediately-usable
// snapshot every time it updates — no multi-frame reconstruction needed,
// since it's short-lived by nature (the next keystroke replaces it anyway).
// This intentionally does NOT reuse the fountain frame protocol; it's a
// different, much simpler format that a receiver can tell apart from a
// fountain frame by its first byte alone (0x4C can never collide with the
// fountain protocol's first magic byte 0xD1 — see shared/protocol.ts).

const LIVE_MARKER = 0x4c; // 'L'

export function packLiveFrame(text: string): Uint8Array {
  const body = new TextEncoder().encode(text);
  const out = new Uint8Array(1 + body.length);
  out[0] = LIVE_MARKER;
  out.set(body, 1);
  return out;
}

export function isLiveFrame(bytes: Uint8Array): boolean {
  return bytes.length >= 1 && bytes[0] === LIVE_MARKER;
}

export function unpackLiveFrame(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes.subarray(1));
}
