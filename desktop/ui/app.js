"use strict";
/* Nimbus Drive control panel — renderer. Talks to main only via window.nimbus. */

const $ = (id) => document.getElementById(id);
const nim = window.nimbus;

let state = null;
let bannerDismissed = "";
let currentLogProc = "api";
let logFollow = true;

/* ── helpers ─────────────────────────────────────────── */
function fmtUptime(ms) {
  if (!ms) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
function pillFor(status) {
  const map = {
    online: ["green", "online"],
    starting: ["yellow", "starting"],
    backoff: ["yellow", "restarting"],
    failed: ["red", "stopped — problem"],
    stopped: ["gray", "stopped"],
  };
  return map[status] || ["gray", status];
}
function setPill(el, status) {
  const [cls, label] = pillFor(status);
  el.className = `pill ${cls}`;
  el.textContent = label;
}
async function copyText(t) {
  try { await navigator.clipboard.writeText(t); } catch { /* ignore */ }
}

/* ── install / update step checklist ─────────────────── */
const STEP_LABELS = {
  find: "Find on GitHub",
  runtime: "Node runtime",
  download: "Download code",
  extract: "Unpack",
  deps: "Install components",
  build: "Build web app",
  activate: "Activate",
  cloudflared: "cloudflared",
  error: "Problem",
};
const STEP_ORDER = ["find", "runtime", "download", "extract", "deps", "build", "activate", "cloudflared", "error"];
let steps = new Map();

function resetSteps() {
  steps = new Map();
  renderSteps();
}
function noteInstallEvent(evt) {
  const cur = steps.get(evt.step) || { status: "running", detail: "", progress: null };
  if (evt.status === "log") {
    cur.detail = evt.detail;
  } else {
    cur.status = evt.status;
    if (evt.detail) cur.detail = evt.detail;
    cur.progress = evt.progress ?? (evt.status === "running" ? cur.progress : null);
  }
  steps.set(evt.step, cur);
  renderSteps();
}
function renderSteps() {
  for (const listId of ["install-steps", "update-steps"]) {
    const ul = $(listId);
    if (!ul) continue;
    ul.classList.toggle("hidden", steps.size === 0);
    ul.textContent = "";
    for (const key of STEP_ORDER) {
      const s = steps.get(key);
      if (!s) continue;
      const li = document.createElement("li");
      const st = document.createElement("span");
      st.className = `st ${s.status}`;
      st.textContent = s.status === "ok" ? "✓" : s.status === "fail" ? "✗" : "…";
      const lbl = document.createElement("span");
      lbl.className = "lbl";
      lbl.textContent = STEP_LABELS[key] || key;
      li.append(st, lbl);
      if (s.status === "running" && s.progress != null) {
        const bar = document.createElement("span");
        bar.className = "bar";
        const fill = document.createElement("i");
        fill.style.width = `${s.progress}%`;
        bar.append(fill);
        li.append(bar);
      } else {
        const det = document.createElement("span");
        det.className = "det";
        det.textContent = s.detail || "";
        det.title = s.detail || "";
        li.append(det);
      }
      ul.append(li);
    }
  }
}
nim.onInstall(noteInstallEvent);

/* ── top-level view switching ────────────────────────── */
function render() {
  if (!state) return;
  const needsWelcome = !state.app.projectRoot;
  $("view-welcome").classList.toggle("hidden", !needsWelcome);
  $("view-main").classList.toggle("hidden", needsWelcome);
  if (needsWelcome) {
    $("repo-label").textContent = state.app.repo || state.app.defaultRepo || "…";
    return;
  }

  const env = state.env || {};
  $("app-name").textContent = env.appName || "Nimbus Drive";
  document.title = env.appName || "Nimbus Drive";

  const overallMap = {
    online: ["green", "online"],
    starting: ["yellow", "starting…"],
    degraded: ["red", "problem"],
    external: ["yellow", "running elsewhere"],
    stopped: ["gray", "stopped"],
  };
  const [cls, label] = overallMap[state.overall] || ["gray", state.overall];
  $("pill-overall").className = `pill ${cls}`;
  $("pill-overall").textContent = label;

  const url = env.baseUrl && env.baseUrl.startsWith("https://") ? env.baseUrl : state.app.localUrl;
  $("public-url").textContent = url || "";
  const busy = !!state.app.install?.busy;
  $("btn-start").classList.toggle("hidden", state.running);
  $("btn-start").disabled = busy;
  $("btn-stop").classList.toggle("hidden", !state.running);
  $("btn-restart").classList.toggle("hidden", !state.running);
  $("btn-restart").disabled = busy;

  // banner precedence: hard error > rebuild needed > tunnel warning
  const needsRebuild = !!state.app.install?.needsRebuild;
  const bannerMsg =
    state.startError ||
    (needsRebuild ? "The API port in your settings changed — the web app needs a one-time rebuild to follow it." : "") ||
    state.app.tunnelWarning ||
    "";
  const showBanner = bannerMsg && bannerMsg !== bannerDismissed;
  $("banner").classList.toggle("hidden", !showBanner);
  $("banner").classList.toggle("red", !!state.startError);
  if (showBanner) {
    $("banner-text").textContent = bannerMsg;
    $("btn-takeover").classList.toggle("hidden", !state.external);
    $("btn-rebuild").classList.toggle("hidden", !(needsRebuild && !state.startError));
  }

  // first-run wizard: no .env yet → land on settings
  const configured = env.configured;
  $("setup-hello").classList.toggle("hidden", configured);
  if (!configured && !render.forcedSetup) {
    render.forcedSetup = true;
    switchTab("settings");
    loadConfigIntoForm();
  }

  renderServices();
  renderQuick();
  renderUpdates();
}

function renderServices() {
  const wrap = $("service-cards");
  const defs = [
    ["api", "API server", "The engine — files, sign-in, links"],
    ["web", "Web app", "The interface everyone opens in a browser"],
    ["tunnel", "Cloudflare Tunnel", "Makes your drive reachable from anywhere"],
  ];
  wrap.textContent = "";
  for (const [name, title, blurb] of defs) {
    const svc = state.services[name];
    const card = document.createElement("div");
    card.className = "card svc";

    const head = document.createElement("div");
    head.className = "svc-head";
    const nameEl = document.createElement("span");
    nameEl.className = "svc-name";
    nameEl.textContent = title;
    const pill = document.createElement("span");
    if (!svc) {
      pill.className = "pill gray";
      pill.textContent = name === "tunnel" ? "disabled" : "—";
    } else {
      setPill(pill, svc.status);
    }
    head.append(nameEl, pill);
    card.append(head);

    const meta = document.createElement("div");
    meta.className = "svc-meta";
    if (svc) {
      const port = name === "api" ? state.apiPort : name === "web" ? state.webPort : null;
      const lines = [
        ["Uptime", fmtUptime(svc.uptimeMs)],
        ["PID", svc.pid || "—"],
        ...(port ? [["Port", port]] : []),
        ["Restarts", svc.restarts || 0],
      ];
      for (const [k, v] of lines) {
        const div = document.createElement("div");
        const b = document.createElement("b");
        b.textContent = String(v);
        div.append(`${k}: `, b);
        meta.append(div);
      }
    } else {
      const div = document.createElement("div");
      div.textContent = blurb;
      meta.append(div);
    }
    card.append(meta);

    if (svc && svc.lastError) {
      const err = document.createElement("div");
      err.className = "svc-err";
      err.textContent = svc.lastError;
      card.append(err);
    }

    if (svc && state.running) {
      const actions = document.createElement("div");
      actions.className = "svc-actions";
      const btn = document.createElement("button");
      btn.className = "btn ghost small";
      btn.textContent = svc.status === "failed" ? "Try again" : "Restart";
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        await nim.restartOne(name);
        btn.disabled = false;
      });
      actions.append(btn);
      card.append(actions);
    }
    wrap.append(card);
  }
}

