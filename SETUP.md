# Setting up Nimbus Drive

From zero to your own private cloud. §1–§4 get it running on your machine (~15 minutes). §5 makes it reachable from anywhere with your own domain. §6 makes it survive reboots.

---

## §1 Install & first run

1. **Install Node.js 20 or newer** — [nodejs.org](https://nodejs.org) (LTS installer). On Windows you can also use `winget install OpenJS.NodeJS.LTS`.
2. Put this project folder anywhere you like (e.g. `C:\Apps\nimbus-drive` or `~/nimbus-drive`).
3. In a terminal, inside the project folder:

   ```bash
   npm run install:all
   ```

That's every dependency for all three packages (root, server, web). Nothing else needs to be installed globally.

## §2 Create your Google sign-in keys (free, ~5 min)

Nimbus uses Google's official OAuth sign-in. You create your own credentials so login belongs to *you* — no third-party auth service.

1. Open [console.cloud.google.com](https://console.cloud.google.com) with your Google account → project picker (top-left) → **New project** → name it e.g. `nimbus-drive` → Create (and select it).
2. **Consent screen:** search for *"OAuth consent screen"* (also called *Google Auth Platform → Branding*). Choose **External**, fill in the app name and your email, and save through the steps. Under **Audience / Publishing status**, click **Publish app** (out of "Testing" mode — otherwise only manually-added test users could ever sign in; publishing needs no review for basic sign-in scopes).
3. **Credentials:** go to *Credentials* → **Create credentials → OAuth client ID** → Application type **Web application** → name it `nimbus`.
4. Under **Authorized redirect URIs**, add exactly:

   ```
   http://localhost:3000/api/auth/callback/google
   ```

   (When you go public in §5 you'll come back and add `https://YOUR-DOMAIN/api/auth/callback/google` as a second one.)
5. Create → copy the **Client ID** and **Client secret**.

> Google occasionally moves these menus, but the goal is always the same: an *OAuth 2.0 Web client* whose redirect URI is `<your base url>/api/auth/callback/google`.

## §3 Configure

```bash
npm run setup
```

The wizard asks for the storage folder (e.g. `D:\CloudDrive`), your admin email, the two Google keys, and the base URL (keep `http://localhost:3000` for now). It writes everything into a single `.env` file at the project root — the only machine-specific file. (Prefer doing it by hand? Copy `.env.example` to `.env`.)

## §4 Run it

```bash
npm run build   # one-time build of the web app (repeat after updates)
npm start       # runs the API and the web app together
```

Open **http://localhost:3000** → *Continue with Google* → sign in with your `ADMIN_EMAIL` account. You're the owner:

- **Admin → Allowlist** — add the Gmail addresses of the family/people you trust. Everyone on the list gets **full access** to the drive; tick *Admin* to also let someone manage the allowlist and see the activity log. Anyone not listed is rejected at login, even with a valid Google account.
- **Admin → Activity** — see who signed in and what everyone uploaded, downloaded, previewed or changed, with timestamps.
- **Share without an account** — open any file/folder's menu → *Get link* to create a read-only **public link** anyone can open with no sign-in (handy for people not on the drive). Manage them under **Links**.
- **Trash** — deleted items land in the Trash page; restore or purge them there.
- Paste some files into your storage folder in Explorer — watch them appear in the browser without a refresh.

For development with hot-reload use `npm run dev` instead of `build` + `start`.

## §5 Go public with Cloudflare Tunnel + your domain

A named tunnel gives you a **stable HTTPS address on your own domain** with no port-forwarding and your home IP hidden. Google OAuth needs a fixed URL, which is why the free *quick* tunnels (random URL each restart, `npm run tunnel:quick`) are only good for a one-off demo, not for real use.

**You need:** a domain (any registrar, ~$10/yr) added to a free [Cloudflare account](https://dash.cloudflare.com) (Cloudflare walks you through pointing the domain's nameservers at them).

1. **Install cloudflared**
   - Windows: `winget install Cloudflare.cloudflared`
   - macOS: `brew install cloudflared`
   - Linux: [developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
2. **Authenticate & create the tunnel**

   ```bash
   cloudflared tunnel login                       # opens browser, pick your domain
   cloudflared tunnel create nimbus              # prints the tunnel ID + credentials file path
   cloudflared tunnel route dns nimbus drive.yourdomain.com
   ```
3. **Config file:** copy `cloudflared/config.example.yml` to the `.cloudflared` folder in your user directory (`C:\Users\you\.cloudflared\config.yml` on Windows, `~/.cloudflared/config.yml` elsewhere) and fill in the tunnel ID, the credentials-file path it printed, and your hostname. It points `drive.yourdomain.com → http://localhost:3000`.
4. **Test it:**

   ```bash
   cloudflared tunnel run nimbus
   ```

   Your drive is now at `https://drive.yourdomain.com` (sign-in will fail until step 5 — that's expected).
5. **Tell Google and Nimbus about the new URL:**
   - Google Cloud Console → your OAuth client → add redirect URI `https://drive.yourdomain.com/api/auth/callback/google` (keep the localhost one too).
   - Edit `.env`: `BASE_URL=https://drive.yourdomain.com` → restart (`npm start`).
6. **Run the tunnel as a service** so it survives reboots:
   - **Windows** (as Administrator): copy `config.yml` + the tunnel's `.json` credentials file to `C:\Windows\System32\config\systemprofile\.cloudflared\`, then `cloudflared service install`.
   - **Linux:** `sudo cloudflared --config ~/.cloudflared/config.yml service install && sudo systemctl enable --now cloudflared`
   - **macOS:** `sudo cloudflared service install`

Traffic passes through Cloudflare's edge (that's what hides your IP and gives you HTTPS), but files are stored only on your machine, and every request still has to get past your Google-login + allowlist.

## §6 Start everything on boot (PM2)

PM2 keeps both processes alive (auto-restart on crash) and brings them back after a reboot — same tool on every OS:

```bash
npx pm2 start ecosystem.config.cjs   # start api + web supervised
npx pm2 save                         # remember this process list
```

Then make PM2 itself start at boot:

- **Windows:** `npm i -g pm2-windows-startup && pm2-startup install`
- **Linux / macOS:** `npx pm2 startup` → run the one command it prints → done.

Useful: `npx pm2 status`, `npx pm2 logs`, `npx pm2 restart all`. Logs land in `data/logs/`.
(Prefer not to use PM2? A shortcut to `npm start` in the Windows *Startup* folder, or a systemd unit running `npm start`, works too.)

## §7 Docker (optional)

If you'd rather run it as a container:

```bash
docker compose up -d --build
```

Set `ADMIN_EMAIL`, the Google keys, and `BASE_URL` in the environment (or point `env_file` at your `.env`), and map your real storage folder in the `volumes:` section. Note: with a bind-mounted folder on Docker Desktop (Windows/macOS), files pasted from the host may not fire live events — they still show up on refresh, or set `WATCH_POLLING=true`. Run `cloudflared` on the host or as a second container.

## §8 Moving to another machine (or reinstalling)

Everything is portable:

1. Copy the project folder (skip `node_modules` and `web/.next`), your **storage folder**, and the **`data/` folder**.
2. On the new machine: `npm run install:all`.
3. Open `.env` and fix the two paths (`STORAGE_ROOT`, `DATA_DIR`) if they changed. Windows↔Linux path styles are both fine.
4. `npm run build && npm start`.

Users, allowlist, and share links all keep working (the database stores paths relative to the storage root). **Backups** are the same two folders: storage + `data/`.

## §9 Troubleshooting

| Symptom | Fix |
|---|---|
| Google shows **redirect_uri_mismatch** | The URI in Google Console must match `<BASE_URL>/api/auth/callback/google` **exactly** (scheme, host, no trailing slash). Wait a minute after editing — Google caches. |
| Login loops back with `error=not_configured` | `GOOGLE_CLIENT_ID/SECRET` missing in `.env` — rerun `npm run setup`, restart. |
| Sign-in says *not authorized* for a friend | Add their exact Gmail address in **Admin → Allowlist** (it's matched case-insensitively). |
| Port 3000 or 4400 already in use | Change `API_PORT` in `.env`; for the web port run `npm start` with `PORT=3100` set, and update `BASE_URL` + Google URIs accordingly. |
| Files pasted on a **NAS / network drive** don't appear live | Set `WATCH_POLLING=true` in `.env`. They always appear on refresh regardless — listings read the real disk. |
| `https://…` shows Cloudflare error 502 | The tunnel is up but the app isn't — start the app (`npm start` / `pm2 status`). |
| Thumbnails missing for some images | Fine — corrupt/unsupported images fall back to an icon. Everything else still works. |
| Want to verify everything after an update | `npm run test:e2e` — ~50 automated checks against a mock Google, no real account needed. |

## §10 For development

`npm run dev` = hot-reload on both apps. `scripts/dev/mock-google.mjs` fakes Google's OAuth endpoints so you can develop login flows offline: point `GOOGLE_AUTHORIZE_URL/TOKEN_URL/USERINFO_URL` in `.env` at `http://127.0.0.1:5599/...` (see `scripts/dev/e2e.mjs` for the exact values), run `npm run mock:google`, and any email you put in the authorize URL's `login_hint` becomes the signed-in user. **Never** set those overrides in production — leaving them unset means the server talks only to the real Google.
