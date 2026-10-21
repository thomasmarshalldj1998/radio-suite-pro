"""Full DSP chain registry and live control state.

The Python bridge exposes this module to the console. It is deliberately a
control plane: toggles and parameter values are validated and stored here, and
the preset loader maps the same section names used by the offline chain. Audio
remains on the console's Web Audio path until the native engine is selected.

The registry covers the 40 full-chain processors plus the three v3.1 dynamics
modules, for 43 modules in the UI.
"""

from __future__ import annotations

import configparser
import math
import os
import threading
import time
from typing import Any

ROOT = os.path.dirname(os.path.abspath(__file__))
FULL_CHAIN_CFG = os.path.join(ROOT, "signalpath_full_chain_presets.cfg")
V31_CFG = os.path.join(ROOT, "signalpath_v3.1_presets.cfg")

PRESET_ALIASES = {
    "OFCOM-FM-TRANSMIT": "FM-Reference",
    "OFCOM-DAB-STANDARD": "Streaming-Safe",
    "WEB-HD-HIGH": "Music-Open",
    "Clean Reference": "Reference-Flat",
    "Warm Broadcast": "Broadcast-Punch",
    "Punchy Radio": "Broadcast-Punch",
}

PUBLIC_PRESETS = (
    "OFCOM-FM-TRANSMIT",
    "OFCOM-DAB-STANDARD",
    "WEB-HD-HIGH",
    "Clean Reference",
    "Warm Broadcast",
    "Punchy Radio",
    "Reference-Flat",
    "Broadcast-Punch",
    "Speech-Clarity",
    "Music-Open",
    "Podcast-Clean",
    "Streaming-Safe",
    "FM-Reference",
    "Archive-Transparent",
)


def _num(value: float, low: float, high: float, step: float = 0.1, unit: str = "") -> dict[str, Any]:
    return {"value": value, "min": low, "max": high, "step": step, "unit": unit}


def _choice(value: str, options: list[str]) -> dict[str, Any]:
    return {"value": value, "options": options}


def _bool(value: bool) -> dict[str, Any]:
    return {"value": bool(value)}


