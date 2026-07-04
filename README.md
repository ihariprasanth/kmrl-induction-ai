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
