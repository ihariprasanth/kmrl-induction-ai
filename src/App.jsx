import React, { useState, useEffect, useMemo } from "react";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer, Cell,
} from "recharts";
import {
  Train, LogOut, Search, AlertTriangle, User, Lock, ChevronRight, X,
  ShieldCheck, Wrench, Clock3, CheckCircle2, Radio, Zap, Battery, Wind,
  Gauge, History, ClipboardList, Circle as CircleIcon, MessageSquareWarning,
  CalendarClock, Send,
} from "lucide-react";
import { supabase } from "./lib/supabaseClient";
import { sfx } from "./lib/sfx";

/* =========================================================================
   FLEET DATA
   25 KMRL trainsets. Names sourced from public references to KMRL's river-
   name convention; verify against kochimetro.org before external use.
   Numbers below are internal fleet IDs for this planning system, not
   official rake numbers.
========================================================================= */
const TRAIN_NAMES = [
  "Krishna", "Tapti", "Nila", "Sarayu", "Aruth", "Vaigai", "Jhanavi", "Dhwanil",
  "Bhavani", "Padma", "Mandakini", "Yamuna", "Periyar", "Kabani", "Vaayu",
  "Kaveri", "Shiriya", "Pampa", "Narmada", "Mahe", "Maarut", "Sabarmathi",
  "Godhavari", "Ganga", "Pavan",
];

const TRAIN_ID_LIST = TRAIN_NAMES.map((name, i) => ({
  id: `KMRL-T${String(i + 1).padStart(2, "0")}`,
  name,
}));

/* Distance (km) after which a train is due for its next scheduled service */
const SERVICE_INTERVAL_KM = 4500;

/* =========================================================================
   ROUTE MODEL — KMRL Blue Line (Aluva <-> Tripunithura)
   Real-world reference points: 25 operational stations, official route
   length 25.16 km, ~47 min end-to-end running time, service window
   06:00-22:30 daily (Sun 07:30 start, simplified here to one window).
   Per-station cumulative distances below are INTERPOLATED from KMRL's
   published commissioning-segment lengths (Aluva-Palarivattom 13.2km,
   Palarivattom-Maharaja's College 5km, ...-Thaikoodam 5.65km, -Petta
   1.12km, -SN Junction 1.78km, -Tripunithura 1.16km) and rescaled to sum
   to the official 25.16 km total — they are a realistic approximation,
   not an official KMRL station-to-station distance table.
========================================================================= */
const STATIONS = [
  "Aluva", "Pulinchodu", "Companypady", "Ambattukavu", "Muttom", "Kalamassery",
  "CUSAT", "Pathadipalam", "Edapally", "Changampuzha Park", "Palarivattom",
  "JLN Stadium", "Kaloor", "Lissie", "MG Road", "Maharaja's College",
  "Ernakulam South", "Kadavanthra", "Elamkulam", "Vytila", "Thaikoodam",
  "Petta", "Vadakkekotta", "SN Junction", "Tripunithura",
];
const STATION_KM = [
  0.00, 1.19, 2.38, 3.57, 4.76, 5.95, 7.14, 8.33, 9.52, 10.71, 11.90,
  12.80, 13.70, 14.61, 15.51, 16.41, 17.42, 18.44, 19.46, 20.48, 21.50,
  22.51, 23.31, 24.11, 25.16,
];
const DEPOT_STATION_IDX = 4; // Muttom — real KMRL depot location
const ONE_WAY_KM = STATION_KM[STATION_KM.length - 1]; // 25.16 km
const ROUND_TRIP_KM = ONE_WAY_KM * 2;
const ONE_WAY_MINUTES = 47;
const TURNAROUND_MINUTES = 5;
const CYCLE_MINUTES = ONE_WAY_MINUTES * 2 + TURNAROUND_MINUTES * 2; // 104
const SERVICE_START_MIN = 6 * 60; // 06:00
const SERVICE_END_MIN = 22 * 60 + 30; // 22:30
/* Assumed average hours/day a given trainset is actually in ACTIVE
   rotation (vs standby/turnback) — used only for the predictive estimate
   below, not an official KMRL utilisation figure. */
const AVG_ACTIVE_HOURS_PER_DAY = 12;
/* Max one-way "single covers" a train can run between services, purely
   from the fixed service-interval-km / one-way-km ratio. */
const MAX_RIDES_PER_SERVICE_CYCLE = Math.floor(SERVICE_INTERVAL_KM / ONE_WAY_KM);

/* ---- AI-style predictive scoring (rule-based heuristic — see README) ---- */
function riskScoreFor(t) {
  let s = 0;
  if (t.jobCardOpen) s += 30;
  if (t.certDaysLeft <= 7) s += (7 - t.certDaysLeft) * 4;
  s += Math.round((100 - t.tractionMotorHealth) * 0.25);
  s += Math.round(t.brakePadWear * 0.3);
  s += Math.round((100 - t.batteryHealth) * 0.2);
  if (t.hvacStatus === "Needs Check") s += 8;
  s += Math.round((t.mileageSinceService / SERVICE_INTERVAL_KM) * 20);
  s += Math.round((100 - t.regenBrakingEfficiency) * 0.1);
  return Math.max(0, Math.min(100, s));
}
function priorityFor(score, t) {
  if (t.jobCardOpen || t.certDaysLeft <= 2 || score >= 55) return "P1";
  if (score >= 30) return "P2";
  return "P3";
}
const PRIORITY_META = {
  P1: { label: "P1 · CRITICAL — MAINTENANCE FIRST", color: "#FF4D4D" },
  P2: { label: "P2 · MONITOR / SCHEDULE SOON", color: "#FFC93B" },
  P3: { label: "P3 · ROUTINE", color: "#39E68B" },
};
function predictFor(t) {
  const kmToService = Math.max(0, SERVICE_INTERVAL_KM - t.mileageSinceService);
  const dailyKmEstimate = t.mileageRatePerHour * AVG_ACTIVE_HOURS_PER_DAY;
  const ridesRemaining = Math.floor(kmToService / ONE_WAY_KM);
  const tripsPerDay = Math.max(1, Math.round(dailyKmEstimate / ONE_WAY_KM));
  const predictedDays = Math.max(0, Math.ceil(kmToService / Math.max(dailyKmEstimate, 1)));
  return { kmToService, dailyKmEstimate, ridesRemaining, tripsPerDay, predictedDays };
}
/* Explainable-AI style reason string for why a train landed at its priority */
function reasonForRisk(t) {
  const reasons = [];
  if (t.jobCardOpen) reasons.push("open job-card");
  if (t.certDaysLeft <= 7) reasons.push(`fitness cert expires in ${t.certDaysLeft}d`);
  if (t.tractionMotorHealth < 80) reasons.push(`motor health ${t.tractionMotorHealth}%`);
  if (t.brakePadWear > 60) reasons.push(`brake wear ${t.brakePadWear}%`);
  if (t.batteryHealth < 85) reasons.push(`battery ${t.batteryHealth}%`);
  if (t.hvacStatus === "Needs Check") reasons.push("HVAC needs check");
  if (t.mileageSinceService / SERVICE_INTERVAL_KM > 0.8) reasons.push("nearing service-km limit");
  if (reasons.length === 0) return "All health indicators within normal range.";
  return reasons.join(" · ");
}

/* ---- Live-position simulation along the route, driven by the clock ---- */
function stationIndexFromKm(km) {
  let i = 0;
  while (i < STATION_KM.length - 2 && STATION_KM[i + 1] <= km) i++;
  return i;
}
function getLivePosition(t, status, now) {
  if (status !== "ACTIVE") {
    return { mode: "DEPOT", bay: t.bay, note: "Muttom Depot" };
  }
  const minutesNow = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
  if (minutesNow < SERVICE_START_MIN || minutesNow > SERVICE_END_MIN) {
    return { mode: "DEPOT", bay: t.bay, note: "Outside service hours (06:00-22:30)" };
  }
  const offset = seeded(t.number * 53.7) * CYCLE_MINUTES;
  const cyc = ((minutesNow - SERVICE_START_MIN + offset) % CYCLE_MINUTES + CYCLE_MINUTES) % CYCLE_MINUTES;
  let direction, km, dwellAt = null;
  if (cyc < ONE_WAY_MINUTES) {
    direction = "UP"; km = (cyc / ONE_WAY_MINUTES) * ONE_WAY_KM;
  } else if (cyc < ONE_WAY_MINUTES + TURNAROUND_MINUTES) {
    direction = "UP"; km = ONE_WAY_KM; dwellAt = "Tripunithura";
  } else if (cyc < ONE_WAY_MINUTES * 2 + TURNAROUND_MINUTES) {
    const tt = cyc - ONE_WAY_MINUTES - TURNAROUND_MINUTES;
    direction = "DOWN"; km = ONE_WAY_KM - (tt / ONE_WAY_MINUTES) * ONE_WAY_KM;
  } else {
    direction = "DOWN"; km = 0; dwellAt = "Aluva";
  }
  const idx = stationIndexFromKm(km);
  const nextIdx = direction === "UP" ? Math.min(idx + 1, STATIONS.length - 1) : idx;
  const nextStation = dwellAt || STATIONS[direction === "UP" ? nextIdx : idx];
  const kmPerMin = ONE_WAY_KM / ONE_WAY_MINUTES;
  const kmToNext = dwellAt ? 0 : Math.abs(STATION_KM[nextIdx] - km);
  const etaMinutes = dwellAt ? 0 : Math.max(0, Math.round(kmToNext / kmPerMin));
  return {
    mode: dwellAt ? "AT_STATION" : "RUNNING",
    direction, km, pct: (km / ONE_WAY_KM) * 100,
    nextStation, etaMinutes, dwellAt,
  };
}

/* Common passenger-reported issues, tagged to a coach via QR complaint portal */
const COMPARTMENTS = ["Coach 1 (Aluva end)", "Coach 2 (Middle)", "Coach 3 (Tripunithura end)"];
const COMPLAINT_ISSUES = [
  "Light not working",
  "Fan not working",
  "AC / cooling issue",
  "Window not opening/closing",
  "Door issue",
  "Seat damage",
  "Cleanliness issue",
  "TTR / staff behaviour complaint",
  "Other",
];
/* =========================================================================
   SUPABASE — PASSENGER QUERIES ("complaints" table)
   Replaces the old localStorage-only version so a query raised by a
   passenger scanning the QR on the actual train shows up live on every
   HOD / Operator screen, not just the same browser. Run supabase/schema.sql
   in your Supabase project once before using this.
========================================================================= */
function complaintFromRow(r) {
  return {
    id: r.id,
    trainId: r.train_id,
    trainName: r.train_name,
    compartment: r.compartment,
    issue: r.issue,
    description: r.description,
    status: r.status,
    reviewedBy: r.reviewed_by,
    expectedCompletionDate: r.expected_completion_date,
    sentToServiceAt: r.sent_to_service_at,
    resolvedBy: r.resolved_by,
    resolvedTs: r.resolved_ts,
    ts: r.ts,
  };
}

async function fetchComplaints() {
  const { data, error } = await supabase.from("complaints").select("*").order("ts", { ascending: false });
  if (error) {
    // eslint-disable-next-line no-console
    console.error("[complaints] fetch failed — did you run supabase/schema.sql?", error.message);
    return [];
  }
  return (data || []).map(complaintFromRow);
}

async function insertComplaint({ trainId, trainName, compartment, issue, description }) {
  const { data, error } = await supabase
    .from("complaints")
    .insert({ train_id: trainId, train_name: trainName, compartment, issue, description })
    .select()
    .single();
  if (error) throw error;
  return complaintFromRow(data);
}

/* patch uses camelCase keys mirroring complaintFromRow() output */
async function updateComplaint(id, patch) {
  const row = {};
  if ("status" in patch) row.status = patch.status;
  if ("reviewedBy" in patch) row.reviewed_by = patch.reviewedBy;
  if ("expectedCompletionDate" in patch) row.expected_completion_date = patch.expectedCompletionDate;
  if ("sentToServiceAt" in patch) row.sent_to_service_at = patch.sentToServiceAt;
  if ("resolvedBy" in patch) row.resolved_by = patch.resolvedBy;
  if ("resolvedTs" in patch) row.resolved_ts = patch.resolvedTs;
  const { error } = await supabase.from("complaints").update(row).eq("id", id);
  if (error) throw error;
}

/* =========================================================================
   SUPABASE — TRAINS table row <-> app's camelCase train object
========================================================================= */
function trainFromRow(r) {
  return {
    id: r.id,
    number: r.number,
    name: r.name,
    bay: r.bay,
    mileageKm: r.mileage_km,
    mileageSinceService: r.mileage_since_service,
    mileageRatePerHour: r.mileage_rate_per_hour,
    certDaysLeft: r.cert_days_left,
    jobCardOpen: r.job_card_open,
    brandingHoursPending: r.branding_hours_pending,
    lastCleanedDaysAgo: r.last_cleaned_days_ago,
    checksComplete: r.checks_complete,
    approved: r.approved,
    tractionMotorHealth: r.traction_motor_health,
    brakePadWear: r.brake_pad_wear,
    batteryHealth: r.battery_health,
    hvacStatus: r.hvac_status,
    energyConsumptionKwhKm: Number(r.energy_consumption_kwh_km),
    regenBrakingEfficiency: r.regen_braking_efficiency,
    lastServiceDate: r.last_service_date,
    lastServiceType: r.last_service_type,
    lastServiceNotes: r.last_service_notes,
    lastServiceApprovedBy: r.last_service_approved_by,
    serviceHistory: r.service_history || [],
    assignedOperator: r.assigned_operator,
  };
}

