import QRCode from "qrcode";
import { LTEncoder } from "../shared/fountain";
import { HEADER_LEN, fnv1a, packFrame, type FrameHeader } from "../shared/protocol";
import { createEnvelope } from "../shared/envelope";
import { encryptPayload } from "../shared/crypto";
import { initGgwave, encodeAudio, getSampleRate, AUDIO_PROTOCOLS } from "../shared/audio";
import { frameToPngBlob } from "../shared/qrImage";
import { zipSync } from "../shared/zip";
import { floatArrayToWavBlob } from "../shared/wav";
import { packLiveFrame } from "../shared/live";

const MARGIN = 4;
const LOOKAHEAD = 3;

// UI
const stepFiles = document.getElementById("step-files")!;
const stepMode = document.getElementById("step-mode")!;
const stepTransmit = document.getElementById("step-transmit")!;
const stepAudioSend = document.getElementById("step-audio-send")!;
const fileInput = document.getElementById("file-input") as HTMLInputElement;
const fileList = document.getElementById("file-list")!;
const totalSize = document.getElementById("total-size")!;
const dropzone = document.getElementById("dropzone")!;
const modePublicBtn = document.getElementById("mode-public")!;
const modePrivateBtn = document.getElementById("mode-private")!;
const codeBox = document.getElementById("code-box")!;
const accessCodeInput = document.getElementById("access-code") as HTMLInputElement;
const transportQrBtn = document.getElementById("transport-qr")!;
const transportAudioBtn = document.getElementById("transport-audio")!;
const audioNote = document.getElementById("audio-note")!;
const modeBadge = document.getElementById("mode-badge")!;
const modeBadgeAudio = document.getElementById("mode-badge-audio")!;
const qrContainer = document.getElementById("qr-container")!;
const statusHint = document.getElementById("status-hint")!;
const cancelBtn = document.getElementById("cancel-send")!;
const cancelAudioBtn = document.getElementById("cancel-audio-send")!;
const audioStatus = document.getElementById("audio-send-status")!;
const audioBar = document.getElementById("audio-bar")!;
const cfgBytes = document.getElementById("cfg-bytes") as HTMLSelectElement;
const cfgFps = document.getElementById("cfg-fps") as HTMLSelectElement;
const cfgEcc = document.getElementById("cfg-ecc") as HTMLSelectElement;
const cfgSize = document.getElementById("cfg-size") as HTMLInputElement;
const cfgGrid = document.getElementById("cfg-grid") as HTMLSelectElement;
const downloadQrBtn = document.getElementById("download-qr") as HTMLButtonElement;
const downloadAudioBtn = document.getElementById("download-audio") as HTMLButtonElement;
const audioProtocolBox = document.getElementById("audio-protocol-box")!;
const audioProtocolSelect = document.getElementById("audio-protocol") as HTMLSelectElement;
const audioProtocolHint = document.getElementById("audio-protocol-hint")!;

// Live mode
const typeLiveBtn = document.getElementById("type-live")!;
const stepLive = document.getElementById("step-live")!;
const liveText = document.getElementById("live-text") as HTMLTextAreaElement;
const liveTransportQrBtn = document.getElementById("live-transport-qr")!;
const liveTransportAudioBtn = document.getElementById("live-transport-audio")!;
const liveQrView = document.getElementById("live-qr-view")!;
const liveQrCanvas = document.getElementById("live-qr-canvas") as HTMLCanvasElement;
const liveAudioStatus = document.getElementById("live-audio-status")!;
const liveStopBtn = document.getElementById("live-stop")!;

// Toggle mode
const typeFileBtn = document.getElementById("type-file")!;
const typeMessageBtn = document.getElementById("type-message")!;
const fileArea = document.getElementById("file-area")!;
const messageArea = document.getElementById("message-area")!;
const messageText = document.getElementById("message-text") as HTMLTextAreaElement;
const charCount = document.getElementById("char-count")!;

