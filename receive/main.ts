// Receiver: camera → WASM QR decode → fountain → optionally decrypt → envelope → files.
import { LTDecoder } from "../shared/fountain";
import { fnv1a, parseFrame } from "../shared/protocol";
import { decryptPayload } from "../shared/crypto";
import { unpackEnvelope, extractFiles } from "../shared/envelope";

const OVERHEAD_EST = 1.18;

const startBtn = document.getElementById("start-btn")!;
const stepStart = document.getElementById("step-start")!;
const stepReceive = document.getElementById("step-receive")!;
const video = document.getElementById("video") as HTMLVideoElement;
const stopBtn = document.getElementById("stop-btn")!;
const codeOverlay = document.getElementById("code-overlay")!;
const privateCodeInput = document.getElementById("private-code") as HTMLInputElement;
const submitCodeBtn = document.getElementById("submit-code")!;
const resultDiv = document.getElementById("result")!;
const progressEl = document.getElementById("progress")!; // we'll use div with inner bar
const progressLabel = document.getElementById("progress-label")!;
const metric = (id: string) => document.getElementById(id)!;

let stream: MediaStream | null = null;
let decoder: LTDecoder | null = null;
let sessionId = 0;
let startTs = 0;
let captureGen = 0;
let done = false;
let needsCode = false; // set when first private frame arrives
let encryptedPayload: Uint8Array | null = null;
let headerPayloadFnv = 0;
let headerTotalLen = 0;

const workers: Worker[] = [];
const busy: boolean[] = [];
const captureTimes: number[] = [];
const decodeTimes: number[] = [];

startBtn.onclick = () => void start();

async function start() {
  if (!navigator.mediaDevices?.getUserMedia) {
    alert("Camera requires HTTPS. Use a secure connection.");
    return;
  }
  stepStart.style.display = "none";
  stepReceive.style.display = "flex";
  stopBtn.style.display = "block";

  // Default settings (auto)
  const captureWidth = 1280;
  const captureFps = 60;
  const workerCount = 2;

  const base: MediaTrackConstraints = {
    facingMode: "environment",
    width: { ideal: captureWidth },
    height: { ideal: Math.round((captureWidth * 3) / 4) },
  };
  try {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { ...base, frameRate: { exact: captureFps } },
      });
    } catch {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { ...base, frameRate: { ideal: captureFps } },
      });
    }
  } catch (err) {
    statusText(`✗ camera: ${err}`);
    return;
  }
  video.srcObject = stream;
  await video.play().catch(() => undefined);

  // Spawn workers
  for (let i = 0; i < workerCount; i++) {
    const w = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    const slot = i;
    w.onmessage = (e) => {
      const { id, bytes } = e.data;
      if (id === -1) return;
      busy[slot] = false;
      if (bytes) onDecoded(bytes);
    };
    workers.push(w);
    busy.push(false);
  }

  captureGen++;
  scheduleFrame(captureGen);
  setInterval(updateStats, 500);
  try { await (navigator as any).wakeLock?.request("screen"); } catch {}
}

type VideoRVFC = HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number };
function scheduleFrame(gen: number) {
  if (done || gen !== captureGen) return;
  const v = video as VideoRVFC;
  const next = () => {
    if (done || gen !== captureGen) return;
    captureFrame();
    scheduleFrame(gen);
  };
  if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(next);
  else requestAnimationFrame(next);
}

const grab = document.createElement("canvas");
let frameId = 0;
function captureFrame() {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return;
  captureTimes.push(performance.now());
  const slot = busy.indexOf(false);
  if (slot === -1) return;
  if (grab.width !== vw || grab.height !== vh) { grab.width = vw; grab.height = vh; }
  const ctx = grab.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(video, 0, 0);
  const img = ctx.getImageData(0, 0, vw, vh);
  busy[slot] = true;
  workers[slot]!.postMessage({ id: frameId++, buf: img.data.buffer, w: vw, h: vh }, [img.data.buffer]);
}

function onDecoded(bytes: Uint8Array) {
  decodeTimes.push(performance.now());
  const parsed = parseFrame(bytes);
  if (!parsed || done) return;
  const { header, block } = parsed;

  if (!decoder || sessionId !== header.sessionId) {
    // New transfer
    decoder = new LTDecoder(header.k, header.blockLen, header.sessionId, header.totalLen);
    sessionId = header.sessionId;
    startTs = performance.now();
    progressEl.style.display = "block";
    progressLabel.style.display = "block";
    needsCode = (header.flags & 1) === 1;
    headerTotalLen = header.totalLen;
    headerPayloadFnv = header.payloadFnv;
    if (needsCode) {
      codeOverlay.style.display = "flex";
    }
  }
  decoder.addFrame(header.seq, block);

  // Progress bar
  const progress = Math.min(0.99, decoder.framesNew / (decoder.k * OVERHEAD_EST));
  progressEl.innerHTML = `<div style="width:${(progress*100).toFixed(1)}%; height:100%; background:var(--accent); transition:width 0.2s"></div>`;
  progressLabel.textContent = `Receiving… ${(progress*100).toFixed(0)}%`;

  if (decoder.isComplete) {
    encryptedPayload = decoder.assemble()!;
    if (needsCode) {
      // Wait for code submission
      return;
    }
    finishTransfer(encryptedPayload, false);
  }
}

