# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Architecture

Live business dashboard for a fitness studio. Data flows from Excel exports (EasyBizy) → Vercel serverless functions → Supabase → browser dashboard.

```
GET  /              → dashboard.html  → fetch /api/get-data → Supabase → JSON → charts + KPIs
POST /api/upload    → parse Excel in-memory → process → upsert Supabase
GET  /upload        → upload.html (password-gated)
```

**No build step.** Static HTML files + Vercel serverless functions. Deploy by pushing to GitHub (Vercel auto-deploys).

## Environment Variables (Vercel + local .env)

| Variable | Source |
|----------|--------|
| `SUPABASE_URL` | `https://xxxx.supabase.co` — no trailing path |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Settings → API → service_role |
| `UPLOAD_PASSWORD` | Self-chosen password for /upload page |

## Supabase Schema

Single table, single row:

```sql
create table dashboard_history (
  id integer primary key,
  data jsonb,
  updated_at timestamptz default now()
);
insert into dashboard_history (id, data) values (1, null);
```

The entire app state lives in `data` (JSONB) at `id = 1`:

```json
{
  "months": { "2026-05": { "activeClients": 40, "newClients": 5, "revenueTotal": 17720, "revenuePaid": 13390 } },
  "visitor_sets": { "2026-05": [1739, 2778, ...] },
  "debt_ledger": { "CUSTOMER_ID": { "name": "...", "balance": 1250 } },
  "client_name_map": { "1739": "שם לקוח" },
  "kpis": { "openDebts": {...}, "atRiskClients": {...}, "expiringCards": {...}, "noNextMeeting": {...} },
  "lastUpdated": "2026-05-27T14:47:00.000Z"
}
```

Uploading a file **merges** into this object — existing months are overwritten per-field, history accumulates.

## Data Processing (`lib/processors.js`)

Each Excel type maps to a processor. Key business logic:

- **activeClients**: distinct `CustomerId` where `LastVisit` falls within a calendar month
- **newClients**: rows where `CreatedOn` is within month AND `NumberOfVisits > 0`
- **revenueTotal**: sum of `סכום` where `סכום > 0 AND חוב >= 0` (new sales only; negative-debt rows = old debt payments, excluded)
- **revenuePaid**: `revenueTotal − outstanding debt for that period`
- **atRiskClients** (KPI): customers in `visitor_sets[N-1]` but not in `visitor_sets[N]`
- **openDebts** (KPI): accumulated `debt_ledger` entries with `balance > 0`
- **expiringCards** (KPI): unique customers where `נותרו ∈ {1, 2}`
- **noNextMeeting** (KPI): customers with a meeting in the dominant month of MeetingClosings who have no future `NextMeeting` in the active clients file

Chart data filters out future months (keys > current `YYYY-MM`) and shows last 12 months.

## Excel File → Upload Field Mapping

| Upload field | EasyBizy file | Key columns |
|---|---|---|
| `new_clients` | Customers (5).xlsx | `CreatedOn`, `NumberOfVisits` |
| `active_clients` | Customers (6).xlsx | `LastVisit`, `NextMeeting`, `CustomerId`, `Name` |
| `sales` | TotalSales (2).xlsx | `תאריך`, `סכום`, `חוב`, `CustomerId`, `לקוח` |
| `subscriptions` | Subscriptions.xlsx | `לקוח`, `נותרו` |
| `meetings` | MeetingClosings.xlsx | `CustomerId`, `CustomerName`, `MeetingStartTime` |

## api/upload.js Flow

1. Authenticate via `x-upload-password` header
2. Parse multipart form with `multiparty`
3. Read Excel buffers from temp files into memory
4. Load existing history from Supabase (`id = 1`)
5. Run processors, merge into history object
6. Recompute KPIs (`computeOpenDebts`, `computeAtRisk`)
7. Upsert back to Supabase — check `upsertError` before returning 200

## api/get-data.js

Returns JSON (not JS). Dashboard parses with `res.json()`. The `eval` approach was removed — do not reintroduce it.