let selectedFiles: File[] = [];
let mode: "public" | "private" = "public";
let generation = 0;
let encoder: LTEncoder | null = null;
let streamAborted = false;
let transport: "qr" | "audio" = "qr";
let contentMode: "file" | "message" = "file";
let currentAccept = "";
let gridSize = 1;
let gridCanvases: HTMLCanvasElement[] = [];
let stagingCanvases: HTMLCanvasElement[] = [];

// Remembers the most recently started transfer so the download buttons
// (which live outside startQRSend/startAudioSend's own scope) can reach it.
let lastEncoder: LTEncoder | null = null;
let lastHeader: FrameHeader | null = null;
let lastAudioPayload: Uint8Array | null = null;
let lastAudioProtocolKey = "AUDIBLE_FAST";

// Live mode state
let liveTransport: "qr" | "audio" = "qr";
let liveAudioContext: AudioContext | null = null;
let liveAudioSource: AudioBufferSourceNode | null = null;
let liveDebounceTimer: ReturnType<typeof setTimeout> | null = null;

// Filter buttons
document.querySelectorAll(".filter-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".filter-btn").forEach(b => b.classList.remove("selected"));
    btn.classList.add("selected");
    currentAccept = (btn as HTMLElement).dataset.accept ?? "";
  });
});

// Set up file input accept before opening
dropzone.addEventListener("click", () => {
  if (currentAccept) fileInput.accept = currentAccept;
  else fileInput.removeAttribute("accept");
  fileInput.click();
});
fileInput.addEventListener("change", () => {
  selectedFiles = Array.from(fileInput.files ?? []);
  renderFileList();
});
dropzone.addEventListener("dragover", e => e.preventDefault());
dropzone.addEventListener("drop", e => {
  e.preventDefault();
  selectedFiles = Array.from(e.dataTransfer?.files ?? []);
  renderFileList();
});

function renderFileList() {
  fileList.innerHTML = "";
  let total = 0;
  selectedFiles.forEach((f, i) => {
    total += f.size;
    const li = document.createElement("li");
    li.innerHTML = `<span>${f.name} (${formatSize(f.size)})</span>
      <button class="secondary" style="padding:4px 8px;font-size:0.8rem" data-idx="${i}">Remove</button>`;
    fileList.appendChild(li);
  });
  totalSize.textContent = selectedFiles.length
    ? `Total: ${formatSize(total)} · ${selectedFiles.length} file(s)`
    : "No files selected";
  stepMode.style.display = selectedFiles.length || contentMode === "message" ? "block" : "none";
  fileList.querySelectorAll("button[data-idx]").forEach(btn => {
    btn.addEventListener("click", (e) => {
      const idx = Number((e.target as HTMLElement).dataset.idx);
      selectedFiles.splice(idx, 1);
      renderFileList();
    });
  });
}

// Content toggle (File / Message)
typeFileBtn.addEventListener("click", () => {
  contentMode = "file";
  typeFileBtn.classList.add("selected");
  typeMessageBtn.classList.remove("selected");
  typeLiveBtn.classList.remove("selected");
  fileArea.style.display = "block";
  messageArea.style.display = "none";
  stepMode.style.display = selectedFiles.length ? "block" : "none";
  stepLive.style.display = "none";
});
typeMessageBtn.addEventListener("click", () => {
  contentMode = "message";
  typeMessageBtn.classList.add("selected");
  typeFileBtn.classList.remove("selected");
  typeLiveBtn.classList.remove("selected");
  fileArea.style.display = "none";
  messageArea.style.display = "block";
  stepMode.style.display = "block";
  stepLive.style.display = "none";
});
typeLiveBtn.addEventListener("click", async () => {
  typeLiveBtn.classList.add("selected");
  typeFileBtn.classList.remove("selected");
  typeMessageBtn.classList.remove("selected");
  stepFiles.style.display = "none";
  stepMode.style.display = "none";
  stepLive.style.display = "flex";
  await initGgwave(); // live audio needs this ready before first keystroke
});
messageText.addEventListener("input", () => {
  charCount.textContent = `${messageText.value.length} characters`;
});