async function fetchFleetFromSupabase() {
  const { data, error } = await supabase.from("trains").select("*").order("number", { ascending: true });
  if (error) {
    // eslint-disable-next-line no-console
    console.error("[trains] fetch failed — did you run supabase/schema.sql?", error.message);
    return null;
  }
  return (data || []).map(trainFromRow);
}

/* patch uses camelCase keys mirroring trainFromRow() output */
function trainPatchToRow(patch) {
  const map = {
    mileageKm: "mileage_km",
    mileageSinceService: "mileage_since_service",
    mileageRatePerHour: "mileage_rate_per_hour",
    certDaysLeft: "cert_days_left",
    jobCardOpen: "job_card_open",
    brandingHoursPending: "branding_hours_pending",
    lastCleanedDaysAgo: "last_cleaned_days_ago",
    checksComplete: "checks_complete",
    approved: "approved",
    tractionMotorHealth: "traction_motor_health",
    brakePadWear: "brake_pad_wear",
    batteryHealth: "battery_health",
    hvacStatus: "hvac_status",
    energyConsumptionKwhKm: "energy_consumption_kwh_km",
    regenBrakingEfficiency: "regen_braking_efficiency",
    lastServiceDate: "last_service_date",
    lastServiceType: "last_service_type",
    lastServiceNotes: "last_service_notes",
    lastServiceApprovedBy: "last_service_approved_by",
    serviceHistory: "service_history",
    assignedOperator: "assigned_operator",
  };
  const row = {};
  Object.entries(patch).forEach(([k, v]) => {
    if (map[k]) row[map[k]] = v;
  });
  return row;
}

async function persistTrain(id, patch) {
  const row = trainPatchToRow(patch);
  if (Object.keys(row).length === 0) return;
  const { error } = await supabase.from("trains").update(row).eq("id", id);
  if (error) {
    // eslint-disable-next-line no-console
    console.error(`[trains] failed to save ${id}:`, error.message);
  }
}

/* Builds the passenger complaint-portal link + scannable QR image for a train */
function qrInfoFor(trainId) {
  const base = typeof window !== "undefined" ? `${window.location.origin}${window.location.pathname}` : "";
  const link = `${base}?complain=${trainId}`;
  const qrImg = `https://api.qrserver.com/v1/create-qr-code/?size=170x170&bgcolor=0B1410&color=39E68B&qzone=1&data=${encodeURIComponent(link)}`;
  return { link, qrImg };
}

function seeded(seed) {
  const x = Math.sin(seed * 999.7) * 10000;
  return x - Math.floor(x);
}

const HODS = ["R. Menon (HOD)", "S. Pillai (HOD)", "A. Nair (HOD)", "K. Warrier (HOD)"];
const OPERATORS = ["Operator Vinod", "Operator Anjali", "Operator Rahul", "Operator Divya", "Operator Suresh"];
const SERVICE_TYPES = [
  { type: "Scheduled Maintenance", note: "90-day inspection — brake calipers, coupler alignment, door sensor calibration checked." },
  { type: "Brake Pad Inspection", note: "Brake pad thickness measured across all bogies; disc rotor checked for scoring." },
  { type: "HVAC Servicing", note: "Cabin HVAC filters replaced, coolant pressure verified, airflow balanced across coaches." },
  { type: "Deep Cleaning & Detailing", note: "Full interior deep clean, exterior wash, pantograph and undercarriage wipe-down." },
  { type: "Traction Motor Check", note: "Traction motor winding resistance tested, bearing lubrication topped up." },
  { type: "Battery & Auxiliary Check", note: "Auxiliary battery bank load-tested, backup power cutover verified." },
];

function fmtDate(daysAgo) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

function buildFleet() {
  return TRAIN_NAMES.map((name, i) => {
    const n = i + 1;
    const lastServiceDaysAgo = Math.round(2 + seeded(n * 7.2) * 40);
    const lastServiceIdx = Math.floor(seeded(n * 8.4) * SERVICE_TYPES.length);
    const lastService = SERVICE_TYPES[lastServiceIdx];
    const lastServiceApprovedBy = HODS[Math.floor(seeded(n * 9.1) * HODS.length)];

    const serviceHistory = Array.from({ length: 4 }).map((_, h) => {
      const daysAgo = lastServiceDaysAgo + h * (18 + Math.round(seeded(n * 11 + h) * 20));
      const svc = SERVICE_TYPES[Math.floor(seeded(n * 13 + h * 3) * SERVICE_TYPES.length)];
      return {
        date: fmtDate(daysAgo),
        type: svc.type,
        workDone: svc.note,
        approvedBy: HODS[Math.floor(seeded(n * 17 + h * 5) * HODS.length)],
        durationHrs: Math.round(2 + seeded(n * 19 + h) * 6),
      };
    });

    return {
      id: `KMRL-T${String(n).padStart(2, "0")}`,
      number: n,
      name,
      mileageKm: Math.round(38000 + seeded(n * 1.1) * 42000),
      mileageSinceService: Math.round(500 + seeded(n * 1.7) * 6000),
      mileageRatePerHour: Math.round(4 + seeded(n * 41.3) * 10), // km/h while in ACTIVE service (simulated)
      certDaysLeft: Math.round(1 + seeded(n * 2.3) * 60),
      jobCardOpen: seeded(n * 3.7) < 0.18,
      brandingHoursPending: Math.round(seeded(n * 4.9) * 40),
      lastCleanedDaysAgo: Math.round(seeded(n * 5.3) * 6),
      checksComplete: seeded(n * 6.1) > 0.45,
      approved: false,
      bay: ((n - 1) % 6) + 1,

      // Electric traction / component health
      tractionMotorHealth: Math.round(68 + seeded(n * 21) * 31),
      brakePadWear: Math.round(6 + seeded(n * 23) * 34),
      batteryHealth: Math.round(78 + seeded(n * 27) * 21),
      hvacStatus: seeded(n * 29) > 0.75 ? "Needs Check" : "Optimal",
      energyConsumptionKwhKm: +(3.1 + seeded(n * 31) * 1.4).toFixed(2),
      regenBrakingEfficiency: Math.round(64 + seeded(n * 33) * 28),

      // Service records
      lastServiceDate: fmtDate(lastServiceDaysAgo),
      lastServiceType: lastService.type,
      lastServiceNotes: lastService.note,
      lastServiceApprovedBy,
      serviceHistory,
      assignedOperator: OPERATORS[Math.floor(seeded(n * 37) * OPERATORS.length)],
    };
  });
}

/* Signal-aspect palette — real railway indication colors */
const SIGNAL = {
  MAINTENANCE: { label: "MAINTENANCE HOLD", color: "#FF4D4D", glow: "rgba(255,77,77,0.35)" },
  STANDBY: { label: "STANDBY / IN CHECK", color: "#FFC93B", glow: "rgba(255,201,59,0.3)" },
  PENDING: { label: "PENDING HOD APPROVAL", color: "#3FC8FF", glow: "rgba(63,200,255,0.3)" },
  ACTIVE: { label: "ACTIVE SERVICE", color: "#39E68B", glow: "rgba(57,230,139,0.35)" },
};

function deriveStatus(t) {
  if (t.jobCardOpen || t.certDaysLeft <= 2) return "MAINTENANCE";
  if (t.approved) return "ACTIVE";
  if (t.checksComplete) return "PENDING";
  return "STANDBY";
}

function reasonFor(t, status) {
  if (status === "MAINTENANCE") {
    return t.jobCardOpen
      ? "Open job-card — maintenance clearance required before re-entry."
      : `Fitness certificate expires in ${t.certDaysLeft}d — renewal required.`;
  }
  if (status === "ACTIVE") return "HOD-approved and certified for active service.";
  if (status === "PENDING") return "All servicing checks cleared. Awaiting HOD sign-off.";
  return "Servicing / cleaning / inspection in progress.";
}

