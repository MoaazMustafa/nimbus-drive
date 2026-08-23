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
  renderShellUpdate();
}

/* The app's own version — separate from the drive code above. "Update now"
   never touches this; it arrives via the self-updater or a new installer. */
function renderShellUpdate() {
  const su = state.app.shellUpdate || {};
  if (!$("shell-version")) return;
  $("shell-version").textContent = `v${state.app.version}`;
  const statusText =
    su.status === "downloading"
      ? `downloading ${su.version || "update"}${su.progress != null ? ` — ${su.progress}%` : ""}…`
      : su.status === "ready"
        ? `v${su.version} downloaded — restart to finish`
        : su.status === "error" && su.appOutdated
          ? `${su.latestVersion} available — automatic update failed (${su.error || "unknown error"})`
          : su.appOutdated
            ? `${su.latestVersion} available — install it to update this app`
            : "up to date · updates itself automatically";
  $("shell-status").textContent = statusText;
  $("btn-shell-restart").classList.toggle("hidden", su.status !== "ready");
  $("btn-shell-download").classList.toggle("hidden", !su.fallback);
}

if ($("btn-shell-restart")) {
  $("btn-shell-restart").addEventListener("click", async () => {
    $("btn-shell-restart").disabled = true;
    $("update-msg").textContent = "Restarting to update the app… (the drive comes back automatically)";
    const res = await nim.shellUpdateInstall();
    if (!res.ok) {
      $("btn-shell-restart").disabled = false;
      $("update-msg").textContent = res.error || "Could not restart.";
    }
  });
}
if ($("btn-shell-download")) {
  $("btn-shell-download").addEventListener("click", () => nim.openReleases());
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
  $("btn-run-update").disabled = true;
  $("update-msg").textContent = "Updating — the app will restart when finished…";
  const res = await nim.runUpdate();
  if (!res.ok) {
    $("btn-run-update").disabled = false;
    $("update-msg").textContent = res.error || "Update failed.";
  } else if (res.restarting) {
    $("update-msg").textContent = "Updated ✓ Restarting app now…";
  } else {
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

function updateTunnelUI() {
  const enabled = $("f-tunnelEnabled").checked;
  const mode = $("f-tunnelMode").value;
  $("tunnel-options").classList.toggle("hidden", !enabled);
  $("group-tunnelToken").classList.toggle("hidden", mode !== "token");
  $("group-tunnelName").classList.toggle("hidden", mode !== "named");
  const showSetup = enabled && mode === "named";
  if ($("tunnel-setup")) {
    const was = !$("tunnel-setup").classList.contains("hidden");
    $("tunnel-setup").classList.toggle("hidden", !showSetup);
    if (showSetup && !was && typeof refreshTunnelStatus === "function") refreshTunnelStatus();
  }
}

async function loadConfigIntoForm() {
  const cfg = await nim.getConfig();
  for (const k of ENV_FIELDS) $(`f-${k}`).value = cfg.env[k] ?? "";
  $("f-tunnelEnabled").checked = !!cfg.app.config.tunnelEnabled;
  $("f-tunnelMode").value = cfg.app.config.tunnelMode || "quick";
  $("f-tunnelToken").value = cfg.app.config.tunnelToken || "";
  $("f-tunnelName").value = cfg.app.config.tunnelName || "nimbus";
  $("f-cloudflaredPath").value = cfg.app.config.cloudflaredPath || "cloudflared";
  $("f-startServicesOnLaunch").checked = !!cfg.app.config.startServicesOnLaunch;
  $("f-openAtLogin").checked = !!cfg.app.config.openAtLogin;
  updateTunnelUI();
  updateRedirectUri();
}
function updateRedirectUri() {
  const base = $("f-BASE_URL").value.trim().replace(/\/+$/, "");
  const uri = base ? `${base}/api/auth/callback/google` : "—";
  $("redirect-uri").textContent = uri;
  if ($("modal-redirect-uri")) $("modal-redirect-uri").textContent = uri;
}

$("f-tunnelEnabled").addEventListener("change", updateTunnelUI);
$("f-tunnelMode").addEventListener("change", updateTunnelUI);
$("f-BASE_URL").addEventListener("input", updateRedirectUri);
$("btn-copy-uri").addEventListener("click", () => copyText($("redirect-uri").textContent));
$("link-google").addEventListener("click", () => nim.openLink("google-console"));
if ($("modal-link-google")) $("modal-link-google").addEventListener("click", () => nim.openLink("google-console"));

/* Google OAuth Help Modal */
if ($("btn-google-help")) {
  $("btn-google-help").addEventListener("click", () => {
    updateRedirectUri();
    $("modal-google-help").classList.remove("hidden");
  });
  $("btn-close-google-help").addEventListener("click", () => $("modal-google-help").classList.add("hidden"));
  $("btn-done-google-help").addEventListener("click", () => $("modal-google-help").classList.add("hidden"));
  $("btn-modal-copy-uri").addEventListener("click", () => copyText($("modal-redirect-uri").textContent));
}

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
  try {
    const env = {};
    for (const k of ENV_FIELDS) env[k] = $(`f-${k}`).value.trim();
    const res = await nim.saveConfig({
      env,
      app: {
        tunnelEnabled: $("f-tunnelEnabled").checked,
        tunnelMode: $("f-tunnelMode").value,
        tunnelToken: $("f-tunnelToken").value.trim(),
        tunnelName: $("f-tunnelName").value.trim() || "nimbus",
        cloudflaredPath: $("f-cloudflaredPath").value.trim() || "cloudflared",
        startServicesOnLaunch: $("f-startServicesOnLaunch").checked,
        openAtLogin: $("f-openAtLogin").checked,
      },
    });
    if (!res.ok) {
      $("save-status").textContent = "Error saving";
      $("form-errors").textContent = res.problems.map((p) => `• ${p.message}`).join("\n");
      $("form-errors").classList.remove("hidden");
      return;
    }
    state = res.state;
    render();
    await loadConfigIntoForm().catch(() => {});
    if (res.restartNeeded) {
      $("save-status").textContent = "Saved — restarting to apply…";
      try {
        state = await nim.restart();
        render();
        $("save-status").textContent = "Saved and applied ✓";
      } catch (err) {
        $("save-status").textContent = "Saved, restart failed: " + err.message;
      }
    } else if (!state.running && state.env.configured) {
      $("save-status").textContent = "Saved — starting your drive…";
      try {
        state = await nim.start();
        render();
        $("save-status").textContent = state.overall === "degraded" ? "Saved, but something failed — see Overview." : "Saved ✓ your drive is starting";
        switchTab("overview");
      } catch (err) {
        $("save-status").textContent = "Saved, start failed: " + err.message;
      }
    } else {
      $("save-status").textContent = "Saved ✓";
    }
    setTimeout(() => { $("save-status").textContent = ""; }, 6000);
  } catch (err) {
    $("save-status").textContent = "Save failed: " + err.message;
  } finally {
    btn.disabled = false;
  }
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

/* ── domain & sign-in verification ───────────────────── */
const VERDICT_PILL = {
  ok: ["green", "all good"],
  warn: ["yellow", "needs attention"],
  fail: ["red", "problem found"],
};
function renderVerify(report) {
  const list = $("verify-list");
  const verdict = $("verify-verdict");
  if (!list || !verdict) return;
  const [cls, label] = VERDICT_PILL[report.overall] || ["gray", report.overall];
  verdict.className = `pill ${cls}`;
  verdict.textContent = label;
  verdict.classList.remove("hidden");

  list.textContent = "";
  list.classList.remove("hidden");
  const MARK = { ok: "✓", fail: "✗", warn: "!", skip: "–" };
  for (const c of report.checks) {
    const li = document.createElement("li");
    li.className = c.status;
    const mark = document.createElement("span");
    mark.className = `mark ${c.status}`;
    mark.textContent = MARK[c.status] || "·";
    const head = document.createElement("span");
    head.className = "head";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = c.label;
    const why = document.createElement("span");
    why.className = "why";
    why.textContent = c.detail || "";
    head.append(name, why);
    li.append(mark, head);
    if (c.fix && (c.status === "fail" || c.status === "warn")) {
      const fix = document.createElement("span");
      fix.className = "fix";
      fix.textContent = c.fix;
      li.append(fix);
    }
    list.append(li);
  }
}
if ($("btn-verify")) {
  $("btn-verify").addEventListener("click", async () => {
    const btn = $("btn-verify");
    btn.disabled = true;
    btn.textContent = "Checking…";
    $("verify-verdict")?.classList.add("hidden");
    try {
      const res = await nim.verifyDomain();
      if (res.ok) renderVerify(res.report);
      else renderVerify({ overall: "fail", checks: [{ id: "err", label: "Verification", status: "fail", detail: res.error || "could not run", fix: null }] });
    } catch (err) {
      renderVerify({ overall: "fail", checks: [{ id: "err", label: "Verification", status: "fail", detail: String(err.message || err), fix: null }] });
    } finally {
      btn.disabled = false;
      btn.textContent = "Verify now";
    }
  });
}

/* ── Cloudflare tunnel setup ─────────────────────────── */
const TUNNEL_STEP_LABEL = {
  install: "Install cloudflared",
  link: "Authorize your Cloudflare account",
  tunnel: "Create the tunnel",
  dns: "Point your domain at it",
  config: "Write the tunnel configuration",
  done: "Finish",
};
const STEP_CLASS = { ok: "ok", fail: "fail", running: "warn", action: "warn" };
const STEP_MARK = { ok: "✓", fail: "✗", running: "…", action: "→" };
let tunnelSteps = [];

function renderTunnelSteps() {
  const list = $("tunnel-steps");
  if (!list) return;
  list.classList.toggle("hidden", tunnelSteps.length === 0);
  list.textContent = "";
  for (const s of tunnelSteps) {
    const cls = STEP_CLASS[s.status] || "warn";
    const li = document.createElement("li");
    li.className = cls;
    const mark = document.createElement("span");
    mark.className = `mark ${cls}`;
    mark.textContent = STEP_MARK[s.status] || "·";
    const head = document.createElement("span");
    head.className = "head";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = TUNNEL_STEP_LABEL[s.step] || s.step;
    const why = document.createElement("span");
    why.className = "why";
    why.textContent = s.detail || (s.progress != null ? `${Math.round(s.progress)}%` : "");
    head.append(name, why);
    li.append(mark, head);
    list.append(li);
  }
}
function noteTunnelStep(evt) {
  const i = tunnelSteps.findIndex((s) => s.step === evt.step);
  if (i > -1) tunnelSteps[i] = { ...tunnelSteps[i], ...evt };
  else tunnelSteps.push({ ...evt });
  renderTunnelSteps();
}
if (nim.onTunnelStep) nim.onTunnelStep(noteTunnelStep);

async function refreshTunnelStatus() {
  const pill = $("tunnel-state");
  const hint = $("tunnel-hint");
  if (!pill || !nim.tunnelStatus) return;
  pill.className = "pill gray";
  pill.textContent = "checking…";
  if (hint) hint.textContent = "";
  let res;
  try { res = await nim.tunnelStatus(); }
  catch (err) { pill.className = "pill red"; pill.textContent = "error"; if (hint) hint.textContent = String(err.message || err); return; }
  if (!res || !res.ok) {
    pill.className = "pill red";
    pill.textContent = "unavailable";
    if (hint) hint.textContent = (res && res.error) || "could not read the tunnel state";
    return;
  }
  const s = res.status;
  const [cls, label] = !s.installed ? ["yellow", "cloudflared missing"]
    : !s.linked ? ["yellow", "not signed in"]
    : !s.hasConfig ? ["yellow", "not configured"]
    : ["green", "ready"];
  pill.className = `pill ${cls}`;
  pill.textContent = label;

  const parts = [];
  parts.push(s.hostname
    ? `Domain: ${s.hostname}.`
    : "Set BASE_URL above to your domain first — the tunnel needs to know what to route.");
  if (s.linked && Array.isArray(s.tunnels)) {
    parts.push(s.tunnels.length
      ? `Tunnels on this account: ${s.tunnels.map((t) => t.name).join(", ")}.`
      : "No tunnels on this account yet.");
  }
  if (s.tunnelsError) parts.push(s.tunnelsError);
  // the case that strands people: the tunnel exists remotely, its secret does not
  if (s.match && Array.isArray(s.credentials) && !s.credentials.some((c) => c.id === s.match.id)) {
    parts.push(`"${s.match.name}" exists in your account but its credentials are not on this PC — tick “Recreate the tunnel on this PC”.`);
  }
  if (hint) hint.textContent = parts.join(" ");
}

function setTunnelBusy(busy, label) {
  for (const id of ["btn-tunnel-setup", "btn-tunnel-install", "btn-tunnel-refresh"]) {
    if ($(id)) $(id).disabled = busy;
  }
  $("btn-tunnel-cancel")?.classList.toggle("hidden", !busy);
  if ($("btn-tunnel-setup")) $("btn-tunnel-setup").textContent = busy ? (label || "Working…") : "Set up the tunnel";
}

if ($("btn-tunnel-setup")) {
  $("btn-tunnel-setup").addEventListener("click", async () => {
    tunnelSteps = [];
    renderTunnelSteps();
    setTunnelBusy(true, "Setting up…");
    try {
      const res = await nim.tunnelSetup({
        overwriteDns: $("f-tunnelOverwriteDns")?.checked || false,
        recreate: $("f-tunnelRecreate")?.checked || false,
      });
      if (!res.ok && res.needsOverwrite && $("f-tunnelOverwriteDns")) $("f-tunnelOverwriteDns").checked = false;
      if (!res.ok && res.needsRecreate && $("f-tunnelRecreate")) $("f-tunnelRecreate").checked = false;
      if (res.ok) {
        // setup implies a named tunnel — reflect what the app just decided
        if ($("f-tunnelEnabled")) $("f-tunnelEnabled").checked = true;
        if ($("f-tunnelMode")) $("f-tunnelMode").value = "named";
        updateTunnelUI();
      }
    } finally {
      setTunnelBusy(false);
      refreshTunnelStatus();
    }
  });
}
if ($("btn-tunnel-install")) {
  $("btn-tunnel-install").addEventListener("click", async () => {
    setTunnelBusy(true, "Installing…");
    try { await nim.tunnelInstall(); }
    finally { setTunnelBusy(false); refreshTunnelStatus(); }
  });
}
if ($("btn-tunnel-cancel")) {
  $("btn-tunnel-cancel").addEventListener("click", () => nim.tunnelCancel && nim.tunnelCancel());
}
if ($("btn-tunnel-refresh")) {
  $("btn-tunnel-refresh").addEventListener("click", () => refreshTunnelStatus());
}

/* ── boot ────────────────────────────────────────────── */
nim.onState((s) => {
  state = s;
  render();
});
(async () => {
  state = await nim.getState();
  render();
})();
