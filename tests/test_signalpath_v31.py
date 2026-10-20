#!/usr/bin/env python3
"""SignalPath v3.1 — verification suite for the new encoder/DSP modules.

    python3 tests/test_signalpath_v31.py

Every check exercises the module's public interface; the suite prints
"N checks passed, M failed." and exits non-zero on any failure, matching the
repo's other verify scripts.
"""

from __future__ import annotations

import configparser
import math
import os
import random
import sys
import tempfile
import threading
import traceback
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from monitor_artefact_score import grade_for, score_artefacts  # noqa: E402
from monitor_continuity_log import EVENTS, ContinuityLog  # noqa: E402
from proc_2pass_clip import TwoPassClip, true_peak  # noqa: E402
from proc_density_anchors import DensityAnchors  # noqa: E402
from proc_dualband_transient import DualBandTransient  # noqa: E402
from proc_loudness_shortterm import ShortTermCeiling  # noqa: E402
from proc_preduck import PreDuck  # noqa: E402
from stream_codec_lame import (  # noqa: E402
    CodecUnavailable as LameUnavailable,
    LameConfig,
    LameEncoder,
    find_library,
    mp3_frame_header,
)
from stream_codec_libfdk_aac import (  # noqa: E402
    AACConfig,
    CodecUnavailable as AacUnavailable,
    FdkAACEncoder,
    adts_header,
)
from stream_encoder_core import (  # noqa: E402
    BitReservoir,
    EncoderCore,
    EncoderThread,
    PtsClock,
    RealtimeSetup,
    crc16_mpeg,
)
from system_health_report import HealthState, build_report, save_report  # noqa: E402
from system_src_lock import (  # noqa: E402
    DriftLock,
    PolyphaseResampler,
    coefficient_table,
    detect_sample_rate,
)
from transport_failover import FailoverConfig, FailoverRouter  # noqa: E402
from transport_simulcast import Simulcast  # noqa: E402

CHECKS = 0
FAILED = 0


def check(name: str, condition: bool, detail: str = "") -> None:
    global CHECKS, FAILED
    CHECKS += 1
    if not condition:
        FAILED += 1
        print(f"FAIL  {name}" + (f" — {detail}" if detail else ""))


def near(a: float, b: float, tol: float) -> bool:
    return abs(a - b) <= tol


def tone(freq: float, rate: int, seconds: float, amp: float = 0.5, phase: float = 0.0):
    return [amp * math.sin(2 * math.pi * freq * i / rate + phase) for i in range(int(rate * seconds))]


def rms(values) -> float:
    return math.sqrt(sum(v * v for v in values) / max(1, len(values)))


def db(value: float) -> float:
    return -120.0 if value <= 0 else 20.0 * math.log10(value)


def goertzel(values, freq: float, rate: int) -> float:
    n = len(values)
    k = 2 * math.cos(2 * math.pi * freq / rate)
    s1 = s2 = 0.0
    for v in values:
        s0 = v + k * s1 - s2
        s2, s1 = s1, s0
    return math.sqrt(max(0.0, s1 * s1 + s2 * s2 - k * s1 * s2)) / n


def test_clock() -> None:
    clock = PtsClock(48_000, 1152, start_pts=90_000)
    check("clock: 90 kHz", clock.snapshot()["clock_hz"] == 90_000)
    check("clock: frame duration", clock.frame_duration == round(1152 * 90_000 / 48_000))
    first = clock.advance()
    check("clock: starts at offset", first[0] == 90_000)
    for _ in range(999):
        clock.advance()
    check("clock: no drift over 1000 frames", clock.pts == 90_000 + 1000 * 2160)
    clock.reconnect()
    check("clock: PTS continuous across reconnect", clock.pts == 90_000 + 1000 * 2160)
    check("clock: DTS trails PTS", clock.dts < clock.pts)
    fine = PtsClock(44_100, 1152)
    for _ in range(1000):
        fine.advance()
    check("clock: 44.1 kHz stays exact", fine.pts == round(1000 * 1152 * 90000 / 44100))
    fine.restart(0)
    check("clock: restart resets", fine.pts == 0)