/* =========================================================================
   PASSENGER COMPLAINT PORTAL — opened by scanning a train's QR code.
   No login required. Writes into shared localStorage so the fleet console
   picks it up (same-browser / same-device real-time; a backend like
   Supabase would be needed to sync this across different phones/laptops).
========================================================================= */
function ComplaintPortal({ presetTrainId }) {
  const presetValid = TRAIN_ID_LIST.some((t) => t.id === presetTrainId);
  const [trainId, setTrainId] = useState(presetValid ? presetTrainId : TRAIN_ID_LIST[0].id);
  const [compartment, setCompartment] = useState(COMPARTMENTS[0]);
  const [issue, setIssue] = useState(COMPLAINT_ISSUES[0]);
  const [description, setDescription] = useState("");
  const [submitted, setSubmitted] = useState(null);
  const [sending, setSending] = useState(false);
  const [submitErr, setSubmitErr] = useState("");

  const train = TRAIN_ID_LIST.find((t) => t.id === trainId);

  const submit = async (e) => {
    e.preventDefault();
    setSubmitErr("");
    setSending(true);
    try {
      const complaint = await insertComplaint({
        trainId,
        trainName: train?.name || trainId,
        compartment,
        issue,
        description: description.trim(),
      });
      setSubmitted(complaint);
    } catch (err) {
      setSubmitErr("Could not submit — check connection and try again.");
    } finally {
      setSending(false);
    }
  };

  const submitAnother = () => {
    setSubmitted(null);
    setIssue(COMPLAINT_ISSUES[0]);
    setCompartment(COMPARTMENTS[0]);
    setDescription("");
  };

  if (submitted) {
    return (
      <div className="scada-root login-screen">
        <div className="scanlines" />
        <div className="login-box complaint-box">
          <div className="term-header">
            <Radio size={16} />
            <span>KMRL // PASSENGER COMPLAINT DESK</span>
          </div>
          <div className="complaint-thanks">
            <CheckCircle2 size={34} color="#39E68B" />
            <div className="complaint-thanks-title">COMPLAINT LOGGED</div>
            <div className="complaint-thanks-note">
              Reported on <strong>{submitted.trainName}</strong> · {submitted.compartment}. Our maintenance team
              will address this before the train's next service.
            </div>
            <div className="complaint-ref mono">REF: {submitted.id}</div>
            <button className="term-submit" onClick={submitAnother}>
              &gt; REPORT ANOTHER ISSUE
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="scada-root login-screen">
      <div className="scanlines" />
      <div className="login-box complaint-box">
        <div className="term-header">
          <Radio size={16} />
          <span>KMRL // PASSENGER COMPLAINT DESK</span>
        </div>
        <div className="login-title-row">
          <div className="login-icon"><AlertTriangle size={24} /></div>
          <div>
            <div className="login-title">REPORT AN ISSUE</div>
            <div className="login-sub">SCANNED FROM TRAIN {trainId} — TAG THE COACH &amp; ISSUE BELOW</div>
          </div>
        </div>

        <form onSubmit={submit} className="login-form complaint-form">
          <div className="complaint-field">
            <span className="field-label">TRAIN</span>
            <select value={trainId} onChange={(e) => setTrainId(e.target.value)}>
              {TRAIN_ID_LIST.map((t) => (
                <option key={t.id} value={t.id}>{t.id} — {t.name}</option>
              ))}
            </select>
          </div>

          <div className="complaint-field">
            <span className="field-label">COMPARTMENT</span>
            <div className="chip-row">
              {COMPARTMENTS.map((c) => (
                <button type="button" key={c} className={c === compartment ? "chip on" : "chip"} onClick={() => setCompartment(c)}>
                  {c}
                </button>
              ))}
            </div>
          </div>

          <div className="complaint-field">
            <span className="field-label">WHAT'S THE ISSUE?</span>
            <div className="chip-row">
              {COMPLAINT_ISSUES.map((i) => (
                <button type="button" key={i} className={i === issue ? "chip on" : "chip"} onClick={() => setIssue(i)}>
                  {i}
                </button>
              ))}
            </div>
          </div>

          <div className="complaint-field">
            <span className="field-label">DESCRIBE (OPTIONAL)</span>
            <textarea
              rows={3}
              placeholder="Any extra detail — e.g. exact seat number, TTR name..."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          {submitErr && <div className="term-err"><AlertTriangle size={13} /> {submitErr}</div>}

          <button className="term-submit" type="submit" disabled={sending}>
            &gt; {sending ? "SUBMITTING..." : "SUBMIT COMPLAINT"} <ChevronRight size={15} />
          </button>
        </form>
        <div className="login-footnote">THIS ISSUE WILL BE PULLED INTO THE TRAIN'S NEXT SERVICE CHECKLIST</div>
      </div>
    </div>
  );
}


/* =========================================================================
   TRAIN HERO — advanced blueprint / schematic HUD train (login backdrop)
========================================================================= */
function TrainHero() {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 400);
    return () => clearInterval(id);
  }, []);

  const speed = (78 + 6 * Math.sin(tick / 6)).toFixed(1);
  const trac = (91 + 4 * Math.sin(tick / 4 + 1)).toFixed(0);
  const posX = (1200 + 300 * Math.sin(tick / 20)).toFixed(0);

  return (
    <div className="train-hero blueprint">
      <svg viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid slice">
        <defs>
          <pattern id="bpGridMinor" width="20" height="20" patternUnits="userSpaceOnUse">
            <path d="M20 0H0V20" fill="none" stroke="#123024" strokeWidth="0.5" />
          </pattern>
          <pattern id="bpGridMajor" width="100" height="100" patternUnits="userSpaceOnUse">
            <rect width="100" height="100" fill="url(#bpGridMinor)" />
            <path d="M100 0H0V100" fill="none" stroke="#1B4A38" strokeWidth="1" />
          </pattern>
          <linearGradient id="bpSky" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#071812" />
            <stop offset="55%" stopColor="#05100B" />
            <stop offset="100%" stopColor="#04070A" />
          </linearGradient>
          <radialGradient id="bpVignette" cx="50%" cy="38%" r="75%">
            <stop offset="0%" stopColor="#0C221A" stopOpacity="0" />
            <stop offset="100%" stopColor="#020403" stopOpacity="0.85" />
          </radialGradient>
          <linearGradient id="bpSweepGrad" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#39E68B" stopOpacity="0" />
            <stop offset="100%" stopColor="#39E68B" stopOpacity="0.12" />
          </linearGradient>
          <filter id="bpGlow" x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur stdDeviation="3.2" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <filter id="bpGlowSoft" x="-80%" y="-80%" width="260%" height="260%">
            <feGaussianBlur stdDeviation="5" />
          </filter>
        </defs>

        {/* deep sky + grid */}
        <rect x="0" y="0" width="1600" height="900" fill="url(#bpSky)" />
        <rect x="0" y="0" width="1600" height="900" fill="url(#bpGridMajor)" opacity="0.55" />

        {/* perspective tunnel converging lines — HUD depth cue */}
        <g stroke="#1B4A38" strokeWidth="1" opacity="0.5">
          <line x1="800" y1="380" x2="-200" y2="900" />
          <line x1="800" y1="380" x2="500" y2="900" />
          <line x1="800" y1="380" x2="1100" y2="900" />
          <line x1="800" y1="380" x2="1800" y2="900" />
        </g>

        {/* distant orbiting satellite / status rings, top corners */}
        <g className="bp-ring" transform="translate(1480,90)" stroke="#39E68B" fill="none" opacity="0.5">
          <circle r="26" strokeWidth="1" strokeDasharray="4 5" />
          <circle r="14" strokeWidth="1" />
        </g>
        <g className="bp-ring" style={{ animationDuration: "14s" }} transform="translate(120,120)" stroke="#39E68B" fill="none" opacity="0.4">
          <circle r="34" strokeWidth="1" strokeDasharray="3 7" />
        </g>

        {/* radar / oscilloscope sweep across full height */}
        <rect className="bp-sweep" x="0" y="0" width="220" height="900" fill="url(#bpSweepGrad)" />

        {/* HUD corner brackets — full frame */}
        <g stroke="#39E68B" strokeWidth="2" fill="none" opacity="0.65">
          <path d="M18,18 L18,54 M18,18 L54,18" />
          <path d="M1582,18 L1582,54 M1582,18 L1546,18" />
          <path d="M18,882 L18,846 M18,882 L54,882" />
          <path d="M1582,882 L1582,846 M1582,882 L1546,882" />
        </g>

        {/* distant parallax train — smaller, slower, drifting opposite direction */}
        <g className="emu-unit-far" opacity="0.35">
          <g stroke="#39E68B" strokeWidth="1.1" fill="none">
            <path d="M0,510 L0,478 Q0,464 15,463 L190,463 Q204,463 213,472 L239,497
                     Q243,501 243,506 L243,510 Z" />
            {[...Array(4)].map((_, i) => (
              <rect key={i} x={10 + i * 42} y="474" width="30" height="16" rx="2" />
            ))}
          </g>
        </g>

        {/* main track bed with sleepers running the width */}
        <g>
          <line x1="0" y1="640" x2="1600" y2="640" stroke="#1F3B30" strokeWidth="1" strokeDasharray="2 6" />
          <line x1="0" y1="648" x2="1600" y2="648" stroke="#12271F" strokeWidth="1" />
          {[...Array(30)].map((_, i) => (
            <rect key={i} className="sleeper" x={i * 56 - 20} y="642" width="26" height="7" fill="#183227" opacity="0.7" />
          ))}
          {/* running signal lights along the track */}
          {[...Array(6)].map((_, i) => (
            <circle key={i} className="track-pulse" style={{ animationDelay: `${i * 0.5}s` }} cx={i * 300 + 80} cy="640" r="3" fill="#39E68B" />
          ))}
        </g>

        {/* ---- moving wireframe EMU train unit — FULL 5-COACH RAKE ---- */}
        <g className="emu-unit" filter="url(#bpGlow)">

          {/* ===== TRAILER COACHES 1-4 (plain wireframe coach bodies) ===== */}
          {[0, 232, 464, 696].map((cx, idx) => (
            <g key={idx}>
              <rect x={cx} y="484" width="210" height="116" rx="14"
                    fill="none" stroke="#39E68B" strokeWidth="2" opacity="0.95" />
              {[0, 1, 2].map((w) => (
                <rect key={w} x={cx + 12 + w * 66} y="510" width="54" height="42" rx="6"
                      fill="none" stroke="#39E68B" strokeWidth="2" opacity="0.95" />
              ))}
              {/* sliding door boundary */}
              <line x1={cx + 105} y1="486" x2={cx + 105} y2="598"
                    stroke="#39E68B" strokeWidth="1.4" strokeDasharray="3 4" opacity="0.55" />
              {/* livery / dimension line */}
              <line x1={cx} y1="556" x2={cx + 210} y2="556"
                    stroke="#39E68B" strokeWidth="2" strokeDasharray="5 5" opacity="0.6" />
              <text x={cx + 105} y="474" textAnchor="middle"
                    fontFamily="'IBM Plex Mono',monospace" fontSize="10" fill="#39E68B" opacity="0.6">
                COACH {idx + 1}
              </text>
              {/* bogies */}
              <g transform={`translate(${cx + 45},588)`}>
                <rect x="-38" y="0" width="76" height="22" rx="5" fill="none" stroke="#39E68B" strokeWidth="1.8" />
                <circle className="wheel" cx="-20" cy="22" r="16" fill="none" stroke="#39E68B" strokeWidth="1.8" />
                <circle className="wheel" cx="20" cy="22" r="16" fill="none" stroke="#39E68B" strokeWidth="1.8" />
              </g>
              <g transform={`translate(${cx + 165},588)`}>
                <rect x="-38" y="0" width="76" height="22" rx="5" fill="none" stroke="#39E68B" strokeWidth="1.8" />
                <circle className="wheel" cx="-20" cy="22" r="16" fill="none" stroke="#39E68B" strokeWidth="1.8" />
                <circle className="wheel" cx="20" cy="22" r="16" fill="none" stroke="#39E68B" strokeWidth="1.8" />
              </g>
              {/* coupler knuckle joining the next coach */}
              <line x1={cx + 210} y1="556" x2={cx + 232} y2="556" stroke="#39E68B" strokeWidth="2.4" opacity="0.8" />
              <circle className="bp-node" cx={cx + 221} cy="556" r="4" fill="#39E68B" />
            </g>
          ))}

          {/* coupler joining COACH 4 to the driving cab */}
          <line x1="906" y1="556" x2="928" y2="556" stroke="#39E68B" strokeWidth="2.4" opacity="0.8" />
          <circle className="bp-node" cx="917" cy="556" r="4" fill="#39E68B" />

          {/* ===== CAB COACH — COACH 5 / driving unit with nose + pantograph ===== */}
          <g transform="translate(928,0)">
            <g stroke="#39E68B" strokeWidth="2" fill="none" opacity="0.95">
              {/* body shell wireframe */}
              <path d="M0,600 L0,520 Q0,486 36,484 L470,484 Q504,484 526,505 L592,566
                       Q601,575 601,588 L601,600 Z" />
              {/* front windshield */}
              <path d="M488,505 L538,510 Q566,528 582,566 L526,566 Q504,554 488,530 Z" />
              {/* passenger window grid */}
              {[...Array(6)].map((_, i) => (
                <rect key={i} x={22 + i * 78} y="510" width="60" height="42" rx="6" />
              ))}
              {/* livery / dimension line */}
              <line x1="0" y1="556" x2="601" y2="556" strokeDasharray="5 5" opacity="0.6" />
              {/* pantograph */}
              <path d="M235,484 L235,446 L268,428 L268,412 M235,484 L235,446 L202,428 L202,412" />
              <rect x="188" y="406" width="94" height="7" rx="3" />
            </g>

            {/* joint / reference nodes */}
            <circle cx="601" cy="556" r="4" fill="#39E68B" />
            <circle cx="235" cy="412" r="4" fill="#39E68B" className="bp-node" />
            <circle className="panto-spark" cx="235" cy="410" r="9" fill="#BFF7DD" />

            <text x="300" y="474" textAnchor="middle"
                  fontFamily="'IBM Plex Mono',monospace" fontSize="10" fill="#39E68B" opacity="0.6">
              COACH 5 // CAB-A
            </text>

            {/* bogies */}
            <g transform="translate(94,588)">
              <rect x="-38" y="0" width="76" height="22" rx="5" fill="none" stroke="#39E68B" strokeWidth="1.8" />
              <circle className="wheel" cx="-20" cy="22" r="16" fill="none" stroke="#39E68B" strokeWidth="1.8" />
              <circle className="wheel" cx="20" cy="22" r="16" fill="none" stroke="#39E68B" strokeWidth="1.8" />
            </g>
            <g transform="translate(470,588)">
              <rect x="-38" y="0" width="76" height="22" rx="5" fill="none" stroke="#39E68B" strokeWidth="1.8" />
              <circle className="wheel" cx="-20" cy="22" r="16" fill="none" stroke="#39E68B" strokeWidth="1.8" />
              <circle className="wheel" cx="20" cy="22" r="16" fill="none" stroke="#39E68B" strokeWidth="1.8" />
            </g>

            {/* headlight beam */}
            <path className="headlight-beam" d="M601,570 L840,530 L840,610 Z" fill="url(#bpSweepGrad)" filter="url(#bpGlowSoft)" opacity="0.5" />

            {/* leader-line callouts */}
            <g fontFamily="'IBM Plex Mono',monospace" fontSize="13" fill="#39E68B" opacity="0.85">
              <line x1="235" y1="406" x2="235" y2="368" stroke="#1F3B30" strokeWidth="1" />
              <text x="150" y="360">PANTOGRAPH ASSY // OHE-750VDC</text>

              <line x1="518" y1="503" x2="566" y2="460" stroke="#1F3B30" strokeWidth="1" />
              <text x="470" y="450">CAB-A // TRACTION CTRL</text>

              <line x1="94" y1="612" x2="94" y2="644" stroke="#1F3B30" strokeWidth="1" />
              <text x="20" y="662">BOGIE-09</text>

              <line x1="470" y1="612" x2="470" y2="644" stroke="#1F3B30" strokeWidth="1" />
              <text x="426" y="662">BOGIE-10</text>
            </g>
          </g>

          {/* rear taillight, at the very back of coach 1 */}
          <circle className="taillight" cx="6" cy="556" r="5" fill="#FF4D4D" />
        </g>


        {/* live schematic data readout */}
        <g fontFamily="'IBM Plex Mono',monospace" fontSize="14" fill="#39E68B" opacity="0.9">
          <text x="26" y="700">UNIT KMRL-EMU // VEL {speed} KM/H // TRACTION {trac}%</text>
          <text x="1574" y="700" textAnchor="end">POS X:{posX} // OHE 750VDC // STATUS NOMINAL</text>
          <text x="26" y="60">SECTOR ALUVA–TRIPUNITHURA // FLEET-CTRL v2.1</text>
          <text x="1574" y="60" textAnchor="end">{new Date().toLocaleDateString("en-IN")}</text>
        </g>

        <rect x="0" y="0" width="1600" height="900" fill="url(#bpVignette)" />
      </svg>
      <div className="train-hero-fade" />
    </div>
  );
}

