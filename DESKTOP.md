# Nimbus Drive Desktop

One app that installs, runs, updates, and watches your self-hosted drive —
**no terminal, ever**. A new PC needs exactly one download: the
`Nimbus Drive Setup.exe` from your GitHub Releases page. The app does the rest:

```
Setup.exe  →  fetch code from GitHub  →  private Node runtime  →  install
           →  build  →  setup wizard (storage, Google keys)  →  drive online
```

## For a brand-new PC (the family story)

1. Download **Nimbus Drive Setup.exe** from the repo's **Releases** page and run
   it. (Unsigned build → SmartScreen shows "Windows protected your PC" once:
   click *More info → Run anyway*.)
2. The app opens on a welcome screen. Type the repo (e.g. `yourname/nimbus-drive`)
   and press **Install**. It then, with a visible checklist and progress:
   - downloads its own private Node runtime (~30 MB — nothing to pre-install),
   - downloads the latest **Release** of the code,
   - installs components and builds the web app,
   - activates the version (kept in the app's own folder — never OneDrive).
3. The setup wizard asks for: storage folder (native picker), owner Google
   email, the two Google OAuth keys, base URL. It shows the exact **redirect
   URI** to paste into Google Console, with a copy button.
4. Done — the drive starts, with live status pills. Optional toggles: start at
   Windows sign-in (tray), run the Cloudflare Tunnel (the app downloads
   `cloudflared` itself when you enable it).

**Updates:** the app checks your GitHub Releases on launch and daily. When you
publish a new release it shows a notification and an **Update now** button
(release notes included). Updates install side-by-side and only activate after
the build fully succeeds — a failed update can never break the running version,
and **Roll back** returns to the previous one in one click.

## For this PC (where the code already lives)

`npm run desktop:install` once, then `npm run desktop` — choose **"Locate my
nimbus-drive folder"** on the welcome screen. Same control panel, but it
supervises your checkout directly and updates stay manual (`git pull` +
`npm run build` + Restart), which is what you want on a dev machine.

## What the control panel does (both modes)

- **Start / Stop / Restart** with live pills for API, Web, and Tunnel; per-service restart.
- **Crash auto-restart** with backoff; 5 crashes in 60 s → stops looping, tells
  you why, desktop notification.
- **Port auto-healing** for the web port (tunnel follows via `--url`); a
  foreign program on the API port produces a clear explanation instead of a
  silent half-broken state — and if you change `API_PORT`, the app offers the
  required one-click **Rebuild & restart**.
- **Take-over** of a Nimbus already running outside the app (old auto-start scripts).
- **Live logs** (API / Web / Tunnel / App), filter + export; files in `data/logs/`.
- **Public reachability check** of your `https://` address every minute, with a
  notification when the drive stops being reachable from the internet.
- **OAuth helper**: always shows the redirect URI for the current BASE_URL and
  warns when the tunnel hostname and BASE_URL disagree.
- Tray + optional autostart at Windows sign-in; quitting the app stops the drive.

## Publishing (you, once per release)

First time:
1. Create a **public** GitHub repo and push this project.
   `.gitignore` already keeps out: `.env` (your Google keys), `data/`,
   `storage/`, `cloudflared/config.yml` + `cert.pem` (your tunnel identity),
   `node_modules`, builds.
2. Push a version tag — that's the whole release ritual:
   ```bash
   git tag v1.0.0
   git push origin v1.0.0
   ```
   The included GitHub Actions workflow (`.github/workflows/release.yml`) runs
   the test suites, builds `Nimbus Drive Setup.exe` on a Windows runner, and
   attaches it to the release automatically. Your machine builds nothing.
3. Send the family the Releases link.

Next releases: commit, tag, push the tag. Users click **Update now**.

## Honest notes

- **Tunnel first-time setup is still manual on the HOST PC** (one time):
  `cloudflared tunnel login` / `create` / `route dns` per SETUP.md §5. The app
  downloads the binary and runs the tunnel afterwards. Family members' PCs need
  none of this — only the machine that hosts the files.
- **Autostart runs at Windows sign-in**, not before login. For a reboot-prone
  host PC, enable Windows auto-login or ask for the service-mode version later.
- **The installer is unsigned** unless you add a code-signing certificate —
  expect the one-time SmartScreen prompt. (Azure Trusted Signing is the
  affordable route if it starts to matter.)
- **Install-from-source, but safely**: dependency installs use npm's bundled
  prebuilt binaries (no compiler needed) — the app deliberately installs
  without lockfiles because lockfile installs falsely trigger from-source C++
  builds of `better-sqlite3` (verified). Versions are pinned by the release tag.
- Config lives in one `.env` (bootstrap mode keeps the master copy in the app's
  config folder and stamps it into each installed version — settings survive
  updates and rollbacks). Storage + `data/` are outside the versioned folders,
  so files, users, links, and activity history all survive updates too.
- Tests: `npm run test:e2e` (server), `npm run test:desktop` (supervision core),
  `node scripts/dev/bootstrap-test.mjs` (full install pipeline against a mock
  GitHub — download → deps → build → activate → boot → rollback).