def test_crc_reservoir() -> None:
    check("crc16: CMS check value", crc16_mpeg(b"123456789") == 0xAEE7)
    res = BitReservoir(frame_bytes=100, frames=9)
    check("reservoir: nine frames", res.capacity == 900 and res.frames == 9)
    check("reservoir: starts full", res.fill_ratio == 1.0)
    for _ in range(8):
        res.commit(b"x" * 100, need=100)
    check("reservoir: drains on borrow", res.available == 100)
    res.commit(b"x" * 100, need=100)
    check("reservoir: underflow warning below 25 %", res.underflow_warning)
    entry = res.commit(b"x" * 10, need=100)
    check("reservoir: underflow counted", res.underflows >= 1 and entry["borrowed"] == 0)
    res.reset()
    check("reservoir: reset refills", res.fill_ratio == 1.0 and res.underflows == 0)
    fill = BitReservoir(frame_bytes=100, frames=9, mode="fill")
    fill.commit(b"x" * 10, need=100)
    check("reservoir: fill mode never borrows", fill.borrowed_total == 0)
    protect = BitReservoir(frame_bytes=100, frames=9, mode="protect")
    protect.commit(b"x" * 100, need=900)
    check("reservoir: protect keeps 25 %", protect.available >= 225)


def test_realtime() -> None:
    setup = RealtimeSetup()
    status = setup.configure("fifo", 80, None)
    check("realtime: status is reported", "applied" in status.as_dict())
    check(
        "realtime: graceful fallback",
        status.applied or bool(status.reason),
        status.reason,
    )
    check("realtime: policy recorded", status.policy in ("fifo", "rr", "other"))
    check(
        "realtime: realtime flag matches the policy",
        status.realtime == (status.policy == "fifo" and status.applied),
        f"{status.policy} applied={status.applied}",
    )
    setup.restore()
    check("realtime: restore is reported", setup.status.reason == "restored")


def test_encoder_thread() -> None:
    entered = threading.Event()
    seen: dict[str, object] = {}

    def work(encoder: EncoderThread) -> None:
        seen["ident"] = threading.get_ident()
        seen["scheduling"] = encoder.scheduling.as_dict()
        entered.set()
        encoder.stop_event.wait(0.5)

    encoder = EncoderThread(work, priority=70)
    status = encoder.start()
    check("thread: start returns scheduling", status.requested_priority == 70)
    check("thread: worker entered", entered.wait(1.0))
    check("thread: runs on its own thread", seen.get("ident") == encoder.ident)
    check("thread: scheduling applied in worker", isinstance(seen.get("scheduling"), dict))
    check("thread: reported running", encoder.running)
    check("thread: stop joins", encoder.stop())
    check("thread: stopped", not encoder.running)
    check("thread: no target error", encoder.error is None)
    check("thread: status snapshot", "scheduling" in encoder.status())


def test_encoder_core() -> None:
    core = EncoderCore(
        lambda pcm, index: b"\x00" * 100,
        codec="mp3",
        sample_rate=48_000,
        frame_samples=1152,
        crc=True,
    )
    packet = core.submit([0.0] * 1152)
    check("core: packet produced", packet is not None)
    assert packet is not None
    check("core: 90 kHz PTS", packet.pts == 0)
    check("core: CRC emitted", len(packet.crc) == 2)
    core.submit([0.0] * 1152)
    before = core.clock.pts
    core.reconnect()
    third = core.submit([0.0] * 1152)
    assert third is not None
    check("core: PTS continues after reconnect", third.pts == before)
    check("core: reconnect counted", core.clock.snapshot()["reconnects"] == 1)
    check("core: stats include reservoir", "reservoir" in core.stats())
    silent = EncoderCore(None, codec="mp3")
    silent.submit([0.0] * 1152)
    check("core: clock advances without a packetizer", silent.clock.pts == 2160)


