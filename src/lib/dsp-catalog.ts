import type { DspModule, DspParam } from "@/lib/backend-bridge";

const n = (value: number, min: number, max: number, step = 1, unit = ""): DspParam => ({
  value,
  min,
  max,
  step,
  unit,
});
const c = (value: string, options: string[]): DspParam => ({ value, options });

export const CHAIN_CATEGORIES = [
  "Input Conditioning",
  "Restoration",
  "EQ & Tone",
  "Dynamics",
  "Stereo",
  "Harmonics & Tape",
  "Loudness",
  "Protection & Output",
  "Codec & Delivery",
] as const;

type Entry = {
  id: string;
  name: string;
  category: (typeof CHAIN_CATEGORIES)[number];
  params: Record<string, DspParam>;
};

const ENTRIES: Entry[] = [
  { id: "input_dc_phase", name: "DC Offset & Phase", category: "Input Conditioning", params: {
    dc_block_hz: n(5, 1, 30, 0.5, "Hz"), align_ms: n(0, 0, 5, 0.1, "ms"), polarity: c("+1", ["+1", "-1"]),
  } },
  { id: "clip_repair_declick", name: "Clip Repair / De-Click", category: "Restoration", params: {
    clip_threshold: n(0.999, 0.5, 1, 0.001), max_repair_ms: n(1.5, 0.05, 10, 0.05, "ms"), declick: { value: true },
  } },
  { id: "hum_canceller", name: "Hum Canceller", category: "Restoration", params: {
    mains_hz: c("50", ["50", "60"]), harmonics: n(4, 1, 8), depth_db: n(-24, -60, -3, 1, "dB"),
  } },
  { id: "noise_adaptive_hiss", name: "Adaptive Hiss", category: "Restoration", params: {
    reduction_db: n(6, 0, 18, 0.5, "dB"), hf_hz: n(4000, 2000, 12000, 100, "Hz"),
  } },
  { id: "adaptive_noise_gate", name: "Adaptive Noise Gate", category: "Restoration", params: {
    margin_db: n(8, 0, 30, 0.5, "dB"), hold_ms: n(90, 0, 1000, 5, "ms"), range_db: n(60, 6, 120, 1, "dB"),
  } },
  { id: "source_match_eq", name: "Source Match EQ", category: "EQ & Tone", params: {
    profile: c("broadcast", ["broadcast", "speech", "music", "flat"]), amount: n(60, 0, 100, 1, "%"),
  } },
  { id: "parametric_eq_6band", name: "Parametric EQ 6-Band", category: "EQ & Tone", params: {
    presence_db: n(0, -18, 18, 0.5, "dB"), air_db: n(0, -18, 18, 0.5, "dB"),
  } },
  { id: "de_mud_clarity", name: "De-Mud & Clarity", category: "EQ & Tone", params: {
    mud_cut_db: n(-3, -12, 0, 0.5, "dB"), clarity_db: n(2, 0, 12, 0.5, "dB"),
  } },
  { id: "dynamic_tilt", name: "Dynamic Tilt", category: "EQ & Tone", params: {
    tilt_db: n(0, -12, 12, 0.5, "dB"), dynamic_db: n(0, -12, 12, 0.5, "dB"),
  } },
  { id: "bass_sculptor_3band", name: "Bass Sculptor 3-Band", category: "EQ & Tone", params: {
    sub_db: n(0, -18, 18, 0.5, "dB"), punch_db: n(0, -18, 18, 0.5, "dB"), warmth_db: n(0, -18, 18, 0.5, "dB"),
  } },
  { id: "vocal_presence_isolate", name: "Vocal Presence", category: "EQ & Tone", params: {
    presence_db: n(3, 0, 12, 0.5, "dB"), side_reduction_db: n(-3, -12, 0, 0.5, "dB"),
  } },
  { id: "de_esser_psycho", name: "Psycho De-Esser", category: "EQ & Tone", params: {
    threshold_db: n(-28, -60, 0, 1, "dB"), ratio: n(4, 1, 20, 0.5), freq: n(6500, 4000, 10000, 100, "Hz"),
  } },
  { id: "air_brilliance", name: "Air & Brilliance", category: "EQ & Tone", params: {
    air_db: n(3, -6, 12, 0.5, "dB"), drive: n(0.8, 0, 4, 0.1),
  } },
  { id: "agc_dual_speed", name: "AGC Dual-Speed", category: "Dynamics", params: {
    target_db: n(-18, -36, -6, 0.5, "dB"), max_boost_db: n(12, 0, 24, 0.5, "dB"),
  } },
  { id: "upward_compressor", name: "Upward Compressor", category: "Dynamics", params: {
    threshold_db: n(-30, -60, 0, 1, "dB"), ratio: n(2, 1, 10, 0.1), range_db: n(12, 0, 30, 0.5, "dB"),
  } },
  { id: "downward_compressor", name: "Downward Compressor", category: "Dynamics", params: {
    threshold_db: n(-18, -60, 0, 1, "dB"), ratio: n(3, 1, 20, 0.1), knee_db: n(6, 0, 24, 0.5, "dB"),
  } },
  { id: "multiband_compressor", name: "Multiband Compressor", category: "Dynamics", params: {
    low_threshold_db: n(-24, -60, 0, 1, "dB"), mid_threshold_db: n(-20, -60, 0, 1, "dB"), high_threshold_db: n(-18, -60, 0, 1, "dB"),
  } },
  { id: "envelope_shaper", name: "Envelope Shaper", category: "Dynamics", params: {
    attack_pct: n(0, -100, 100, 1, "%"), sustain_pct: n(0, -100, 100, 1, "%"), mode: c("emphasise", ["emphasise", "smooth", "transparent"]),
  } },
  { id: "density_control", name: "Density Control", category: "Dynamics", params: {
    amount: n(40, 0, 100, 1, "%"), threshold_db: n(-26, -60, 0, 1, "dB"),
  } },
  { id: "ms_dynamic_width", name: "M/S Dynamic Width", category: "Stereo", params: {
    width: n(1, 0, 2, 0.01), dynamic: n(0, -1, 1, 0.01),
  } },
  { id: "stereo_enhancer_3band", name: "Stereo Enhancer 3-Band", category: "Stereo", params: {
    low_width: n(0.8, 0, 2, 0.01), mid_width: n(1, 0, 2, 0.01), high_width: n(1.3, 0, 2, 0.01),
  } },
  { id: "ambience_recovery", name: "Ambience Recovery", category: "Stereo", params: {
    amount: n(30, 0, 150, 1, "%"), freq: n(3000, 800, 10000, 100, "Hz"),
  } },
  { id: "bass_phase_lock", name: "Bass Phase Lock", category: "Stereo", params: {
    crossover_hz: n(120, 40, 300, 5, "Hz"), amount: n(100, 0, 100, 1, "%"),
  } },
  { id: "mono_compat_alert", name: "Mono Compatibility", category: "Stereo", params: {
    correlation_threshold: n(0.3, -1, 1, 0.01), mono_loss_threshold_db: n(-6, -24, 0, 0.5, "dB"),
  } },
  { id: "downmix_preview", name: "Downmix Preview", category: "Stereo", params: {
    mode: c("mono", ["mono", "sum", "difference"]), gain_db: n(0, -24, 12, 0.5, "dB"),
  } },
  { id: "saturation_2nd_order", name: "2nd-Order Saturation", category: "Harmonics & Tape", params: {
    drive_db: n(6, 0, 24, 0.5, "dB"), amount: n(0.25, 0, 1, 0.01),
  } },
  { id: "harmonic_edge_3rd", name: "3rd-Harmonic Edge", category: "Harmonics & Tape", params: {
    drive_db: n(6, 0, 24, 0.5, "dB"), amount: n(0.2, 0, 1, 0.01),
  } },
  { id: "tape_emulation", name: "Tape Emulation", category: "Harmonics & Tape", params: {
    drive: n(1.3, 1, 6, 0.1), head_bump_db: n(1.5, -6, 6, 0.5, "dB"), mix: n(1, 0, 1, 0.01),
  } },
  { id: "pre_emphasis_filter", name: "Pre-Emphasis", category: "Loudness", params: {
    time_constant_us: c("75", ["50", "75"]), gain_db: n(9, -12, 12, 0.5, "dB"), mode: c("pre", ["pre", "de"]),
  } },
  { id: "short_term_loudness", name: "Short-Term Loudness", category: "Loudness", params: {
    ceiling_lufs: n(-16, -30, -5, 0.5, "LUFS"), window_s: c("1", ["1", "3"]),
  } },
  { id: "loudness_gate_silence", name: "Silence Gate", category: "Loudness", params: {
    threshold_db: n(-60, -96, -20, 1, "dB"), hold_ms: n(500, 0, 5000, 10, "ms"),
  } },
  { id: "lra_dynamic_range_preserve", name: "LRA Preserve", category: "Loudness", params: {
    target_db: n(-18, -40, 0, 0.5, "dB"), max_reduction_db: n(6, 0, 18, 0.5, "dB"),
  } },
  { id: "true_peak_guard", name: "True-Peak Guard", category: "Protection & Output", params: {
    ceiling_db: n(-1, -12, 0, 0.1, "dBTP"), lookahead_ms: n(2, 0, 10, 0.5, "ms"), oversample: n(4, 2, 16, 1),
  } },
  { id: "lookahead_limiter", name: "Lookahead Limiter", category: "Protection & Output", params: {
    ceiling_db: n(-1, -12, 0, 0.1, "dB"), lookahead_ms: n(5, 0.5, 20, 0.5, "ms"),
  } },
  { id: "soft_knee_clipper", name: "Soft-Knee Clipper", category: "Protection & Output", params: {
    ceiling_db: n(-1, -12, 0, 0.1, "dB"), drive_db: n(0, 0, 24, 0.5, "dB"), knee_db: n(6, 0, 24, 0.5, "dB"),
  } },
  { id: "twopass_protection", name: "Two-Pass Protection", category: "Protection & Output", params: {
    ceiling_db: n(-0.5, -12, 0, 0.1, "dB"), blend_pct: n(0, 0, 15, 0.5, "%"),
  } },
  { id: "overshoot_correction", name: "Overshoot Correction", category: "Protection & Output", params: {
    ceiling_db: n(-0.1, -12, 0, 0.1, "dB"), release_ms: n(40, 1, 1000, 1, "ms"),
  } },
  { id: "perceptual_rolloff", name: "Perceptual Rolloff", category: "Codec & Delivery", params: {
    cutoff_hz: n(15000, 4000, 20000, 100, "Hz"), slope_db_oct: c("24", ["12", "24", "48"]),
  } },
  { id: "bitrate_allocation", name: "Bitrate Allocation", category: "Codec & Delivery", params: {
    total_kbps: n(192, 48, 512, 8, "kbps"), min_kbps: n(24, 8, 96, 4, "kbps"),
  } },
  { id: "stereo_bandwidth_limit", name: "Stereo Bandwidth", category: "Codec & Delivery", params: {
    cutoff_hz: n(8000, 2000, 18000, 100, "Hz"), width: n(0.5, 0, 1, 0.01),
  } },
  { id: "preduck", name: "Lookahead Pre-Duck", category: "Dynamics", params: {
    detect_ms: n(3, 1, 10, 0.5, "ms"), sensitivity: n(50, 0, 100, 1, "%"), range_db: n(3, 0, 6, 0.5, "dB"),
  } },
  { id: "density_anchors", name: "Density Anchors", category: "Dynamics", params: {
    bass_strength: n(50, 0, 100, 1, "%"), mid_strength: n(50, 0, 100, 1, "%"),
  } },
  { id: "dualband_transient", name: "Dual-Band Transient", category: "Dynamics", params: {
    low_attack: n(0, -100, 100, 1, "%"), high_attack: n(0, -100, 100, 1, "%"), mode: c("emphasise", ["emphasise", "smooth", "transparent"]),
  } },
];

