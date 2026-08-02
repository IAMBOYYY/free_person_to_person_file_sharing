// Sender: build envelope, optionally encrypt, then fountain-code QR stream.
import QRCode from "qrcode";
import { LTEncoder } from "../shared/fountain";
import { HEADER_LEN, fnv1a, packFrame, type FrameHeader } from "../shared/protocol";
import { createEnvelope } from "../shared/envelope";
import { encryptPayload } from "../shared/crypto";

const MARGIN = 4;
const LOOKAHEAD = 3;

// UI elements
const stepFiles = document.getElementById("step-files")!;
const stepMode = document.getElementById("step-mode")!;
const stepTransmit = document.getElementById("step-transmit")!;
const fileInput = document.getElementById("file-input") as HTMLInputElement;
const fileList = document.getElementById("file-list")!;
const totalSize = document.getElementById("total-size")!;
const dropzone = document.getElementById("dropzone")!;
const modePublicBtn = document.getElementById("mode-public")!;
const modePrivateBtn = document.getElementById("mode-private")!;
const codeBox = document.getElementById("code-box")!;
const accessCodeInput = document.getElementById("access-code") as HTMLInputElement;
const modeBadge = document.getElementById("mode-badge")!;
const canvas = document.getElementById("qr") as HTMLCanvasElement;
const statusHint = document.getElementById("status-hint")!;
const cancelBtn = document.getElementById("cancel-send")!;
const metric = (id: string) => document.getElementById(id)!;

// Config elements
const cfgBytes = document.getElementById("cfg-bytes") as HTMLSelectElement;
const cfgFps = document.getElementById("cfg-fps") as HTMLSelectElement;
const cfgEcc = document.getElementById("cfg-ecc") as HTMLSelectElement;
const cfgSize = document.getElementById("cfg-size") as HTMLInputElement;

let selectedFiles: File[] = [];
let mode: "public" | "private" = "public";
let generation = 0;
let encoder: LTEncoder | null = null;
let streamAborted = false;

// Populate config options (defaults: bytes 1465, fps 24, ecc L)
[500, 1000, 1465, 1850, 2331, 2953].forEach(b => {
  const opt = document.createElement("option");
  opt.value = String(b); opt.textContent = `${b} B (V${Math.ceil(b/20)})`; // rough version estimate
  if (b === 1465) opt.selected = true;
  cfgBytes.appendChild(opt);
});
[10,15,20,24,30,60].forEach(f => {
  const opt = document.createElement("option");
  opt.value = String(f); opt.textContent = String(f);
  if (f === 24) opt.selected = true;
  cfgFps.appendChild(opt);
});
["L","M","Q","H"].forEach(e => {
  const opt = document.createElement("option");
  opt.value = e; opt.textContent = e;
  if (e === "L") opt.selected = true;
  cfgEcc.appendChild(opt);
});

