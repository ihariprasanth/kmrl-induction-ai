# kmrl-induction-ai

AI-Driven Train Induction Planning & Scheduling — SIH25081
Kochi Metro Rail Limited (KMRL), 25-trainset fleet.

## Run locally

```
npm install
npm run dev
```

Open the printed localhost URL. Any username/password logs you in — pick
**Head of Department** or **Service / Operator** on the login screen.

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
  This is presented as the project's AI-driven prediction layer — it's a
  deterministic heuristic for demo purposes, not a trained ML model.
- **Live Ops Map** — a simulated schematic of the real Aluva ↔
  Tripunithura Blue Line (25 stations, 25.16 km, ~47 min one-way, 06:00–
  22:30 service window — sourced from public KMRL route information).
  Trains in ACTIVE service are animated along the line in real time
  (direction, next station, ETA) based on the app's own clock and each
  train's schedule cycle; trains not in service are shown parked at
  Muttom Depot with their bay number. **No public live-GPS feed exists
  for individual KMRL trainsets**, so this is a realistic simulation
  driven by the app itself, not scraped or fetched live data.

Per-station distances are interpolated from KMRL's published
commissioning-segment lengths and rescaled to the official 25.16 km
total — they're a realistic approximation, not an official
station-to-station distance table.

## Data note

Train names (Krishna, Periyar, Kaveri, Pampa, Ganga, etc.) reflect KMRL's
public river-naming convention, compiled from available web sources. Verify
the exact roster against kochimetro.org before using this in an official
submission — the live page could not be scraped directly.

Fleet metrics (mileage, certificate expiry, job-cards, branding hours,
traction/electrical health, service history) are deterministically generated
mock data for demonstration, not live KMRL operational data or real
maintenance records.

## Stack

React 18 + Vite, recharts for the mileage chart, lucide-react for icons.
No backend — all state is in-memory and resets on refresh.