function renderQuick() {
  const env = state.env || {};
  $("qa-storage").textContent = env.storageRoot || "—";
  $("qa-admin").textContent = env.adminEmail || "—";
  const isPublic = env.baseUrl && env.baseUrl.startsWith("https://");
  $("qa-public").textContent = isPublic ? env.baseUrl : "not set up (local only)";
  const okChip = $("qa-public-ok");
  if (isPublic && state.running && state.publicOk !== null) {
    okChip.classList.remove("hidden");
    okChip.className = `chip ${state.publicOk ? "ok" : "bad"}`;
    okChip.textContent = state.publicOk ? "reachable ✓" : "not reachable";
  } else {
    okChip.classList.add("hidden");
  }
}

function renderUpdates() {
  const info = state.app.install;
  $("updates-card").classList.toggle("hidden", !info);
  if (!info) return;
  $("up-current").textContent = info.current
    ? `${info.current.version} · installed ${new Date(info.current.activatedAt || Date.now()).toLocaleDateString()}`
    : "—";
  $("up-available-row").classList.toggle("hidden", !info.update);
  if (info.update) {
    $("up-available").textContent = info.update.name || info.update.version;
    const notes = (info.update.notes || "").trim();
    $("up-notes").classList.toggle("hidden", !notes);
    $("up-notes").textContent = notes;
  } else {
    $("up-notes").classList.add("hidden");
  }
  $("up-prev-row").classList.toggle("hidden", !info.previous);
  if (info.previous) $("up-previous").textContent = info.previous.version;
  $("btn-run-update").disabled = info.busy;
  $("btn-rollback").disabled = info.busy;

  // this app (the shell) — auto-updates in the background; restart applies it
  const su = state.app.shellUpdate || {};
  $("shell-version").textContent = `v${state.app.version}`;
  const statusText =
    su.status === "downloading"
      ? `downloading update${su.progress != null ? ` ${su.progress}%` : ""}…`
      : su.status === "ready"
        ? `v${su.version} downloaded`
        : su.fallback
          ? "newer app available"
          : "up to date · updates itself automatically";
  $("shell-status").textContent = statusText;
  $("btn-shell-restart").classList.toggle("hidden", su.status !== "ready");
  $("btn-shell-download").classList.toggle("hidden", !su.fallback);
}

