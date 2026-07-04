import React, { useState, useEffect, useMemo } from "react";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer, Cell,
} from "recharts";
import {
  Train, LogOut, Search, AlertTriangle, User, Lock, ChevronRight, X,
  ShieldCheck, Wrench, Clock3, CheckCircle2, Radio, Zap, Battery, Wind,
  Gauge, History, ClipboardList, Circle as CircleIcon,
} from "lucide-react";

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
const COMPLAINTS_KEY = "kmrl_complaints_v1";

function loadComplaints() {
  try {
    const raw = localStorage.getItem(COMPLAINTS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}
function saveComplaints(list) {
  try { localStorage.setItem(COMPLAINTS_KEY, JSON.stringify(list)); } catch { /* storage unavailable */ }
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

  const train = TRAIN_ID_LIST.find((t) => t.id === trainId);

  const submit = (e) => {
    e.preventDefault();
    const complaint = {
      id: `CMP-${Date.now().toString(36).toUpperCase()}`,
      ts: new Date().toISOString(),
      trainId,
      trainName: train?.name || trainId,
      compartment,
      issue,
      description: description.trim(),
      status: "OPEN",
    };
    const list = loadComplaints();
    saveComplaints([complaint, ...list]);
    setSubmitted(complaint);
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

          <button className="term-submit" type="submit">
            &gt; SUBMIT COMPLAINT <ChevronRight size={15} />
          </button>
        </form>
        <div className="login-footnote">THIS ISSUE WILL BE PULLED INTO THE TRAIN'S NEXT SERVICE CHECKLIST</div>
      </div>
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
  const [clock, setClock] = useState(new Date());

  useEffect(() => {
    const id = setInterval(() => setClock(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const submit = (e) => {
    e.preventDefault();
    if (!uname.trim() || !pwd.trim()) {
      setErr("CREDENTIALS REQUIRED");
      return;
    }
    onLogin({ role, name: uname.trim() });
  };

  return (
    <div className="scada-root login-screen">
      <div className="scanlines" />
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
          <button className={role === "HOD" ? "role-tab on" : "role-tab"} onClick={() => setRole("HOD")}>
            HEAD OF DEPARTMENT
          </button>
          <button className={role === "OPERATOR" ? "role-tab on" : "role-tab"} onClick={() => setRole("OPERATOR")}>
            SERVICE / OPERATOR
          </button>
        </div>

        <form onSubmit={submit} className="login-form">
          <div className="term-field">
            <User size={14} />
            <input placeholder="OPERATOR ID" value={uname} onChange={(e) => setUname(e.target.value)} />
          </div>
          <div className="term-field">
            <Lock size={14} />
            <input type="password" placeholder="ACCESS CODE" value={pwd} onChange={(e) => setPwd(e.target.value)} />
          </div>
          {err && <div className="term-err"><AlertTriangle size={13} /> {err}</div>}
          <button className="term-submit" type="submit">
            &gt; AUTHENTICATE <ChevronRight size={15} />
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

        <div className="login-footnote">DEMO SYSTEM — ANY ID/CODE PAIR GRANTS ACCESS</div>
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
                className="train-marker"
                style={{ left: `${t.live.pct}%`, borderColor: SIGNAL[t.status].color, color: SIGNAL[t.status].color }}
                onClick={() => onSelect(t.id)}
                title={`${t.name} · ${t.live.direction} · next: ${t.live.nextStation}`}
              >
                {String(t.number).padStart(2, "0")}
              </button>
            ))}
          </div>
        </div>
        <div className="route-ref-note">
          Positions are computed live from each train's schedule cycle (one-way run + turnaround), not fetched from a
          KMRL live-GPS feed — no such public feed exists. Trains not in ACTIVE service show at Muttom Depot.
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
  const [fleet, setFleet] = useState(buildFleet);
  const [filter, setFilter] = useState("ALL");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState(null);
  const [clock, setClock] = useState(new Date());
  const [view, setView] = useState("FLEET"); // "FLEET" | "LOG"
  const [activityLog, setActivityLog] = useState([]);
  const [complaints, setComplaints] = useState(loadComplaints);
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

  // Passenger complaints are submitted from a separate QR-scan page (no login).
  // Poll + listen for cross-tab storage events so new ones show up live here.
  useEffect(() => {
    const refresh = () => setComplaints(loadComplaints());
    const id = setInterval(refresh, 4000);
    window.addEventListener("storage", refresh);
    return () => {
      clearInterval(id);
      window.removeEventListener("storage", refresh);
    };
  }, []);

  // Live mileage simulation — trains in ACTIVE service rack up km in real time,
  // which counts down their "next service due" distance automatically.
  useEffect(() => {
    const id = setInterval(() => {
      setFleet((prev) =>
        prev.map((t) => {
          if (deriveStatus(t) !== "ACTIVE") return t;
          const jitter = 1 + seeded((Date.now() / 5000) % 1000 + t.number) * 0.6;
          const inc = Math.max(1, Math.round((t.mileageRatePerHour / 12) * jitter));
          return { ...t, mileageKm: t.mileageKm + inc, mileageSinceService: t.mileageSinceService + inc };
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
        return next;
      })
    );
  };

  const approve = (id) => {
    setFleet((prev) => prev.map((t) => (t.id === id ? { ...t, approved: true } : t)));
  };
  const revoke = (id) => {
    setFleet((prev) => prev.map((t) => (t.id === id ? { ...t, approved: false } : t)));
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
        return {
          ...t,
          mileageSinceService: 0,
          lastServiceDate: today,
          lastServiceType: type,
          lastServiceNotes: doneLabels.join("; "),
          lastServiceApprovedBy: user.name,
          serviceHistory: [entry, ...t.serviceHistory],
        };
      })
    );
    if (complaintIds && complaintIds.length) {
      setComplaints((prev) => {
        const next = prev.map((c) =>
          complaintIds.includes(c.id)
            ? { ...c, status: "RESOLVED", resolvedBy: user.name, resolvedTs: new Date().toISOString() }
            : c
        );
        saveComplaints(next);
        return next;
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
        {totalOpenComplaints > 0 && (
          <div className="complaints-banner" onClick={() => setView("LOG")}>
            <AlertTriangle size={14} />
            <strong>{totalOpenComplaints}</strong> open passenger complaint{totalOpenComplaints > 1 ? "s" : ""} across the fleet —
            these are pulled into each train's next service checklist. Click to view in Maintenance Log.
          </div>
        )}

        <section className="status-panel">
          {Object.entries(SIGNAL).map(([key, sig]) => (
            <div className="status-tile" key={key} style={{ borderColor: sig.color }}>
              <span className="led" style={{ background: sig.color, boxShadow: `0 0 7px ${sig.color}` }} />
              <div className="status-tile-value">{counts[key]}</div>
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
              <div className="yard">
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
