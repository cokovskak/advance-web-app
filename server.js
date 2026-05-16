const http   = require("http");
const fs     = require("fs");
const path   = require("path");
const crypto = require("crypto");

// Load .env before anything reads process.env
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    process.env[m[1]] = v;
  }
}
loadDotEnv(path.join(__dirname, ".env"));

let webpush = null;
try {
  webpush = require("web-push");
} catch (_) {
  console.warn("[warn] 'web-push' not installed. Push will be disabled. Run: npm install");
}

const ROOT = __dirname;
const PORT = Number(process.argv[2] || process.env.PORT || 8080);
const DB_PATH = path.join(ROOT, "data", "db.json");

const INGEST_TOKEN     = process.env.INGEST_TOKEN || "";
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_SUBJECT    = process.env.VAPID_SUBJECT || "mailto:admin@example.com";

if (webpush && VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  console.log("[ok] Web Push enabled.");
} else if (webpush) {
  console.warn("[warn] VAPID keys missing. Push will not send. Run: npm run gen-keys");
}

// -------- Tiny JSON "database" (single file) --------

function loadDB() {
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
  } catch (_) {
    return { reports: [], subscriptions: [] };
  }
}
function saveDB(db) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

let DB = loadDB();
// Seed: if we have static sample files but no DB rows, import them so /api/reports works on first boot.
if (DB.reports.length === 0) {
  const dataDir = path.join(ROOT, "data");
  for (const f of fs.readdirSync(dataDir).filter(n => n.endsWith(".json") && n !== "db.json")) {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(dataDir, f), "utf8"));
      if (r && r.id) DB.reports.push(r);
    } catch (_) {}
  }
  saveDB(DB);
}

// -------- HTTP helpers --------

function sendJSON(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*"
  });
  res.end(data);
}
function send(res, code, body, type = "text/plain") {
  res.writeHead(code, { "Content-Type": type });
  res.end(body);
}
async function readJSONBody(req, max = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", c => {
      size += c.length;
      if (size > max) { req.destroy(); reject(new Error("payload too large")); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8") || "{}";
      try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}
function requireBearer(req) {
  if (!INGEST_TOKEN) return { ok: false, code: 503, msg: "INGEST_TOKEN not configured" };
  const h = req.headers.authorization || "";
  if (!h.startsWith("Bearer ")) return { ok: false, code: 401, msg: "missing bearer token" };
  const given = h.slice(7);
  const a = Buffer.from(given);
  const b = Buffer.from(INGEST_TOKEN);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, code: 403, msg: "bad token" };
  }
  return { ok: true };
}

// -------- Push --------

async function broadcastPush(payload) {
  if (!webpush || !VAPID_PUBLIC_KEY) return { sent: 0, failed: 0, skipped: "push disabled" };
  const body = JSON.stringify(payload);
  let sent = 0, failed = 0;
  const dead = [];
  await Promise.all(DB.subscriptions.map(async (sub) => {
    try {
      await webpush.sendNotification(sub, body, { TTL: 60 });
      sent++;
    } catch (err) {
      failed++;
      // 404/410 → subscription is gone; prune it.
      if (err.statusCode === 404 || err.statusCode === 410) dead.push(sub.endpoint);
    }
  }));
  if (dead.length) {
    DB.subscriptions = DB.subscriptions.filter(s => !dead.includes(s.endpoint));
    saveDB(DB);
  }
  return { sent, failed, pruned: dead.length };
}

function payloadFromReport(r) {
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of r.findings || []) {
    const s = (f.severity || "").toLowerCase();
    if (s in counts) counts[s]++;
  }
  const failed = (r.pipeline?.status || "").toLowerCase() === "failure";
  if (failed) {
    return { title: "Pipeline failed",
             body: `Run #${r.pipeline?.runNumber ?? "?"} on ${r.pipeline?.branch || "?"} — ${counts.critical} crit, ${counts.high} high`,
             tag: "critical", url: "/" };
  }
  if (counts.critical > 0) {
    return { title: "Critical vulnerability detected",
             body: `${counts.critical} critical finding${counts.critical === 1 ? "" : "s"} in run #${r.pipeline?.runNumber ?? "?"}`,
             tag: "critical", url: "/" };
  }
  return { title: "New scan completed",
           body: `Run #${r.pipeline?.runNumber ?? "?"} · ${(r.findings || []).length} findings`,
           tag: "scan", url: "/" };
}

// -------- API routes --------

