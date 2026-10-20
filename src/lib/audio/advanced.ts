/**
 * v3.1 Advanced Processing Suite — parameters, neutral defaults and the pure
 * control maths behind the new stages.
 *
 * Every module ships bypassed / neutral: with `advanced` untouched the chain
 * is bit-for-bit the v3.0 audio path (all new gains sit at unity, all new
 * filters at 0 dB or outside the audible range, the gate/AGC helpers return
 * the operator's v3.0 values). Presets and v3.0 saves coerce into this shape,
 * so nothing has to be migrated by hand.
 *
 * The helper functions are pure and are exercised by
 * `scripts/verify-advanced.ts`; the engine only applies their results.
 */
import type { LoudnessStandardId } from "./params";

export type LatencyMode = "low" | "balanced" | "max";

export interface AdvancedParams {
  latency: LatencyMode;
  restoration: {
    nr: {
      on: boolean;
      mode: "light" | "medium" | "heavy";
      learn: "hold" | "continuous";
      attenuationDb: number;
      floorTrack: "slow" | "normal" | "fast";
      transientProtect: number;
    };
    impulse: {
      on: boolean;
      sensitivity: number;
      reconstruct: number;
      oversample: 4 | 8;
      clipThresholdDb: number;
    };
    phaseLin: {
      on: boolean;
      correction: "off" | "narrow" | "medium" | "wide";
      minHz: number;
      maxHz: number;
      monitor: boolean;
    };
    src: {
      on: boolean;
      target: "auto" | "44.1" | "48" | "88.2" | "96";
      attenuationDb: number;
      dither: "tpdf" | "none";
      lock: "auto" | "manual";
    };
    drr: {
      on: boolean;
      expansion: number;
      timeS: number;
      crestTargetDb: number;
      depthPreserve: number;
    };
    harmonics: {
      on: boolean;
      even: number;
      odd: number;
      band: "low" | "mid" | "high";
      drive: number;
      mix: number;
    };
  };
  leveling: {
    agcProfile: {
      on: boolean;
      profile: "auto" | "music" | "speech";
      sensitivity: number;
      switchDelayS: number;
      music: { attackMs: number; releaseMs: number };
      speech: { attackMs: number; releaseMs: number };
    };
    gate: {
      on: boolean;
      lookaheadMs: number;
      openDb: number;
      closeDb: number;
      holdMs: number;
      hysteresisDb: number;
      curve: "linear" | "log" | "exponential";
    };
    crest: {
      on: boolean;
      targetDb: number;
      response: "fast" | "medium" | "slow";
      hardLimit: boolean;
    };
    drift: {
      on: boolean;
      windowH: 1 | 6 | 12 | 24;
      rangeDb: 1 | 2 | 3;
      rate: "slow" | "normal" | "fast";
    };
    dualAnchor: {
      on: boolean;
      lufsTarget: -14 | -16 | -18 | -23;
      densityTargetDb: -20 | -18 | -16 | -14;
      balance: number;
    };
    transient: {
      on: boolean;
      band: "all" | "low" | "mid" | "high";
      attack: number;
      sustain: number;
      rangeMs: number;
    };
  };
  compliance: {
    dual: { on: boolean; standardA: LoudnessStandardId; standardB: LoudnessStandardId };
    lra: {
      on: boolean;
      targetLu: 4 | 6 | 8 | 10;
      mode: "compress" | "expand";
      response: "fast" | "medium" | "slow";
      preserveQuiet: number;
    };
    truePeak: { on: boolean; factor: 8 | 16 | 32; ceilingDb: number; holdS: number };
    log: {
      on: boolean;
      intervalMin: 1 | 5 | 15 | 60;
      exportCsv: boolean;
      autoSave: "daily" | "weekly";
    };
    gate: {
      on: boolean;
      thresholdDb: -10 | -20 | -30;
      kWeighted: boolean;
      ignoreLowFreq: boolean;
      ignoreNoise: boolean;
      ignoreGaps: boolean;
    };
    channelMatch: {
      on: boolean;
      levelMode: "auto" | "manual";
      levelTrimDb: number;
      phaseMode: "auto" | "manual";
      phaseTrimDeg: number;
    };
  };
  spatial: {
    msEq: {
      on: boolean;
      bands: { freq: number; midDb: number; sideDb: number; q: number }[];
    };
    diffusion: {
      on: boolean;
      width: number;
      decorrelation: number;
      freqHz: number;
      monoSafe: boolean;
    };
    bassAlign: {
      on: boolean;
      lockHz: 80 | 100 | 120;
      coherence: number;
      monoCheck: boolean;
      phaseCorr: "auto" | "manual";
    };
    signature: {
      on: boolean;
      toleranceDb: number;
      smooth: number;
      capturedAt: number;
      profile: number[];
    };
    correlation: {
      on: boolean;
      minCorrelation: number;
      autoNarrow: number;
      alert: "visual" | "audio";
    };
    headroom: {
      on: boolean;
      centreProtect: number;
      sideHeadroom: number;
      imbalanceDb: number;
      autoRedistribute: boolean;
    };
  };
  eq: {
    dynamic: {
      on: boolean;
      bands: 4 | 6 | 8;
      q: number;
      thresholdDb: number;
      rangeDb: number;
      attackMs: number;
      releaseMs: number;
      mode: "compress" | "expand";
    };
    crossover: {
      on: boolean;
      order: 24;
      type: "linear" | "minimum";
      phase: "zero" | "low" | "normal";
    };
    spectral: {
      on: boolean;
      shift: number;
      densityLimit: number;
      midrangeProtect: number;
      decayS: number;
    };
    presence: {
      on: boolean;
      presenceGainDb: number;
      presenceWidth: number;
      presenceMode: "natural" | "sharp";
      brillianceGainDb: number;
      airType: "smooth" | "sparkle" | "open";
    };
    deess: {
      on: boolean;
      band1: { freqHz: number; sensitivity: number; suppress: number };
      band2: { freqHz: number; sensitivity: number; suppress: number };
      monitor: boolean;
      release: "fast" | "slow";
    };
    notch: {
      on: boolean;
      notch1: { freqHz: number; widthOct: number; autoTrack: boolean };
      notch2: { freqHz: number; widthOct: number; autoTrack: boolean };
      leakageDetect: boolean;
    };
  };
  limiter: {
    window: {
      on: boolean;
      fastMs: number;
      ceilingDb: number;
      densityMs: number;
      blend: "auto" | "manual";
      attackMs: number;
      release: "adaptive" | "fixed";
      density: number;
    };
    harmonics: {
      on: boolean;
      even: number;
      odd: number;
      saturation: number;
      tone: "warm" | "balanced" | "tight";
      oversample: 2 | 4 | 8;
      ispRemoval: boolean;
    };
    mpx: {
      on: boolean;
      pilotLevelPct: number;
      rdsProtect: boolean;
      stokkemask: boolean;
      maskKhz: 15 | 30 | 50;
      clipper: boolean;
      oversample: 8;
      multipath: number;
    };
    preEmph: {
      on: boolean;
      curve: "50" | "75" | "j17" | "flat";
      apply: "before" | "after";
      compensateHf: number;
    };
    codec: {
      on: boolean;
      target: "auto" | "mp3" | "aac" | "opus";
      bitrate: "auto" | "manual";
      lowpassHz: number;
      hfPreserve: number;
    };
    undershoot: {
      on: boolean;
      depth: number;
      recovery: "fast" | "normal";
      windowMs: number;
    };
  };
  intelligence: {
    autoSource: {
      on: boolean;
      confidence: number;
      switchDelayS: number;
      musicPreset: string;
      speechPreset: string;
      quietPreset: string;
      loudPreset: string;
    };
    morph: {
      on: boolean;
      transitionS: number;
      curve: "linear" | "smooth";
      history: number;
      autoSave: boolean;
    };
    gainStaging: {
      on: boolean;
      warnDb: number;
      criticalDb: number;
      autoTrim: boolean;
    };
    safety: {
      on: boolean;
      hangDetect: boolean;
      timeoutS: number;
      action: "mute" | "bypass" | "relay";
      relay: "nc" | "no";
      failSafe: "last" | "flat" | "mute";
    };
    remote: {
      on: boolean;
      protocol: "osc" | "ws" | "both";
      port: number;
      auth: "password" | "token";
      token: string;
    };
    health: { on: boolean };
  };
}