# id, display name, category, parameters. The id is also the stage name used
# by signalpath_full_chain_presets.cfg.
MODULE_DEFS: tuple[tuple[str, str, str, dict[str, dict[str, Any]]], ...] = (
    ("input_dc_phase", "DC Offset & Phase", "Input Conditioning", {
        "dc_block_hz": _num(5.0, 1.0, 30.0, 0.5, "Hz"),
        "align_ms": _num(0.0, 0.0, 5.0, 0.1, "ms"),
        "polarity": _choice("+1", ["+1", "-1"]),
    }),
    ("clip_repair_declick", "Clip Repair / De-Click", "Restoration", {
        "clip_threshold": _num(0.999, 0.5, 1.0, 0.001),
        "max_repair_ms": _num(1.5, 0.05, 10.0, 0.05, "ms"),
        "declick": _bool(True),
    }),
    ("hum_canceller", "Hum Canceller", "Restoration", {
        "mains_hz": _choice("50", ["50", "60"]),
        "harmonics": _num(4, 1, 8, 1),
        "depth_db": _num(-24.0, -60.0, -3.0, 1.0, "dB"),
    }),
    ("noise_adaptive_hiss", "Adaptive Hiss", "Restoration", {
        "reduction_db": _num(6.0, 0.0, 18.0, 0.5, "dB"),
        "hf_hz": _num(4000.0, 2000.0, 12000.0, 100.0, "Hz"),
    }),
    ("adaptive_noise_gate", "Adaptive Noise Gate", "Restoration", {
        "margin_db": _num(8.0, 0.0, 30.0, 0.5, "dB"),
        "hold_ms": _num(90.0, 0.0, 1000.0, 5.0, "ms"),
        "range_db": _num(60.0, 6.0, 120.0, 1.0, "dB"),
    }),
    ("source_match_eq", "Source Match EQ", "EQ & Tone", {
        "profile": _choice("broadcast", ["broadcast", "speech", "music", "flat"]),
        "amount": _num(60.0, 0.0, 100.0, 1.0, "%"),
    }),
    ("parametric_eq_6band", "Parametric EQ 6-Band", "EQ & Tone", {
        "presence_db": _num(0.0, -18.0, 18.0, 0.5, "dB"),
        "air_db": _num(0.0, -18.0, 18.0, 0.5, "dB"),
    }),
    ("de_mud_clarity", "De-Mud & Clarity", "EQ & Tone", {
        "mud_cut_db": _num(-3.0, -12.0, 0.0, 0.5, "dB"),
        "clarity_db": _num(2.0, 0.0, 12.0, 0.5, "dB"),
    }),
    ("dynamic_tilt", "Dynamic Tilt", "EQ & Tone", {
        "tilt_db": _num(0.0, -12.0, 12.0, 0.5, "dB"),
        "dynamic_db": _num(0.0, -12.0, 12.0, 0.5, "dB"),
    }),
    ("bass_sculptor_3band", "Bass Sculptor 3-Band", "EQ & Tone", {
        "sub_db": _num(0.0, -18.0, 18.0, 0.5, "dB"),
        "punch_db": _num(0.0, -18.0, 18.0, 0.5, "dB"),
        "warmth_db": _num(0.0, -18.0, 18.0, 0.5, "dB"),
    }),
    ("vocal_presence_isolate", "Vocal Presence", "EQ & Tone", {
        "presence_db": _num(3.0, 0.0, 12.0, 0.5, "dB"),
        "side_reduction_db": _num(-3.0, -12.0, 0.0, 0.5, "dB"),
    }),
    ("de_esser_psycho", "Psycho De-Esser", "EQ & Tone", {
        "threshold_db": _num(-28.0, -60.0, 0.0, 1.0, "dB"),
        "ratio": _num(4.0, 1.0, 20.0, 0.5),
        "freq": _num(6500.0, 4000.0, 10000.0, 100.0, "Hz"),
    }),
    ("air_brilliance", "Air & Brilliance", "EQ & Tone", {
        "air_db": _num(3.0, -6.0, 12.0, 0.5, "dB"),
        "drive": _num(0.8, 0.0, 4.0, 0.1),
    }),
    ("agc_dual_speed", "AGC Dual-Speed", "Dynamics", {
        "target_db": _num(-18.0, -36.0, -6.0, 0.5, "dB"),
        "max_boost_db": _num(12.0, 0.0, 24.0, 0.5, "dB"),
    }),
    ("upward_compressor", "Upward Compressor", "Dynamics", {
        "threshold_db": _num(-30.0, -60.0, 0.0, 1.0, "dB"),
        "ratio": _num(2.0, 1.0, 10.0, 0.1),
        "range_db": _num(12.0, 0.0, 30.0, 0.5, "dB"),
    }),
    ("downward_compressor", "Downward Compressor", "Dynamics", {
        "threshold_db": _num(-18.0, -60.0, 0.0, 1.0, "dB"),
        "ratio": _num(3.0, 1.0, 20.0, 0.1),
        "knee_db": _num(6.0, 0.0, 24.0, 0.5, "dB"),
    }),
    ("multiband_compressor", "Multiband Compressor", "Dynamics", {
        "low_threshold_db": _num(-24.0, -60.0, 0.0, 1.0, "dB"),
        "mid_threshold_db": _num(-20.0, -60.0, 0.0, 1.0, "dB"),
        "high_threshold_db": _num(-18.0, -60.0, 0.0, 1.0, "dB"),
    }),
    ("envelope_shaper", "Envelope Shaper", "Dynamics", {
        "attack_pct": _num(0.0, -100.0, 100.0, 1.0, "%"),
        "sustain_pct": _num(0.0, -100.0, 100.0, 1.0, "%"),
        "mode": _choice("emphasise", ["emphasise", "smooth", "transparent"]),
    }),
    ("density_control", "Density Control", "Dynamics", {
        "amount": _num(40.0, 0.0, 100.0, 1.0, "%"),
        "threshold_db": _num(-26.0, -60.0, 0.0, 1.0, "dB"),
    }),
    ("ms_dynamic_width", "M/S Dynamic Width", "Stereo", {
        "width": _num(1.0, 0.0, 2.0, 0.01),
        "dynamic": _num(0.0, -1.0, 1.0, 0.01),
    }),
    ("stereo_enhancer_3band", "Stereo Enhancer 3-Band", "Stereo", {
        "low_width": _num(0.8, 0.0, 2.0, 0.01),
        "mid_width": _num(1.0, 0.0, 2.0, 0.01),
        "high_width": _num(1.3, 0.0, 2.0, 0.01),
    }),
    ("ambience_recovery", "Ambience Recovery", "Stereo", {
        "amount": _num(30.0, 0.0, 150.0, 1.0, "%"),
        "freq": _num(3000.0, 800.0, 10000.0, 100.0, "Hz"),
    }),
    ("bass_phase_lock", "Bass Phase Lock", "Stereo", {
        "crossover_hz": _num(120.0, 40.0, 300.0, 5.0, "Hz"),
        "amount": _num(100.0, 0.0, 100.0, 1.0, "%"),
    }),
    ("mono_compat_alert", "Mono Compatibility", "Stereo", {
        "correlation_threshold": _num(0.3, -1.0, 1.0, 0.01),
        "mono_loss_threshold_db": _num(-6.0, -24.0, 0.0, 0.5, "dB"),
    }),
    ("downmix_preview", "Downmix Preview", "Stereo", {
        "mode": _choice("mono", ["mono", "sum", "difference"]),
        "gain_db": _num(0.0, -24.0, 12.0, 0.5, "dB"),
    }),
    ("saturation_2nd_order", "2nd-Order Saturation", "Harmonics & Tape", {
        "drive_db": _num(6.0, 0.0, 24.0, 0.5, "dB"),
        "amount": _num(0.25, 0.0, 1.0, 0.01),
    }),
    ("harmonic_edge_3rd", "3rd-Harmonic Edge", "Harmonics & Tape", {
        "drive_db": _num(6.0, 0.0, 24.0, 0.5, "dB"),
        "amount": _num(0.2, 0.0, 1.0, 0.01),
    }),
    ("tape_emulation", "Tape Emulation", "Harmonics & Tape", {
        "drive": _num(1.3, 1.0, 6.0, 0.1),
        "head_bump_db": _num(1.5, -6.0, 6.0, 0.5, "dB"),
        "mix": _num(1.0, 0.0, 1.0, 0.01),
    }),
    ("pre_emphasis_filter", "Pre-Emphasis", "Loudness", {
        "time_constant_us": _choice("75", ["50", "75"]),
        "gain_db": _num(9.0, -12.0, 12.0, 0.5, "dB"),
        "mode": _choice("pre", ["pre", "de"]),
    }),
    ("short_term_loudness", "Short-Term Loudness", "Loudness", {
        "ceiling_lufs": _num(-16.0, -30.0, -5.0, 0.5, "LUFS"),
        "window_s": _choice("1", ["1", "3"]),
    }),
    ("loudness_gate_silence", "Silence Gate", "Loudness", {
        "threshold_db": _num(-60.0, -96.0, -20.0, 1.0, "dB"),
        "hold_ms": _num(500.0, 0.0, 5000.0, 10.0, "ms"),
    }),
    ("lra_dynamic_range_preserve", "LRA Preserve", "Loudness", {
        "target_db": _num(-18.0, -40.0, 0.0, 0.5, "dB"),
        "max_reduction_db": _num(6.0, 0.0, 18.0, 0.5, "dB"),
    }),
    ("true_peak_guard", "True-Peak Guard", "Protection & Output", {
        "ceiling_db": _num(-1.0, -12.0, 0.0, 0.1, "dBTP"),
        "lookahead_ms": _num(2.0, 0.0, 10.0, 0.5, "ms"),
        "oversample": _num(4, 2, 16, 1),
    }),
    ("lookahead_limiter", "Lookahead Limiter", "Protection & Output", {
        "ceiling_db": _num(-1.0, -12.0, 0.0, 0.1, "dB"),
        "lookahead_ms": _num(5.0, 0.5, 20.0, 0.5, "ms"),
    }),
    ("soft_knee_clipper", "Soft-Knee Clipper", "Protection & Output", {
        "ceiling_db": _num(-1.0, -12.0, 0.0, 0.1, "dB"),
        "drive_db": _num(0.0, 0.0, 24.0, 0.5, "dB"),
        "knee_db": _num(6.0, 0.0, 24.0, 0.5, "dB"),
    }),
    ("twopass_protection", "Two-Pass Protection", "Protection & Output", {
        "ceiling_db": _num(-0.5, -12.0, 0.0, 0.1, "dB"),
        "blend_pct": _num(0.0, 0.0, 15.0, 0.5, "%"),
    }),
    ("overshoot_correction", "Overshoot Correction", "Protection & Output", {
        "ceiling_db": _num(-0.1, -12.0, 0.0, 0.1, "dB"),
        "release_ms": _num(40.0, 1.0, 1000.0, 1.0, "ms"),
    }),
    ("perceptual_rolloff", "Perceptual Rolloff", "Codec & Delivery", {
        "cutoff_hz": _num(15000.0, 4000.0, 20000.0, 100.0, "Hz"),
        "slope_db_oct": _choice("24", ["12", "24", "48"]),
    }),
    ("bitrate_allocation", "Bitrate Allocation", "Codec & Delivery", {
        "total_kbps": _num(192, 48, 512, 8, "kbps"),
        "min_kbps": _num(24, 8, 96, 4, "kbps"),
    }),
    ("stereo_bandwidth_limit", "Stereo Bandwidth", "Codec & Delivery", {
        "cutoff_hz": _num(8000.0, 2000.0, 18000.0, 100.0, "Hz"),
        "width": _num(0.5, 0.0, 1.0, 0.01),
    }),
    ("preduck", "Lookahead Pre-Duck", "Dynamics", {
        "detect_ms": _num(3.0, 1.0, 10.0, 0.5, "ms"),
        "sensitivity": _num(50.0, 0.0, 100.0, 1.0, "%"),
        "range_db": _num(3.0, 0.0, 6.0, 0.5, "dB"),
    }),
    ("density_anchors", "Density Anchors", "Dynamics", {
        "bass_strength": _num(50.0, 0.0, 100.0, 1.0, "%"),
        "mid_strength": _num(50.0, 0.0, 100.0, 1.0, "%"),
    }),
    ("dualband_transient", "Dual-Band Transient", "Dynamics", {
        "low_attack": _num(0.0, -100.0, 100.0, 1.0, "%"),
        "high_attack": _num(0.0, -100.0, 100.0, 1.0, "%"),
        "mode": _choice("emphasise", ["emphasise", "smooth", "transparent"]),
    }),
)


