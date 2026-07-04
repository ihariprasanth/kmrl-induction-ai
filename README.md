# kmrl-induction-ai

AI-Driven Train Induction Planning & Scheduling — SIH25081
Kochi Metro Rail Limited (KMRL), 25-trainset fleet.

## Supabase setup (do this first)

The app now persists everything in Supabase instead of resetting on refresh:
login (`app_users`), the 25-train fleet (`trains`), and passenger queries
(`complaints`).

1. Create a free project at https://supabase.com.
2. Open **SQL Editor** → New query → paste the contents of
   `supabase/schema.sql` → **Run**. This creates all 3 tables, seeds the
   25 trainsets at a **zero baseline** (mileage 0, cert days 0, health 0%,
   etc.), seeds 2 demo logins, enables Row Level Security with anon
   read/write policies, and turns on Realtime for `trains` and
   `complaints`. Re-running this file wipes and reseeds everything — that's
   how you do a full "reset to zero" later.
3. Open **Project Settings → API**, copy the **Project URL** and the
   **anon public key**.
4. Copy `.env.example` to `.env` in the project root and paste those two
   values in.
5. `npm install` (pulls in `@supabase/supabase-js`), then `npm run dev`.

Change the two demo accounts (`hod` / `hod@123` and `operator` /
`operator@123`) in the `app_users` table before sharing this with anyone —
see the note at the bottom of `supabase/schema.sql` about passwords being
plaintext in this demo build.

## Run locally

```
npm install
npm run dev
```

Open the printed localhost URL and log in with a username/password from
your `app_users` table, picking the matching **Head of Department** or
**Service / Operator** role tab.

## Roles

- **Both roles** can edit train parameters: mileage, fitness-certificate days
  remaining, job-card status, branding SLA hours pending, last-cleaned date,
  and the "all checks complete" flag.
- Once a train's checks are complete and it has no open job-card or expiring
  certificate, it moves to **PENDING HOD APPROVAL**.
- **Only Head of Department** can click "Approve for Active Service" to move
  a train to **ACTIVE**. Operators cannot self-approve.
- Safety interlock: reopening a job-card or letting a certificate lapse
  automatically revokes any existing approval and forces the train back to
  **MAINTENANCE HOLD**, regardless of role.

## Train detail drawer

Clicking any train opens a full detail view with:
- **Traction & electrical health** — motor health %, brake pad wear %, battery health %,
  HVAC status, energy consumption (kWh/km), regenerative braking efficiency, total and
  since-last-service mileage.
- **Current service activity** — a live checklist (job-card clearance, certificate
  validity, cleaning, branding/SLA check, HOD sign-off) showing exactly what's done and
  what's still pending right now, derived from the train's live data.
- **Last service record** — date, service type, notes, and which HOD approved it.
- **Service history log** — the last 4 service entries with type, work performed,
  duration, and approving HOD.

## Induction Plan & Live Ops Map (new)

Two extra tabs sit alongside Fleet View / Maintenance Log:

- **Induction Plan** — ranks all 25 trains into **P1 (critical, route to
  maintenance first)**, **P2 (monitor / schedule soon)**, **P3 (routine)**
  using a rule-based risk score (job-card status, certificate days left,
  traction motor / brake / battery health %, HVAC, and how close each
  train is to its 4,500 km service interval). For each train it also
  shows km already run since last service, km left to next service, how
  many more one-way "single covers" it can do before it's due, and an
  estimated number of days to that point based on its live mileage rate.
  Every row shows a short "Why:" explainable-AI reason string, and for
  P1 trains, HOD can log an **override note** (visible in the Maintenance
  Log) explaining why a suggested priority wasn't followed — this doesn't
  change the train's actual status, it's an accountability record.
  This is presented as the project's AI-driven prediction layer — it's a
  deterministic heuristic for demo purposes, not a trained ML model.
- **Live Ops Map** — a simulated schematic of the real Aluva ↔
  Tripunithura Blue Line (25 stations, 25.16 km, ~47 min one-way, service
  06:00–22:30 weekdays / 07:30 start Sundays, frequency ~8 min peak /
  10-15 min non-peak — sourced from public KMRL route information).
  Trains in ACTIVE service are animated along the line in real time
  (direction, next station, ETA) based on the app's own clock and each
  train's schedule cycle; trains not in service are shown parked at
  Muttom Depot with their bay number. **No public live-GPS feed exists
  for individual KMRL trainsets** — even KMRL-linked third-party trip
  planners state their train positions are "based on schedules and are
  not live" — so this is a realistic simulation driven by the app itself,
  not scraped or fetched live data.

Per-station distances are interpolated from KMRL's published
commissioning-segment lengths and rescaled to the official 25.16 km
total — they're a realistic approximation, not an official
station-to-station distance table.

## Data note

Train names (Krishna, Periyar, Kaveri, Pampa, Ganga, etc.) reflect KMRL's
public river-naming convention, compiled from available web sources. Verify
the exact roster against kochimetro.org before using this in an official
submission — the live page could not be scraped directly.

## Passenger Queries (new)

A dedicated **Passenger Queries** tab (with a live badge count of open
items) sits alongside the other four tabs. A passenger scans the QR code
shown in a train's detail drawer, which opens the no-login
`ComplaintPortal` page and submits straight into Supabase. Every open
dashboard sees it appear instantly via Supabase Realtime — no refresh
needed. From this tab, **HOD** can:
- mark a query **Under Review**,
- assign an **expected completion date**,
- **Send to Service**, and
- **Mark Resolved** once fixed.

Operators can view the same list read-only. Anything sent to Service is
also pulled into that train's next service checklist in the drawer, same
as before.

Fleet metrics (mileage, certificate expiry, job-cards, branding hours,
traction/electrical health, service history) start at a **zero baseline**
in Supabase and are edited/persisted from there on — they are demo data
you fill in through the UI, not live KMRL operational data.

## Stack

React 18 + Vite, recharts for the mileage chart, lucide-react for icons,
Supabase (Postgres + Realtime) for auth, fleet data, and passenger
queries — see "Supabase setup" above.