// Code overlay
submitCodeBtn.addEventListener("click", async () => {
  const code = privateCodeInput.value.trim();
  if (!code || !encryptedPayload) return;
  try {
    const plain = await decryptPayload(encryptedPayload, code);
    codeOverlay.style.display = "none";
    finishTransfer(plain, true);
  } catch (err) {
    alert("That code doesn't match — nothing was saved. Ask the sender to repeat it.");
  }
});

async function finishTransfer(payload: Uint8Array, wasEncrypted: boolean) {
  done = true;
  captureGen++;
  stream?.getTracks().forEach(t => t.stop());
  stopBtn.style.display = "none";
  progressEl.innerHTML = `<div style="width:100%; height:100%; background:var(--success)"></div>`;
  progressLabel.textContent = "Transfer complete ✓";

  const seconds = (performance.now() - startTs) / 1000;
  const fnvOk = fnv1a(payload) === headerPayloadFnv;
  statusText(`Transfer complete · ${(headerTotalLen/1024).toFixed(0)} KB in ${seconds.toFixed(1)}s · hash ${fnvOk ? "✓" : "MISMATCH"}`);

  // Unpack envelope
  try {
    const { metadata, payload: content } = unpackEnvelope(payload);
    const files = extractFiles(metadata, content);
    resultDiv.innerHTML = "";
    files.forEach(f => {
      const url = URL.createObjectURL(f.blob);
      const ext = f.name.split('.').pop()?.toLowerCase();
      const isImage = f.blob.type.startsWith("image/");
      const isVideo = f.blob.type.startsWith("video/");
      const isApk = f.blob.type === "application/vnd.android.package-archive" || ext === "apk";

      const wrapper = document.createElement("div");
      wrapper.className = "result-item";

      if (isImage) {
        const img = document.createElement("img");
        img.src = url; img.style.maxWidth = "200px"; img.style.borderRadius = "6px";
        wrapper.appendChild(img);
      } else if (isVideo) {
        const vid = document.createElement("video");
        vid.src = url; vid.controls = true; vid.style.maxWidth = "200px";
        wrapper.appendChild(vid);
      } else {
        // generic file icon
        wrapper.innerHTML = `<span style="font-size:2rem">📄</span>`;
      }

      const info = document.createElement("div");
      info.style.flex = "1";
      info.innerHTML = `<strong>${f.name}</strong><br><span style="color:var(--muted);font-size:0.85rem">${formatSize(f.blob.size)}</span>`;
      wrapper.appendChild(info);

      const dlBtn = document.createElement("a");
      dlBtn.href = url;
      dlBtn.download = f.name;
      dlBtn.className = "btn";
      dlBtn.textContent = isApk ? "Install app" : "Download";
      wrapper.appendChild(dlBtn);

      resultDiv.appendChild(wrapper);
    });
  } catch (err) {
    resultDiv.textContent = `✗ Failed to unpack: ${err}`;
  }
}

function statusText(msg: string) {
  document.getElementById("stats")?.remove(); // not used, maybe add a hint element
  const hint = document.createElement("p");
  hint.className = "hint";
  hint.textContent = msg;
  resultDiv.parentNode?.insertBefore(hint, resultDiv);
}

function updateStats() {
  if (done) return;
  const now = performance.now();
  const prune = (a: number[]) => { while (a.length && a[0]! < now-2000) a.shift(); };
  prune(captureTimes); prune(decodeTimes);
  metric("m-cap").textContent = (captureTimes.length / 2).toFixed(0);
  metric("m-dec").textContent = (decodeTimes.length / 2).toFixed(1);
  if (!decoder) return;
  const elapsed = (now - startTs)/1000;
  const kbs = (decoder.framesNew * decoder.blockLen) / OVERHEAD_EST / 1024 / Math.max(0.1, elapsed);
  metric("m-rate").textContent = `${kbs.toFixed(1)} KB/s`;
  metric("m-time").textContent = elapsed.toFixed(0) + "s";
  metric("m-frames").textContent = `${decoder.framesNew}/${decoder.framesDup}`;
  metric("m-k").textContent = String(decoder.k);
}

stopBtn.addEventListener("click", () => {
  done = true;
  captureGen++;
  stream?.getTracks().forEach(t => t.stop());
  stepStart.style.display = "block";
  stepReceive.style.display = "none";
});

function formatSize(b: number) {
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b/1024).toFixed(1)} KB`;
  return `${(b/1048576).toFixed(2)} MB`;
}