async function handleApi(req, res, pathname) {
  if (pathname === "/api/health" && req.method === "GET") {
    return sendJSON(res, 200, { ok: true, reports: DB.reports.length, subscriptions: DB.subscriptions.length, pushEnabled: !!(webpush && VAPID_PUBLIC_KEY) });
  }

  if (pathname === "/api/vapid-public-key" && req.method === "GET") {
    if (!VAPID_PUBLIC_KEY) return sendJSON(res, 503, { error: "VAPID not configured" });
    return sendJSON(res, 200, { key: VAPID_PUBLIC_KEY });
  }

  if (pathname === "/api/reports" && req.method === "GET") {
    const list = [...DB.reports].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    return sendJSON(res, 200, list);
  }

  if (pathname === "/api/reports/latest" && req.method === "GET") {
    if (!DB.reports.length) return sendJSON(res, 404, { error: "no reports" });
    const latest = [...DB.reports].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))[0];
    return sendJSON(res, 200, latest);
  }

  const idMatch = pathname.match(/^\/api\/reports\/([^/]+)$/);
  if (idMatch && req.method === "GET") {
    const id = decodeURIComponent(idMatch[1]);
    if (id === "latest") return; // handled above
    const r = DB.reports.find(x => x.id === id);
    if (!r) return sendJSON(res, 404, { error: "not found" });
    return sendJSON(res, 200, r);
  }

  if (pathname === "/api/reports" && req.method === "POST") {
    const auth = requireBearer(req);
    if (!auth.ok) return sendJSON(res, auth.code, { error: auth.msg });
    let body;
    try { body = await readJSONBody(req); }
    catch (e) { return sendJSON(res, 400, { error: "invalid JSON" }); }
    if (!body || !body.id || !body.timestamp) return sendJSON(res, 400, { error: "id and timestamp required" });
    // Upsert by id
    DB.reports = DB.reports.filter(r => r.id !== body.id);
    DB.reports.push(body);
    // Cap stored reports
    DB.reports.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    DB.reports = DB.reports.slice(0, 200);
    saveDB(DB);
    const push = await broadcastPush(payloadFromReport(body));
    return sendJSON(res, 201, { ok: true, id: body.id, push });
  }

  if (pathname === "/api/subscriptions" && req.method === "POST") {
    let body;
    try { body = await readJSONBody(req); }
    catch (_) { return sendJSON(res, 400, { error: "invalid JSON" }); }
    if (!body || !body.endpoint || !body.keys?.p256dh || !body.keys?.auth) {
      return sendJSON(res, 400, { error: "invalid subscription" });
    }
    DB.subscriptions = DB.subscriptions.filter(s => s.endpoint !== body.endpoint);
    DB.subscriptions.push(body);
    saveDB(DB);
    return sendJSON(res, 201, { ok: true });
  }

  if (pathname === "/api/subscriptions" && req.method === "DELETE") {
    let body;
    try { body = await readJSONBody(req); }
    catch (_) { return sendJSON(res, 400, { error: "invalid JSON" }); }
    if (!body?.endpoint) return sendJSON(res, 400, { error: "endpoint required" });
    const before = DB.subscriptions.length;
    DB.subscriptions = DB.subscriptions.filter(s => s.endpoint !== body.endpoint);
    saveDB(DB);
    return sendJSON(res, 200, { ok: true, removed: before - DB.subscriptions.length });
  }

  if (pathname === "/api/notify" && req.method === "POST") {
    const auth = requireBearer(req);
    if (!auth.ok) return sendJSON(res, auth.code, { error: auth.msg });
    let body;
    try { body = await readJSONBody(req); }
    catch (_) { return sendJSON(res, 400, { error: "invalid JSON" }); }
    const result = await broadcastPush({
      title: body.title || "Pentest update",
      body:  body.body  || "",
      tag:   body.tag   || "pentest",
      url:   body.url   || "/"
    });
    return sendJSON(res, 200, result);
  }

  return false; // not an API route we handle
}

// -------- Static --------

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico":  "image/x-icon",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".txt":  "text/plain; charset=utf-8",
  ".yml":  "text/yaml; charset=utf-8",
  ".yaml": "text/yaml; charset=utf-8"
};

function serveStatic(req, res, pathname) {
  if (pathname === "/") pathname = "/index.html";
  const filePath = path.normalize(path.join(ROOT, pathname));
  if (!filePath.startsWith(ROOT)) return send(res, 403, "Forbidden");
  // Hide the DB file from the web.
  if (filePath === DB_PATH) return send(res, 404, "Not found");
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) return send(res, 404, "Not found");
    const ext = path.extname(filePath).toLowerCase();
    const type = MIME[ext] || "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": type,
      "Cache-Control": ext === ".html" || ext === ".js" || ext === ".webmanifest" ? "no-cache" : "public, max-age=3600",
      "Service-Worker-Allowed": "/"
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

// -------- Server --------

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  // CORS preflight (handy if PWA is served from a different origin in prod)
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,Authorization"
    });
    return res.end();
  }

  try {
    if (pathname.startsWith("/api/")) {
      const handled = await handleApi(req, res, pathname);
      if (handled === false) return sendJSON(res, 404, { error: "not found" });
      return;
    }
    return serveStatic(req, res, decodeURIComponent(pathname));
  } catch (err) {
    console.error("[err]", err);
    if (!res.headersSent) sendJSON(res, 500, { error: "internal error" });
    else res.end();
  }
});

server.listen(PORT, () => {
  console.log(`Pentest PWA + backend running on http://localhost:${PORT}`);
  console.log(`  Reports stored: ${DB.reports.length}   Push subs: ${DB.subscriptions.length}`);
  if (!INGEST_TOKEN) console.log("  [warn] INGEST_TOKEN not set — POST /api/reports will return 503");
});