def _module_payload(module_id: str, name: str, category: str, params: dict[str, Any], bypassed: bool) -> dict[str, Any]:
    return {
        "id": module_id,
        "name": name,
        "category": category,
        "bypassed": bool(bypassed),
        "params": params,
    }


class DspChainState:
    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.block_size = 1024
        self.active_preset = "Reference-Flat"
        self._modules: dict[str, dict[str, Any]] = {}
        for module_id, name, category, params in MODULE_DEFS:
            self._modules[module_id] = _module_payload(
                module_id, name, category, dict(params), True
            )
        self._perf_cache: dict[str, Any] = {}
        self._perf_at = 0.0

    # ── module state ───────────────────────────────────────────────────
    def modules(self) -> list[dict[str, Any]]:
        with self.lock:
            return [dict(module, params=dict(module["params"])) for module in self._modules.values()]

    def set_value(self, module_id: str, param: str, value: Any) -> dict[str, Any]:
        with self.lock:
            module = self._modules.get(module_id)
            if module is None:
                raise KeyError(module_id)
            if param == "bypassed":
                module["bypassed"] = bool(value)
                return {"ok": True, "module": module_id, "param": param, "value": module["bypassed"]}
            spec = module["params"].get(param)
            if spec is None:
                raise KeyError(param)
            if "options" in spec:
                option = str(value)
                if option not in spec["options"]:
                    raise ValueError(f"{param} must be one of {spec['options']}")
                spec["value"] = option
            elif isinstance(spec.get("value"), bool):
                spec["value"] = bool(value)
            else:
                number = float(value)
                if not math.isfinite(number):
                    raise ValueError("value must be finite")
                low = float(spec.get("min", -1e9))
                high = float(spec.get("max", 1e9))
                spec["value"] = max(low, min(high, number))
            return {"ok": True, "module": module_id, "param": param, "value": spec["value"]}

    def set_bypassed(self, module_id: str, bypassed: bool) -> None:
        self.set_value(module_id, "bypassed", bypassed)

    # ── presets ────────────────────────────────────────────────────────
    @staticmethod
    def _parse(value: str) -> Any:
        text = value.strip()
        lower = text.lower()
        if lower in ("true", "false"):
            return lower == "true"
        try:
            number = float(text)
        except ValueError:
            return text
        return int(number) if number.is_integer() else number

    def load_preset(self, name: str, morph_time: float = 2.0) -> dict[str, Any]:
        canonical = PRESET_ALIASES.get(name, name)
        parser = configparser.ConfigParser()
        parser.read([FULL_CHAIN_CFG, V31_CFG])
        section = canonical if parser.has_section(canonical) else name
        if not parser.has_section(section):
            raise KeyError(name)
        with self.lock:
            # Every load starts from neutral; the section then enables what it
            # needs. That matches the offline chain's "defaults bypassed" rule.
            for module in self._modules.values():
                module["bypassed"] = True
            applied = 0
            for key, raw in parser.items(section):
                if "." not in key:
                    continue
                stage, param = key.split(".", 1)
                module = self._modules.get(stage)
                if module is None:
                    continue
                value = self._parse(raw)
                if param == "enabled":
                    module["bypassed"] = not bool(value)
                    applied += 1
                elif param in module["params"]:
                    try:
                        self.set_value(stage, param, value)
                        applied += 1
                    except (KeyError, ValueError, TypeError):
                        continue
            self.active_preset = name
            self._perf_at = 0.0
            return {
                "ok": True,
                "preset": name,
                "canonical": section,
                "morph_time": float(max(1.0, min(5.0, morph_time))),
                "applied": applied,
            }

    # ── performance probe ──────────────────────────────────────────────
    def performance(self, force: bool = False) -> dict[str, Any]:
        now = time.time()
        # A forced probe (the console's Probe button) still short-circuits if a
        # measurement just landed, so holding the button cannot stack probes.
        with self.lock:
            ttl = 1.0 if force else 8.0
            if self._perf_cache and now - self._perf_at < ttl:
                return self._perf_copy()
            block = self.block_size
        # Measure the real module classes on a representative block. This is a
        # worst-case diagnostic: it enables every stage, independent of the
        # current bypass state, so the UI can show headroom (or the lack of it).
        elapsed, stages = _probe_all_modules(block)
        audio_s = block / 48_000.0
        factor = audio_s / elapsed if elapsed > 0 else 0.0
        total_ms = elapsed * 1000.0
        rows = [
            {
                "id": stage,
                "name": name,
                "category": category,
                "ms": round(ms, 3),
                "pct": round(100.0 * ms / total_ms, 1) if total_ms > 0 else 0.0,
            }
            for stage, name, category, ms in stages
        ]
        rows.sort(key=lambda row: row["ms"], reverse=True)
        with self.lock:
            self._perf_cache = {
                "realtime_factor": round(factor, 2),
                "cpu_dsp_pct": round(min(100.0, 100.0 / factor) if factor > 0 else 100.0, 1),
                "block_size": block,
                "latency_ms": round(audio_s * 1000.0, 1),
                "block_time_ms": round(total_ms, 2),
                "dropped_blocks": 0,
                "state": "live" if factor >= 1.0 else "lagging",
                "modules": len(MODULE_DEFS),
                "stages": rows,
                "measured_at": now,
            }
            self._perf_at = now
            return self._perf_copy()

    def _perf_copy(self) -> dict[str, Any]:
        payload = dict(self._perf_cache)
        payload["stages"] = [dict(row) for row in self._perf_cache.get("stages", ())]
        return payload