/* =========================================================================
   LOGIN
========================================================================= */
function Login({ onLogin }) {
  const [role, setRole] = useState("HOD");
  const [uname, setUname] = useState("");
  const [pwd, setPwd] = useState("");
  const [err, setErr] = useState("");
  const [checking, setChecking] = useState(false);
  const [clock, setClock] = useState(new Date());

  useEffect(() => {
    const id = setInterval(() => setClock(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    sfx.submit();
    if (!uname.trim() || !pwd.trim()) {
      setErr("CREDENTIALS REQUIRED");
      sfx.error();
      return;
    }
    setErr("");
    setChecking(true);
    const { data, error } = await supabase
      .from("app_users")
      .select("*")
      .eq("username", uname.trim())
      .eq("password", pwd)
      .eq("role", role)
      .maybeSingle();
    setChecking(false);
    if (error) {
      setErr("LOGIN CHECK FAILED — CHECK SUPABASE CONNECTION");
      sfx.error();
      return;
    }
    if (!data) {
      setErr("INVALID USERNAME / PASSWORD FOR THIS ROLE");
      sfx.error();
      return;
    }
    sfx.success();
    onLogin({ role: data.role, name: data.name });
  };

  const chooseRole = (r) => {
    if (r === role) return;
    sfx.tabSwitch();
    setRole(r);
  };

  return (
    <div className="scada-root login-screen">
      <div className="scanlines" />
      <TrainHero />
      <div className="login-box">
        <div className="term-header">
          <Radio size={16} />
          <span>KMRL // FLEET-CTRL v2.1</span>
          <span className="term-clock">{clock.toLocaleTimeString("en-IN", { hour12: false })}</span>
        </div>

        <div className="login-title-row">
          <div className="login-icon"><Train size={24} /></div>
          <div>
            <div className="login-title">TRAIN INDUCTION CONTROL</div>
            <div className="login-sub">AUTHENTICATION REQUIRED — SECTOR: ALUVA–TRIPUNITHURA</div>
          </div>
        </div>

        <div className="role-tabs">
          <button
            className={role === "HOD" ? "role-tab on" : "role-tab"}
            onClick={() => chooseRole("HOD")}
            onMouseEnter={sfx.hover}
          >
            HEAD OF DEPARTMENT
          </button>
          <button
            className={role === "OPERATOR" ? "role-tab on" : "role-tab"}
            onClick={() => chooseRole("OPERATOR")}
            onMouseEnter={sfx.hover}
          >
            TECHNICIAN
          </button>
        </div>

        <form onSubmit={submit} className="login-form">
          <div className="term-field">
            <User size={14} />
            <input placeholder="OPERATOR ID" value={uname} onChange={(e) => setUname(e.target.value)} onFocus={sfx.focus} />
          </div>
          <div className="term-field">
            <Lock size={14} />
            <input type="password" placeholder="ACCESS CODE" value={pwd} onChange={(e) => setPwd(e.target.value)} onFocus={sfx.focus} />
          </div>
          {err && <div className="term-err"><AlertTriangle size={13} /> {err}</div>}
          <button className="term-submit" type="submit" disabled={checking} onMouseEnter={sfx.hover}>
            &gt; {checking ? "CHECKING..." : "AUTHENTICATE"} <ChevronRight size={15} />
          </button>
        </form>

        <div className="rail-track">
          <span className="rail-station" style={{ left: "10%" }} />
          <span className="rail-station" style={{ left: "38%" }} />
          <span className="rail-station" style={{ left: "66%" }} />
          <span className="rail-station" style={{ left: "92%" }} />
          <div className="rail-line" />
          <div className="rail-train">
            <Train size={20} />
            <span className="rail-trail" />
          </div>
        </div>

        <div className="login-footnote">CREDENTIALS CHECKED AGAINST SUPABASE app_users TABLE</div>
      </div>
    </div>
  );
}

/* =========================================================================
   SERVICE CHECKLIST MODAL
   Shown every time servicing is being finalized — HOD / operator must tick
   off exactly what was serviced before the action (approve / mark complete)
   is allowed to go through.
========================================================================= */
function ChecklistModal({ title, subtitle, items, confirmLabel, onConfirm, onCancel }) {
  const [checked, setChecked] = useState(() => new Set());
  const allChecked = checked.size === items.length;

  const toggle = (id) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="drawer-backdrop" onClick={onCancel}>
      <div className="checklist-modal" onClick={(e) => e.stopPropagation()}>
        <div className="checklist-head">
          <ClipboardList size={17} />
          <div>
            <div className="checklist-title">{title}</div>
            {subtitle && <div className="checklist-sub">{subtitle}</div>}
          </div>
          <button className="icon-x" onClick={onCancel}><X size={18} /></button>
        </div>

        <div className="checklist-items">
          {items.map((it) => (
            <label key={it.id} className={`checklist-item ${checked.has(it.id) ? "on" : ""}`}>
              <input type="checkbox" checked={checked.has(it.id)} onChange={() => toggle(it.id)} />
              <div>
                <div className="checklist-item-title">{it.label}</div>
                {it.note && <div className="checklist-item-note">{it.note}</div>}
              </div>
            </label>
          ))}
        </div>

        <div className="checklist-progress">{checked.size} / {items.length} SERVICES CONFIRMED</div>

        <button
          className="approve-btn"
          disabled={!allChecked}
          onClick={() => onConfirm(items.filter((it) => checked.has(it.id)))}
        >
          <ShieldCheck size={15} /> {confirmLabel}
        </button>
        <button className="checklist-cancel" onClick={onCancel}>CANCEL</button>
      </div>
    </div>
  );
}

/* =========================================================================
   COUNT UP — animated number tween for HUD stat tiles
========================================================================= */
function CountUp({ value }) {
  const [display, setDisplay] = useState(0);
  useEffect(() => {
    let raf;
    const start = performance.now();
    const from = display;
    const duration = 600;
    const step = (now) => {
      const p = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      setDisplay(Math.round(from + (value - from) * eased));
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return <>{display}</>;
}

/* =========================================================================
   MINI BLIP — tiny animated train HUD indicator (fleet rows + bay grid)
========================================================================= */
function MiniBlip({ color, mode = "still" }) {
  return (
    <svg viewBox="0 0 20 14" className={`mini-blip ${mode}`} width="20" height="14">
      <rect x="1" y="3" width="14" height="7" rx="2" fill="none" stroke={color} strokeWidth="1.2" />
      <circle className="mini-wheel" cx="4" cy="11" r="1.5" fill="none" stroke={color} strokeWidth="1" />
      <circle className="mini-wheel" cx="12" cy="11" r="1.5" fill="none" stroke={color} strokeWidth="1" />
      <circle className="mini-pulse" cx="17" cy="5.5" r="1.4" fill={color} />
    </svg>
  );
}

/* =========================================================================
   TRAIN SIM PANEL — live blueprint-HUD train simulation inside the drawer
   Driven by the actual train's health data (not decorative-only).
========================================================================= */
function TrainSimPanel({ train, status, sig }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 350);
    return () => clearInterval(id);
  }, []);

  const running = status === "ACTIVE";
  const halted = status === "MAINTENANCE";
  const motorHealth = train.tractionMotorHealth ?? 90;
  const brakeWear = train.brakePadWear ?? 15;
  const battery = train.batteryHealth ?? 90;

  // ---- DEMO MODE -----------------------------------------------------
  // Motor / Brake / Battery % above are the REAL per-train sensor fields
  // (train.tractionMotorHealth, train.brakePadWear, train.batteryHealth)
  // pulled straight from Supabase — those are not faked.
  // Speed & RPM below ARE demo-simulated: they're derived FROM those
  // sensor values (not random), but there's no live telemetry feed yet.
  // To go from demo → real: replace this block with a subscription to
  // your actual sensor/telemetry table (e.g. Supabase realtime channel
  // on a `train_telemetry` table) and set speed/rpm straight from it.
  const maxSpeed = 60 + (motorHealth / 100) * 30;      // weaker motor → lower ceiling
  const brakeDrag = (brakeWear / 100) * 12;             // worn brakes → shaves off top speed
  const jitter = Math.sin(tick / 5) * (motorHealth / 100) * 4;
  const targetSpeed = running ? maxSpeed - brakeDrag + jitter : halted ? 0 : (maxSpeed / 4) + jitter;
  const speed = Math.max(0, targetSpeed).toFixed(0);
  const rpm = running ? (motorHealth * 27 + jitter * 15).toFixed(0) : "0";
  const motorColor = motorHealth > 80 ? "#39E68B" : motorHealth > 50 ? "#FFC93B" : "#FF4D4D";
  const brakeColor = brakeWear > 60 ? "#FF4D4D" : brakeWear > 30 ? "#FFC93B" : "#39E68B";

  // simple speedometer arc: 0-100 mapped to -120deg..120deg
  const arcPct = Math.min(100, Number(speed));
  const arcDeg = -120 + (arcPct / 100) * 240;
  const arcRad = (arcDeg * Math.PI) / 180;
  const needleX = 60 + 34 * Math.sin(arcRad);
  const needleY = 60 - 34 * Math.cos(arcRad);

  return (
    <div className="sim-panel">
      <div className="sim-panel-head">
        <Radio size={12} /> LIVE UNIT SIMULATION — {train.id}
        <span className="sim-demo-badge">DEMO MODE — SPEED/RPM MODELED FROM SENSOR %</span>
        <span className="sim-status" style={{ color: sig.color }}>{halted ? "HALTED" : running ? "IN MOTION" : "IDLE"}</span>
      </div>

      <svg viewBox="0 0 760 150" className="sim-svg">
        <defs>
          <pattern id={`simGrid-${train.id}`} width="18" height="18" patternUnits="userSpaceOnUse">
            <path d="M18 0H0V18" fill="none" stroke="#123024" strokeWidth="0.5" />
          </pattern>
          <filter id={`simGlow-${train.id}`} x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur stdDeviation="2.6" result="b" />
            <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>
        <rect x="0" y="0" width="760" height="150" fill="#081310" />
        <rect x="0" y="0" width="760" height="150" fill={`url(#simGrid-${train.id})`} />
        <line x1="0" y1="128" x2="760" y2="128" stroke="#1F3B30" strokeWidth="1" strokeDasharray="2 6" />

        {/* HUD corner brackets */}
        <g stroke={sig.color} strokeWidth="1.6" fill="none" opacity="0.55">
          <path d="M8,8 L8,24 M8,8 L24,8" />
          <path d="M752,8 L752,24 M752,8 L736,8" />
          <path d="M8,142 L8,126 M8,142 L24,142" />
          <path d="M752,142 L752,126 M752,142 L736,142" />
        </g>

        {/* moving wireframe train, position depends on running state */}
        <g
          className={halted ? "sim-unit halted" : running ? "sim-unit running" : "sim-unit idle"}
          filter={`url(#simGlow-${train.id})`}
        >
          <g stroke={halted ? "#FF4D4D" : "#39E68B"} strokeWidth="1.4" fill="none" opacity="0.95">
            <path d="M0,95 L0,60 Q0,44 16,43 L150,43 Q164,43 174,53 L196,80
                     Q200,84 200,90 L200,95 Z" />
            {[...Array(3)].map((_, i) => (
              <rect key={i} x={10 + i * 42} y="55" width="32" height="20" rx="3" />
            ))}
            <path d="M78,43 L78,28 L92,20 L92,12 M78,43 L78,28 L64,20 L64,12" />
            <rect x="58" y="9" width="38" height="3.5" rx="1.5" />
          </g>
          <circle className="sim-spark" cx="78" cy="11" r="4" fill="#BFF7DD" />
          <circle cx="190" cy="90" r="4" fill={halted ? "#FF4D4D" : "#39E68B"} />
          <g transform="translate(30,95)">
            <circle className="sim-wheel" cx="0" cy="10" r="7" fill="none" stroke={brakeColor} strokeWidth="1.4" />
            <circle className="sim-wheel" cx="22" cy="10" r="7" fill="none" stroke={brakeColor} strokeWidth="1.4" />
          </g>
          <g transform="translate(148,95)">
            <circle className="sim-wheel" cx="0" cy="10" r="7" fill="none" stroke={brakeColor} strokeWidth="1.4" />
            <circle className="sim-wheel" cx="22" cy="10" r="7" fill="none" stroke={brakeColor} strokeWidth="1.4" />
          </g>
        </g>

        {/* speedometer gauge */}
        <g transform="translate(600,0)">
          <path d="M26,84 A34,34 0 1 1 94,84" fill="none" stroke="#1F3B30" strokeWidth="6" />
          <path
            d="M26,84 A34,34 0 1 1 94,84"
            fill="none" stroke={sig.color} strokeWidth="6"
            strokeDasharray={`${(arcPct / 100) * 160} 400`}
          />
          <line x1="60" y1="84" x2={needleX} y2={needleY} stroke="#EAF7F0" strokeWidth="2" />
          <circle cx="60" cy="84" r="3" fill="#EAF7F0" />
          <text x="60" y="106" textAnchor="middle" fontFamily="'IBM Plex Mono',monospace" fontSize="12" fill="#EAF7F0">{speed}</text>
          <text x="60" y="118" textAnchor="middle" fontFamily="'IBM Plex Mono',monospace" fontSize="8" fill="#5C7A6C">KM/H</text>
        </g>

        {/* live readouts */}
        <g fontFamily="'IBM Plex Mono',monospace" fontSize="10" fill="#39E68B">
          <text x="10" y="140">MOTOR {motorHealth}%</text>
          <text x="120" y="140" fill={brakeColor}>BRAKE {brakeWear}%</text>
          <text x="230" y="140">BATT {battery}%</text>
          <text x="330" y="140">RPM {rpm}</text>
        </g>
      </svg>
    </div>
  );
}

/* =========================================================================
   TRAIN DETAIL DRAWER
========================================================================= */
function Drawer({ train, isHod, approverName, complaints, onChange, onApprove, onRevoke, onClose, onLog, onFinalize }) {
  const [modal, setModal] = useState(null); // null | "approve" | "checks"
  const status = deriveStatus(train);
  const sig = SIGNAL[status];

  const { link: qrLink, qrImg } = qrInfoFor(train.id);

  const trainComplaints = (complaints || []).slice().sort((a, b) => new Date(b.ts) - new Date(a.ts));
  const openComplaints = trainComplaints.filter((c) => c.status === "OPEN");

  const nextDueKm = SERVICE_INTERVAL_KM - train.mileageSinceService;
  const overdue = nextDueKm <= 0;

  const checklistItems = [
    ...SERVICE_TYPES.map((s) => ({ id: s.type, label: s.type, note: s.note, isComplaint: false })),
    ...openComplaints.map((c) => ({
      id: c.id,
      label: `Fix passenger complaint: ${c.issue}`,
      note: `${c.compartment}${c.description ? " — " + c.description : ""}`,
      isComplaint: true,
    })),
  ];

  const field = (label, value, onSet, type = "number") => (
    <div className="field-row">
      <span className="field-label">{label}</span>
      {type === "checkbox" ? (
        <input type="checkbox" checked={value} onChange={(e) => onSet(e.target.checked)} />
      ) : (
        <input type={type} value={value} onChange={(e) => onSet(type === "number" ? Number(e.target.value) : e.target.value)} />
      )}
    </div>
  );

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <div>
            <div className="drawer-eyebrow">{train.id} · BAY {train.bay}</div>
            <div className="drawer-title">{train.name.toUpperCase()}</div>
          </div>
          <button className="icon-x" onClick={onClose}><X size={18} /></button>
        </div>

        <div className="signal-strip" style={{ borderColor: sig.color, boxShadow: `0 0 18px ${sig.glow}` }}>
          <span className="led" style={{ background: sig.color, boxShadow: `0 0 8px ${sig.color}` }} />
          <span style={{ color: sig.color }}>{sig.label}</span>
        </div>
        <div className="drawer-reason">{reasonFor(train, status)}</div>

        <TrainSimPanel train={train} status={status} sig={sig} />

        <div className="drawer-section-title"><Zap size={12} /> TRACTION &amp; ELECTRICAL HEALTH</div>
        <div className="health-grid">
          <div className="health-tile">
            <div className="health-icon"><Gauge size={13} /></div>
            <div className="health-value">{train.tractionMotorHealth}%</div>
            <div className="health-label">Traction Motor</div>
            <div className="health-bar"><div className="health-bar-fill" style={{ width: `${train.tractionMotorHealth}%`, background: train.tractionMotorHealth > 80 ? "#39E68B" : "#FFC93B" }} /></div>
          </div>
          <div className="health-tile">
            <div className="health-icon"><Wrench size={13} /></div>
            <div className="health-value">{train.brakePadWear}%</div>
            <div className="health-label">Brake Pad Wear</div>
            <div className="health-bar"><div className="health-bar-fill" style={{ width: `${train.brakePadWear}%`, background: train.brakePadWear > 30 ? "#FF4D4D" : "#39E68B" }} /></div>
          </div>
          <div className="health-tile">
            <div className="health-icon"><Battery size={13} /></div>
            <div className="health-value">{train.batteryHealth}%</div>
            <div className="health-label">Battery Health</div>
            <div className="health-bar"><div className="health-bar-fill" style={{ width: `${train.batteryHealth}%`, background: train.batteryHealth > 85 ? "#39E68B" : "#FFC93B" }} /></div>
          </div>
          <div className="health-tile">
            <div className="health-icon"><Wind size={13} /></div>
            <div className="health-value" style={{ fontSize: 12 }}>{train.hvacStatus}</div>
            <div className="health-label">HVAC Status</div>
          </div>
          <div className="health-tile">
            <div className="health-icon"><Zap size={13} /></div>
            <div className="health-value">{train.energyConsumptionKwhKm}</div>
            <div className="health-label">kWh / km</div>
          </div>
          <div className="health-tile">
            <div className="health-icon"><Gauge size={13} /></div>
            <div className="health-value">{train.regenBrakingEfficiency}%</div>
            <div className="health-label">Regen Braking Eff.</div>
          </div>
        </div>
        <div className="mileage-strip">
          <span>Total mileage: <strong>{train.mileageKm.toLocaleString()} km</strong></span>
          <span>Since last service: <strong>{train.mileageSinceService.toLocaleString()} km</strong></span>
        </div>
        <div className={`next-service-strip ${overdue ? "overdue" : ""}`}>
          {overdue ? (
            <span className="next-service-warn"><AlertTriangle size={12} /> SERVICE OVERDUE by {Math.abs(nextDueKm).toLocaleString()} km</span>
          ) : (
            <span>Next service due in <strong>{nextDueKm.toLocaleString()} km</strong> <em>(interval: every {SERVICE_INTERVAL_KM.toLocaleString()} km)</em></span>
          )}
          {status === "ACTIVE" && (
            <span className="live-rate"><Radio size={10} /> LIVE · ~{train.mileageRatePerHour} km/h in service</span>
          )}
        </div>

        <div className="drawer-section-title"><ClipboardList size={12} /> CURRENT SERVICE ACTIVITY — WHAT'S HAPPENING NOW</div>
        <div className="activity-list">
          {[
            { task: "Job-card / defect clearance", done: !train.jobCardOpen, who: train.assignedOperator },
            { task: "Fitness certificate verification", done: train.certDaysLeft > 2, who: train.assignedOperator },
            { task: "Cleaning & detailing", done: train.lastCleanedDaysAgo <= 1, who: train.assignedOperator },
            { task: "Branding / SLA wrap check", done: train.brandingHoursPending === 0, who: train.assignedOperator },
            { task: "Final HOD sign-off", done: train.approved, who: "Head of Department" },
          ].map((a, i) => (
            <div className="activity-row" key={i}>
              <CircleIcon size={9} fill={a.done ? "#39E68B" : "#FFC93B"} color={a.done ? "#39E68B" : "#FFC93B"} />
              <span className="activity-task">{a.task}</span>
              <span className="activity-status" style={{ color: a.done ? "#39E68B" : "#FFC93B" }}>
                {a.done ? "DONE" : "IN PROGRESS"}
              </span>
              <span className="activity-who">{a.who}</span>
            </div>
          ))}
        </div>

        <div className="drawer-section-title"><History size={12} /> LAST SERVICE RECORD</div>
        <div className="last-service-box">
          <div className="last-service-row"><span>Date</span><strong>{train.lastServiceDate}</strong></div>
          <div className="last-service-row"><span>Type</span><strong>{train.lastServiceType}</strong></div>
          <div className="last-service-row"><span>Approved by</span><strong>{train.lastServiceApprovedBy}</strong></div>
          <div className="last-service-notes">{train.lastServiceNotes}</div>
        </div>

        <div className="drawer-section-title"><AlertTriangle size={12} /> PASSENGER COMPLAINTS — {openComplaints.length} OPEN</div>
        <div className="complaint-list">
          {trainComplaints.length === 0 && <div className="log-empty" style={{ padding: "16px" }}>No complaints reported on this train yet.</div>}
          {trainComplaints.map((c) => (
            <div className={`complaint-item ${c.status === "OPEN" ? "open" : "resolved"}`} key={c.id}>
              <div className="complaint-item-head">
                <span className="complaint-issue">{c.issue}</span>
                <span className="complaint-status">{c.status}</span>
              </div>
              <div className="complaint-meta">{c.compartment} · {new Date(c.ts).toLocaleString("en-IN", { hour12: false })}</div>
              {c.description && <div className="complaint-desc">{c.description}</div>}
            </div>
          ))}
        </div>

        <div className="drawer-section-title"><ClipboardList size={12} /> PASSENGER COMPLAINT QR</div>
        <div className="qr-box">
          <img src={qrImg} alt={`Complaint QR for ${train.id}`} className="qr-img" />
          <div className="qr-info">
            <div className="qr-note">
              Passengers scan this on board {train.name} to report an issue — it's auto-tagged to this
              train and pulled into the next service finalization checklist.
            </div>
            <div className="qr-link mono">{qrLink}</div>
          </div>
        </div>

        <div className="drawer-section-title"><History size={12} /> SERVICE HISTORY LOG</div>
        <div className="history-list">
          {train.serviceHistory.map((h, i) => (
            <div className="history-item" key={i}>
              <div className="history-item-head">
                <span className="history-date">{h.date}</span>
                <span className="history-type">{h.type}</span>
                <span className="history-duration">{h.durationHrs}h</span>
              </div>
              <div className="history-notes">{h.workDone}</div>
              <div className="history-approver">Approved by {h.approvedBy}</div>
            </div>
          ))}
        </div>

        <div className="drawer-section-title">EDITABLE PARAMETERS — {isHod ? "HOD" : "OPERATOR"} ACCESS</div>
        <div className="field-grid">
          {field("MILEAGE (KM)", train.mileageKm, (v) => onChange(train.id, "mileageKm", v))}
          {field("CERT DAYS LEFT", train.certDaysLeft, (v) => onChange(train.id, "certDaysLeft", v))}
          {field("BRANDING HRS PENDING", train.brandingHoursPending, (v) => onChange(train.id, "brandingHoursPending", v))}
          {field("LAST CLEANED (D AGO)", train.lastCleanedDaysAgo, (v) => onChange(train.id, "lastCleanedDaysAgo", v))}
          {field("JOB-CARD OPEN", train.jobCardOpen, (v) => onChange(train.id, "jobCardOpen", v), "checkbox")}
          <div className="field-row">
            <span className="field-label">ALL CHECKS COMPLETE</span>
            <input
              type="checkbox"
              checked={train.checksComplete}
              onChange={(e) => {
                if (e.target.checked) setModal("checks");
                else onChange(train.id, "checksComplete", false);
              }}
            />
          </div>
        </div>

        <div className="drawer-section-title">INDUCTION AUTHORITY</div>
        {isHod ? (
          <div className="authority-box">
            <p className="authority-note">
              Only Head of Department may certify a train ACTIVE. Approval requires
              confirming every servicing item on the finalization checklist below.
            </p>
            <button
              className="approve-btn"
              disabled={status !== "PENDING"}
              onClick={() => setModal("approve")}
            >
              <ShieldCheck size={15} /> APPROVE FOR ACTIVE SERVICE
            </button>
            {status === "ACTIVE" && (
              <button
                className="revoke-btn"
                onClick={() => {
                  onRevoke(train.id);
                  onLog(train.id, train.name, "APPROVAL REVOKED", "Returned to standby from active service.", approverName);
                }}
              >
                REVOKE APPROVAL → RETURN TO STANDBY
              </button>
            )}
          </div>
        ) : (
          <div className="authority-box readonly">
            <p className="authority-note">
              You can update servicing data above. Final certification to ACTIVE SERVICE
              requires Head of Department sign-off.
            </p>
          </div>
        )}
      </div>

      {modal === "checks" && (
        <ChecklistModal
          title="SERVICE FINALIZATION CHECKLIST"
          subtitle={`${train.name} · confirm every item actually serviced${openComplaints.length ? " (incl. open passenger complaints)" : ""}`}
          items={checklistItems}
          confirmLabel="MARK CHECKS COMPLETE"
          onCancel={() => setModal(null)}
          onConfirm={(done) => {
            const serviceLabels = done.filter((d) => !d.isComplaint).map((d) => d.label);
            const complaintIds = done.filter((d) => d.isComplaint).map((d) => d.id);
            onChange(train.id, "checksComplete", true);
            onFinalize(train.id, serviceLabels.length ? serviceLabels : done.map((d) => d.label), complaintIds);
            onLog(
              train.id,
              train.name,
              "SERVICE CHECKLIST COMPLETED",
              done.map((d) => d.label).join(", "),
              approverName
            );
            setModal(null);
          }}
        />
      )}

      {modal === "approve" && (
        <ChecklistModal
          title="FINAL INDUCTION SIGN-OFF"
          subtitle={`${train.name} · confirm servicing before certifying ACTIVE${openComplaints.length ? " (incl. open passenger complaints)" : ""}`}
          items={checklistItems}
          confirmLabel="CONFIRM & APPROVE FOR SERVICE"
          onCancel={() => setModal(null)}
          onConfirm={(done) => {
            const serviceLabels = done.filter((d) => !d.isComplaint).map((d) => d.label);
            const complaintIds = done.filter((d) => d.isComplaint).map((d) => d.id);
            onApprove(train.id);
            onFinalize(train.id, serviceLabels.length ? serviceLabels : done.map((d) => d.label), complaintIds);
            onLog(
              train.id,
              train.name,
              "APPROVED FOR ACTIVE SERVICE",
              done.map((d) => d.label).join(", "),
              approverName
            );
            setModal(null);
          }}
        />
      )}
    </div>
  );
}

/* =========================================================================
   PASSENGER QUERIES — dedicated dashboard tab.
   Every query a passenger raises by scanning the in-train QR code lands
   here across the whole fleet. HOD reviews each one, assigns an expected
   completion date, and sends it to Service; status then tracks it through
   to resolution. Backed live by the Supabase `complaints` table.
========================================================================= */
const PQ_STATUS_META = {
  OPEN:             { label: "OPEN — NEW", color: "#FF4D4D" },
  UNDER_REVIEW:     { label: "UNDER HOD REVIEW", color: "#FFC93B" },
  SENT_TO_SERVICE:  { label: "SENT TO SERVICE", color: "#3FC8FF" },
  RESOLVED:         { label: "RESOLVED", color: "#39E68B" },
};
const PQ_STATUS_ORDER = ["OPEN", "UNDER_REVIEW", "SENT_TO_SERVICE", "RESOLVED"];

function PassengerQueryRow({ c, isHod, onUpdate }) {
  const [date, setDate] = useState(c.expectedCompletionDate || "");
  const [saving, setSaving] = useState(false);
  const meta = PQ_STATUS_META[c.status] || PQ_STATUS_META.OPEN;

  const setStatus = async (status) => {
    setSaving(true);
    const patch = { status };
    if (status === "UNDER_REVIEW") patch.reviewedBy = c.reviewedByPending || "HOD";
    if (status === "SENT_TO_SERVICE") {
      patch.sentToServiceAt = new Date().toISOString();
      if (date) patch.expectedCompletionDate = date;
    }
    if (status === "RESOLVED") {
      patch.resolvedBy = "HOD";
      patch.resolvedTs = new Date().toISOString();
    }
    await onUpdate(c.id, patch);
    setSaving(false);
  };

  const saveDate = async () => {
    if (!date) return;
    setSaving(true);
    await onUpdate(c.id, { expectedCompletionDate: date });
    setSaving(false);
  };

  return (
    <div className="pq-row">
      <div className="pq-row-top">
        <span className="pq-train mono">{c.trainId}</span>
        <span className="pq-train-name">{c.trainName}</span>
        <span className="pq-compartment">{c.compartment}</span>
        <span className="pq-status-chip" style={{ color: meta.color, borderColor: meta.color }}>{meta.label}</span>
      </div>
      <div className="pq-row-mid">
        <span className="pq-issue"><MessageSquareWarning size={13} /> {c.issue}</span>
        {c.description && <span className="pq-desc">{c.description}</span>}
      </div>
      <div className="pq-row-bottom">
        <span className="pq-ts mono">{new Date(c.ts).toLocaleString("en-IN", { hour12: false })}</span>
        {c.expectedCompletionDate && (
          <span className="pq-expected"><CalendarClock size={12} /> Expected: {c.expectedCompletionDate}</span>
        )}
        {isHod && c.status !== "RESOLVED" && (
          <div className="pq-actions">
            {c.status === "OPEN" && (
              <button className="pq-btn" disabled={saving} onClick={() => setStatus("UNDER_REVIEW")}>
                REVIEW
              </button>
            )}
            {(c.status === "OPEN" || c.status === "UNDER_REVIEW") && (
              <>
                <input
                  type="date"
                  className="pq-date-input"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  onBlur={saveDate}
                />
                <button className="pq-btn send" disabled={saving} onClick={() => setStatus("SENT_TO_SERVICE")}>
                  <Send size={11} /> SEND TO SERVICE
                </button>
              </>
            )}
            {c.status === "SENT_TO_SERVICE" && (
              <button className="pq-btn resolve" disabled={saving} onClick={() => setStatus("RESOLVED")}>
                <CheckCircle2 size={11} /> MARK RESOLVED
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function PassengerQueries({ complaints, isHod, onUpdate }) {
  const [statusFilter, setStatusFilter] = useState("ALL");
  const filtered = complaints.filter((c) => statusFilter === "ALL" || c.status === statusFilter);
  const counts = useMemo(() => {
    const c = { OPEN: 0, UNDER_REVIEW: 0, SENT_TO_SERVICE: 0, RESOLVED: 0 };
    complaints.forEach((x) => { if (c[x.status] !== undefined) c[x.status] += 1; });
    return c;
  }, [complaints]);

  return (
    <section className="pq-panel">
      <div className="pq-summary">
        {PQ_STATUS_ORDER.map((s) => (
          <button
            key={s}
            className={statusFilter === s ? "pq-summary-tile on" : "pq-summary-tile"}
            style={{ borderColor: PQ_STATUS_META[s].color }}
            onClick={() => setStatusFilter(statusFilter === s ? "ALL" : s)}
          >
            <span className="pq-summary-value" style={{ color: PQ_STATUS_META[s].color }}>{counts[s]}</span>
            <span className="pq-summary-label">{PQ_STATUS_META[s].label}</span>
          </button>
        ))}
      </div>
      {!isHod && (
        <div className="pq-view-note">
          VIEW ONLY — SIGN IN AS HEAD OF DEPARTMENT TO REVIEW, ASSIGN A COMPLETION DATE, AND SEND TO SERVICE.
        </div>
      )}
      <div className="pq-list">
        {filtered.length === 0 && (
          <div className="log-empty" style={{ padding: "24px" }}>No passenger queries in this category.</div>
        )}
        {filtered.map((c) => (
          <PassengerQueryRow key={c.id} c={c} isHod={isHod} onUpdate={onUpdate} />
        ))}
      </div>
    </section>
  );
}

/* =========================================================================
   MAINTENANCE LOG — per-train log across all 25 trains.
   Merges seeded service history with live (session) actions so every
   approval / checklist completion shows up here immediately.
========================================================================= */
function MaintenanceLog({ fleet, activityLog, complaints }) {
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState(fleet[0]?.id ?? null);

  const filteredTrains = fleet.filter(
    (t) =>
      t.name.toLowerCase().includes(query.toLowerCase()) ||
      t.id.toLowerCase().includes(query.toLowerCase())
  );

  const selected = fleet.find((t) => t.id === selectedId) || filteredTrains[0] || null;

  const entries = useMemo(() => {
    if (!selected) return [];
    const live = activityLog
      .filter((l) => l.trainId === selected.id)
      .map((l) => ({ ...l, kind: "live", sortTs: l.ts.getTime() }));
    const historical = selected.serviceHistory.map((h) => ({
      id: `${selected.id}-${h.date}-${h.type}`,
      action: h.type,
      detail: h.workDone,
      by: h.approvedBy,
      dateLabel: h.date,
      kind: "history",
      sortTs: new Date(h.date).getTime(),
    }));
    const complaintEntries = (complaints || [])
      .filter((c) => c.trainId === selected.id)
      .map((c) => ({
        id: c.id,
        action: c.status === "OPEN" ? "PASSENGER COMPLAINT — OPEN" : "PASSENGER COMPLAINT — RESOLVED",
        detail: `${c.issue} · ${c.compartment}${c.description ? " — " + c.description : ""}`,
        by: c.status === "RESOLVED" ? `Resolved by ${c.resolvedBy}` : "Reported by passenger via QR",
        kind: c.status === "OPEN" ? "complaint-open" : "complaint-resolved",
        ts: new Date(c.ts),
        sortTs: new Date(c.ts).getTime(),
      }));
    return [...live, ...historical, ...complaintEntries].sort((a, b) => b.sortTs - a.sortTs);
  }, [selected, activityLog, complaints]);

  return (
    <section className="log-wrap">
      <div className="log-sidebar">
        <div className="search-field log-search">
          <Search size={14} />
          <input placeholder="SEARCH TRAIN — ID / NAME" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <div className="log-train-list">
          {filteredTrains.map((t) => {
            const openCount = (complaints || []).filter((c) => c.trainId === t.id && c.status === "OPEN").length;
            return (
              <button
                key={t.id}
                className={`log-train-row ${selected?.id === t.id ? "on" : ""}`}
                onClick={() => setSelectedId(t.id)}
              >
                <span className="led sm" style={{ background: SIGNAL[t.status].color, boxShadow: `0 0 6px ${SIGNAL[t.status].color}` }} />
                <span className="log-train-name">
                  {t.name}
                  {openCount > 0 && <span className="complaint-badge">⚠ {openCount}</span>}
                </span>
                <span className="log-train-id mono">{t.id}</span>
                <span className="log-train-date mono">{t.lastServiceDate}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="log-detail">
        {selected ? (
          <>
            <div className="log-detail-head">
              <div>
                <div className="drawer-eyebrow">{selected.id} · BAY {selected.bay}</div>
                <div className="drawer-title">{selected.name.toUpperCase()} — MAINTENANCE LOG</div>
              </div>
              <span className="row-status" style={{ color: SIGNAL[selected.status].color }}>
                <span className="led sm" style={{ background: SIGNAL[selected.status].color }} />
                {SIGNAL[selected.status].label}
              </span>
            </div>
            <div className="log-entries">
              {entries.map((e) => (
                <div className={`log-entry ${e.kind}`} key={e.id}>
                  <div className="log-entry-head">
                    <span className="log-entry-date mono">
                      {e.kind === "history" ? e.dateLabel : e.ts.toLocaleString("en-IN", { hour12: false })}
                    </span>
                    <span className="log-entry-action">{e.action}</span>
                    {e.kind !== "history" && <span className={`log-live-badge ${e.kind === "complaint-open" ? "warn" : ""}`}>
                      {e.kind === "live" ? "LIVE" : e.kind === "complaint-open" ? "OPEN" : "RESOLVED"}
                    </span>}
                  </div>
                  <div className="log-entry-detail">{e.detail}</div>
                  <div className="log-entry-by">By {e.by}</div>
                </div>
              ))}
              {entries.length === 0 && <div className="log-empty">NO MAINTENANCE RECORDS YET</div>}
            </div>
          </>
        ) : (
          <div className="log-empty">NO TRAIN SELECTED</div>
        )}
      </div>
    </section>
  );
}

/* =========================================================================
   MAIN CONSOLE
========================================================================= */
/* =========================================================================
   INDUCTION PRIORITY PLAN
   P1 / P2 / P3 risk-ranked induction queue + trip-capacity predictions.
========================================================================= */
function InductionPlan({ fleet, onSelect, isHod, onOverride, overrides }) {
  const ranked = useMemo(() => {
    return fleet
      .slice()
      .sort((a, b) => {
        const order = { P1: 0, P2: 1, P3: 2 };
        if (order[a.priority] !== order[b.priority]) return order[a.priority] - order[b.priority];
        return b.riskScore - a.riskScore;
      });
  }, [fleet]);

  const counts = { P1: 0, P2: 0, P3: 0 };
  fleet.forEach((t) => (counts[t.priority] += 1));

  const needsMaintenanceFirst = ranked.filter((t) => t.priority === "P1" && t.status !== "MAINTENANCE");

  return (
    <>
      <section className="status-panel">
        {["P1", "P2", "P3"].map((p) => (
          <div className="status-tile" key={p} style={{ borderColor: PRIORITY_META[p].color }}>
            <span className="led" style={{ background: PRIORITY_META[p].color, boxShadow: `0 0 7px ${PRIORITY_META[p].color}` }} />
            <div className="status-tile-value">{counts[p]}</div>
            <div className="status-tile-label">{PRIORITY_META[p].label}</div>
          </div>
        ))}
        <div className="status-tile" style={{ borderColor: "#3FC8FF" }}>
          <span className="led" style={{ background: "#3FC8FF", boxShadow: "0 0 7px #3FC8FF" }} />
          <div className="status-tile-value">{MAX_RIDES_PER_SERVICE_CYCLE}</div>
          <div className="status-tile-label">MAX SINGLE-COVERS / SERVICE CYCLE</div>
        </div>
      </section>

      <section className="schematic" style={{ marginBottom: 18 }}>
        <div className="section-title">ROUTE &amp; CAPACITY REFERENCE — ALUVA ↔ TRIPUNITHURA</div>
        <div className="route-ref-grid">
          <div><span className="route-ref-label">Line span</span><span className="route-ref-val">{ONE_WAY_KM.toFixed(2)} km · 25 stations</span></div>
          <div><span className="route-ref-label">One-way run time</span><span className="route-ref-val">~{ONE_WAY_MINUTES} min</span></div>
          <div><span className="route-ref-label">Turnaround / dwell</span><span className="route-ref-val">{TURNAROUND_MINUTES} min each end</span></div>
          <div><span className="route-ref-label">Service window</span><span className="route-ref-val">06:00 – 22:30 (Sun from 07:30)</span></div>
          <div><span className="route-ref-label">Frequency</span><span className="route-ref-val">~8 min peak · 10-15 min non-peak</span></div>
          <div><span className="route-ref-label">Service interval</span><span className="route-ref-val">{SERVICE_INTERVAL_KM.toLocaleString()} km</span></div>
          <div><span className="route-ref-label">Max single-covers before next service</span><span className="route-ref-val">{MAX_RIDES_PER_SERVICE_CYCLE} rides</span></div>
        </div>
        <div className="route-ref-note">
          These are the fixed rules the induction plan below is derived from: how far one single cover (one-way run) is,
          how many a train can do before it's due for service, and the priority order trains should be pulled in for maintenance.
        </div>
      </section>

      {needsMaintenanceFirst.length > 0 && (
        <div className="complaints-banner" style={{ borderColor: "#FF4D4D", color: "#FF4D4D" }}>
          <AlertTriangle size={14} />
          <strong>{needsMaintenanceFirst.length}</strong> P1 (high-risk) train{needsMaintenanceFirst.length > 1 ? "s" : ""} should be routed to
          maintenance before being sent to standby/active — {needsMaintenanceFirst.map((t) => t.name).join(", ")}.
        </div>
      )}

      <section className="registry">
        <div className="registry-head plan-head">
          <span>ID</span><span>NAME</span><span>PRIORITY</span><span>RISK</span>
          <span>KM SINCE SVC</span><span>KM TO NEXT SVC</span><span>SINGLE-COVERS LEFT</span><span>EST. DAYS TO SVC</span>
        </div>
        {ranked.map((t) => {
          const pm = PRIORITY_META[t.priority];
          const ov = overrides[t.id];
          return (
            <div key={t.id} className="plan-row-wrap">
              <button className="registry-row plan-row" onClick={() => onSelect(t.id)}>
                <span className="mono">{t.id}</span>
                <span className="row-name">{t.name}</span>
                <span className="row-status" style={{ color: pm.color }}>
                  <span className="led sm" style={{ background: pm.color }} /> {t.priority}
                </span>
                <span className="mono">{t.riskScore}</span>
                <span className="mono">{t.mileageSinceService.toLocaleString()} km</span>
                <span className="mono">{t.kmToService.toLocaleString()} km</span>
                <span className="mono">{t.ridesRemaining}</span>
                <span className="mono">{t.predictedDays}d</span>
              </button>
              <div className="plan-reason-row">
                <span className="plan-reason-text"><em>Why:</em> {t.reason}</span>
                {isHod && t.priority === "P1" && (
                  <button className="override-btn" onClick={() => onOverride(t)}>
                    {ov ? "EDIT OVERRIDE" : "OVERRIDE"}
                  </button>
                )}
              </div>
              {ov && (
                <div className="plan-override-note">
                  <History size={11} /> HOD override by {ov.by}: "{ov.note}"
                </div>
              )}
            </div>
          );
        })}
      </section>
      <div className="route-ref-note" style={{ marginTop: -6 }}>
        Risk score and days-to-service are a rule-based heuristic combining job-card status, certificate expiry, component
        health %, and live mileage rate — a demo predictive model, not a trained ML system.
      </div>
    </>
  );
}

/* =========================================================================
   LIVE OPS MAP
   Simulated real-time positions along the Aluva-Tripunithura line, driven
   by the app clock (no external live-GPS feed exists publicly for this).
========================================================================= */
function LiveMap({ fleet, clock, onSelect }) {
  const running = fleet.filter((t) => t.live.mode !== "DEPOT");
  const atDepot = fleet.filter((t) => t.live.mode === "DEPOT");
  const depotPct = (STATION_KM[DEPOT_STATION_IDX] / ONE_WAY_KM) * 100;

  return (
    <>
      <section className="status-panel" style={{ gridTemplateColumns: "repeat(3, 1fr)" }}>
        <div className="status-tile" style={{ borderColor: "#39E68B" }}>
          <span className="led" style={{ background: "#39E68B", boxShadow: "0 0 7px #39E68B" }} />
          <div className="status-tile-value">{running.length}</div>
          <div className="status-tile-label">RUNNING ON LINE</div>
        </div>
        <div className="status-tile" style={{ borderColor: "#5C7A6C" }}>
          <span className="led" style={{ background: "#5C7A6C" }} />
          <div className="status-tile-value">{atDepot.length}</div>
          <div className="status-tile-label">AT MUTTOM DEPOT</div>
        </div>
        <div className="status-tile" style={{ borderColor: "#3FC8FF" }}>
          <span className="led" style={{ background: "#3FC8FF", boxShadow: "0 0 7px #3FC8FF" }} />
          <div className="status-tile-value">{clock.toLocaleTimeString("en-IN", { hour12: false })}</div>
          <div className="status-tile-label">SIM CLOCK</div>
        </div>
      </section>

      <section className="schematic" style={{ marginBottom: 18 }}>
        <div className="section-title">LIVE LINE SCHEMATIC — ALUVA ↔ TRIPUNITHURA (SIMULATED)</div>
        <div className="line-track-wrap">
          <div className="line-track">
            <span className="line-endpoint left">ALUVA</span>
            <span className="line-endpoint right">TRIPUNITHURA</span>
            <div className="depot-marker" style={{ left: `${depotPct}%` }} title="Muttom Depot">
              <div className="depot-dot" /><span className="depot-label">DEPOT</span>
            </div>
            {STATION_KM.map((km, i) => (
              <div key={i} className="station-tick" style={{ left: `${(km / ONE_WAY_KM) * 100}%` }} />
            ))}
            {running.map((t) => (
              <button
                key={t.id}
                className={`train-marker dir-${t.live.dwellAt ? "dwell" : t.live.direction.toLowerCase()}`}
                style={{ left: `${t.live.pct}%`, "--tcolor": SIGNAL[t.status].color }}
                onClick={() => onSelect(t.id)}
                title={`${t.name} · ${t.live.direction} · next: ${t.live.nextStation}`}
              >
                <span className="train-marker-trail" />
                <span className="train-marker-body">
                  <Train size={12} strokeWidth={2.4} />
                </span>
                <span className="train-marker-label">{t.name}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="route-ref-note">
          Positions are computed live from each train's schedule cycle (one-way run + turnaround), not fetched from a
          KMRL live-GPS feed — no such public feed exists. Trains not in ACTIVE service show at Muttom Depot.
        </div>
        <div className="route-ref-note" style={{ marginTop: 4 }}>
          Real-world reference: KMRL's Blue Line fleet is 25 trainsets, of which typically only <strong>7–8 run on
          the line at the same time</strong> on a normal day — the rest are in standby, cleaning, or maintenance at
          Muttom Depot at any given moment. This demo intentionally lets the HOD approve any number ACTIVE so you can
          exercise the full workflow; it doesn't cap concurrent trains at that real-world figure.
        </div>
      </section>

      <div className="live-list-cols">
        <section className="registry" style={{ flex: 1 }}>
          <div className="registry-head live-head">
            <span>ID</span><span>NAME</span><span>DIR</span><span>NEXT STOP</span><span>ETA</span>
          </div>
          {running.length === 0 && <div className="empty-row">No trains currently running (outside service hours).</div>}
          {running.map((t) => (
            <button key={t.id} className="registry-row live-row" onClick={() => onSelect(t.id)}>
              <span className="mono">{t.id}</span>
              <span className="row-name">{t.name}</span>
              <span className="mono">{t.live.dwellAt ? "•" : t.live.direction === "UP" ? "→" : "←"}</span>
              <span className="mono">{t.live.dwellAt ? `At ${t.live.dwellAt}` : t.live.nextStation}</span>
              <span className="mono">{t.live.dwellAt ? "dwelling" : `${t.live.etaMinutes} min`}</span>
            </button>
          ))}
        </section>
        <section className="registry" style={{ flex: 1 }}>
          <div className="registry-head depot-head">
            <span>ID</span><span>NAME</span><span>STATUS</span><span>BAY</span>
          </div>
          {atDepot.map((t) => (
            <button key={t.id} className="registry-row depot-row" onClick={() => onSelect(t.id)}>
              <span className="mono">{t.id}</span>
              <span className="row-name">{t.name}</span>
              <span className="row-status" style={{ color: SIGNAL[t.status].color }}>
                <span className="led sm" style={{ background: SIGNAL[t.status].color }} /> {SIGNAL[t.status].label}
              </span>
              <span className="mono">B{t.bay}</span>
            </button>
          ))}
        </section>
      </div>
    </>
  );
}

function OverrideModal({ train, initialNote, onSave, onCancel }) {
  const [note, setNote] = useState(initialNote || "");
  return (
    <div className="drawer-backdrop" onClick={onCancel}>
      <div className="checklist-modal" onClick={(e) => e.stopPropagation()}>
        <div className="checklist-head">
          <ClipboardList size={17} />
          <div>
            <div className="checklist-title">HOD OVERRIDE — {train.name} ({train.id})</div>
            <div className="checklist-sub">
              AI-suggested priority: {PRIORITY_META[train.priority].label}. Record why you're overriding the
              suggested induction order — this is logged to the maintenance log for accountability.
            </div>
          </div>
          <button className="icon-x" onClick={onCancel}><X size={18} /></button>
        </div>
        <div style={{ padding: "0 20px 6px" }}>
          <textarea
            rows={4}
            placeholder="e.g. Spare rake unavailable tonight, holding this train in standby despite P1 flag..."
            value={note}
            onChange={(e) => setNote(e.target.value)}
            style={{ width: "100%" }}
          />
        </div>
        <button className="approve-btn" disabled={!note.trim()} onClick={() => onSave(note.trim())}>
          <ShieldCheck size={15} /> SAVE OVERRIDE NOTE
        </button>
      </div>
    </div>
  );
}

function Console({ user, onLogout }) {
  const [fleet, setFleet] = useState([]);
  const [fleetLoading, setFleetLoading] = useState(true);
  const [filter, setFilter] = useState("ALL");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState(null);
  const [clock, setClock] = useState(new Date());
  const [view, setView] = useState("FLEET"); // "FLEET" | "LOG" | "PLAN" | "MAP" | "PQUERIES"
  const [activityLog, setActivityLog] = useState([]);
  const [complaints, setComplaints] = useState([]);
  const [overrides, setOverrides] = useState({}); // trainId -> { note, by, ts }
  const [overrideTarget, setOverrideTarget] = useState(null); // train being overridden

  const logEvent = (trainId, trainName, action, detail, by) => {
    setActivityLog((prev) => [
      { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, ts: new Date(), trainId, trainName, action, detail, by },
      ...prev,
    ]);
  };

  const saveOverride = (note) => {
    if (!overrideTarget) return;
    setOverrides((prev) => ({ ...prev, [overrideTarget.id]: { note, by: user.name, ts: new Date() } }));
    logEvent(overrideTarget.id, overrideTarget.name, "HOD OVERRIDE", note, user.name);
    setOverrideTarget(null);
  };

  useEffect(() => {
    const id = setInterval(() => setClock(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  // Load the fleet from Supabase once on mount. If the `trains` table is
  // empty (schema.sql not run yet), fall back to the local mock generator
  // purely so the UI still renders — real data comes from Supabase once
  // supabase/schema.sql has been executed in your project.
  useEffect(() => {
    let alive = true;
    (async () => {
      const rows = await fetchFleetFromSupabase();
      if (!alive) return;
      setFleet(rows && rows.length ? rows : buildFleet());
      setFleetLoading(false);
    })();
    return () => { alive = false; };
  }, []);

  // Passenger queries live in Supabase now — fetch once, then subscribe to
  // realtime changes so a new QR-scan submission or an HOD update shows up
  // instantly on every open dashboard, across devices.
  useEffect(() => {
    let alive = true;
    (async () => {
      const rows = await fetchComplaints();
      if (alive) setComplaints(rows);
    })();
    const channel = supabase
      .channel("complaints-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "complaints" }, async () => {
        const rows = await fetchComplaints();
        if (alive) setComplaints(rows);
      })
      .subscribe();
    return () => {
      alive = false;
      supabase.removeChannel(channel);
    };
  }, []);

  // Live mileage simulation — trains in ACTIVE service rack up km in real time,
  // which counts down their "next service due" distance automatically. Also
  // pushed to Supabase every tick so the odometer persists across sessions.
  useEffect(() => {
    const id = setInterval(() => {
      setFleet((prev) =>
        prev.map((t) => {
          if (deriveStatus(t) !== "ACTIVE") return t;
          const jitter = 1 + seeded((Date.now() / 5000) % 1000 + t.number) * 0.6;
          const inc = Math.max(1, Math.round((t.mileageRatePerHour / 12) * jitter));
          const mileageKm = t.mileageKm + inc;
          const mileageSinceService = t.mileageSinceService + inc;
          persistTrain(t.id, { mileageKm, mileageSinceService });
          return { ...t, mileageKm, mileageSinceService };
        })
      );
    }, 5000);
    return () => clearInterval(id);
  }, []);

  const isHod = user.role === "HOD";

  const updateField = (id, key, value) => {
    setFleet((prev) =>
      prev.map((t) => {
        if (t.id !== id) return t;
        const next = { ...t, [key]: value };
        // Safety interlock: reopening a job-card or letting cert lapse revokes any prior approval
        if ((key === "jobCardOpen" && value === true) || (key === "certDaysLeft" && value <= 2)) {
          next.approved = false;
        }
        const patch = { [key]: value };
        if (next.approved !== t.approved) patch.approved = next.approved;
        persistTrain(id, patch);
        return next;
      })
    );
  };

  const approve = (id) => {
    setFleet((prev) => prev.map((t) => (t.id === id ? { ...t, approved: true } : t)));
    persistTrain(id, { approved: true });
  };
  const revoke = (id) => {
    setFleet((prev) => prev.map((t) => (t.id === id ? { ...t, approved: false } : t)));
    persistTrain(id, { approved: false });
  };

  // Passenger-Queries workflow: HOD reviews a query, assigns an expected
  // completion date, and pushes it to Service. Writes straight to Supabase;
  // the realtime subscription above then refreshes local state for everyone.
  const updateComplaintStatus = async (id, patch) => {
    await updateComplaint(id, patch);
  };

  // Called when a finalize-checklist is confirmed: resets the "since last service"
  // odometer to zero (so next-service due recalculates), records a fresh service
  // history entry, and resolves any passenger complaints ticked off in the checklist.
  const finalizeService = (id, doneLabels, complaintIds) => {
    const today = new Date().toISOString().slice(0, 10);
    setFleet((prev) =>
      prev.map((t) => {
        if (t.id !== id) return t;
        const type = doneLabels.length > 1 ? "Full Service Checklist" : doneLabels[0] || "Scheduled Maintenance";
        const entry = {
          date: today,
          type,
          workDone: doneLabels.join("; "),
          approvedBy: user.name,
          durationHrs: Math.round(2 + Math.random() * 5),
        };
        const serviceHistory = [entry, ...t.serviceHistory];
        persistTrain(id, {
          mileageSinceService: 0,
          lastServiceDate: today,
          lastServiceType: type,
          lastServiceNotes: doneLabels.join("; "),
          lastServiceApprovedBy: user.name,
          serviceHistory,
        });
        return {
          ...t,
          mileageSinceService: 0,
          lastServiceDate: today,
          lastServiceType: type,
          lastServiceNotes: doneLabels.join("; "),
          lastServiceApprovedBy: user.name,
          serviceHistory,
        };
      })
    );
    if (complaintIds && complaintIds.length) {
      complaintIds.forEach((cid) => {
        updateComplaint(cid, { status: "RESOLVED", resolvedBy: user.name, resolvedTs: new Date().toISOString() })
          .then(async () => setComplaints(await fetchComplaints()))
          .catch(() => {});
      });
    }
  };

  const complaintsByTrain = useMemo(() => {
    const map = {};
    complaints.forEach((c) => {
      if (!map[c.trainId]) map[c.trainId] = [];
      map[c.trainId].push(c);
    });
    return map;
  }, [complaints]);

  const totalOpenComplaints = complaints.filter((c) => c.status === "OPEN").length;

  const withStatus = useMemo(
    () => fleet.map((t) => ({ ...t, status: deriveStatus(t) })),
    [fleet]
  );
  const enriched = useMemo(
    () =>
      withStatus.map((t) => {
        const riskScore = riskScoreFor(t);
        const priority = priorityFor(riskScore, t);
        const prediction = predictFor(t);
        const reason = reasonForRisk(t);
        const live = getLivePosition(t, t.status, clock);
        return { ...t, riskScore, priority, reason, ...prediction, live };
      }),
    [withStatus, clock]
  );

  const counts = useMemo(() => {
    const c = { MAINTENANCE: 0, STANDBY: 0, PENDING: 0, ACTIVE: 0 };
    withStatus.forEach((t) => (c[t.status] += 1));
    return c;
  }, [withStatus]);

  const filtered = withStatus.filter((t) => {
    const okFilter = filter === "ALL" || t.status === filter;
    const okQuery =
      query.trim() === "" ||
      t.name.toLowerCase().includes(query.toLowerCase()) ||
      t.id.toLowerCase().includes(query.toLowerCase());
    return okFilter && okQuery;
  });

  const barData = withStatus.map((t) => ({ name: t.name, km: t.mileageKm, color: SIGNAL[t.status].color }));
  const selected = withStatus.find((t) => t.id === selectedId);

  const bays = useMemo(() => {
    const map = {};
    withStatus.forEach((t) => {
      if (!map[t.bay]) map[t.bay] = [];
      map[t.bay].push(t);
    });
    return map;
  }, [withStatus]);

  return (
    <div className="scada-root">
      <div className="scanlines" />
      <header className="console-header">
        <div className="header-left">
          <Radio size={16} />
          <span className="header-tag">KMRL // FLEET-CTRL v2.1</span>
          <span className="header-clock">{clock.toLocaleTimeString("en-IN", { hour12: false })}</span>
        </div>
        <div className="header-right">
          <span className="user-tag">
            <User size={13} /> {user.name} <em className="role-badge">{user.role}</em>
          </span>
          <button className="logout-mini" onClick={onLogout}><LogOut size={13} /> EXIT</button>
        </div>
      </header>

      <main className="console-main">
        {fleetLoading && (
          <div className="pq-view-note" style={{ marginBottom: 14 }}>
            LOADING FLEET FROM SUPABASE...
          </div>
        )}
        {totalOpenComplaints > 0 && (
          <div className="complaints-banner" onClick={() => setView("PQUERIES")}>
            <AlertTriangle size={14} />
            <strong>{totalOpenComplaints}</strong> open passenger quer{totalOpenComplaints > 1 ? "ies" : "y"} across the fleet —
            click to review, assign a date, and send to Service.
          </div>
        )}

        <section className="status-panel">
          {Object.entries(SIGNAL).map(([key, sig]) => (
            <div className="status-tile hud" key={key} style={{ borderColor: sig.color, "--tile-glow": sig.glow }}>
              <span className="status-tile-sweep" />
              <span className="led" style={{ background: sig.color, boxShadow: `0 0 7px ${sig.color}` }} />
              <div className="status-tile-value"><CountUp value={counts[key]} /></div>
              <div className="status-tile-label">{sig.label}</div>
            </div>
          ))}
        </section>

        <section className="control-row">
          <div className="view-tabs">
            <button className={view === "FLEET" ? "tab on" : "tab"} onClick={() => setView("FLEET")}>
              <Radio size={11} style={{ marginRight: 5, verticalAlign: -2 }} /> FLEET VIEW
            </button>
            <button className={view === "LOG" ? "tab on" : "tab"} onClick={() => setView("LOG")}>
              <History size={11} style={{ marginRight: 5, verticalAlign: -2 }} /> MAINTENANCE LOG
            </button>
            <button className={view === "PLAN" ? "tab on" : "tab"} onClick={() => setView("PLAN")}>
              <ClipboardList size={11} style={{ marginRight: 5, verticalAlign: -2 }} /> INDUCTION PLAN
            </button>
            <button className={view === "MAP" ? "tab on" : "tab"} onClick={() => setView("MAP")}>
              <Gauge size={11} style={{ marginRight: 5, verticalAlign: -2 }} /> LIVE OPS MAP
            </button>
            <button className={view === "PQUERIES" ? "tab on" : "tab"} onClick={() => setView("PQUERIES")}>
              <MessageSquareWarning size={11} style={{ marginRight: 5, verticalAlign: -2 }} /> PASSENGER QUERIES
              {totalOpenComplaints > 0 && <span className="complaint-badge">⚠ {totalOpenComplaints}</span>}
            </button>
          </div>
          {view === "FLEET" && (
            <>
              <div className="tabs">
                {["ALL", ...Object.keys(SIGNAL)].map((f) => (
                  <button key={f} className={filter === f ? "tab on" : "tab"} onClick={() => setFilter(f)}>
                    {f === "ALL" ? "ALL · 25" : SIGNAL[f].label}
                  </button>
                ))}
              </div>
              <div className="search-field">
                <Search size={14} />
                <input placeholder="SEARCH ID / NAME" value={query} onChange={(e) => setQuery(e.target.value)} />
              </div>
            </>
          )}
        </section>

        {view === "LOG" ? (
          <MaintenanceLog fleet={withStatus} activityLog={activityLog} complaints={complaints} />
        ) : view === "PLAN" ? (
          <InductionPlan
            fleet={enriched}
            onSelect={setSelectedId}
            isHod={isHod}
            onOverride={setOverrideTarget}
            overrides={overrides}
          />
        ) : view === "MAP" ? (
          <LiveMap fleet={enriched} clock={clock} onSelect={setSelectedId} />
        ) : view === "PQUERIES" ? (
          <PassengerQueries complaints={complaints} isHod={isHod} onUpdate={updateComplaintStatus} />
        ) : (
          <>
            <section className="registry">
              <div className="registry-head">
                <span>ID</span><span>NAME</span><span>STATUS</span><span>MILEAGE</span>
                <span>CERT</span><span>JOB-CARD</span><span>CHECKS</span><span>BAY</span>
              </div>
              {filtered.map((t) => {
                const sig = SIGNAL[t.status];
                const openCount = (complaintsByTrain[t.id] || []).filter((c) => c.status === "OPEN").length;
                return (
                  <button key={t.id} className="registry-row" onClick={() => setSelectedId(t.id)}>
                    <span className="mono">{t.id}</span>
                    <span className="row-name">
                      {t.name}
                      {openCount > 0 && <span className="complaint-badge">⚠ {openCount}</span>}
                    </span>
                    <span className="row-status" style={{ color: sig.color }}>
                      <MiniBlip color={sig.color} mode={t.status === "ACTIVE" ? "run" : t.status === "MAINTENANCE" ? "halt" : "idle"} />
                      <span className="led sm" style={{ background: sig.color }} /> {sig.label}
                    </span>
                    <span className="mono">{t.mileageKm.toLocaleString()} km</span>
                    <span className="mono">{t.certDaysLeft}d</span>
                    <span className="mono">{t.jobCardOpen ? <Wrench size={13} color="#FF4D4D" /> : <CheckCircle2 size={13} color="#39E68B" />}</span>
                    <span className="mono">{t.checksComplete ? <CheckCircle2 size={13} color="#39E68B" /> : <Clock3 size={13} color="#FFC93B" />}</span>
                    <span className="mono">B{t.bay}</span>
                  </button>
                );
              })}
            </section>

            <section className="schematic">
              <div className="section-title">DEPOT INTERLOCKING SCHEMATIC — BAY OCCUPANCY</div>
              <div className="yard hud-grid">
                <div className="hud-sweep" />
                {Object.entries(bays).map(([bay, trains]) => (
                  <div className="bay-row" key={bay}>
                    <div className="bay-label">BAY {bay}</div>
                    <div className="bay-track">
                      {trains.map((t) => (
                        <button
                          key={t.id}
                          className="bay-block"
                          style={{ borderColor: SIGNAL[t.status].color, color: SIGNAL[t.status].color }}
                          onClick={() => setSelectedId(t.id)}
                          title={t.name}
                        >
                          <MiniBlip color={SIGNAL[t.status].color} mode={t.status === "ACTIVE" ? "run" : t.status === "MAINTENANCE" ? "halt" : "idle"} />
                          {String(t.number).padStart(2, "0")}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <section className="chart-section">
              <div className="section-title">FLEET MILEAGE DISTRIBUTION</div>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={barData} margin={{ top: 8, right: 8, left: -20, bottom: 40 }}>
                  <CartesianGrid strokeDasharray="2 4" stroke="#1A2620" />
                  <XAxis dataKey="name" angle={-45} textAnchor="end" interval={0} tick={{ fill: "#5C7A6C", fontSize: 9 }} />
                  <YAxis tick={{ fill: "#5C7A6C", fontSize: 9 }} />
                  <Tooltip contentStyle={{ background: "#0B1410", border: "1px solid #1A2620" }} labelStyle={{ color: "#D8F0E4" }} />
                  <Bar dataKey="km" radius={[3, 3, 0, 0]}>
                    {barData.map((e, i) => <Cell key={i} fill={e.color} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </section>
          </>
        )}
      </main>

      {overrideTarget && (
        <OverrideModal
          train={overrideTarget}
          initialNote={overrides[overrideTarget.id]?.note}
          onSave={saveOverride}
          onCancel={() => setOverrideTarget(null)}
        />
      )}
      {selected && (
        <Drawer
          train={selected}
          isHod={isHod}
          approverName={user.name}
          complaints={complaintsByTrain[selected.id] || []}
          onChange={updateField}
          onApprove={approve}
          onRevoke={revoke}
          onClose={() => setSelectedId(null)}
          onLog={logEvent}
          onFinalize={finalizeService}
        />
      )}
    </div>
  );
}

/* =========================================================================
   ROOT
========================================================================= */
export default function App() {
  const [user, setUser] = useState(null);

  const params = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
  const complainTrainId = params?.get("complain");
  if (complainTrainId) {
    return <ComplaintPortal presetTrainId={complainTrainId.toUpperCase()} />;
  }

  if (!user) return <Login onLogin={setUser} />;
  return <Console user={user} onLogout={() => setUser(null)} />;
}
