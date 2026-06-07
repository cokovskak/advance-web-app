const DB_NAME = "pentest-db";
const DB_VERSION = 1;
const STORE_REPORTS = "reports";
// Try the API first, fall back to the static file so the PWA still works without a backend.
const LATEST_URLS = ["/api/reports/latest", "data/latest.json"];

let currentFilter = "all";
let currentReport = null;
let deferredInstallPrompt = null;

// -------- IndexedDB --------

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_REPORTS)) {
        const store = db.createObjectStore(STORE_REPORTS, { keyPath: "id" });
        store.createIndex("timestamp", "timestamp");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(report) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_REPORTS, "readwrite");
    tx.objectStore(STORE_REPORTS).put(report);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbAll() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_REPORTS, "readonly");
    const req = tx.objectStore(STORE_REPORTS).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_REPORTS, "readonly");
    const req = tx.objectStore(STORE_REPORTS).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

// -------- Service worker --------

async function registerSW() {
  if (!("serviceWorker" in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.register("sw.js");
    // Listen for messages from SW (e.g. push delivered while page open)
    navigator.serviceWorker.addEventListener("message", (e) => {
      if (e.data?.type === "push-received") {
        toast(`Push: ${e.data.payload?.title || "New event"}`);
        loadAndRender({ preferNetwork: true });
      }
    });
    return reg;
  } catch (err) {
    console.warn("SW registration failed:", err);
  }
}

// -------- Network + offline data --------

async function tryFetchLatest() {
  for (const u of LATEST_URLS) {
    try {
      const res = await fetch(u, { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        if (data && data.id) return data;
      }
    } catch (_) { /* try next */ }
  }
  return null;
}

async function fetchLatestReport({ preferNetwork = false } = {}) {
  if (preferNetwork || navigator.onLine) {
    const data = await tryFetchLatest();
    if (data) {
      await idbPut(data);
      // Best-effort: also pull recent history from the API so the History list mirrors the server.
      backfillHistoryFromApi();
      return { report: data, source: "network" };
    }
  }
  const all = await idbAll();
  if (all.length) {
    all.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    return { report: all[0], source: "offline" };
  }
  const data = await tryFetchLatest();
  if (data) {
    await idbPut(data);
    return { report: data, source: "network" };
  }
  return { report: null, source: "none" };
}

async function backfillHistoryFromApi() {
  try {
    const res = await fetch("/api/reports", { cache: "no-store" });
    if (!res.ok) return;
    const list = await res.json();
    if (!Array.isArray(list)) return;
    for (const r of list) if (r && r.id) await idbPut(r);
    await renderHistory();
  } catch (_) { /* best effort */ }
}

// -------- Rendering --------

const $ = (sel) => document.querySelector(sel);

function setText(sel, value) {
  const el = $(sel);
  if (el) el.textContent = value;
}

function fmtTime(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  return d.toLocaleString();
}

function renderSummary(report, source) {
  // Prefer the authoritative per-severity totals from the report (the
  // pipeline may have truncated the findings array to fit the backend's
  // body cap). Fall back to counting findings for older reports that
  // don't include totalsBySeverity.
  const totals = report.totalsBySeverity || null;
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  if (totals) {
    counts.critical = totals.critical || 0;
    counts.high     = totals.high     || 0;
    counts.medium   = totals.medium   || 0;
    counts.low      = totals.low      || 0;
  } else {
    for (const f of report.findings || []) {
      const sev = (f.severity || "").toLowerCase();
      if (sev in counts) counts[sev]++;
    }
  }
  setText("#kpiCrit", counts.critical);
  setText("#kpiHigh", counts.high);
  setText("#kpiMed",  counts.medium);
  setText("#kpiLow",  counts.low);

  const pipeEl = $("#kpiPipe");
  const status = (report.pipeline?.status || "unknown").toLowerCase();
  pipeEl.textContent = status === "success" ? "PASS" : status === "failure" ? "FAIL" : status.toUpperCase();
  pipeEl.className = status === "success" ? "ok" : status === "failure" ? "fail" : "";
  setText("#kpiPipeMeta",
    `${report.pipeline?.workflow || "workflow"} · #${report.pipeline?.runNumber ?? "?"}`);

  const tag = source === "offline" ? " · cached (offline)" : "";
  setText("#lastSyncLabel", `Updated ${fmtTime(report.timestamp)}${tag}`);
}

function renderStages(report) {
  const stages = report.stages || [];
  setText("#stagesMeta", `${stages.length} tools`);
  const root = $("#stages");
  root.innerHTML = "";
  for (const s of stages) {
    const ok = (s.status || "").toLowerCase() === "success";
    const el = document.createElement("article");
    el.className = "stage";
    el.innerHTML = `
      <div>
        <h3>${escapeHtml(s.name)}</h3>
        <div class="meta">${s.findings ?? 0} finding${(s.findings ?? 0) === 1 ? "" : "s"} · ${fmtDuration(s.durationMs)}</div>
      </div>
      <span class="status ${ok ? "ok" : "fail"}">${ok ? "PASS" : "FAIL"}</span>
    `;
    root.appendChild(el);
  }
}

// Tracks "Load more" state per tool so re-renders preserve user expansion.
const PAGE_SIZE = 15;
let toolPageState = {};

function renderFindings(report) {
  const list = $("#findings");
  const empty = $("#findingsEmpty");
  list.innerHTML = "";

  const filtered = (report.findings || []).filter(f =>
    currentFilter === "all" ? true : (f.severity || "").toLowerCase() === currentFilter
  );

  if (!filtered.length) {
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");

  // Truncation note (pipeline capped findings to fit backend body limit)
  if (report.findingsTruncated && currentFilter === "all") {
    const note = document.createElement("li");
    note.className = "finding truncated-note";
    note.innerHTML = `
      <div class="sev">info</div>
      <div>
        <div class="title">Showing ${(report.findings || []).length} of ${report.findingsTotal} findings</div>
        <div class="desc">Lower-severity findings were capped to fit the report under the backend's body limit. Full set available in the workflow run's artifact bundle.</div>
      </div>
      <span class="tool">pipeline</span>
    `;
    list.appendChild(note);
  }

  // Group by tool, sort each group by severity
  const sevOrder = { critical: 0, high: 1, medium: 2, low: 3 };
  const byTool = new Map();
  for (const f of filtered) {
    const tool = f.tool || "unknown";
    if (!byTool.has(tool)) byTool.set(tool, []);
    byTool.get(tool).push(f);
  }
  for (const arr of byTool.values()) {
    arr.sort((a, b) => (sevOrder[a.severity?.toLowerCase()] ?? 9) - (sevOrder[b.severity?.toLowerCase()] ?? 9));
  }

  // Display order: most findings first (Trivy tends to dominate; user can
  // collapse it). Within each group, severity-sorted.
  const toolOrder = ["OWASP ZAP", "Trivy", "Nmap", "Nikto"];
  const tools = [...byTool.keys()].sort((a, b) => {
    const ai = toolOrder.indexOf(a), bi = toolOrder.indexOf(b);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });

  for (const tool of tools) {
    const items = byTool.get(tool);
    const pageKey = `${tool}|${currentFilter}`;
    const shown = toolPageState[pageKey] || PAGE_SIZE;

    // Group header (collapsible)
    const group = document.createElement("li");
    group.className = "tool-group";
    const collapsed = group.dataset.collapsed === "true";
    group.innerHTML = `
      <button class="tool-group-head" type="button" aria-expanded="true">
        <span class="caret">▾</span>
        <span class="tool-name">${escapeHtml(tool)}</span>
        <span class="tool-count">${items.length} finding${items.length === 1 ? "" : "s"}</span>
      </button>
      <ul class="tool-findings"></ul>
    `;
    const headBtn = group.querySelector(".tool-group-head");
    const sublist = group.querySelector(".tool-findings");

    const renderRows = () => {
      sublist.innerHTML = "";
      const visible = items.slice(0, shown);
      for (const f of visible) {
        const sev = (f.severity || "low").toLowerCase();
        const li = document.createElement("li");
        li.className = `finding ${sev}`;
        li.innerHTML = `
          <div class="sev">${sev}</div>
          <div>
            <div class="title">${escapeHtml(f.title || "Untitled finding")}</div>
            <div class="desc">${escapeHtml(f.description || "")}${f.target ? ` · <span class="muted">${escapeHtml(f.target)}</span>` : ""}</div>
          </div>
          <span class="tool">${escapeHtml(f.tool || "unknown")}</span>
        `;
        sublist.appendChild(li);
      }
      if (items.length > visible.length) {
        const more = document.createElement("li");
        more.className = "load-more";
        more.innerHTML = `<button type="button">Load ${Math.min(PAGE_SIZE, items.length - visible.length)} more · ${items.length - visible.length} remaining</button>`;
        more.querySelector("button").addEventListener("click", () => {
          toolPageState[pageKey] = (toolPageState[pageKey] || PAGE_SIZE) + PAGE_SIZE;
          renderRows();
        });
        sublist.appendChild(more);
      }
    };
    renderRows();

    headBtn.addEventListener("click", () => {
      const isCollapsed = group.classList.toggle("collapsed");
      headBtn.setAttribute("aria-expanded", String(!isCollapsed));
      headBtn.querySelector(".caret").textContent = isCollapsed ? "▸" : "▾";
    });

    list.appendChild(group);
  }
}

async function renderHistory() {
  const all = await idbAll();
  all.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  const root = $("#history");
  root.innerHTML = "";
  if (!all.length) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="muted small">No reports stored yet.</span>`;
    root.appendChild(li);
    return;
  }
  for (const r of all.slice(0, 20)) {
    const status = (r.pipeline?.status || "unknown").toLowerCase();
    const li = document.createElement("li");
    li.title = "Load this report";
    li.innerHTML = `
      <div>
        <div>${escapeHtml(r.pipeline?.workflow || "workflow")} · <span class="id">${escapeHtml(r.id)}</span></div>
        <div class="muted small">${fmtTime(r.timestamp)}</div>
      </div>
      <span class="badge-status ${status === "success" ? "ok" : "fail"}">
        ${status === "success" ? "PASS" : "FAIL"}
      </span>
    `;
    li.addEventListener("click", async () => {
      const full = await idbGet(r.id);
      if (full) {
        currentReport = full;
        renderAll(full, "offline");
        toast(`Loaded ${full.id}`);
      }
    });
    root.appendChild(li);
  }
}

function renderAll(report, source) {
  renderSummary(report, source);
  renderStages(report);
  renderFindings(report);
}

// -------- Helpers --------

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

function fmtDuration(ms) {
  if (!ms && ms !== 0) return "—";
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return `${m}m ${rs}s`;
}

let toastTimer = null;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
}

// -------- Online/offline indicator --------

function setNetStatus() {
  const el = $("#netStatus");
  const online = navigator.onLine;
  el.classList.toggle("offline", !online);
  el.querySelector(".label").textContent = online ? "online" : "offline";
}

// -------- Install prompt (beforeinstallprompt) --------

function wireInstallPrompt() {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    $("#installBtn").classList.remove("hidden");
  });
  $("#installBtn").addEventListener("click", async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    const { outcome } = await deferredInstallPrompt.userChoice;
    if (outcome === "accepted") toast("App installed");
    deferredInstallPrompt = null;
    $("#installBtn").classList.add("hidden");
  });
  window.addEventListener("appinstalled", () => {
    toast("Installed to home screen");
    $("#installBtn").classList.add("hidden");
  });
}

// -------- Notifications + simulated push --------

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function subscribeToPush() {
  const reg = await navigator.serviceWorker.ready;
  if (!reg || !("pushManager" in reg)) {
    toast("Push API not supported");
    return false;
  }
  // Fetch VAPID public key from backend.
  let key;
  try {
    const res = await fetch("/api/vapid-public-key");
    if (!res.ok) throw new Error("vapid endpoint not available");
    key = (await res.json()).key;
  } catch (_) {
    toast("Backend offline — push not configured");
    return false;
  }
  if (!key) { toast("VAPID key missing on server"); return false; }

  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(key)
    });
  }
  // Send subscription to backend.
  try {
    await fetch("/api/subscriptions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sub)
    });
    toast("Subscribed to push");
    return true;
  } catch (_) {
    toast("Couldn't register subscription");
    return false;
  }
}

async function requestNotifyPermission() {
  if (!("Notification" in window)) { toast("Notifications unsupported"); return; }
  let perm = Notification.permission;
  if (perm !== "granted") perm = await Notification.requestPermission();
  if (perm !== "granted") { toast(`Notifications: ${perm}`); return; }
  await subscribeToPush();
}

// -------- Init --------

async function loadAndRender({ preferNetwork = false } = {}) {
  const { report, source } = await fetchLatestReport({ preferNetwork });
  if (!report) {
    setText("#lastSyncLabel", "No data available");
    return;
  }
  currentReport = report;
  renderAll(report, source);
  await renderHistory();
}

document.addEventListener("DOMContentLoaded", async () => {
  setNetStatus();
  window.addEventListener("online",  () => { setNetStatus(); toast("Back online"); loadAndRender({ preferNetwork: true }); });
  window.addEventListener("offline", () => { setNetStatus(); toast("Offline — showing cached"); });
  // Reload data when the tab becomes visible (e.g. user clicks a push notification).
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) loadAndRender({ preferNetwork: true });
  });

  wireInstallPrompt();

  $("#refreshBtn").addEventListener("click", () => loadAndRender({ preferNetwork: true }));
  $("#notifyBtn").addEventListener("click", requestNotifyPermission);

  for (const chip of document.querySelectorAll(".chip")) {
    chip.addEventListener("click", () => {
      document.querySelectorAll(".chip").forEach(c => c.classList.remove("active"));
      chip.classList.add("active");
      currentFilter = chip.dataset.filter;
      toolPageState = {}; // reset paging when severity filter changes
      if (currentReport) renderFindings(currentReport);
    });
  }

  await registerSW();
  await loadAndRender();
});
