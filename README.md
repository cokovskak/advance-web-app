# Pentest Pipeline Dashboard — PWA

A Progressive Web App that receives penetration test results from a GitHub Actions pipeline, displays them in a security dashboard, sends push notifications on critical findings, and works fully offline.

---

## Architecture

```
┌─────────────────────────────┐        ┌──────────────────────────────┐
│   security-reports repo     │        │   advance-web-app (backend)  │
│                             │        │                              │
│  .github/workflows/         │  POST  │  Node.js HTTP server         │
│    send-report.yml  ────────┼───────►│  /api/reports                │
│                             │        │       │                      │
│  reports/                   │        │       ▼                      │
│    scan-critical.json       │        │  data/db.json  (storage)     │
│    scan-medium.json         │        │       │                      │
│    scan-clean.json          │        │       ▼                      │
└─────────────────────────────┘        │  Web Push API                │
                                       │       │                      │
                                       └───────┼──────────────────────┘
                                               │
                                               ▼
                                   ┌────────────────────────┐
                                   │   Browser / PWA        │
                                   │                        │
                                   │  Push notification     │
                                   │  Dashboard refresh     │
                                   │  Offline cache (SW)    │
                                   │  IndexedDB history     │
                                   └────────────────────────┘
```

---

## PWA Features

| Feature | Implementation |
|---|---|
| Installable | `manifest.webmanifest` — name, icons, `display: standalone` |
| Offline support | Service worker caches app shell; IndexedDB stores all reports |
| Push notifications | Web Push API with VAPID keys; `web-push` npm package on backend |
| Background sync | Service worker intercepts fetches; network-first for API, cache-first for shell |
| Responsive design | CSS Grid |
| Install prompt | `beforeinstallprompt` event captured and surfaced as an Install button |

---

## Project Structure

```
advance-web-app/
├── index.html              # App shell — dashboard layout
├── styles.css              # Responsive dark UI
├── app.js                  # IndexedDB, fetch, render, push subscribe
├── sw.js                   # Service worker — cache + push handler
├── manifest.webmanifest    # PWA manifest
├── server.js               # Backend — static files + REST API + Web Push
├── start.ps1               # Convenience script: starts backend + ngrok
├── package.json
├── scripts/
│   └── generate-vapid.js   # One-time VAPID key generator
├── icons/
│   ├── icon.svg
│   └── icon-maskable.svg
└── data/
    ├── db.json             # Runtime storage (git-ignored)
    ├── latest.json         # Seed report
    ├── report-2026-05-08.json
    └── report-2026-05-12.json
```

---

## Report JSON Schema

Every report POSTed to the backend must follow this shape:

```jsonc
{
  "id": "run-2026-05-16-42",          // unique — used as upsert key
  "timestamp": 1747389600000,          // unix milliseconds
  "pipeline": {
    "workflow": "send-report.yml",
    "runNumber": 42,
    "commit": "a1b2c3d",
    "branch": "main",
    "status": "failure"                // "success" | "failure"
  },
  "target": "https://staging.example.com",
  "stages": [
    { "name": "Nmap",      "status": "success", "findings": 3, "durationMs": 41200 },
    { "name": "OWASP ZAP", "status": "failure", "findings": 5, "durationMs": 318400 },
    { "name": "Trivy",     "status": "success", "findings": 2, "durationMs": 61200 },
    { "name": "Nikto",     "status": "success", "findings": 2, "durationMs": 98800 }
  ],
  "findings": [
    {
      "tool": "OWASP ZAP",
      "severity": "critical",          // "critical" | "high" | "medium" | "low"
      "title": "SQL Injection on /api/login",
      "description": "POST parameter 'username' is vulnerable.",
      "target": "POST /api/login"
    }
  ]
}
```

---

## Prerequisites

- [Node.js](https://nodejs.org) 18+
- [ngrok](https://ngrok.com) (for exposing the backend publicly)
- A GitHub account (for the CI pipeline)

---

## First-Time Setup

### 1. Install dependencies
```powershell
cd advance-web-app
npm install
```

### 2. Generate VAPID keys
```powershell
npm run gen-keys
```
Copy the three lines it prints into a new `.env` file:
```
VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
VAPID_SUBJECT=mailto:you@example.com
```

### 3. Generate an ingest token
```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```
Add it to `.env`:
```
INGEST_TOKEN=paste-token-here
```

### 4. Set up ngrok
```powershell
ngrok config add-authtoken YOUR_NGROK_TOKEN
```
Get a free static domain at [dashboard.ngrok.com/domains](https://dashboard.ngrok.com/domains).

---

## Running

### Start everything
```powershell
# Terminal 1 — backend
npm start

# Terminal 2 — public tunnel
ngrok http --domain=your-domain.ngrok-free.app 8080
```

Or use the script:
```powershell
.\start.ps1 -Domain your-domain.ngrok-free.app
```

### Open the dashboard
```
http://localhost:8080
```

### Enable push notifications
Click **🔔 Notify** in the top bar and allow the permission prompt.

---

## API Reference

All endpoints are served on the same port as the static files.

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/health` | — | Server status, report count, push enabled |
| GET | `/api/vapid-public-key` | — | VAPID public key for push subscription |
| GET | `/api/reports` | — | All stored reports, newest first |
| GET | `/api/reports/latest` | — | Most recent report |
| GET | `/api/reports/:id` | — | Report by ID |
| POST | `/api/reports` | Bearer token | Ingest a new report; triggers push |
| POST | `/api/subscriptions` | — | Register a browser push subscription |
| DELETE | `/api/subscriptions` | — | Unsubscribe |
| POST | `/api/notify` | Bearer token | Broadcast a custom push message |

### Sending a report manually
```powershell
$token = "your-ingest-token"
Invoke-RestMethod -Uri "http://localhost:8080/api/reports" -Method POST `
  -Headers @{ Authorization = "Bearer $token" } `
  -ContentType "application/json" `
  -InFile "data/latest.json"
```

### Sending a test push
```powershell
$token = "your-ingest-token"
Invoke-RestMethod -Uri "http://localhost:8080/api/notify" -Method POST `
  -Headers @{ Authorization = "Bearer $token" } `
  -ContentType "application/json" `
  -Body '{"title":"Test","body":"Push working","tag":"critical"}'
```

---

## GitHub Actions Integration

See the [security-reports](https://github.com/cokovskak/security-reports) repository.

Required GitHub secrets on that repo:

| Secret | Value |
|---|---|
| `BACKEND_URL` | `https://your-domain.ngrok-free.app` |
| `INGEST_TOKEN` | Token from your `.env` |

Triggering a run: **Actions → Send Pentest Report → Run workflow → pick report type**.

---

## Offline Behaviour

| Scenario | Behaviour |
|---|---|
| Online | Fetches latest report from `/api/reports/latest` |
| API unreachable | Falls back to `data/latest.json` static file |
| Fully offline | Serves app shell from Cache API; renders last report from IndexedDB |
| Back online | Automatically re-fetches and updates the dashboard |

The service worker caches: `index.html`, `styles.css`, `app.js`, `manifest.webmanifest`, icons.
IndexedDB stores: every report ever loaded (up to 20 shown in History).

