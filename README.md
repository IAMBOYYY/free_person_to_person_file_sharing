# Optical Transfer

Send files, messages, or audio between two devices using only a screen and a
camera (or a speaker and a microphone) — no Wi-Fi pairing, no Bluetooth, no
server, no account. One device displays the data as an animated stream of QR
codes (or plays it as sound); the other device's camera (or microphone)
reads it and reconstructs the original.

**Live demo:** https://free-person-to-person-file-sharing.vercel.app

## Why this works

A screen and a camera facing each other are already a data channel — this
project just makes that channel usable for real files. The interesting part
is doing that *reliably*, since a phone camera will miss frames, blur them,
or lose focus, and there's no way for the receiver to ask the sender to
resend a specific chunk.

The fix is **fountain coding** (a Luby Transform code): instead of sending
sequential chunks, every QR frame encodes the XOR of a random subset of the
file's blocks. The receiver doesn't need any *particular* frame — it just
needs roughly 15–40% more frames than the file has blocks, in any order, and
it can mathematically reconstruct the whole thing. A missed frame costs a
fraction of a second, never correctness.

## Features

- **Any file type** — images, video, documents, APKs, anything
- **Multi-file bundles** — multiple files zipped into one transfer automatically
- **Public or Private mode** — private mode encrypts with AES-256-GCM, keyed
  from a code both people agree on out of band
- **QR or audio transport** — audio uses [ggwave](https://github.com/ggerganov/ggwave)
  (FSK modulation with error correction), best for short text messages
- **Multi-QR grid** — shows several QR codes at once for faster transfers
- **Live mode** — a continuously-updating QR code or audio chirp that
  updates as you type, for quick back-and-forth messaging
- **Download / upload** — save the QR codes or audio as files instead of
  scanning live, and decode them later from an upload instead of a camera
- **Installable PWA** — works offline after first load, add-to-home-screen
  on mobile

## How it's built

Pure client-side static site — there is no backend, and no transferred data
ever touches a server. Built with Vite + TypeScript.

| Piece | Library |
|---|---|
| QR generation | [`qrcode`](https://www.npmjs.com/package/qrcode) |
| QR decoding | [`zxing-wasm`](https://www.npmjs.com/package/zxing-wasm) |
| Audio transport | [`ggwave`](https://www.npmjs.com/package/ggwave) |
| Zip bundling | [`fflate`](https://www.npmjs.com/package/fflate) |
| Encryption | native Web Crypto API (AES-256-GCM, PBKDF2) |

```
shared/     protocol, fountain coding, crypto, envelope packing, audio, live mode
send/       sender UI and logic
receive/    receiver UI, logic, and the QR-decoding worker
public/     PWA manifest, service worker, icons
```

## Getting started

```bash
git clone https://github.com/IAMBOYYY/free_person_to_person_file_sharing.git
cd free_person_to_person_file_sharing
npm install
npm run dev
```

Vite prints a local URL and a network URL. Camera and microphone access
require HTTPS, so the dev server includes a self-signed certificate — your
browser will show a one-time warning on first visit, which is expected.

```bash
npm run build      # type-checks and produces a production build in dist/
npm run preview    # serve the production build locally
```

## Deploying

This repo deploys cleanly to [Vercel](https://vercel.com) with zero
configuration — `vercel.json` is already set up to run `npm run build` and
serve `dist/`. Fork the repo, import it into Vercel, and it's live.

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for how
to get set up and what to know before opening a PR.

## Security

This is a personal/hobby project, not audited for production security use.
Private mode's encryption is implemented with standard Web Crypto primitives
(AES-256-GCM, PBKDF2), but the project has not had a formal security review.
Please open an issue for any security concerns rather than a public PR.

## License

MIT — see [LICENSE](LICENSE). This project builds on
[Decimen Optical Transfer](https://github.com/bashalarmistalt/decimen-optical-transfer),
also MIT licensed.