export const FALLBACK_MODULES: DspModule[] = ENTRIES.map((entry) => ({
  ...entry,
  bypassed: true,
  params: Object.fromEntries(
    Object.entries(entry.params).map(([key, value]) => [key, { ...value }]),
  ),
}));

export const PUBLIC_PRESETS = [
  "OFCOM-FM-TRANSMIT",
  "OFCOM-DAB-STANDARD",
  "WEB-HD-HIGH",
  "Clean Reference",
  "Warm Broadcast",
  "Punchy Radio",
  "Broadcast-Punch",
  "Speech-Clarity",
  "Music-Open",
  "Podcast-Clean",
  "Streaming-Safe",
  "FM-Reference",
  "Archive-Transparent",
  "Reference-Flat",
] as const;

/** Compact offline preset map. The bridge applies the full cfg when online. */
export const PRESET_ENABLES: Record<string, string[]> = {
  "Reference-Flat": [],
  "Clean Reference": [],
  "OFCOM-FM-TRANSMIT": ["input_dc_phase", "clip_repair_declick", "hum_canceller", "source_match_eq", "agc_dual_speed", "multiband_compressor", "bass_phase_lock", "short_term_loudness", "pre_emphasis_filter", "true_peak_guard", "lookahead_limiter", "soft_knee_clipper"],
  "FM-Reference": ["input_dc_phase", "clip_repair_declick", "hum_canceller", "source_match_eq", "agc_dual_speed", "multiband_compressor", "bass_phase_lock", "short_term_loudness", "pre_emphasis_filter", "true_peak_guard", "lookahead_limiter", "soft_knee_clipper"],
  "OFCOM-DAB-STANDARD": ["input_dc_phase", "clip_repair_declick", "noise_adaptive_hiss", "source_match_eq", "de_esser_psycho", "agc_dual_speed", "multiband_compressor", "true_peak_guard", "lookahead_limiter", "perceptual_rolloff", "stereo_bandwidth_limit"],
  "Streaming-Safe": ["input_dc_phase", "clip_repair_declick", "noise_adaptive_hiss", "source_match_eq", "de_esser_psycho", "agc_dual_speed", "multiband_compressor", "true_peak_guard", "lookahead_limiter", "perceptual_rolloff", "stereo_bandwidth_limit", "bitrate_allocation"],
  "WEB-HD-HIGH": ["input_dc_phase", "source_match_eq", "air_brilliance", "agc_dual_speed", "multiband_compressor", "ms_dynamic_width", "stereo_enhancer_3band", "ambience_recovery", "tape_emulation", "true_peak_guard", "lookahead_limiter", "perceptual_rolloff"],
  "Music-Open": ["input_dc_phase", "source_match_eq", "air_brilliance", "agc_dual_speed", "multiband_compressor", "ms_dynamic_width", "stereo_enhancer_3band", "ambience_recovery", "tape_emulation", "true_peak_guard", "lookahead_limiter", "perceptual_rolloff"],
  "Warm Broadcast": ["input_dc_phase", "clip_repair_declick", "source_match_eq", "bass_sculptor_3band", "saturation_2nd_order", "harmonic_edge_3rd", "tape_emulation", "agc_dual_speed", "multiband_compressor", "true_peak_guard", "lookahead_limiter"],
  "Broadcast-Punch": ["input_dc_phase", "clip_repair_declick", "source_match_eq", "bass_sculptor_3band", "saturation_2nd_order", "harmonic_edge_3rd", "agc_dual_speed", "multiband_compressor", "true_peak_guard", "lookahead_limiter"],
  "Punchy Radio": ["input_dc_phase", "clip_repair_declick", "source_match_eq", "de_mud_clarity", "bass_sculptor_3band", "agc_dual_speed", "multiband_compressor", "density_control", "true_peak_guard", "lookahead_limiter"],
  "Speech-Clarity": ["input_dc_phase", "clip_repair_declick", "hum_canceller", "adaptive_noise_gate", "source_match_eq", "de_mud_clarity", "vocal_presence_isolate", "de_esser_psycho", "agc_dual_speed", "upward_compressor", "downward_compressor", "true_peak_guard"],
  "Podcast-Clean": ["input_dc_phase", "clip_repair_declick", "hum_canceller", "noise_adaptive_hiss", "adaptive_noise_gate", "source_match_eq", "de_mud_clarity", "vocal_presence_isolate", "de_esser_psycho", "agc_dual_speed", "upward_compressor", "downward_compressor", "true_peak_guard"],
  "Archive-Transparent": ["input_dc_phase", "clip_repair_declick", "hum_canceller", "noise_adaptive_hiss", "de_esser_psycho", "bass_phase_lock", "overshoot_correction"],
};

export function applyPresetOffline(name: string, modules: DspModule[]): DspModule[] {
  const enabled = new Set(PRESET_ENABLES[name] ?? []);
  return modules.map((module) => ({
    ...module,
    bypassed: !enabled.has(module.id),
  }));
}