/* ── tabs ────────────────────────────────────────────── */
function switchTab(tab) {
  for (const btn of document.querySelectorAll(".tab")) {
    btn.classList.toggle("active", btn.dataset.tab === tab);
  }
  for (const pane of ["overview", "logs", "settings"]) {
    $(`tab-${pane}`).classList.toggle("hidden", pane !== tab);
  }
  if (tab === "settings") loadConfigIntoForm();
  if (tab === "logs") reloadLogs();
}
for (const btn of document.querySelectorAll(".tab")) {
  btn.addEventListener("click", () => switchTab(btn.dataset.tab));
}

/* ── welcome: one-click install (repo is baked in) ───── */
$("repo-change").addEventListener("click", () => {
  $("repo-row").classList.toggle("hidden");
  if (!$("repo-row").classList.contains("hidden")) $("repo-input").focus();
});
$("btn-install").addEventListener("click", async () => {
  // Empty = use the app's built-in repo; the hidden "change" field overrides.
  const repo = $("repo-row").classList.contains("hidden") ? "" : $("repo-input").value.trim();
  $("install-error").classList.add("hidden");
  $("btn-install").disabled = true;
  $("btn-install").textContent = "Installing…";
  $("repo-input").disabled = true;
  $("install-actions").classList.remove("hidden");
  resetSteps();
  const res = await nim.installFromGitHub(repo);
  $("install-actions").classList.add("hidden");
  if (!res.ok) {
    $("btn-install").disabled = false;
    $("btn-install").textContent = "Install Nimbus Drive";
    $("repo-input").disabled = false;
    $("install-error").textContent = res.error || "Install failed";
    $("install-error").classList.remove("hidden");
    return;
  }
  state = res.state;
  render();
});
$("btn-cancel-install").addEventListener("click", () => nim.cancelInstall());
$("btn-locate").addEventListener("click", async () => {
  const res = await nim.locateProject();
  if (!res.ok && res.error) {
    $("locate-error").textContent = res.error;
    $("locate-error").classList.remove("hidden");
    return;
  }
  state = await nim.getState();
  render();
});

