// Minimal PCM16 mono WAV writer — just enough to make a ggwave waveform
// into a real, downloadable/shareable audio file. For reading audio back
// in, we don't need a matching parser: the browser's native
// AudioContext.decodeAudioData() already handles WAV (and MP3/M4A/etc.)
// natively, so uploads go through that instead.

export function floatArrayToWavBlob(samples: Float32Array, sampleRate: number): Blob {
  const bytesPerSample = 2; // 16-bit PCM
  const blockAlign = bytesPerSample; // mono
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const dv = new DataView(buffer);

  function writeString(offset: number, str: string) {
    for (let i = 0; i < str.length; i++) dv.setUint8(offset + i, str.charCodeAt(i));
  }

  writeString(0, "RIFF");
  dv.setUint32(4, 36 + dataSize, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  dv.setUint32(16, 16, true);        // fmt chunk size
  dv.setUint16(20, 1, true);         // PCM format
  dv.setUint16(22, 1, true);         // mono
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * blockAlign, true); // byte rate
  dv.setUint16(32, blockAlign, true);
  dv.setUint16(34, 16, true);        // bits per sample
  writeString(36, "data");
  dv.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    dv.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }

  return new Blob([buffer], { type: "audio/wav" });
}

/** Decode an uploaded audio file back to raw Float32Array PCM samples for ggwave. */
export async function audioFileToFloatArray(file: File, targetSampleRate: number): Promise<Float32Array> {
  const arrayBuffer = await file.arrayBuffer();
  const ctx = new AudioContext({ sampleRate: targetSampleRate });
  try {
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
    return audioBuffer.getChannelData(0);
  } finally {
    ctx.close();
  }
}