// Mode (public/private)
modePublicBtn.addEventListener("click", () => {
  mode = "public";
  modePublicBtn.classList.add("selected");
  modePrivateBtn.classList.remove("selected");
  codeBox.style.display = "none";
});
modePrivateBtn.addEventListener("click", () => {
  mode = "private";
  modePrivateBtn.classList.add("selected");
  modePublicBtn.classList.remove("selected");
  codeBox.style.display = "block";
});

// Transport (QR / Audio)
transportQrBtn.addEventListener("click", () => {
  transport = "qr";
  transportQrBtn.classList.add("selected");
  transportAudioBtn.classList.remove("selected");
  audioNote.style.display = "none";
  audioProtocolBox.style.display = "none";
});
transportAudioBtn.addEventListener("click", async () => {
  transport = "audio";
  transportAudioBtn.classList.add("selected");
  transportQrBtn.classList.remove("selected");
  audioNote.style.display = "block";
  audioProtocolBox.style.display = "block";
  await initGgwave();
  if (!audioProtocolSelect.options.length) {
    for (const [key, opt] of Object.entries(AUDIO_PROTOCOLS)) {
      const el = document.createElement("option");
      el.value = key;
      el.textContent = opt.label;
      if (key === "AUDIBLE_FAST") el.selected = true;
      audioProtocolSelect.appendChild(el);
    }
    audioProtocolHint.textContent = AUDIO_PROTOCOLS.AUDIBLE_FAST?.hint ?? "";
    audioProtocolSelect.addEventListener("change", () => {
      audioProtocolHint.textContent = AUDIO_PROTOCOLS[audioProtocolSelect.value]?.hint ?? "";
    });
  }
});

// Send button
let sendBtn: HTMLButtonElement;
function addSendButton() {
  sendBtn = document.createElement("button");
  sendBtn.textContent = "Send";
  sendBtn.style.marginTop = "12px";
  sendBtn.addEventListener("click", startTransfer);
  stepMode.appendChild(sendBtn);
}
addSendButton();

async function startTransfer() {
  if (mode === "private") {
    const code = accessCodeInput.value.trim();
    if (code.length < 4) {
      alert("Private mode requires a code of at least 4 characters.");
      return;
    }
  }

  // Gather content
  let files: File[];
  if (contentMode === "message") {
    const text = messageText.value;
    if (!text.trim()) {
      alert("Please type a message.");
      return;
    }
    const enc = new TextEncoder();
    const blob = new Blob([enc.encode(text)], { type: "text/plain" });
    files = [new File([blob], "message.txt", { type: "text/plain" })];
  } else {
    if (!selectedFiles.length) {
      alert("Please select at least one file.");
      return;
    }
    files = selectedFiles;
  }

  if (transport === "audio") {
    await startAudioSend(files);
  } else {
    await startQRSend(files);
  }
}