/* ── updates card actions ────────────────────────────── */
$("btn-check-update").addEventListener("click", async () => {
  $("update-msg").textContent = "Checking…";
  const res = await nim.checkUpdate();
  if (!res.ok) $("update-msg").textContent = res.error || "Could not check.";
  else {
    state = res.state;
    render();
    $("update-msg").textContent = res.update ? "" : "You're on the newest version.";
  }
  setTimeout(() => { $("update-msg").textContent = ""; }, 6000);
});
$("btn-run-update").addEventListener("click", async () => {
  resetSteps();
  $("update-msg").textContent = "Updating — the drive will restart when it's done…";
  const res = await nim.runUpdate();
  if (!res.ok) $("update-msg").textContent = res.error || "Update failed.";
  else {
    state = res.state;
    render();
    resetSteps();
    $("update-msg").textContent = "Updated ✓";
    setTimeout(() => { $("update-msg").textContent = ""; }, 6000);
  }
});
$("btn-rollback").addEventListener("click", async () => {
  $("update-msg").textContent = "Rolling back…";
  const res = await nim.rollback();
  if (!res.ok) $("update-msg").textContent = res.error || "Rollback failed.";
  else {
    state = res.state;
    render();
    $("update-msg").textContent = "Rolled back ✓";
    setTimeout(() => { $("update-msg").textContent = ""; }, 6000);
  }
});
$("btn-shell-restart").addEventListener("click", async () => {
  $("btn-shell-restart").disabled = true;
  $("update-msg").textContent = "Restarting to update the app… (the drive comes back automatically)";
  const res = await nim.shellUpdateInstall();
  if (!res.ok) {
    $("btn-shell-restart").disabled = false;
    $("update-msg").textContent = res.error || "Could not restart.";
  }
});
$("btn-shell-download").addEventListener("click", () => nim.openReleases());
$("btn-rebuild").addEventListener("click", async () => {
  $("btn-rebuild").disabled = true;
  bannerDismissed = "";
  const res = await nim.rebuild();
  $("btn-rebuild").disabled = false;
  if (res.ok) {
    state = res.state;
    render();
  }
});

/* ── logs ────────────────────────────────────────────── */
function appendLogEntry(entry) {
  const view = $("log-view");
  const time = document.createElement("span");
  time.className = "time";
  time.textContent = new Date(entry.ts).toLocaleTimeString() + "  ";
  const line = document.createElement("span");
  if (entry.level === "error") line.className = "err";
  line.textContent = entry.line;
  view.append(time, line, "\n");
  while (view.childNodes.length > 6000) view.removeChild(view.firstChild);
  if (logFollow) view.scrollTop = view.scrollHeight;
}
async function reloadLogs() {
  const view = $("log-view");
  view.textContent = "";
  const entries = await nim.getLogs(currentLogProc, 0, $("log-filter").value.trim());
  for (const e of entries) appendLogEntry(e);
}
$("log-procs").addEventListener("click", (ev) => {
  const btn = ev.target.closest(".seg-btn");
  if (!btn) return;
  currentLogProc = btn.dataset.proc;
  for (const b of document.querySelectorAll(".seg-btn")) b.classList.toggle("active", b === btn);
  reloadLogs();
});
let filterTimer = null;
$("log-filter").addEventListener("input", () => {
  clearTimeout(filterTimer);
  filterTimer = setTimeout(reloadLogs, 250);
});
$("log-follow").addEventListener("change", (e) => { logFollow = e.target.checked; });
$("btn-log-export").addEventListener("click", () => nim.exportLogs(currentLogProc));

nim.onLog(({ proc, entry }) => {
  if (proc !== currentLogProc) return;
  if ($("tab-logs").classList.contains("hidden")) return;
  const f = $("log-filter").value.trim().toLowerCase();
  if (f && !entry.line.toLowerCase().includes(f)) return;
  appendLogEntry(entry);
});

