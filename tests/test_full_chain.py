#!/usr/bin/env python3
"""SignalPath full-chain verification.

    python3 tests/test_full_chain.py

Checks every requested processor module, its bypass contract, an active run,
the full chain, the preset file, and the key protective/control behaviours.
Prints "N checks passed, M failed." and exits non-zero on failure.
"""

from __future__ import annotations

import configparser
import importlib
import inspect
import math
import os
import sys
import traceback

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from proc_bitrate_allocation import BitrateAllocation  # noqa: E402
from proc_downmix_preview import DownmixPreview  # noqa: E402
from proc_downward_compressor import DownwardCompressor  # noqa: E402
from proc_lookahead_limiter import LookaheadLimiter  # noqa: E402
from proc_mono_compat_alert import MonoCompatAlert  # noqa: E402
from proc_true_peak_guard import TruePeakGuard  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FS = 48_000
STAGES = [
    "input_dc_phase",
    "clip_repair_declick",
    "hum_canceller",
    "noise_adaptive_hiss",
    "adaptive_noise_gate",
    "source_match_eq",
    "parametric_eq_6band",
    "de_mud_clarity",
    "dynamic_tilt",
    "bass_sculptor_3band",
    "vocal_presence_isolate",
    "de_esser_psycho",
    "air_brilliance",
    "agc_dual_speed",
    "upward_compressor",
    "downward_compressor",
    "multiband_compressor",
    "envelope_shaper",
    "density_control",
    "ms_dynamic_width",
    "stereo_enhancer_3band",
    "ambience_recovery",
    "bass_phase_lock",
    "mono_compat_alert",
    "downmix_preview",
    "saturation_2nd_order",
    "harmonic_edge_3rd",
    "tape_emulation",
    "pre_emphasis_filter",
    "short_term_loudness",
    "loudness_gate_silence",
    "lra_dynamic_range_preserve",
    "true_peak_guard",
    "lookahead_limiter",
    "soft_knee_clipper",
    "twopass_protection",
    "overshoot_correction",
    "perceptual_rolloff",
    "bitrate_allocation",
    "stereo_bandwidth_limit",
]

CHECKS = 0
FAILED = 0


def check(label: str, condition: bool) -> None:
    global CHECKS, FAILED
    CHECKS += 1
    if not condition:
        FAILED += 1
        print(f"FAIL {label}")


def main_class(stage: str) -> type:
    module = importlib.import_module(f"proc_{stage}")
    classes = [
        obj
        for _, obj in inspect.getmembers(module, inspect.isclass)
        if obj.__module__ == f"proc_{stage}"
    ]
    if not classes:
        raise AssertionError(f"no processor class in proc_{stage}")
    return classes[0]


def signal(seconds: float = 0.12) -> tuple[list[float], list[float]]:
    n = int(FS * seconds)
    left = [
        0.28 * math.sin(2 * math.pi * 1_000 * i / FS)
        + 0.08 * math.sin(2 * math.pi * 60 * i / FS)
        for i in range(n)
    ]
    right = [
        0.24 * math.sin(2 * math.pi * 1_000 * i / FS + 0.2)
        + 0.06 * math.sin(2 * math.pi * 60 * i / FS)
        for i in range(n)
    ]
    return left, right


def test_modules() -> None:
    for stage in STAGES:
        path = os.path.join(ROOT, f"proc_{stage}.py")
        check(f"{stage}: file exists", os.path.isfile(path))
        cls = main_class(stage)
        left, right = signal()
        obj = cls()
        out_l, out_r = obj.process_stereo(left, right)
        check(f"{stage}: default bypass is bit-exact", out_l == left and out_r == right)
        active = cls(enabled=True)
        active_l, active_r = active.process_stereo(left, right)
        check(f"{stage}: active length preserved", len(active_l) == len(left) and len(active_r) == len(right))
        check(
            f"{stage}: active output finite",
            all(math.isfinite(v) for v in active_l + active_r),
        )
        check(f"{stage}: state is a dict", isinstance(active.state(), dict))


def test_full_chain() -> None:
    left, right = signal(0.25)
    chain = []
    for stage in STAGES:
        chain.append(main_class(stage)(enabled=True))
    out_l, out_r = left, right
    failures = 0
    for stage, processor in zip(STAGES, chain):
        try:
            out_l, out_r = processor.process_stereo(out_l, out_r)
        except Exception:
            failures += 1
            traceback.print_exc()
            print(f"FAIL chain stage {stage}")
    check("chain: all stages ran", failures == 0)
    check("chain: length preserved", len(out_l) == len(left) and len(out_r) == len(right))
    check("chain: output finite", all(math.isfinite(v) for v in out_l + out_r))
    check("chain: output bounded", max(abs(v) for v in out_l + out_r) <= 2.0)


