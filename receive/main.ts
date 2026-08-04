import { LTDecoder } from "../shared/fountain";
import { fnv1a, parseFrame } from "../shared/protocol";
import { decryptPayload } from "../shared/crypto";
import { unpackEnvelope, extractFiles } from "../shared/envelope";
import { initGgwave, decodeAudio, getSampleRate } from "../shared/audio";

const OVERHEAD_EST = 1.18;

const stepStart = document.getElementById("step-start")!;
const stepReceive = document.getElementById("step-receive")!;
const stepAudioReceive = document.getElementById("step-audio-receive")!;
const startBtn = document.getElementById("start-btn")!;
const listenBtn = document.getElementById("listen-btn")!;
const stopBtn = document.getElementById("stop-btn")!;
const stopAudioBtn = document.getElementById("stop-audio-btn")!;
const codeOverlay = document.getElementById("code-overlay")!;
const privateCodeInput = document.getElementById("private-code") as HTMLInputElement;
const submitCodeBtn = document.getElementById("submit-code")!;
const resultDiv = document.getElementById("result")!;
const audioResultDiv = document.getElementById("audio-result")!;
const progressEl = document.getElementById("progress")!;
const progressLabel = document.getElementById("progress-label")!;
const audioStatus = document.getElementById("audio-receive-status")!;
const metric = (id: string) => document.getElementById(id)!;

let stream: MediaStream | null = null;
let audioStream: MediaStream | null = null;
let decoder: LTDecoder | null = null;
let sessionId = 0;
let startTs = 0;
let captureGen = 0;
let done = false;
let needsCode = false;
let encryptedPayload: Uint8Array | null = null;
let headerPayloadFnv = 0;
let headerTotalLen = 0;
let audioContext: AudioContext | null = null;

const workers: Worker[] = [];
const busy: boolean[] = [];
const captureTimes: number[] = [];
const decodeTimes: number[] = [];

// --- QR receive (multi‑symbol) ---
startBtn.onclick = () => void startQR();

async function startQR() {
  if (!navigator.mediaDevices?.getUserMedia) {
    alert("Camera requires HTTPS.");
    return;
  }
  stepStart.style.display = "none";
  stepReceive.style.display = "flex";
  stopBtn.style.display = "block";

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
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { ...base, frameRate: { exact: captureFps } } });
    } catch {
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { ...base, frameRate: { ideal: captureFps } } });
    }
  } catch (err) {
    statusText(`✗ camera: ${err}`);
    return;
  }
  const video = document.getElementById("video") as HTMLVideoElement;
  video.srcObject = stream;
  await video.play().catch(() => {});

  for (let i = 0; i < workerCount; i++) {
    const w = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    const slot = i;
    w.onmessage = (e) => {
      const { id, bytesList } = e.data; // now an array of Uint8Array
      if (id === -1) return;
      busy[slot] = false;
      if (bytesList && bytesList.length) {
        for (const bytes of bytesList) {
          onDecoded(bytes);
        }
      }
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
  const v = document.getElementById("video") as VideoRVFC;
  const next = () => { if (!done && gen === captureGen) { captureFrame(); scheduleFrame(gen); } };
  if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(next);
  else requestAnimationFrame(next);
}

const grab = document.createElement("canvas");
let frameId = 0;
function captureFrame() {
  const video = document.getElementById("video") as HTMLVideoElement;
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
    decoder = new LTDecoder(header.k, header.blockLen, header.sessionId, header.totalLen);
    sessionId = header.sessionId;
    startTs = performance.now();
    progressEl.style.display = "block";
    progressLabel.style.display = "block";
    needsCode = (header.flags & 1) === 1;
    headerTotalLen = header.totalLen;
    headerPayloadFnv = header.payloadFnv;
    if (needsCode) codeOverlay.style.display = "flex";
  }
  decoder.addFrame(header.seq, block);

  const progress = Math.min(0.99, decoder.framesNew / (decoder.k * OVERHEAD_EST));
  progressEl.innerHTML = `<div style="width:${(progress*100).toFixed(1)}%; height:100%; background:var(--accent); transition:width 0.2s"></div>`;
  progressLabel.textContent = `Receiving… ${(progress*100).toFixed(0)}%`;

  if (decoder.isComplete) {
    encryptedPayload = decoder.assemble()!;
    if (needsCode) return; // wait for code
    finishTransfer(encryptedPayload, false);
  }
}

// --- Audio receive ---
listenBtn.onclick = () => void startAudio();