// --- QR Send (supports grid) ---
async function startQRSend(files: File[]) {
  stepFiles.style.display = "none";
  stepMode.style.display = "none";
  stepTransmit.style.display = "flex";
  modeBadge.textContent = mode === "private" ? "Private 🔒" : "Public 🌐";
  modeBadge.className = `badge ${mode}`;

  let payload: Uint8Array;
  try {
    payload = await createEnvelope(files);
  } catch (err) {
    statusHint.textContent = `✗ Failed to build envelope: ${err}`;
    return;
  }

  let flags = 0;
  if (mode === "private") {
    try {
      payload = await encryptPayload(payload, accessCodeInput.value.trim());
      flags = 1;
    } catch (err) {
      statusHint.textContent = `✗ Encryption failed: ${err}`;
      return;
    }
  }

  // Grid settings
  gridSize = Number(cfgGrid.value);
  updateBytesPerFrameForGrid(gridSize);

  const txFps = Number(cfgFps.value);
  const frameBytes = Number(cfgBytes.value);
  const ecc = cfgEcc.value as "L"|"M"|"Q"|"H";
  const displayPx = Number(cfgSize.value);
  const blockLen = frameBytes - HEADER_LEN;
  const sessionId = (Math.floor(Math.random() * 0xffff) + 1) & 0xffff;
  encoder = new LTEncoder(payload, blockLen, sessionId);
  const payloadFnv = fnv1a(payload);

  const header: FrameHeader = {
    sessionId, seq: 0, k: encoder.k, blockLen, totalLen: payload.length, payloadFnv, flags,
  };
  lastEncoder = encoder;
  lastHeader = header;

  streamAborted = false;
  generation++;
  const gen = generation;

  // Create grid canvases
  qrContainer.innerHTML = "";
  gridCanvases = [];
  stagingCanvases = [];
  const gridDiv = document.createElement("div");
  gridDiv.style.display = "grid";
  gridDiv.style.gridTemplateColumns = `repeat(${Math.ceil(Math.sqrt(gridSize))}, 1fr)`;
  gridDiv.style.gap = "14px";
  gridDiv.style.justifyItems = "center";
  for (let i = 0; i < gridSize; i++) {
    const cellCanvas = document.createElement("canvas");
    cellCanvas.width = 16; cellCanvas.height = 16;
    cellCanvas.style.width = "100%"; // we'll set exact size later
    cellCanvas.style.borderRadius = "8px";
    gridDiv.appendChild(cellCanvas);
    gridCanvases.push(cellCanvas);

    const stg = document.createElement("canvas");
    stagingCanvases.push(stg);
  }
  qrContainer.appendChild(gridDiv);

  // Grid mode has more usable screen space than a single code did — use it,
  // rather than dividing up the single-code display budget and cramming
  // every cell into a quarter of the room it actually has.
  const cols = Math.ceil(Math.sqrt(gridSize));
  const availablePx = gridSize > 1
    ? Math.min(window.innerWidth - 32, 560)
    : displayPx;
  const cellSize = Math.floor(availablePx / cols) - 16;
  let version: number | undefined;
  let modules = 0;
  let scale = 1;

  const sizeAllCanvases = () => {
    for (let i = 0; i < gridSize; i++) {
      const dpr = window.devicePixelRatio || 1;
      const total = modules + 2 * MARGIN;
      const cssBudget = Math.min(0.9 * cellSize, cellSize);
      scale = Math.max(1, Math.floor((cssBudget * dpr) / total));
      stagingCanvases[i]!.width = total;
      stagingCanvases[i]!.height = total;
      gridCanvases[i]!.width = total * scale;
      gridCanvases[i]!.height = total * scale;
      gridCanvases[i]!.style.width = `${(total * scale) / dpr}px`;
      gridCanvases[i]!.style.height = `${(total * scale) / dpr}px`;
    }
  };

  let nextSeq = 0;
  const queue: ImageData[][] = []; // per-tick batch of N images
  const makeFrameBatch = (): ImageData[] => {
    const batch: ImageData[] = [];
    for (let i = 0; i < gridSize; i++) {
      const bytes = packFrame({ ...header, seq: nextSeq + i }, encoder!.encode(nextSeq + i));
      const qr = QRCode.create([{ data: bytes, mode: "byte" } as any], {
        errorCorrectionLevel: ecc, version, maskPattern: 4,
      });
      if (version === undefined) {
        version = qr.version;
        modules = qr.modules.size;
        sizeAllCanvases();
      }
      const size = qr.modules.size;
      const data = qr.modules.data;
      const total = size + 2 * MARGIN;
      const img = new ImageData(total, total);
      const px = new Uint32Array(img.data.buffer);
      px.fill(0xffffffff);
      for (let y = 0; y < size; y++) {
        const row = (y + MARGIN) * total + MARGIN;
        const src = y * size;
        for (let x = 0; x < size; x++) {
          if (data[src + x]) px[row + x] = 0xff000000;
        }
      }
      batch.push(img);
    }
    nextSeq += gridSize;
    return batch;
  };

  const pump = () => {
    if (gen !== generation || streamAborted) return;
    try {
      while (queue.length < LOOKAHEAD) queue.push(makeFrameBatch());
    } catch (err) {
      statusHint.textContent = `✗ ${err instanceof Error ? err.message : String(err)}`;
      return;
    }
    setTimeout(pump, 0);
  };
  pump();

  const interval = 1000 / txFps;
  let nextAt = performance.now();
  const tick = (now: number) => {
    if (gen !== generation || streamAborted) return;
    requestAnimationFrame(tick);
    if (now < nextAt) return;
    const batch = queue.shift();
    if (!batch) { nextAt = now + interval; return; }
    for (let i = 0; i < gridSize; i++) {
      const img = batch[i]!;
      const stgCtx = stagingCanvases[i]!.getContext("2d")!;
      stgCtx.putImageData(img, 0, 0);
      const ctx = gridCanvases[i]!.getContext("2d")!;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(stagingCanvases[i]!, 0, 0, gridCanvases[i]!.width, gridCanvases[i]!.height);
    }
    nextAt += interval;
    if (now - nextAt > 3 * interval) nextAt = now + interval;
  };
  requestAnimationFrame(tick);

  (document.getElementById("m-fps")!).textContent = String(txFps);
  (document.getElementById("m-payload")!).textContent = formatSize(payload.length);
  (document.getElementById("m-k")!).textContent = String(encoder.k);
  statusHint.textContent = "Hold steady, max brightness helps.";
  try { await (navigator as any).wakeLock?.request("screen"); } catch {}
}