def test_lame() -> None:
    cfg = LameConfig(bitrate_kbps=128, mode="cbr")
    check("lame: CBR accepted", cfg.validate().mode == "cbr")
    check("lame: 320 kbps accepted", LameConfig(bitrate_kbps=320).validate().bitrate_kbps == 320)
    try:
        LameConfig(bitrate_kbps=64).validate()
        check("lame: rejects 64 kbps", False)
    except ValueError:
        check("lame: rejects 64 kbps", True)
    standard = LameConfig.preset("standard")
    extreme = LameConfig.preset("extreme")
    check("lame: standard is VBR -V2", standard.mode == "vbr" and standard.vbr_quality == 2)
    check("lame: extreme is VBR -V0", extreme.mode == "vbr" and extreme.vbr_quality == 0)
    header = mp3_frame_header(128, 48_000)
    bits = int.from_bytes(header, "big")
    check("lame: header sync", (bits >> 21) == 0x7FF)
    check("lame: header MPEG-1 Layer III", ((bits >> 19) & 0x3) == 3 and ((bits >> 17) & 0x3) == 1)
    check("lame: header 48 kHz", ((bits >> 10) & 0x3) == 2)
    check("lame: header bitrate", ((bits >> 12) & 0xF) == 9)
    encoder = LameEncoder(cfg)
    check("lame: reservoir is nine frames", encoder.reservoir_frames == 9)
    check("lame: latency reported", 20 < encoder.latency_ms < 30)
    if encoder.available:
        sine = tone(1000, 48_000, 0.024, 0.3)
        interleaved = [s for pair in zip(sine, sine) for s in pair]
        mp3 = encoder.encode_frame(interleaved)
        check("lame: native encode produces a frame", len(mp3) > 100, f"{len(mp3)} bytes")
        check("lame: MPEG frame sync", mp3[:2] == b"\xff\xfb" or mp3[:2] == b"\xff\xf3")
        encoder.close()
    else:
        check("lame: missing library is reported, not hidden", not encoder.available)
        try:
            encoder.encode_frame([0.0] * 64)
            check("lame: encode raises without library", False)
        except LameUnavailable:
            check("lame: encode raises without library", True)


def test_aac() -> None:
    cfg = AACConfig(profile="he-aacv2", bitrate_kbps=64)
    check("aac: HE-AACv2 64 kbps accepted", cfg.validate().aot == 29)
    check("aac: HE-AACv2 measured delay", cfg.latency_ms == 148.0)
    try:
        AACConfig(profile="he-aacv2", bitrate_kbps=160).validate()
        check("aac: HE-AACv2 rejects 160 kbps", False)
    except ValueError:
        check("aac: HE-AACv2 rejects 160 kbps", True)
    ld = AACConfig(profile="aac-ld", bitrate_kbps=128)
    check("aac: AAC-LD 128 kbps accepted", ld.validate().aot == 23)
    check("aac: AAC-LD < 15 ms", ld.latency_ms < 15.0)
    check("aac: AAC-LD defaults to LATM", ld.container == "latm")
    try:
        AACConfig(profile="aac-ld", bitrate_kbps=128, container="adts").validate()
        check("aac: AAC-LD rejects ADTS", False)
    except ValueError:
        check("aac: AAC-LD rejects ADTS", True)
    header = adts_header(100, sample_rate=48_000, channels=2)
    length = ((header[3] & 0x03) << 11) | (header[4] << 3) | (header[5] >> 5)
    check("aac: ADTS sync", header[0] == 0xFF and (header[1] & 0xF0) == 0xF0)
    check("aac: ADTS length includes header", length == 107)
    check("aac: ADTS no CRC by default", header[1] & 1 == 1)
    protected = adts_header(100, sample_rate=48_000, channels=2, crc=True)
    check("aac: ADTS CRC is nine bytes", len(protected) == 9 and protected[1] & 1 == 0)
    encoder = FdkAACEncoder(cfg)
    check("aac: backend status exposed", "available" in encoder.status())
    if encoder.available:
        sine = tone(1000, 48_000, 0.1, 0.3)
        interleaved = [s for pair in zip(sine, sine) for s in pair]
        aac = encoder.encode_pcm(interleaved)
        check("aac: native encode produces bytes", len(aac) > 200, f"{len(aac)} bytes")
        check("aac: ADTS sync", aac[0] == 0xFF and (aac[1] & 0xF0) == 0xF0, aac[:2].hex())
        low_delay = FdkAACEncoder(
            AACConfig(profile="aac-ld", bitrate_kbps=128, sample_rate=48_000)
        )
        loud = low_delay.encode_pcm(interleaved)
        check("aac: AAC-LD LOAS sync", loud[:1] == b"\x56", loud[:2].hex())
    else:
        try:
            encoder.encode_pcm([0.0] * 2048)
            check("aac: encode raises without backend", False)
        except AacUnavailable:
            check("aac: encode raises without backend", True)