async function startAudio() {
  if (!navigator.mediaDevices?.getUserMedia) {
    alert("Microphone requires HTTPS.");
    return;
  }
  stepStart.style.display = "none";
  stepAudioReceive.style.display = "flex";
  stopAudioBtn.style.display = "block";
  audioStatus.textContent = "Listening… No signal yet.";

  try {
    audioStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch (err) {
    audioStatus.textContent = "✗ Microphone permission denied.";
    return;
  }

  await initGgwave();
  const sampleRate = getSampleRate();
  audioContext = new AudioContext({ sampleRate });
  if (audioContext.state === "suspended") await audioContext.resume();
  const source = audioContext.createMediaStreamSource(audioStream);
  const scriptNode = audioContext.createScriptProcessor(4096, 1, 1);
  source.connect(scriptNode);
  scriptNode.connect(audioContext.destination);

  let accumulated: Float32Array = new Float32Array(0);
  let lastDecode = performance.now();
  const maxSamples = sampleRate * 5; // keep at most last 5s — ggwave messages are short

  scriptNode.onaudioprocess = (e) => {
    if (done) return;
    const input = e.inputBuffer.getChannelData(0);
    const newArr = new Float32Array(accumulated.length + input.length);
    newArr.set(accumulated);
    newArr.set(input, accumulated.length);
    accumulated = newArr.length > maxSamples
      ? newArr.subarray(newArr.length - maxSamples)
      : newArr;

    // Attempt decode every ~300ms
    if (performance.now() - lastDecode > 300) {
      lastDecode = performance.now();
      try {
        const res = decodeAudio(accumulated);
        if (res) {
          onAudioDecoded(res);
          done = true;
          scriptNode.disconnect();
          audioContext?.close();
        }
      } catch {}
    }
  };

  stopAudioBtn.onclick = () => {
    done = true;
    scriptNode.disconnect();
    audioContext?.close();
    audioStream?.getTracks().forEach(t => t.stop());
    stepStart.style.display = "block";
    stepAudioReceive.style.display = "none";
  };
}

async function onAudioDecoded(payloadWithFlag: Uint8Array) {
  if (payloadWithFlag.length < 1) return;
  const flags = payloadWithFlag[0]!;
  const payload = payloadWithFlag.subarray(1);
  if (flags & 1) {
    // private: show code overlay
    codeOverlay.style.display = "flex";
    privateCodeInput.value = "";
    // Wait for code submit
    submitCodeBtn.onclick = async () => {
      const code = privateCodeInput.value.trim();
      if (!code) return;
      try {
        const plain = await decryptPayload(payload, code);
        codeOverlay.style.display = "none";
        finishAudio(plain);
      } catch {
        alert("That code doesn't match — nothing was saved. Ask the sender to repeat it.");
      }
    };
  } else {
    finishAudio(payload);
  }
}

function finishAudio(plainPayload: Uint8Array) {
  audioStatus.textContent = "Audio received ✓";
  try {
    const { metadata, payload } = unpackEnvelope(plainPayload);
    const files = extractFiles(metadata, payload);
    audioResultDiv.innerHTML = "";
    files.forEach(f => renderFileResult(f, audioResultDiv));
  } catch (err) {
    audioResultDiv.textContent = `✗ Failed to unpack: ${err}`;
  }
}

// --- Shared result rendering (QR & audio) ---
function finishTransfer(payload: Uint8Array, wasEncrypted: boolean) {
  done = true;
  captureGen++;
  stream?.getTracks().forEach(t => t.stop());
  stopBtn.style.display = "none";
  progressEl.innerHTML = `<div style="width:100%; height:100%; background:var(--success)"></div>`;
  progressLabel.textContent = "Transfer complete ✓";
  const seconds = (performance.now() - startTs) / 1000;
  const fnvOk = fnv1a(payload) === headerPayloadFnv;
  statusText(`Transfer complete · ${(headerTotalLen/1024).toFixed(0)} KB in ${seconds.toFixed(1)}s · hash ${fnvOk ? "✓" : "MISMATCH"}`);
  try {
    const { metadata, payload: content } = unpackEnvelope(payload);
    const files = extractFiles(metadata, content);
    resultDiv.innerHTML = "";
    files.forEach(f => renderFileResult(f, resultDiv));
  } catch (err) {
    resultDiv.textContent = `✗ Failed to unpack: ${err}`;
  }
}

function renderFileResult(f: { name: string; blob: Blob }, container: HTMLElement) {
  const url = URL.createObjectURL(f.blob);
  const isText = f.blob.type === "text/plain";
  const wrapper = document.createElement("div");
  wrapper.className = isText ? "chat-bubble" : "result-item";

  if (isText) {
    f.blob.text().then(text => {
      wrapper.innerHTML = `<div class="bubble-content">${escapeHtml(text)}</div>`;
      const dlBtn = document.createElement("a");
      dlBtn.href = url;
      dlBtn.download = f.name;
      dlBtn.className = "btn";
      dlBtn.textContent = "Download as .txt";
      wrapper.appendChild(dlBtn);
    });
  } else {
    const ext = f.name.split('.').pop()?.toLowerCase();
    const isImage = f.blob.type.startsWith("image/");
    const isVideo = f.blob.type.startsWith("video/");
    const isApk = f.blob.type === "application/vnd.android.package-archive" || ext === "apk";
    if (isImage) {
      const img = document.createElement("img");
      img.src = url; img.style.maxWidth = "200px"; img.style.borderRadius = "6px";
      wrapper.appendChild(img);
    } else if (isVideo) {
      const vid = document.createElement("video");
      vid.src = url; vid.controls = true; vid.style.maxWidth = "200px";
      wrapper.appendChild(vid);
    } else {
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
  }
  container.appendChild(wrapper);
}

function escapeHtml(text: string) {
  const d = document.createElement("div");
  d.textContent = text;
  return d.innerHTML;
}

function statusText(msg: string) {
  const el = document.createElement("p");
  el.className = "hint";
  el.textContent = msg;
  resultDiv.parentNode?.insertBefore(el, resultDiv);
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