import { zipSync, unzipSync } from "fflate";

export interface FileEntry {
  name: string;
  mime: string;
  size: number;
}

export interface EnvelopeMetadata {
  v: 1;
  kind: "single" | "bundle";
  files: FileEntry[];
  createdAt: string;
}

export interface PackedEnvelope {
  metadata: EnvelopeMetadata;
  payload: Uint8Array; // raw file (single) or zip bytes (bundle)
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Build the full envelope: metadata + file content (or zip). */
export async function createEnvelope(files: File[]): Promise<Uint8Array> {
  const entries: FileEntry[] = [];
  const fileDatas: Uint8Array[] = [];
  for (const file of files) {
    entries.push({
      name: file.name,
      mime: file.type || "application/octet-stream",
      size: file.size,
    });
    const buf = await file.arrayBuffer();
    fileDatas.push(new Uint8Array(buf));
  }

  const metadata: EnvelopeMetadata = {
    v: 1,
    kind: files.length === 1 ? "single" : "bundle",
    files: entries,
    createdAt: new Date().toISOString(),
  };
  const metaJson = JSON.stringify(metadata);
  const metaBytes = encoder.encode(metaJson);
  const metaLen = new Uint8Array(4);
  new DataView(metaLen.buffer).setUint32(0, metaBytes.length, true);

  let payload: Uint8Array;
  if (files.length === 1) {
    payload = fileDatas[0]!;
  } else {
    // bundle: zip all files
    const deflated = zipSync(
      Object.fromEntries(files.map((f, i) => [f.name, fileDatas[i]!]))
    );
    payload = new Uint8Array(deflated);
  }

  const total = new Uint8Array(4 + metaBytes.length + payload.length);
  total.set(metaLen, 0);
  total.set(metaBytes, 4);
  total.set(payload, 4 + metaBytes.length);
  return total;
}

/** Unpack an envelope: returns metadata and the raw payload (file or zip). */
export function unpackEnvelope(data: Uint8Array): PackedEnvelope {
  if (data.length < 4) throw new Error("Envelope too short");
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const metaLen = dv.getUint32(0, true);
  if (4 + metaLen > data.length) throw new Error("Metadata length exceeds envelope");
  const metaJson = decoder.decode(data.subarray(4, 4 + metaLen));
  const metadata: EnvelopeMetadata = JSON.parse(metaJson);
  const payload = data.subarray(4 + metaLen);
  return { metadata, payload };
}

/** For single file, return a Blob; for bundle, unzip and return array of { name, blob }. */
export function extractFiles(
  metadata: EnvelopeMetadata,
  payload: Uint8Array
): { name: string; blob: Blob }[] {
  if (metadata.kind === "single") {
    const entry = metadata.files[0]!;
    return [{ name: entry.name, blob: new Blob([payload as BlobPart], { type: entry.mime }) }];
  }
  // bundle: unzip
  const unzipped = unzipSync(payload);
  return Object.entries(unzipped).map(([name, data]) => {
    const entry = metadata.files.find(f => f.name === name);
    const mime = entry?.mime ?? "application/octet-stream";
    return { name, blob: new Blob([data], { type: mime }) };
  });
}