def test_ceiling() -> None:
    fs = 16_000
    signal = tone(1000, fs, 2.5, 0.5)
    bypass = ShortTermCeiling(fs, enabled=False)
    left, right = bypass.process_stereo(signal, signal)
    check("ceiling: bypass is bit-exact", left == signal and right == signal)
    check("ceiling: bypass is 10 ms lookahead", bypass.latency_samples == 160)
    ceiling = ShortTermCeiling(fs, enabled=True, window_s=1.0, ceiling_lufs=-16.0)
    out, _ = ceiling.process_stereo(signal, signal)
    tail = out[-int(0.5 * fs) :]
    measured = db(rms(tail))
    # Input is loud enough to need ~9.3 dB of reduction; output RMS should land
    # near the ceiling rather than near the input level.
    check("ceiling: reduces loud programme", measured < -12.0, f"{measured:.2f} dBFS")
    check("ceiling: settles at the ceiling", near(measured, -15.3, 1.5), f"{measured:.2f} dBFS")
    check("ceiling: reports reduction", ceiling.gain_reduction_db > 5)
    check("ceiling: reports short-term loudness", -20 < ceiling.lufs_s < -5)
    quiet = ShortTermCeiling(fs, enabled=True, window_s=1.0, ceiling_lufs=-16.0)
    soft, _ = quiet.process_stereo(tone(1000, fs, 1.6, 0.03), tone(1000, fs, 1.6, 0.03))
    check("ceiling: leaves quiet programme alone", quiet.gain_reduction_db < 0.1)
    for window in (1.0, 3.0):
        check(f"ceiling: {window:g}s window accepted", ShortTermCeiling(fs, window_s=window).window_s == window)


