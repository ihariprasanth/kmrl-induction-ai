/* =========================================================================
   SFX — lightweight sci-fi / HUD beep engine (Web Audio API, no assets)
   Used to give buttons & interactions a SCADA control-room feel.
========================================================================= */
let _ctx = null;
function getCtx() {
  if (!_ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    _ctx = new AC();
  }
  if (_ctx.state === "suspended") _ctx.resume();
  return _ctx;
}

function beep({ freq = 880, duration = 0.08, type = "square", gain = 0.045, sweep = null, delay = 0 }) {
  const ctx = getCtx();
  if (!ctx) return;
  try {
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (sweep) osc.frequency.exponentialRampToValueAtTime(sweep, t0 + duration);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    osc.connect(g);
    g.connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + duration + 0.02);
  } catch (e) {
    /* audio not available — fail silently */
  }
}

export const sfx = {
  click: () => beep({ freq: 1180, duration: 0.05, type: "square", gain: 0.04 }),
  hover: () => beep({ freq: 1900, duration: 0.018, type: "sine", gain: 0.015 }),
  tabSwitch: () => beep({ freq: 640, duration: 0.07, type: "sine", sweep: 1150, gain: 0.045 }),
  focus: () => beep({ freq: 900, duration: 0.03, type: "triangle", gain: 0.02 }),
  submit: () => {
    beep({ freq: 420, duration: 0.1, type: "sawtooth", sweep: 1500, gain: 0.05 });
    beep({ freq: 1600, duration: 0.05, type: "square", gain: 0.03, delay: 0.09 });
  },
  success: () => {
    beep({ freq: 700, duration: 0.09, type: "sine", sweep: 1400, gain: 0.05 });
    beep({ freq: 1400, duration: 0.12, type: "sine", sweep: 2000, gain: 0.045, delay: 0.1 });
  },
  error: () => beep({ freq: 220, duration: 0.2, type: "square", sweep: 90, gain: 0.06 }),
};
