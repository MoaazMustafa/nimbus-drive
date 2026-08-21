# ☁️ Nimbus Drive

Your own Google-Drive-style cloud — running on **your** computer, storing files on **your** disk, reachable from anywhere through a Cloudflare Tunnel, with **Google sign-in for exactly the people you allow**. No hosting bills, no third-party storage, no public files. Rename it to anything you like via `APP_NAME`.

![Drive](screenshots/03-photos-grid.png)

## What it does

- **Files live on your disk.** The app serves a normal folder (`STORAGE_ROOT`). Paste files into it in Explorer/Finder and they appear in the web UI within seconds (file-watcher + live refresh) — and anything uploaded through the browser is just a normal file in that folder.
- **Google sign-in only, allowlist only.** There are no passwords. Sign-in goes through Google OAuth, and after Google says who the person is, they must also be on *your* allowlist (managed in the Admin page) or they're turned away. Removing someone signs them out everywhere instantly.
- **Nothing opens without authorization** — Google-Photos style. Every byte (files, previews, even thumbnails) streams through an access-checked API. There are no public URLs; a leaked link is useless without an authorized login.
- **Drive-like UI.** Folder browsing, drag-and-drop uploads with progress, grid/list views, image thumbnails, previews (images, video with seeking, audio, PDF, text), rename, move, zip-download for folders, search, dark mode.
- **Sharing, both ways.** Share any file or folder by copyable link: *"anyone authorized with the link"* or *"specific people only"*. Recipients see items in **Shared with me**; you manage everything in **My links**. Deleting a file kills its links; renaming keeps them working.
- **Two drive modes** (Admin toggle): *admin-only* — guests see only what's shared with them (default), or *everyone* — all allowlisted users browse and manage the whole drive together.
- **Runs on any machine.** Windows, macOS, Linux, or Docker. One `.env` file holds everything machine-specific. Deleted files go to a trash folder, not oblivion.

## The stack

Next.js (App Router) + HeroUI + Tailwind for the frontend · Express 5 + SQLite (better-sqlite3) + chokidar + sharp for the backend · Cloudflare Tunnel to go public without opening ports or renting a server.

```
┌─────────────┐     https      ┌────────────┐  proxy   ┌─────────────┐
│  any device │ ─────────────▶ │  Next.js   │ ───────▶ │ Express API │
│  (browser)  │  Cloudflare    │  web  :3000│  /api/*  │  :4400      │
└─────────────┘    Tunnel      └────────────┘          │  ├ SQLite   │
                                                       │  ├ watcher  │
                                    your PC ──────────▶│  └ STORAGE_ │
                                 (paste files in)      │     ROOT 📁 │
                                                       └─────────────┘
```

## Quick start (local)

```bash
npm run install:all   # installs root + server + web dependencies
npm run setup         # interactive wizard → writes .env  (needs Google OAuth keys, see SETUP.md §2)
npm run build         # builds the web app once
npm start             # runs API + web  →  http://localhost:3000
```

Sign in with the Google account you set as `ADMIN_EMAIL` — you're the owner. Add everyone else in **Admin → Allowlist**.

**[SETUP.md](SETUP.md)** has the full walkthrough: creating the Google OAuth keys, going public with a Cloudflare Tunnel + your domain, auto-start on boot, Docker, moving machines, troubleshooting.

## Project layout

```
nimbus-drive/
├─ .env                 ← the only machine-specific file (create with `npm run setup`)
├─ server/              ← Express API: auth, files, shares, admin, watcher
├─ web/                 ← Next.js app: the Drive UI
├─ scripts/setup.mjs    ← interactive .env wizard
├─ scripts/dev/         ← mock Google + full e2e test suite (`npm run test:e2e`)
├─ cloudflared/         ← tunnel config template
├─ ecosystem.config.cjs ← PM2: keep it running / start on boot
├─ Dockerfile + docker-compose.yml
├─ storage/             ← your files (default; move it anywhere via .env)
└─ data/                ← SQLite DB, thumbnail cache, trash
```

## Good to know

- **Trash, not delete.** Deleting in the UI moves things to `data/trash` (timestamped). Empty it whenever you like — or set `TRASH_ENABLED=false` for hard deletes.
- **Backups** = copy two folders: your storage folder and `data/`. That's the whole state.
- **Offline behavior:** on your LAN everything keeps working except *new* Google sign-ins (existing sessions live `SESSION_TTL_DAYS`). The public URL needs the tunnel up.
- **Self-check:** `npm run test:e2e` boots the whole backend against a mock Google and runs ~50 checks (auth, sharing, security, watcher) in under 30 seconds. Run it after any change.