def _probe_all_modules(
    block_size: int,
) -> tuple[float, list[tuple[str, str, str, float]]]:
    """Time one block through every DSP class.

    Returns ``(block_seconds, [(id, name, category, ms), ...])``. Each stage is
    timed on its own so the console can rank them; the per-stage times sum to
    the block time because the calls are made back to back with nothing else in
    the loop.
    """
    try:
        import importlib
        import inspect
        import math

        def programme() -> tuple[list[float], list[float]]:
            return (
                [0.2 * math.sin(2.0 * math.pi * 440.0 * i / 48_000.0) for i in range(n)],
                [0.18 * math.sin(2.0 * math.pi * 440.0 * i / 48_000.0 + 0.2) for i in range(n)],
            )

        n = max(256, int(block_size))
        chain: list[tuple[str, str, str, Any]] = []
        for module_id, name, category, _ in MODULE_DEFS:
            module = importlib.import_module(f"proc_{module_id}")
            classes = [
                obj for _, obj in inspect.getmembers(module, inspect.isclass)
                if obj.__module__ == f"proc_{module_id}"
            ]
            if classes:
                chain.append((module_id, name, category, classes[0](enabled=True)))
        # Warm the caches and lazily-built tables first, then time several
        # blocks: a dropped block is about sustained throughput, and one cold
        # block would only measure page faults and first-call overhead.
        left, right = programme()
        for _, _, _, processor in chain:
            left, right = processor.process_stereo(left, right)
        blocks = 5
        timings = [0.0] * len(chain)
        started = time.perf_counter()
        for _ in range(blocks):
            left, right = programme()
            for i, (_, _, _, processor) in enumerate(chain):
                stage_start = time.perf_counter()
                left, right = processor.process_stereo(left, right)
                timings[i] += time.perf_counter() - stage_start
        elapsed = max(1e-9, (time.perf_counter() - started) / blocks)
        stages = [
            (module_id, name, category, 1000.0 * total / blocks)
            for (module_id, name, category, _), total in zip(chain, timings)
        ]
        return elapsed, stages
    except Exception:
        return 1.0, []


dsp_state = DspChainState()