function updateBytesPerFrameForGrid(grid: number) {
  const factor = 1 / Math.sqrt(grid);
  cfgBytes.innerHTML = "";
  [500, 1000, 1465, 1850, 2331, 2953].forEach(b => {
    const newVal = Math.max(1, Math.round(b * factor));
    const opt = document.createElement("option");
    opt.value = String(newVal);
    opt.textContent = `${newVal} B`;
    if (b === 1465) opt.selected = true; // keep best default near original
    cfgBytes.appendChild(opt);
  });
}

// --- Audio Send ---
let audioContext: AudioContext | null = null;
async function startAudioSend(files: File[]) {
  stepFiles.style.display = "none";
  stepMode.style.display = "none";
  stepAudioSend.style.display = "flex";
  modeBadgeAudio.textContent = mode === "private" ? "Private 🔒" : "Public 🌐";
  modeBadgeAudio.className = `badge ${mode}`;

  let payload: Uint8Array;
  try {
    payload = await createEnvelope(files);
  } catch (err) {
    audioStatus.textContent = `✗ ${err}`;
    return;
  }

  let flags = 0;
  if (mode === "private") {
    try {
      payload = await encryptPayload(payload, accessCodeInput.value.trim());
      flags = 1;
    } catch (err) {
      audioStatus.textContent = `✗ ${err}`;
      return;
    }
  }

  // Prepend flags byte
  const finalPayload = new Uint8Array(1 + payload.length);
  finalPayload[0] = flags;
  finalPayload.set(payload, 1);

  try {
    // Create the context FIRST and read its REAL sample rate — browsers
    // don't always honor a requested rate, so ggwave must be configured to
    // match whatever the browser actually gave us, not the other way round.
    if (!audioContext) audioContext = new AudioContext();
    if (audioContext.state === "suspended") await audioContext.resume();
    await initGgwave(audioContext.sampleRate);

    lastAudioPayload = finalPayload;
    lastAudioProtocolKey = audioProtocolSelect.value || "AUDIBLE_FAST";
    const waveform = encodeAudio(finalPayload, lastAudioProtocolKey);

    const buffer = audioContext.createBuffer(1, waveform.length, audioContext.sampleRate);
    buffer.getChannelData(0).set(waveform);
    const source = audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(audioContext.destination);
    source.start();

    const totalDuration = waveform.length / audioContext.sampleRate;
    const startTime = audioContext.currentTime;
    const updateProgress = () => {
      if (!audioContext) return;
      const elapsed = audioContext.currentTime - startTime;
      const pct = Math.min(100, (elapsed / totalDuration) * 100);
      audioBar.style.width = `${pct}%`;
      if (pct < 100) requestAnimationFrame(updateProgress);
      else audioStatus.textContent = "Done!";
    };
    requestAnimationFrame(updateProgress);
    audioStatus.textContent = "Playing sound… hold receiving device's microphone close.";
    try { await (navigator as any).wakeLock?.request("screen"); } catch {}

    source.onended = () => {
      audioStatus.textContent = "Audio sent — check receiver.";
      audioBar.style.width = "100%";
    };
  } catch (err) {
    audioStatus.textContent = `✗ Audio playback failed: ${err instanceof Error ? err.message : err}`;
  }
}