// File handling
dropzone.addEventListener("click", () => fileInput.click());
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
  // Show mode step if files > 0
  stepMode.style.display = selectedFiles.length ? "block" : "none";
  // Attach remove listeners
  fileList.querySelectorAll("button[data-idx]").forEach(btn => {
    btn.addEventListener("click", (e) => {
      const idx = Number((e.target as HTMLElement).dataset.idx);
      selectedFiles.splice(idx, 1);
      renderFileList();
    });
  });
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes/1024).toFixed(1)} KB`;
  return `${(bytes/1048576).toFixed(2)} MB`;
}

// Mode switching
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

// Start transmission
let sendBtn: HTMLButtonElement;
function addSendButton() {
  sendBtn = document.createElement("button");
  sendBtn.textContent = "Send";
  sendBtn.style.marginTop = "12px";
  sendBtn.addEventListener("click", startTransmission);
  stepMode.appendChild(sendBtn);
}
addSendButton();

async function startTransmission() {
  if (!selectedFiles.length) return;
  if (mode === "private") {
    const code = accessCodeInput.value.trim();
    if (code.length < 4) {
      alert("Private mode requires a code of at least 4 characters.");
      return;
    }
  }
  stepFiles.style.display = "none";
  stepMode.style.display = "none";
  stepTransmit.style.display = "flex";
  modeBadge.textContent = mode === "private" ? "Private 🔒" : "Public 🌐";
  modeBadge.className = `badge ${mode}`;

  // Build envelope
  let payload: Uint8Array;
  try {
    payload = await createEnvelope(selectedFiles);
  } catch (err) {
    statusHint.textContent = `✗ Failed to build envelope: ${err}`;
    return;
  }

  // Encrypt if private
  let flags = 0;
  if (mode === "private") {
    try {
      payload = await encryptPayload(payload, accessCodeInput.value.trim());
      flags = 1; // encrypted bit
    } catch (err) {
      statusHint.textContent = `✗ Encryption failed: ${err}`;
      return;
    }
  }

  // Setup fountain encoder
  const txFps = Number(cfgFps.value);
  const frameBytes = Number(cfgBytes.value);
  const ecc = cfgEcc.value as "L"|"M"|"Q"|"H";
  const displayPx = Number(cfgSize.value);
  const blockLen = frameBytes - HEADER_LEN;
  const sessionId = (Math.floor(Math.random() * 0xffff) + 1) & 0xffff;
  encoder = new LTEncoder(payload, blockLen, sessionId);
  const payloadFnv = fnv1a(payload);

  const header: FrameHeader = {
    sessionId,
    seq: 0,
    k: encoder.k,
    blockLen,
    totalLen: payload.length,
    payloadFnv,
    flags,
  };

  // QR streaming logic (similar to original, but with cancel support)
  streamAborted = false;
  generation++;
  const gen = generation;

  let version: number | undefined;
  let modules = 0;
  let scale = 1;
  const staging = document.createElement("canvas");
  const queue: ImageData[] = [];
  let nextSeq = 0;

  const sizeCanvas = () => {
    const dpr = window.devicePixelRatio || 1;
    const total = modules + 2 * MARGIN;
    const cssBudget = Math.min(0.9 * Math.min(window.innerWidth, window.innerHeight), displayPx);
    scale = Math.max(1, Math.floor((cssBudget * dpr) / total));
    staging.width = total;
    staging.height = total;
    canvas.width = total * scale;
    canvas.height = total * scale;
    canvas.style.width = `${(total * scale) / dpr}px`;
    canvas.style.height = `${(total * scale) / dpr}px`;
  };

  const makeFrame = (): ImageData => {
    const bytes = packFrame({ ...header, seq: nextSeq }, encoder!.encode(nextSeq));
    nextSeq++;
    const qr = QRCode.create([{ data: bytes, mode: "byte" } as any], {
      errorCorrectionLevel: ecc,
      version,
      maskPattern: 4,
    });
    if (version === undefined) {
      version = qr.version;
      modules = qr.modules.size;
      sizeCanvas();
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
    return img;
  };

  const pump = () => {
    if (gen !== generation || streamAborted) return;
    try {
      while (queue.length < LOOKAHEAD) queue.push(makeFrame());
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
    const img = queue.shift();
    if (!img) {
      nextAt = now + interval;
      return;
    }
    staging.getContext("2d")!.putImageData(img, 0, 0);
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(staging, 0, 0, canvas.width, canvas.height);
    nextAt += interval;
    if (now - nextAt > 3 * interval) nextAt = now + interval;
  };
  requestAnimationFrame(tick);

  metric("m-fps").textContent = String(txFps);
  metric("m-payload").textContent = formatSize(payload.length);
  metric("m-k").textContent = String(encoder.k);
  statusHint.textContent = "Hold steady, max brightness helps.";

  // Wake lock
  try {
    await (navigator as any).wakeLock?.request("screen");
  } catch {}
}

cancelBtn.addEventListener("click", () => {
  streamAborted = true;
  generation++;
  // Reset UI
  stepFiles.style.display = "block";
  stepMode.style.display = selectedFiles.length ? "block" : "none";
  stepTransmit.style.display = "none";
});