/* ── settings ────────────────────────────────────────── */
const ENV_FIELDS = ["APP_NAME", "STORAGE_ROOT", "ADMIN_EMAIL", "BASE_URL", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"];
async function loadConfigIntoForm() {
  const cfg = await nim.getConfig();
  for (const k of ENV_FIELDS) $(`f-${k}`).value = cfg.env[k] ?? "";
  $("f-tunnelEnabled").checked = !!cfg.app.config.tunnelEnabled;
  $("f-tunnelName").value = cfg.app.config.tunnelName || "nimbus";
  $("f-cloudflaredPath").value = cfg.app.config.cloudflaredPath || "cloudflared";
  $("f-startServicesOnLaunch").checked = !!cfg.app.config.startServicesOnLaunch;
  $("f-openAtLogin").checked = !!cfg.app.config.openAtLogin;
  updateRedirectUri();
}
function updateRedirectUri() {
  const base = $("f-BASE_URL").value.trim().replace(/\/+$/, "");
  $("redirect-uri").textContent = base ? `${base}/api/auth/callback/google` : "—";
}
$("f-BASE_URL").addEventListener("input", updateRedirectUri);
$("btn-copy-uri").addEventListener("click", () => copyText($("redirect-uri").textContent));
$("link-google").addEventListener("click", () => nim.openLink("google-console"));
$("btn-pick-storage").addEventListener("click", async () => {
  const dir = await nim.pickFolder($("f-STORAGE_ROOT").value.trim() || null);
  if (dir) $("f-STORAGE_ROOT").value = dir;
});
$("btn-reveal").addEventListener("click", () => {
  const input = $("f-GOOGLE_CLIENT_SECRET");
  const hidden = input.type === "password";
  input.type = hidden ? "text" : "password";
  $("btn-reveal").textContent = hidden ? "Hide" : "Show";
});

$("btn-save").addEventListener("click", async () => {
  const btn = $("btn-save");
  btn.disabled = true;
  $("save-status").textContent = "Saving…";
  $("form-errors").classList.add("hidden");
  const env = {};
  for (const k of ENV_FIELDS) env[k] = $(`f-${k}`).value.trim();
  const res = await nim.saveConfig({
    env,
    app: {
      tunnelEnabled: $("f-tunnelEnabled").checked,
      tunnelName: $("f-tunnelName").value.trim() || "nimbus",
      cloudflaredPath: $("f-cloudflaredPath").value.trim() || "cloudflared",
      startServicesOnLaunch: $("f-startServicesOnLaunch").checked,
      openAtLogin: $("f-openAtLogin").checked,
    },
  });
  btn.disabled = false;
  if (!res.ok) {
    $("save-status").textContent = "";
    $("form-errors").textContent = res.problems.map((p) => `• ${p.message}`).join("\n");
    $("form-errors").classList.remove("hidden");
    return;
  }
  state = res.state;
  render();
  if (res.restartNeeded) {
    $("save-status").textContent = "Saved — restarting to apply…";
    state = await nim.restart();
    render();
    $("save-status").textContent = "Saved and applied ✓";
  } else if (!state.running && state.env.configured) {
    $("save-status").textContent = "Saved — starting your drive…";
    state = await nim.start();
    render();
    $("save-status").textContent = state.overall === "degraded" ? "Saved, but something failed — see Overview." : "Saved ✓ your drive is starting";
    switchTab("overview");
  } else {
    $("save-status").textContent = "Saved ✓";
  }
  setTimeout(() => { $("save-status").textContent = ""; }, 6000);
});

/* ── header actions ──────────────────────────────────── */
$("btn-start").addEventListener("click", async () => {
  $("btn-start").disabled = true;
  state = await nim.start();
  $("btn-start").disabled = false;
  render();
});
$("btn-stop").addEventListener("click", async () => {
  $("btn-stop").disabled = true;
  state = await nim.stop();
  $("btn-stop").disabled = false;
  render();
});
$("btn-restart").addEventListener("click", async () => {
  $("btn-restart").disabled = true;
  state = await nim.restart();
  $("btn-restart").disabled = false;
  render();
});
$("btn-open-drive").addEventListener("click", () => nim.openLink("drive"));
$("btn-open-storage").addEventListener("click", () => nim.openLink("storage"));
$("btn-open-logs").addEventListener("click", () => nim.openLink("logs-folder"));
$("btn-copy-url").addEventListener("click", () => copyText($("public-url").textContent));
$("btn-takeover").addEventListener("click", async () => {
  $("btn-takeover").disabled = true;
  state = await nim.takeover();
  $("btn-takeover").disabled = false;
  render();
});
$("banner-close").addEventListener("click", () => {
  bannerDismissed = $("banner-text").textContent;
  $("banner").classList.add("hidden");
});

/* ── boot ────────────────────────────────────────────── */
nim.onState((s) => {
  state = s;
  render();
});
(async () => {
  state = await nim.getState();
  render();
})();