// --- Downloads ---
function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

downloadQrBtn.addEventListener("click", async () => {
  if (!lastEncoder || !lastHeader) return;
  const k = lastHeader.k;
  const frameCount = Math.max(k + 3, Math.ceil(k * 1.4));

  if (frameCount > 40) {
    const proceed = confirm(
      `This needs about ${frameCount} QR codes to download reliably. ` +
      `That'll take a little while to generate and isn't very practical to re-upload by hand — ` +
      `for anything this size, using the live QR/camera transfer is usually much faster. Continue anyway?`
    );
    if (!proceed) return;
  }

  downloadQrBtn.disabled = true;
  const originalLabel = downloadQrBtn.textContent;
  try {
    if (frameCount === 1) {
      downloadQrBtn.textContent = "Preparing…";
      const bytes = packFrame({ ...lastHeader, seq: 0 }, lastEncoder.encode(0));
      const blob = await frameToPngBlob(bytes);
      triggerDownload(blob, "qr-code.png");
    } else {
      const files: Record<string, Uint8Array> = {};
      for (let seq = 0; seq < frameCount; seq++) {
        downloadQrBtn.textContent = `Preparing… ${seq + 1}/${frameCount}`;
        const bytes = packFrame({ ...lastHeader, seq }, lastEncoder.encode(seq));
        const blob = await frameToPngBlob(bytes);
        files[`frame-${String(seq).padStart(4, "0")}.png`] = new Uint8Array(await blob.arrayBuffer());
        // Yield to the browser periodically so the progress text actually
        // repaints and the tab doesn't look frozen during a long batch.
        if (seq % 5 === 0) await new Promise(r => setTimeout(r, 0));
      }
      downloadQrBtn.textContent = "Zipping…";
      const zipped = zipSync(files);
      triggerDownload(new Blob([zipped as BlobPart], { type: "application/zip" }), "qr-codes.zip");
    }
  } catch (err) {
    alert(`Couldn't prepare download: ${err instanceof Error ? err.message : err}`);
  } finally {
    downloadQrBtn.disabled = false;
    downloadQrBtn.textContent = originalLabel;
  }
});

downloadAudioBtn.addEventListener("click", async () => {
  if (!lastAudioPayload) return;
  downloadAudioBtn.disabled = true;
  const originalLabel = downloadAudioBtn.textContent;
  downloadAudioBtn.textContent = "Preparing…";
  try {
    await initGgwave(); // fine to reuse whatever rate is currently configured — a WAV file declares its own rate
    const waveform = encodeAudio(lastAudioPayload, lastAudioProtocolKey);
    const blob = floatArrayToWavBlob(waveform, getSampleRate());
    triggerDownload(blob, "message.wav");
  } catch (err) {
    alert(`Couldn't prepare audio download: ${err instanceof Error ? err.message : err}`);
  } finally {
    downloadAudioBtn.disabled = false;
    downloadAudioBtn.textContent = originalLabel;
  }
});

// --- Live mode ---
function scheduleLiveUpdate() {
  if (liveDebounceTimer) clearTimeout(liveDebounceTimer);
  liveDebounceTimer = setTimeout(() => { void sendLiveSnapshot(); }, 150);
}
liveText.addEventListener("input", scheduleLiveUpdate);