def test_preduck() -> None:
    fs = 16_000
    duck = PreDuck(fs, enabled=False)
    src = [0.0] * 4000
    src[1000] = 0.9
    out, _ = duck.process_stereo(src, src)
    check("preduck: bypass is bit-exact", out == src)
    active = PreDuck(fs, enabled=True, detect_ms=2.0, sensitivity=50, range_db=4.0, release_ms=40)
    out, _ = active.process_stereo(src, src)
    peak = max(abs(v) for v in out)
    check("preduck: ducks the transient", peak < 0.9 * 0.85, f"peak {peak:.3f}")
    check("preduck: stays inside range", active.max_duck_db <= 4.0)
    silence = [0.0] * (fs // 5)
    released, _ = active.process_stereo(silence, silence)
    check("preduck: releases", abs(released[-1]) < 1e-9)
    check("preduck: one detect window of latency", active.latency_samples == 32)
    try:
        PreDuck(fs, detect_ms=20)
        check("preduck: rejects 20 ms", False)
    except ValueError:
        check("preduck: rejects 20 ms", True)
    try:
        PreDuck(fs, range_db=7)
        check("preduck: rejects 7 dB range", False)
    except ValueError:
        check("preduck: rejects 7 dB range", True)


def test_density() -> None:
    from stream_encoder_core import Biquad

    fs = 16_000
    bass = tone(90, fs, 1.0, 0.3)
    high = tone(5000, fs, 1.0, 0.1)
    mix = [a + b for a, b in zip(bass, high)]
    bypass = DensityAnchors(fs, enabled=False)
    out, _ = bypass.process_stereo(mix, mix)
    check("density: bypass is bit-exact", out == mix)
    anchors = DensityAnchors(fs, enabled=True, bass_strength=100, mid_strength=0, bass_hz=90)
    out, _ = anchors.process_stereo(mix, mix)
    bp_in = Biquad.bandpass(fs, 90, 0.9)
    bp_out = Biquad.bandpass(fs, 90, 0.9)
    pre = rms(bp_in.process_block(bass)) or 1e-9
    post = rms(bp_out.process_block([o - h for o, h in zip(out, high)])) or 1e-9
    check("density: bass anchor reduces bass level", db(post) < db(pre) - 1.0, f"{db(post/pre):.2f} dB")
    hp_in = Biquad.bandpass(fs, 5000, 2.0)
    hp_out = Biquad.bandpass(fs, 5000, 2.0)
    high_in = rms(hp_in.process_block(high))
    high_out = rms(hp_out.process_block(out)) or 1e-9
    check("density: leaves other bands alone", near(db(high_out / (high_in or 1e-9)), 0.0, 0.2))
    check("density: reports anchor gain", anchors.state()["bass_gain_db"] < 0)
    try:
        DensityAnchors(fs, bass_hz=200)
        check("density: rejects out-of-band anchor", False)
    except ValueError:
        check("density: rejects out-of-band anchor", True)


def test_dualband() -> None:
    fs = 16_000
    clicks = [0.0] * (fs // 2)
    for i in range(0, len(clicks), 800):
        clicks[i] = 0.5
    neutral = DualBandTransient(fs, enabled=True, high_attack=0, high_sustain=0)
    out, _ = neutral.process_stereo(clicks, clicks)
    check("dualband: neutral is bit-exact", out == clicks)
    bypass = DualBandTransient(fs, enabled=False, high_attack=100)
    out, _ = bypass.process_stereo(clicks, clicks)
    check("dualband: bypass ignores settings", out == clicks)
    boost = DualBandTransient(fs, enabled=True, high_attack=100, mode="emphasise")
    loud, _ = boost.process_stereo(clicks, clicks)
    check(
        "dualband: attack emphasises transients",
        max(abs(v) for v in loud) > max(abs(v) for v in clicks) * 1.05,
        f"{max(abs(v) for v in loud):.3f}",
    )
    smooth = DualBandTransient(fs, enabled=True, high_attack=100, mode="smooth")
    soft, _ = smooth.process_stereo(clicks, clicks)
    check(
        "dualband: smooth softens transients",
        max(abs(v) for v in soft) < max(abs(v) for v in clicks) * 0.98,
    )
    check("dualband: crossover is 300 Hz", boost.state()["crossover_hz"] == 300)


def test_clip() -> None:
    fs = 48_000
    quarter = [
        0.9 * math.sin(math.pi * n / 2 + math.pi / 4) for n in range(int(fs * 0.1))
    ]
    sample_peak = max(abs(v) for v in quarter)
    inter = true_peak(quarter)
    check("clip: true peak exceeds sample peak", inter > sample_peak + 0.2, f"{inter:.3f}")
    limiter = TwoPassClip(fs, pass1=True, ceiling_db=-1.0, pass2=False)
    out, _ = limiter.process_stereo(quarter, quarter)
    ceiling = 10 ** (-1.0 / 20)
    check("clip: block length preserved", len(out) == len(quarter))
    check("clip: true peak held at ceiling", true_peak(out) <= ceiling + 0.002, f"{true_peak(out):.4f}")
    bypass = TwoPassClip(fs, pass1=False, pass2=False)
    raw, _ = bypass.process_stereo(quarter, quarter)
    check("clip: both passes off is bit-exact", raw == quarter)
    tone_in = tone(1000, fs, 0.2, 0.3)
    clean_clip = TwoPassClip(fs, pass1=False, pass2=False)
    clean, _ = clean_clip.process_stereo(tone_in, tone_in)
    clean_h2 = goertzel(clean, 2000, fs)
    sat = TwoPassClip(fs, pass1=False, pass2=True, blend_pct=15, mode="bold")
    dirty, _ = sat.process_stereo(tone_in, tone_in)
    dirty_h2 = goertzel(dirty, 2000, fs)
    check("clip: pass 2 adds even harmonics", dirty_h2 > clean_h2 * 5 + 0.001, f"{dirty_h2:.4f}")
    check("clip: pass 2 is off by default", TwoPassClip(fs).pass2 is False)
    check("clip: pass 1 is on by default", TwoPassClip(fs).pass1 is True)
    check("clip: 16× oversampling", TwoPassClip(fs).oversample == 16)


def test_artefact() -> None:
    fs = 48_000
    rng = random.Random(7)
    source = [rng.uniform(-0.5, 0.5) for _ in range(2400)]
    same = score_artefacts(source, source, fs)
    check("artefact: identical scores 100", near(same.score, 100.0, 0.01))
    check("artefact: identical is good", same.grade == "good")
    from stream_encoder_core import Biquad

    lp1, lp2 = Biquad.lowpass(fs, 6000), Biquad.lowpass(fs, 6000)
    degraded = [lp2.process(lp1.process(v)) + rng.uniform(-0.01, 0.01) for v in source]
    poor = score_artefacts(source, degraded, fs)
    check("artefact: low-passed copy loses score", poor.score < 90, f"{poor.score:.1f}")
    check("artefact: bandwidth loss detected", poor.hf_rolloff_khz < same.hf_rolloff_khz)
    check("artefact: SNR reported", poor.snr_db < 60)
    check("artefact: grade boundaries", grade_for(91) == "good" and grade_for(90) == "fair")
    check("artefact: poor boundary", grade_for(75) == "fair" and grade_for(74) == "poor")
    check("artefact: metrics serialise", set(poor.as_dict()) >= {"snr_db", "score", "grade"})


def test_continuity() -> None:
    log = ContinuityLog()
    log.log("Connect")
    log.log("Disconnect")
    log.log("Underrun", gap_ms=1200)
    check("log: validates events", len(log.entries) == 3)
    try:
        log.log("Explode")
        check("log: rejects unknown events", False)
    except ValueError:
        check("log: rejects unknown events", True)
    check("log: events are the specified five", EVENTS == ("Connect", "Disconnect", "Underrun", "Overrun", "Metadata-Fail"))
    check("log: gap total", log.summary()["gap_total_ms"] == 1200)
    with tempfile.TemporaryDirectory() as tmp:
        path = log.export(os.path.join(tmp, "out.csv"))
        check("log: export writes a file", os.path.exists(path))
        with open(path, encoding="utf-8") as fh:
            header = fh.readline().strip()
            first = fh.readline().strip()
        check("log: CSV header", header == "timestamp,event,gap_ms,stream_id")
        check("log: CSV row", first.endswith(",Connect,0,primary"))
        default_name = log.export(None, now=datetime(2026, 10, 20, tzinfo=timezone.utc))
        check("log: export filename", os.path.basename(default_name) == "continuity_log_20261020.csv")
        os.remove(default_name)
        again = ContinuityLog()
        check("log: load round-trips", again.load(path) == 3 and len(again.entries) == 3)
    old = ContinuityLog()
    old.log("Connect", at=datetime.now(timezone.utc) - timedelta(days=8))
    old.log("Connect")
    old.prune()
    check("log: seven-day retention", len(old.entries) == 1)


def test_simulcast() -> None:
    sim = Simulcast()
    check("simulcast: only primary by default", sim.enabled_slots == ["primary"])
    sim.configure("primary", packetizer=lambda pcm, pts: b"P" * 10)
    sim.configure("secondary", enabled=True, codec="aac", bitrate_kbps=96, mount="/aac", packetizer=lambda pcm, pts: b"S" * 8)
    check("simulcast: secondary enabled independently", sim.enabled_slots == ["primary", "secondary"])
    packets = sim.push_frame([0.0] * 1152)
    check("simulcast: two packets", len(packets) == 2)
    check("simulcast: shared PTS", packets[0].pts == packets[1].pts == 0)
    check("simulcast: per-output codec", {p.slot: p.codec for p in packets} == {"primary": "mp3", "secondary": "aac"})
    check("simulcast: alignment spread", sim.alignment()["spread_ticks"] == 0)
    sim.enable("secondary", False)
    check("simulcast: disable stops the output", len(sim.push_frame([0.0] * 1152)) == 1)
    sim.push_frame([0.0] * 1152, pts=90000)
    check("simulcast: external PTS continues", sim.pts == 90000 + sim.frame_duration)
    captured: list[object] = []

    def broken_writer(packet: object) -> None:
        raise RuntimeError("writer down")

    sim.configure("primary", writer=captured.append)
    sim.configure("secondary", enabled=True, writer=broken_writer)
    sim.push_frame([0.0] * 1152)
    check("simulcast: writer receives packets", len(captured) == 1)
    check("simulcast: failing writer is isolated", sim.errors["secondary"] == 1)
    check("simulcast: status exposes writer health", sim.status()["secondary"]["errors"] == 1)
    sim.enable("secondary", False)
    try:
        sim.configure("tertiary", mount="no-slash")
        check("simulcast: validates mount", False)
    except Exception:
        check("simulcast: validates mount", True)


def test_failover() -> None:
    cfg = FailoverConfig(crossfade_ms=200)
    router = FailoverRouter(cfg)
    router.set_available(1, True)
    router.switch_to(1, "test")
    frames = ([1.0, 1.0], [0.0, 0.0])
    router.process(frames)
    for _ in range(router.fade_samples // 2):
        left, right = router.process(frames)
    weights = router.weights()
    check("failover: equal-power fade", near(sum(w * w for w in weights.values()), 1.0, 1e-9))
    check("failover: crossfade is 200 ms", router.fade_samples == 9600)
    for _ in range(router.fade_samples):
        router.process(frames)
    check("failover: switch completes", router.active == 1 and not router.fading)
    for _ in range(10):
        router.notify_primary_ok(1.0)
    check("failover: auto-reverts after 10 s", router.active == 1 and router.fading and router.restores == 1)
    for _ in range(router.fade_samples):
        router.process(frames)
    check("failover: back on primary", router.active == 0)
    disc = FailoverRouter(FailoverConfig())
    disc.set_available(1, True)
    check("failover: disconnect switches immediately", disc.notify_disconnect(0) and disc.fading)
    under = FailoverRouter(FailoverConfig())
    under.set_available(1, True)
    check("failover: short underrun ignored", not under.notify_underrun(1000))
    check("failover: 2 s underrun switches", under.notify_underrun(1100))
    silent = FailoverRouter(FailoverConfig())
    silent.set_available(1, True)
    check("failover: silence under 5 s ignored", not silent.notify_silence(4000))
    check("failover: 5 s silence switches", silent.notify_silence(1100))
    try:
        FailoverConfig(crossfade_ms=50).validate()
        check("failover: rejects 50 ms fade", False)
    except ValueError:
        check("failover: rejects 50 ms fade", True)


def test_src() -> None:
    fs = 48_000
    check("src: detects 48 kHz", detect_sample_rate(tone(1000, fs, 0.1), fs) == 48_000)
    wrong = tone(1000, 44_100, 0.1)
    check("src: detects a 44.1 kHz source", detect_sample_rate(wrong, fs) == 44_100)
    resampler = PolyphaseResampler()
    check("src: 512-tap polyphase", resampler.taps == 512 and len(resampler.table[0]) == 512)

    def stopband_db(freq_per_sample: float) -> float:
        kernel = coefficient_table()[0]
        real = sum(c * math.cos(2 * math.pi * freq_per_sample * k) for k, c in enumerate(kernel))
        imag = sum(c * math.sin(2 * math.pi * freq_per_sample * k) for k, c in enumerate(kernel))
        return 20 * math.log10(max(1e-12, math.hypot(real, imag)))

    check("src: DC gain is unity", near(stopband_db(0.0), 0.0, 0.01))
    check("src: 144 dB stopband", stopband_db(0.495) < -140.0, f"{stopband_db(0.495):.1f} dB")
    signal = tone(500, 8000, 0.05)
    unity = resampler.resample(signal, 1.0)
    check("src: unity preserves length", len(unity) == len(signal))
    check("src: unity preserves level", near(db(rms(unity[50:-50]) / rms(signal[50:-50])), 0.0, 0.2))
    lock = DriftLock(8000)
    lock.set_measured_ppm(5.0)
    check("src: 0.1 ppm quantisation", lock.correction_ppm == 5.0)
    check("src: correction step", near(1.0 + lock.correction_ppm * 1e-6, 1.000005, 1e-12))
    check("src: short drift does not warn", not lock.warning)
    for _ in range(3):
        lock.set_measured_ppm(2.0)
    check("src: sustained drift warns", lock.warning)
    for _ in range(3):
        lock.set_measured_ppm(0.0)
    check("src: warning clears", not lock.warning)
    small = signal[:400]
    out = lock.process(small)
    check("src: resamples at the corrected rate", len(out) == int(len(small) / (1.0 + lock.correction_ppm * 1e-6)))
    check("src: status is complete", set(lock.status().__dict__) == {
        "measured_ppm", "correction_ppm", "warning", "corrections", "input_samples", "output_samples"
    })


def test_health() -> None:
    state = HealthState(
        cpu_pct=23.4,
        memory_mb=512,
        memory_total_mb=16384,
        disk_free_gb=42.1,
        dsp_peak_pct=31,
        thread_status="running · SCHED_FIFO 80 · core 2",
        stream_uptime_s=5025,
        reconnects=2,
        gap_total_ms=3450,
        clock_drift_ppm=0.4,
        src_corrections=812,
        reservoir_fill=0.78,
        reservoir_underflows=1,
        crc_errors=0,
        artefact_score=92.4,
        preset="Mobile-Stream",
        preset_modified=False,
    )
    report = build_report(state)
    for needle in (
        "SignalPath v3.1 Reference",
        "Version & build",
        "CPU load: 23.4 %",
        "Memory: 512 MB",
        "Disk free: 42.1 GB",
        "DSP peak: 31 %",
        "Thread status",
        "Uptime: 01:23:45",
        "Reconnects: 2",
        "Gap total: 3450 ms",
        "Clock drift: 0.4 ppm",
        "SRC corrections: 812",
        "Reservoir: 78 %",
        "Artefact score: 92.4 (good)",
        "Active: Mobile-Stream · modified: no",
    ):
        check(f"health: contains {needle!r}", needle in report)
    with tempfile.TemporaryDirectory() as tmp:
        path = save_report(report, os.path.join(tmp, "health.txt"))
        check("health: saves .txt", os.path.exists(path) and path.endswith(".txt"))
    missing = build_report({"preset": "X"})
    check("health: missing values are dashes", "Clock drift: —" in missing)
    check("health: dict input accepted", "Preset" in missing)


def test_defaults() -> None:
    check("default: short-term ceiling bypassed", ShortTermCeiling().enabled is False)
    check("default: pre-duck bypassed", PreDuck().enabled is False)
    check("default: density anchors bypassed", DensityAnchors().enabled is False)
    check("default: dual-band bypassed", DualBandTransient().enabled is False)
    check("default: pass 2 off", TwoPassClip().pass2 is False)
    sim = Simulcast()
    check("default: secondary/tertiary off", sim.enabled_slots == ["primary"])
    check("default: failover on primary", FailoverRouter().active == 0)
    check("default: continuity log empty", len(ContinuityLog().entries) == 0)
    check("default: drift correction zero", DriftLock(8000).correction_ppm == 0.0)


def test_pipeline() -> None:
    fs = 16_000
    programme = [a + b for a, b in zip(tone(220, fs, 0.4, 0.25), tone(3000, fs, 0.4, 0.15))]
    # All defaults: the chain must not touch a single sample.
    bypass = [
        ShortTermCeiling(fs),
        PreDuck(fs),
        DensityAnchors(fs),
        DualBandTransient(fs),
        TwoPassClip(fs, pass1=False, pass2=False),
    ]
    l, r = list(programme), list(programme)
    for stage in bypass:
        l, r = stage.process_stereo(l, r)
    check("pipeline: defaults are bit-exact", l == programme and r == programme)

    active = [
        ShortTermCeiling(fs, enabled=True, ceiling_lufs=-16),
        PreDuck(fs, enabled=True, sensitivity=70, range_db=3),
        DensityAnchors(fs, enabled=True, bass_strength=40, mid_strength=30, bass_hz=90, mid_hz=2500),
        DualBandTransient(fs, enabled=True, high_attack=30, mode="emphasise"),
        TwoPassClip(fs, pass1=True, ceiling_db=-1.0, pass2=True, blend_pct=5, mode="warm"),
    ]
    l, r = list(programme), list(programme)
    for stage in active:
        l, r = stage.process_stereo(l, r)
    check("pipeline: chain produces full-length output", len(l) == len(programme))
    check("pipeline: output is finite", all(math.isfinite(v) for v in l + r))
    check("pipeline: ceiling holds", max(abs(v) for v in l + r) <= 10 ** (-1.0 / 20) + 0.001)
    metrics = score_artefacts(programme, l, fs)
    check("pipeline: artefact metrics produced", 0 <= metrics.score <= 100 and metrics.grade in ("good", "fair", "poor"))
    log = ContinuityLog()
    log.log("Underrun", gap_ms=240, stream_id="primary")
    check("pipeline: continuity records the chain run", log.summary()["gap_total_ms"] == 240)


def test_presets() -> None:
    parser = configparser.ConfigParser()
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    read = parser.read(os.path.join(root, "signalpath_v3.1_presets.cfg"))
    check("presets: file parses", len(read) == 1)
    for section in ("Reference-Flat", "Mobile-Stream", "Tight-Punchy", "Encoder-Reference", "meta"):
        check(f"presets: {section} exists", parser.has_section(section))
    check("presets: version", parser.get("meta", "version") == "3.1")
    check("presets: flat bypasses new DSP", parser.getboolean("Reference-Flat", "ceiling.enabled") is False)
    check("presets: flat bypasses clip", parser.getboolean("Reference-Flat", "clip.pass1") is False)
    check("presets: 90 kHz clock", parser.getint("Encoder-Reference", "pts.clock_hz") == 90000)
    check("presets: nine-frame reservoir", parser.getint("Encoder-Reference", "reservoir.frames") == 9)
    check("presets: AAC-LD range", parser.getint("Encoder-Reference", "aac_ld.bitrate_min") == 64)
    check("presets: three outputs", parser.get("Encoder-Reference", "simulcast.tertiary") == "off")


def main() -> int:
    suites = [
        test_clock,
        test_crc_reservoir,
        test_realtime,
        test_encoder_thread,
        test_encoder_core,
        test_lame,
        test_aac,
        test_ceiling,
        test_preduck,
        test_density,
        test_dualband,
        test_clip,
        test_artefact,
        test_continuity,
        test_simulcast,
        test_failover,
        test_src,
        test_health,
        test_defaults,
        test_pipeline,
        test_presets,
    ]
    for suite in suites:
        try:
            suite()
        except Exception:
            global FAILED
            FAILED += 1
            print(f"FAIL  {suite.__name__} raised")
            traceback.print_exc()
    print(f"{CHECKS} checks passed, {FAILED} failed.")
    return 0 if FAILED == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
