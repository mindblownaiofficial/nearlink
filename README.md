# Nearlink

Private file transfers between nearby Mac and Windows computers. No cloud, no account: computers on the same local network find each other, pair once with a matching code, and then copy files directly.

## How it works

- **Discovery** uses Bonjour (mDNS) on the local network only. VPN tunnels and virtual-machine adapters are ignored.
- **Identity**: each computer creates its own certificate on first launch. Every connection is TLS 1.3 with certificates checked on both sides.
- **Pairing**: both computers show the same 16-character code, and both must approve it.
- **Sharing**: only folders you choose are visible to paired computers. Folders start read-only.
- **Transfers** are checksum-verified before a file is saved, and an existing file is never overwritten.

## Run from source

Requires Node.js 22 or newer.

```bash
npm install
npm run dev
```

`npm run dev` keeps its data in `.dev-data/`, so it does not touch an installed copy. `npm start` uses the real data folder.

## Test

```bash
npm test
```

The tests run without Electron and cover filename safety, the local-network filter, pairing codes, and a full trust, browse, send, receive and move run between two in-process computers.

## Build installers

```bash
npm run dist:mac
npm run dist:win
```

Installers are written to `dist/`. They are not signed with a developer certificate: macOS builds are ad-hoc signed, and Windows will show a SmartScreen warning.

## Layout

| Path | What it holds |
| --- | --- |
| `src/main.cjs` | Electron main process: window, IPC handlers, pairing |
| `src/preload.cjs` | The small, allow-listed bridge the UI can call |
| `src/core/` | Discovery, file server, transfers, transport, security, settings store |
| `src/ui/` | The interface: plain HTML, CSS and JavaScript under a strict content security policy |
| `test/` | Core tests |
| `build/` | App icon source and rendered icon |
| `legacy/nearlink-0.4.2/` | Source recovered from the 0.4.2 app, kept for reference |

## Data

Settings (`settings.json`) and this computer's identity (`identity.json`) are plain files in the app's data folder. Keep `identity.json` private.