liveTransportQrBtn.addEventListener("click", () => {
  liveTransport = "qr";
  liveTransportQrBtn.classList.add("selected");
  liveTransportAudioBtn.classList.remove("selected");
  liveAudioStatus.style.display = "none";
  scheduleLiveUpdate();
});
liveTransportAudioBtn.addEventListener("click", () => {
  liveTransport = "audio";
  liveTransportAudioBtn.classList.add("selected");
  liveTransportQrBtn.classList.remove("selected");
  liveQrView.style.display = "none";
  liveAudioStatus.style.display = "block";
  scheduleLiveUpdate();
});

async function sendLiveSnapshot() {
  const text = liveText.value;
  if (!text) { liveQrView.style.display = "none"; return; }
  const frame = packLiveFrame(text);

  if (liveTransport === "qr") {
    liveQrView.style.display = "block";
    await QRCode.toCanvas(liveQrCanvas, [{ data: frame, mode: "byte" } as any], {
      errorCorrectionLevel: "M",
      margin: 2,
      width: Math.min(window.innerWidth - 64, 320),
    });
  } else {
    try {
      if (!liveAudioContext) liveAudioContext = new AudioContext();
      if (liveAudioContext.state === "suspended") await liveAudioContext.resume();
      await initGgwave(liveAudioContext.sampleRate);
      const waveform = encodeAudio(frame, "AUDIBLE_FAST");
      if (liveAudioSource) { try { liveAudioSource.stop(); } catch {} }
      const buffer = liveAudioContext.createBuffer(1, waveform.length, liveAudioContext.sampleRate);
      buffer.getChannelData(0).set(waveform);
      liveAudioSource = liveAudioContext.createBufferSource();
      liveAudioSource.buffer = buffer;
      liveAudioSource.connect(liveAudioContext.destination);
      liveAudioSource.start();
      liveAudioStatus.textContent = "Replaying as you type…";
    } catch (err) {
      liveAudioStatus.textContent = `✗ ${err instanceof Error ? err.message : err}`;
    }
  }
}

liveStopBtn.addEventListener("click", () => {
  if (liveDebounceTimer) clearTimeout(liveDebounceTimer);
  if (liveAudioSource) { try { liveAudioSource.stop(); } catch {} liveAudioSource = null; }
  if (liveAudioContext) { liveAudioContext.close(); liveAudioContext = null; }
  liveText.value = "";
  liveQrView.style.display = "none";
  stepLive.style.display = "none";
  stepFiles.style.display = "block";
  stepMode.style.display = selectedFiles.length || contentMode === "message" ? "block" : "none";
});

// Cancel buttons
cancelBtn.addEventListener("click", () => { streamAborted = true; generation++; stepFiles.style.display = "block"; stepMode.style.display = selectedFiles.length || contentMode==="message" ? "block":"none"; stepTransmit.style.display = "none"; });
cancelAudioBtn.addEventListener("click", () => { streamAborted = true; if (audioContext) audioContext.close(); audioContext = null; stepFiles.style.display = "block"; stepMode.style.display = selectedFiles.length || contentMode==="message" ? "block":"none"; stepAudioSend.style.display = "none"; });

// Grid selector population
for (const g of [1,4,6,9]) {
  const opt = document.createElement("option");
  opt.value = String(g); opt.textContent = `${g} cells`; if (g===4) opt.selected = true;
  cfgGrid.appendChild(opt);
}
updateBytesPerFrameForGrid(4); // default 4

// Bytes/fps/ecc initial lists
[500,1000,1465,1850,2331,2953].forEach(b => { /* will be overridden by grid update */ });
cfgFps.innerHTML = "";
[10,15,20,24,30,60].forEach(f => { const o = document.createElement("option"); o.value=String(f); o.textContent=String(f); if(f===24) o.selected=true; cfgFps.appendChild(o); });
cfgEcc.innerHTML = "";
["L","M","Q","H"].forEach(e => { const o = document.createElement("option"); o.value=e; o.textContent=e; if(e==="L") o.selected=true; cfgEcc.appendChild(o); });

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes/1024).toFixed(1)} KB`;
  return `${(bytes/1048576).toFixed(2)} MB`;
}