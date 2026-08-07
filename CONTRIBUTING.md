# Contributing

Thanks for considering contributing! This is a small hobby project, so the
process is intentionally lightweight.

## Getting set up

```bash
npm install
npm run dev
```

You'll need two devices (or two browser windows/tabs) to actually test a
transfer — one acting as sender, one as receiver. Camera/microphone access
requires HTTPS, which the dev server already provides via a self-signed
certificate.

Before opening a PR, please run:

```bash
npm run build
```

This type-checks the whole project and produces a production build — treat
a clean build as the minimum bar for any change, since TypeScript errors
here will also break the deployed site.

## Where things live

- `shared/protocol.ts` — the wire format for QR frames. Changing this breaks
  compatibility between sender/receiver versions, so treat it carefully.
- `shared/fountain.ts` — the actual fountain (Luby Transform) coding math.
  This includes a hand-rolled deterministic log function (`dlog`) instead of
  `Math.log` — this is intentional, not leftover cruft. `Math.log` is
  implementation-defined across JS engines and can silently desync sender
  and receiver on different browsers if reintroduced here.
- `shared/envelope.ts` — wraps arbitrary files (with filename/mime metadata)
  or zip bundles into the payload that gets transferred.
- `shared/crypto.ts` — Private mode's AES-256-GCM encryption.
- `shared/audio.ts` — the ggwave audio transport wrapper. Note the
  `convertTypedArray` helper — ggwave's encode/decode functions pass data
  through typed arrays whose element type doesn't match their real meaning;
  this reinterprets the same bytes as a different typed array type rather
  than converting values. This matches ggwave's own official browser example
  exactly; don't "simplify" it without checking that example first.
- `receive/worker.ts` — QR decoding runs in a Web Worker so the camera
  capture loop never blocks on decode time.

## Reporting bugs

Please include: what device/browser you're on, what you expected vs. what
happened, and if it's a transfer failure, whether it's QR or audio, and
whether it's Public or Private mode. "It didn't work" is much harder to fix
than "on Chrome for Android, private-mode QR transfer got stuck at 80%."

## Code style

Follow what's already there — this project intentionally uses plain
TypeScript and vanilla DOM APIs rather than a UI framework, to keep the
bundle small. Please keep new code consistent with that rather than
introducing a framework dependency.