/** Ten fixed M/S EQ centres (31 Hz … 16 kHz), neutral gains. */
export const MS_BANDS = [31, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

const msBands = () =>
  MS_BANDS.map((freq) => ({ freq, midDb: 0, sideDb: 0, q: 1 }));

export const DEFAULT_ADVANCED: AdvancedParams = {
  latency: "balanced",
  restoration: {
    nr: {
      on: false,
      mode: "medium",
      learn: "continuous",
      attenuationDb: 12,
      floorTrack: "normal",
      transientProtect: 50,
    },
    impulse: {
      on: false,
      sensitivity: 50,
      reconstruct: 50,
      oversample: 8,
      clipThresholdDb: -1,
    },
    phaseLin: {
      on: false,
      correction: "medium",
      minHz: 20,
      maxHz: 500,
      monitor: false,
    },
    src: { on: false, target: "auto", attenuationDb: 128, dither: "tpdf", lock: "auto" },
    drr: { on: false, expansion: 0, timeS: 4, crestTargetDb: 10, depthPreserve: 50 },
    harmonics: { on: false, even: 0, odd: 0, band: "mid", drive: 0, mix: 0 },
  },
  leveling: {
    agcProfile: {
      on: false,
      profile: "auto",
      sensitivity: 50,
      switchDelayS: 3,
      music: { attackMs: 25, releaseMs: 450 },
      speech: { attackMs: 5, releaseMs: 120 },
    },
    gate: {
      on: false,
      lookaheadMs: 20,
      openDb: -40,
      closeDb: -45,
      holdMs: 300,
      hysteresisDb: 3,
      curve: "log",
    },
    crest: { on: false, targetDb: 10, response: "medium", hardLimit: false },
    drift: { on: false, windowH: 6, rangeDb: 2, rate: "normal" },
    dualAnchor: { on: false, lufsTarget: -16, densityTargetDb: -18, balance: 50 },
    transient: { on: false, band: "all", attack: 0, sustain: 0, rangeMs: 3 },
  },
  compliance: {
    dual: { on: false, standardA: "ebu", standardB: "atsc" },
    lra: { on: false, targetLu: 8, mode: "compress", response: "medium", preserveQuiet: 50 },
    truePeak: { on: false, factor: 8, ceilingDb: -1, holdS: 2 },
    log: { on: false, intervalMin: 5, exportCsv: true, autoSave: "daily" },
    gate: {
      on: false,
      thresholdDb: -20,
      kWeighted: true,
      ignoreLowFreq: true,
      ignoreNoise: false,
      ignoreGaps: true,
    },
    channelMatch: {
      on: false,
      levelMode: "auto",
      levelTrimDb: 0,
      phaseMode: "auto",
      phaseTrimDeg: 0,
    },
  },
  spatial: {
    msEq: { on: false, bands: msBands() },
    diffusion: { on: false, width: 0, decorrelation: 0, freqHz: 700, monoSafe: true },
    bassAlign: { on: false, lockHz: 100, coherence: 50, monoCheck: true, phaseCorr: "auto" },
    signature: { on: false, toleranceDb: 0.5, smooth: 50, capturedAt: 0, profile: [] },
    correlation: { on: false, minCorrelation: 0.8, autoNarrow: 50, alert: "visual" },
    headroom: {
      on: false,
      centreProtect: 50,
      sideHeadroom: 50,
      imbalanceDb: 1,
      autoRedistribute: false,
    },
  },
  eq: {
    dynamic: {
      on: false,
      bands: 6,
      q: 1,
      thresholdDb: -20,
      rangeDb: 3,
      attackMs: 15,
      releaseMs: 100,
      mode: "compress",
    },
    crossover: { on: false, order: 24, type: "minimum", phase: "normal" },
    spectral: { on: false, shift: 0, densityLimit: 50, midrangeProtect: 50, decayS: 2 },
    presence: {
      on: false,
      presenceGainDb: 0,
      presenceWidth: 1,
      presenceMode: "natural",
      brillianceGainDb: 0,
      airType: "smooth",
    },
    deess: {
      on: false,
      band1: { freqHz: 5500, sensitivity: 50, suppress: 50 },
      band2: { freqHz: 9000, sensitivity: 50, suppress: 50 },
      monitor: false,
      release: "fast",
    },
    notch: {
      on: false,
      notch1: { freqHz: 100, widthOct: 0.2, autoTrack: false },
      notch2: { freqHz: 1000, widthOct: 0.2, autoTrack: false },
      leakageDetect: true,
    },
  },
  limiter: {
    window: {
      on: false,
      fastMs: 1,
      ceilingDb: -0.5,
      densityMs: 10,
      blend: "auto",
      attackMs: 1,
      release: "adaptive",
      density: 50,
    },
    harmonics: {
      on: false,
      even: 0,
      odd: 0,
      saturation: 0,
      tone: "balanced",
      oversample: 4,
      ispRemoval: false,
    },
    mpx: {
      on: false,
      pilotLevelPct: 9,
      rdsProtect: true,
      stokkemask: false,
      maskKhz: 30,
      clipper: true,
      oversample: 8,
      multipath: 0,
    },
    preEmph: { on: false, curve: "50", apply: "after", compensateHf: 50 },
    codec: { on: false, target: "auto", bitrate: "auto", lowpassHz: 16000, hfPreserve: 50 },
    undershoot: { on: false, depth: 0, recovery: "normal", windowMs: 3 },
  },
  intelligence: {
    autoSource: {
      on: false,
      confidence: 60,
      switchDelayS: 5,
      musicPreset: "Music-HiFi-Open",
      speechPreset: "Omnia · Talk",
      quietPreset: "Omnia · Natural",
      loudPreset: "Tight-Punchy",
    },
    morph: { on: false, transitionS: 3, curve: "smooth", history: 100, autoSave: true },
    gainStaging: { on: false, warnDb: 3, criticalDb: 1, autoTrim: false },
    safety: {
      on: false,
      hangDetect: true,
      timeoutS: 3,
      action: "mute",
      relay: "nc",
      failSafe: "last",
    },
    remote: { on: false, protocol: "both", port: 9000, auth: "token", token: "" },
    health: { on: true },
  },
};

/* ── control maths ─────────────────────────────────────────────────────── */

export type ProgramClass = "quiet" | "speech" | "music" | "loud";

/**
 * AGC envelope for the active profile. `auto` picks music/speech from the
 * detector (the engine passes `speech`), sensitivity trims the attack (more
 * sensitive = faster) and the switch delay only affects the mode pick, so the
 * numbers stay bounded.
 */
export function agcProfileEnvelope(
  profile: AdvancedParams["leveling"]["agcProfile"],
  speech: boolean,
): { attackMs: number; releaseMs: number } {
  const pick =
    profile.profile === "auto" ? (speech ? "speech" : "music") : profile.profile;
  const base = pick === "speech" ? profile.speech : profile.music;
  const sens = Math.min(100, Math.max(0, profile.sensitivity)) / 100;
  // Neutral (50 %) leaves the stored envelopes alone; more sensitive is
  // faster in both directions, less sensitive smoother.
  const scale = 1.35 - sens * 0.7;
  return {
    attackMs: Math.max(0.5, base.attackMs * scale),
    releaseMs: Math.max(20, base.releaseMs * scale),
  };
}

/** Gate gain target from the level, with hysteresis and the release curve. */
export function gateGainTarget(
  levelDb: number,
  open: boolean,
  gate: AdvancedParams["leveling"]["gate"],
): { open: boolean; gain: number } {
  const openDb = gate.openDb;
  const closeDb = Math.min(openDb - 1, gate.closeDb);
  const hystereticClose = closeDb - Math.max(0, gate.hysteresisDb);
  const isOpen = open ? levelDb >= hystereticClose : levelDb >= openDb;
  if (isOpen) return { open: true, gain: 1 };
  const curve = gate.curve;
  // Depth into the closed region 0…1; linear, log or exponential taper.
  const span = Math.max(1, openDb - closeDb);
  const t = Math.min(1, Math.max(0, (openDb - levelDb) / span));
  const shaped =
    curve === "linear" ? t : curve === "log" ? Math.log10(1 + 9 * t) : t * t;
  return { open: false, gain: Math.max(0, 1 - shaped) };
}

/** Extra drive into the peak stage needed to hit a crest target (0…6 dB). */
export function crestDriveDb(
  measuredCrestDb: number,
  crest: AdvancedParams["leveling"]["crest"],
  currentDriveDb = 0,
): number {
  const target = Math.min(14, Math.max(6, crest.targetDb));
  const excess = measuredCrestDb - target;
  if (!Number.isFinite(excess) || excess <= 0) return currentDriveDb;
  const speed =
    crest.response === "fast" ? 0.9 : crest.response === "slow" ? 0.3 : 0.6;
  const next = currentDriveDb + excess * speed;
  return Math.min(6, Math.max(0, next));
}

/** Rider target after the long-term drift corrector and dual anchor. */
export function riderTargetLufs(
  params: {
    riderTarget: number;
    drift: AdvancedParams["leveling"]["drift"];
    dual: AdvancedParams["leveling"]["dualAnchor"];
  },
  measuredLufsI: number | null,
): number {
  let target = params.riderTarget;
  if (params.dual.on) {
    const b = Math.min(100, Math.max(0, params.dual.balance)) / 100;
    target = target * (1 - b) + params.dual.densityTargetDb * b;
  }
  if (params.drift.on && measuredLufsI !== null && Number.isFinite(measuredLufsI)) {
    const err = target - measuredLufsI;
    const cap = Math.abs(params.drift.rangeDb);
    const rate =
      params.drift.rate === "fast" ? 0.6 : params.drift.rate === "slow" ? 0.15 : 0.3;
    target += Math.max(-cap, Math.min(cap, err * rate));
  }
  return Math.round(target * 100) / 100;
}

/**
 * Multiband ratio scale from the LRA controller: a wide programme under a
 * narrow target is compressed harder; expanding asks for more dynamic range.
 */
export function lraRatioScale(
  measuredLu: number | null,
  lra: AdvancedParams["compliance"]["lra"],
): number {
  if (!lra.on || measuredLu === null || !Number.isFinite(measuredLu)) return 1;
  const error = measuredLu - lra.targetLu;
  const speed = lra.response === "fast" ? 0.08 : lra.response === "slow" ? 0.02 : 0.04;
  const direction = lra.mode === "expand" ? -1 : 1;
  return Math.min(1.35, Math.max(0.65, 1 + error * speed * direction));
}

/** L/R trim pair from the channel-match stage (0 dB when bypassed). */
export function channelTrim(trimDb: number): { l: number; r: number } {
  const t = Math.min(1, Math.max(-1, trimDb));
  return { l: Math.pow(10, -t / 20), r: Math.pow(10, t / 20) };
}

/**
 * Mid/side gains from the headroom allocator. Centre protect trades side
 * headroom for mid level; the imbalance allowance lets the operator choose
 * how much asymmetry is permitted before redistribution.
 */
export function headroomGains(headroom: AdvancedParams["spatial"]["headroom"]): {
  mid: number;
  side: number;
} {
  const centre = Math.min(100, Math.max(0, headroom.centreProtect)) / 100;
  const side = Math.min(100, Math.max(0, headroom.sideHeadroom)) / 100;
  return {
    mid: 1 + centre * 0.2,
    side: 1 - (1 - side) * 0.8,
  };
}

/** Presence/brilliance shelf gains in dB (neutral at 0). */
export function presenceGains(
  presence: AdvancedParams["eq"]["presence"],
): { presenceDb: number; brillianceDb: number } {
  const sharp = presence.presenceMode === "sharp" ? 1.3 : 1;
  return {
    presenceDb: Math.max(-6, Math.min(6, presence.presenceGainDb * sharp)),
    brillianceDb: Math.max(-6, Math.min(6, presence.brillianceGainDb)),
  };
}

/** Harmonic mix weights, normalised so 100 % odd + 100 % even stays bounded. */
export function harmonicMix(even: number, odd: number): { even: number; odd: number } {
  const e = Math.min(100, Math.max(0, even)) / 100;
  const o = Math.min(100, Math.max(0, odd)) / 100;
  const sum = e + o;
  return sum > 1 ? { even: e / sum, odd: o / sum } : { even: e, odd: o };
}

/** Biquad Q from a notch bandwidth in octaves. */
export function notchQ(widthOct: number): number {
  const w = Math.max(0.05, Math.min(4, widthOct));
  return 1 / (2 * Math.sinh((Math.LN2 / 2) * w));
}

/** Codec pre-shaping low-pass: keeps the profile's own bandwidth. */
export function codecLowpassHz(codec: AdvancedParams["limiter"]["codec"]): number {
  if (!codec.on) return 22000;
  const cap =
    codec.target === "mp3" ? 16000 : codec.target === "aac" ? 17000 : codec.target === "opus" ? 20000 : 19000;
  const hf = Math.min(100, Math.max(0, codec.hfPreserve)) / 100;
  return Math.min(22000, codec.lowpassHz || cap) * (0.85 + hf * 0.15);
}

/** Pre-emphasis correction shelf gain/frequency from the chosen curve. */
export function preEmphCorrection(
  pre: AdvancedParams["limiter"]["preEmph"],
): { freqHz: number; gainDb: number } {
  if (!pre.on) return { freqHz: 8000, gainDb: 0 };
  const curveDb = pre.curve === "50" ? 1.2 : pre.curve === "75" ? 1.8 : pre.curve === "j17" ? 2.2 : 0;
  const amount = Math.min(100, Math.max(0, pre.compensateHf)) / 100;
  return { freqHz: pre.curve === "75" ? 6500 : 7500, gainDb: curveDb * amount };
}

/** Latency target in ms for the operator-facing mode selector. */
export function latencyTargetMs(mode: LatencyMode): number {
  return mode === "low" ? 10 : mode === "max" ? 96 : 32;
}

const PRESET_ORDER: ProgramClass[] = ["quiet", "speech", "music", "loud"];

/** Music / speech / quiet / loud from short-term loudness and crest factor. */
export function classifyProgram(lufsS: number, crestDb: number): ProgramClass {
  if (!Number.isFinite(lufsS) || lufsS <= -55) return "quiet";
  if (lufsS > -9) return "loud";
  // Speech sits around 8–14 dB crest and mid loudness; music is denser.
  return crestDb >= 11 ? "speech" : "music";
}

/** Preset name to morph toward for a detected class. */
export function presetForClass(
  auto: AdvancedParams["intelligence"]["autoSource"],
  cls: ProgramClass,
): string | null {
  if (!auto.on) return null;
  const name =
    cls === "quiet"
      ? auto.quietPreset
      : cls === "loud"
        ? auto.loudPreset
        : cls === "speech"
          ? auto.speechPreset
          : auto.musicPreset;
  return name?.trim() || null;
}

/** True when every advanced module is in its neutral state. */
export function advancedIsNeutral(adv: AdvancedParams): boolean {
  return (
    !adv.restoration.nr.on &&
    !adv.restoration.impulse.on &&
    !adv.restoration.phaseLin.on &&
    !adv.restoration.src.on &&
    !adv.restoration.drr.on &&
    !adv.restoration.harmonics.on &&
    !adv.leveling.agcProfile.on &&
    !adv.leveling.gate.on &&
    !adv.leveling.crest.on &&
    !adv.leveling.drift.on &&
    !adv.leveling.dualAnchor.on &&
    !adv.leveling.transient.on &&
    !adv.compliance.dual.on &&
    !adv.compliance.lra.on &&
    !adv.compliance.truePeak.on &&
    !adv.compliance.log.on &&
    !adv.compliance.gate.on &&
    !adv.compliance.channelMatch.on &&
    !adv.spatial.msEq.on &&
    !adv.spatial.diffusion.on &&
    !adv.spatial.bassAlign.on &&
    !adv.spatial.signature.on &&
    !adv.spatial.correlation.on &&
    !adv.spatial.headroom.on &&
    !adv.eq.dynamic.on &&
    !adv.eq.crossover.on &&
    !adv.eq.spectral.on &&
    !adv.eq.presence.on &&
    !adv.eq.deess.on &&
    !adv.eq.notch.on &&
    !adv.limiter.window.on &&
    !adv.limiter.harmonics.on &&
    !adv.limiter.mpx.on &&
    !adv.limiter.preEmph.on &&
    !adv.limiter.codec.on &&
    !adv.limiter.undershoot.on &&
    !adv.intelligence.autoSource.on &&
    !adv.intelligence.morph.on &&
    !adv.intelligence.gainStaging.on &&
    !adv.intelligence.safety.on &&
    !adv.intelligence.remote.on
  );
}

export { PRESET_ORDER };
