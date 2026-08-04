import QRCode from "qrcode";
import { LTEncoder } from "../shared/fountain";
import { HEADER_LEN, fnv1a, packFrame, type FrameHeader } from "../shared/protocol";
import { createEnvelope } from "../shared/envelope";
import { encryptPayload } from "../shared/crypto";
import { initGgwave, encodeAudio, getSampleRate } from "../shared/audio";

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
  fileArea.style.display = "block";
  messageArea.style.display = "none";
  stepMode.style.display = selectedFiles.length ? "block" : "none";
});
typeMessageBtn.addEventListener("click", () => {
  contentMode = "message";
  typeMessageBtn.classList.add("selected");
  typeFileBtn.classList.remove("selected");
  fileArea.style.display = "none";
  messageArea.style.display = "block";
  stepMode.style.display = "block";
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
});
transportAudioBtn.addEventListener("click", () => {
  transport = "audio";
  transportAudioBtn.classList.add("selected");
  transportQrBtn.classList.remove("selected");
  audioNote.style.display = "block";
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
  gridDiv.style.gap = "6px";
  gridDiv.style.justifyItems = "center";
  for (let i = 0; i < gridSize; i++) {
    const cellCanvas = document.createElement("canvas");
    cellCanvas.width = 16; cellCanvas.height = 16;
    cellCanvas.style.width = "100%"; // we'll set exact size later
    gridDiv.appendChild(cellCanvas);
    gridCanvases.push(cellCanvas);

    const stg = document.createElement("canvas");
    stagingCanvases.push(stg);
  }
  qrContainer.appendChild(gridDiv);

  const cellSize = Math.floor(displayPx / Math.ceil(Math.sqrt(gridSize))) - 20;
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

  await initGgwave();
  const waveform = encodeAudio(finalPayload);
  const sampleRate = getSampleRate();

  // Play
  if (!audioContext) audioContext = new AudioContext({ sampleRate });
  const buffer = audioContext.createBuffer(1, waveform.length, sampleRate);
  buffer.getChannelData(0).set(waveform);
  const source = audioContext.createBufferSource();
  source.buffer = buffer;
  source.connect(audioContext.destination);
  source.start();

  const totalDuration = waveform.length / sampleRate;
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
}

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