def test_protection() -> None:
    left, right = signal()
    loud = [3.0 * x for x in left], [3.0 * x for x in right]
    comp = DownwardCompressor(FS, enabled=True, threshold_db=-30.0, ratio=10.0, attack_ms=1.0, release_ms=50.0)
    out_l, out_r = comp.process_stereo(*loud)
    check("downward: loud signal is reduced", max(abs(v) for v in out_l) < max(abs(v) for v in loud[0]))
    check("downward: reduction reported", comp.state()["gain_reduction_db"] > 0.0)

    guard = TruePeakGuard(FS, enabled=True, ceiling_db=-6.0, lookahead_ms=2.0)
    out_l, out_r = guard.process_stereo(loud[0], loud[1])
    ceiling = 10.0 ** (-6.0 / 20.0)
    check("true-peak: ceiling holds", max(abs(v) for v in out_l + out_r) <= ceiling + 1e-9)
    check("true-peak: latency is declared", guard.latency_samples == int(2.0 * FS / 1000.0))
    check("true-peak: guard reports reduction", guard.state()["max_reduction_db"] > 0.0)

    limiter = LookaheadLimiter(FS, enabled=True, ceiling_db=-3.0, lookahead_ms=5.0)
    out_l, out_r = limiter.process_stereo(loud[0], loud[1])
    check("limiter: ceiling holds", max(abs(v) for v in out_l + out_r) <= 10 ** (-3 / 20) + 1e-9)
    check("limiter: lookahead latency", limiter.latency_samples == int(5.0 * FS / 1000.0))


def test_control_and_stereo() -> None:
    alloc = BitrateAllocation(total_kbps=192, streams=("a", "b", "c"), weights=(0.6, 0.3, 0.1), min_kbps=24)
    allocation = alloc.allocate()
    check("bitrate: allocation sums to total", sum(allocation.values()) == 192)
    check("bitrate: minimum respected", min(allocation.values()) >= 24)
    check("bitrate: primary gets most", allocation["a"] > allocation["b"] > allocation["c"])

    mono = MonoCompatAlert(FS, enabled=True)
    anti = [math.sin(2 * math.pi * 500 * i / FS) for i in range(4800)]
    mono.process_stereo(anti, [-x for x in anti])
    check("mono: anti-phase is flagged", mono.state()["alert"] is True)
    check("mono: correlation is negative", mono.state()["correlation"] < 0.0)

    preview = DownmixPreview(FS, enabled=True, mode="mono")
    out_l, out_r = preview.process_stereo(*signal())
    check("downmix: both channels equal", out_l == out_r)
    check("downmix: preview is mono sum", all(abs(a - 0.5 * (b + c)) < 1e-12 for a, b, c in zip(out_l, *signal())))


def test_presets() -> None:
    parser = configparser.ConfigParser()
    read = parser.read(os.path.join(ROOT, "signalpath_full_chain_presets.cfg"))
    check("presets: file parses", len(read) == 1)
    check("presets: version", parser.get("meta", "version") == "4.0")
    order = [s.strip() for s in parser.get("chain", "order").split(",")]
    check("presets: 40 stages", len(order) == 40)
    check("presets: order matches modules", order == STAGES)
    for stage in STAGES:
        check(f"presets: stage {stage} has module", os.path.isfile(os.path.join(ROOT, f"proc_{stage}.py")))
    for section in (
        "Reference-Flat",
        "Broadcast-Punch",
        "Speech-Clarity",
        "Music-Open",
        "Podcast-Clean",
        "Streaming-Safe",
        "FM-Reference",
        "Archive-Transparent",
    ):
        check(f"presets: {section} exists", parser.has_section(section))
    flat = parser["Reference-Flat"]
    check("presets: flat disables every stage", all(flat.get(f"{s}.enabled") == "false" for s in STAGES))
    check("presets: FM pre-emphasis is 50 us", parser.get("FM-Reference", "pre_emphasis_filter.time_constant_us") == "50")


def main() -> int:
    suites = [test_modules, test_full_chain, test_protection, test_control_and_stereo, test_presets]
    for suite in suites:
        try:
            suite()
        except Exception:
            global FAILED
            FAILED += 1
            traceback.print_exc()
    print(f"{CHECKS} checks passed, {FAILED} failed.")
    return 1 if FAILED else 0


if __name__ == "__main__":
    raise SystemExit(main())
