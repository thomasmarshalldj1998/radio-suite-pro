#!/usr/bin/env python3
"""Integration checks for the installed codec backends and the API bridge.

    python3 tests/test_integration.py
"""

from __future__ import annotations

import array
import math
import os
import sys
import traceback

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from aac_streaming_encoder import AACEncoderError, StreamingAACEncoder  # noqa: E402
from api_bridge import app  # noqa: E402
from codec_backend_guard import CodecStatus, codec_backend  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

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


def stereo_pcm(seconds: float, rate: int = 48_000, amp: float = 0.5) -> bytes:
    pcm = array.array("h")
    for n in range(int(rate * seconds)):
        value = int(amp * 32767 * math.sin(2 * math.pi * 1000 * n / rate))
        pcm.extend((value, value))
    return pcm.tobytes()


def adts_frames(data: bytes) -> list[int]:
    sizes = []
    i = 0
    while i + 7 <= len(data):
        if data[i] != 0xFF or (data[i + 1] & 0xF0) != 0xF0:
            break
        length = ((data[i + 3] & 0x03) << 11) | (data[i + 4] << 3) | (data[i + 5] >> 5)
        if length < 7 or i + length > len(data):
            break
        sizes.append(length)
        i += length
    return sizes


def test_guard() -> None:
    codec_backend.probe_all()
    check("guard: MP3 native", codec_backend.lame_status == CodecStatus.AVAILABLE)
    check("guard: AAC native", codec_backend.fdkaac_status == CodecStatus.AVAILABLE)
    check("guard: Opus via CLI", codec_backend.opus_status == CodecStatus.FALLBACK)
    check("guard: FLAC via CLI", codec_backend.flac_status == CodecStatus.FALLBACK)
    check("guard: every codec probed", all(i.status != CodecStatus.UNCHECKED for i in codec_backend.infos.values()))
    mode, note = codec_backend.get_encoder_info("fdkaac")
    check("guard: native mode reported", mode == "native", note)
    check("guard: unknown codec is safe", codec_backend.get_encoder_info("nope")[0] == "none")
    check("guard: details include paths", "library" in codec_backend.details()["AAC (FDK)"])


def test_aac_native() -> None:
    enc = StreamingAACEncoder(bitrate=64_000, profile="he-aacv2")
    check("aac: starts native", enc.start(), enc.error or "")
    check("aac: native mode", enc.mode == "native")
    check("aac: reports the library's measured delay", 100 < enc.latency_ms < 200, f"{enc.latency_ms:.1f} ms")
    pcm = stereo_pcm(1.0)
    out = b""
    for i in range(0, len(pcm), 960 * 4):
        out += enc.encode(pcm[i : i + 960 * 4])
    tail = enc.stop()
    out += tail
    frames = adts_frames(out)
    check("aac: ADTS output", len(frames) > 20, f"{len(frames)} frames")
    check("aac: whole stream parses", sum(frames) == len(out), f"{sum(frames)}/{len(out)}")
    kbps = len(out) * 8 / 1.0 / 1000
    check("aac: bitrate on target", 50 < kbps < 80, f"{kbps:.1f} kbps")
    check("aac: latency cached after stop", enc.latency_ms > 100)

    ld = StreamingAACEncoder(bitrate=128_000, profile="aac-ld")
    check("aac-ld: starts native", ld.start(), ld.error or "")
    out = b""
    pcm = stereo_pcm(0.5)
    for i in range(0, len(pcm), 960 * 4):
        out += ld.encode(pcm[i : i + 960 * 4])
    out += ld.stop()
    check("aac-ld: LOAS sync", out[:1] == b"\x56", out[:2].hex())
    check("aac-ld: latency < 15 ms", ld.latency_ms < 15.0, f"{ld.latency_ms:.2f} ms")

    try:
        StreamingAACEncoder(bitrate=10_000).start()
        check("aac: rejects 10 kbps", False)
    except AACEncoderError:
        check("aac: rejects 10 kbps", True)


def test_api() -> None:
    client = TestClient(app)
    r = client.get("/api/health")
    check("api: health", r.status_code == 200 and r.json()["version"] == "3.1.0")
    r = client.get("/api/status/codecs")
    body = r.json()["codecs"]
    check("api: codec statuses", r.status_code == 200 and len(body) == 4)
    check("api: AAC native", body["AAC (FDK)"]["mode"] == "native")
    check("api: path alias kept", body["AAC (FDK)"]["path"] == "native")
    check("api: MP3 native", body["MP3 (LAME)"]["mode"] == "native")

    r = client.get("/api/status/live")
    check("api: idle initially", r.json()["stream_status"] == "idle")

    r = client.post("/api/control/start-stream", json={"mount": "/live"})
    check("api: start", r.status_code == 200 and r.json()["mode"] == "native", r.text)
    r = client.post("/api/control/start-stream", json={"mount": "/live"})
    check("api: double start is rejected", r.status_code == 409)

    pcm = stereo_pcm(0.5)
    r = client.post("/api/control/feed", content=pcm, headers={"Content-Type": "application/octet-stream"})
    check("api: feed accepted", r.status_code == 200 and r.json()["bytes_out"] > 0, r.text)
    r = client.get("/api/status/live")
    live = r.json()
    check("api: live after feed", live["stream_status"] == "live")
    check("api: frames counted", live["frames"] > 0)
    check("api: uptime counted", live["uptime_seconds"] > 0)
    check("api: input level measured", live["input_level_db"] is not None and near(live["input_level_db"], -6.0, 1.5), str(live["input_level_db"]))
    check("api: loudness measured", live["lufs_integrated"] is not None)
    check("api: unmeasured fields stay null", live["true_peak_db"] is None and live["output_level_db"] is None)
    check("api: measured bitrate reported", live["bitrate_kbps"] > 0)

    r = client.post("/api/control/feed", content=b"\x00" * 3)
    check("api: rejects bad PCM framing", r.status_code == 400)
    r = client.post("/api/control/stop-stream")
    check("api: stop", r.status_code == 200 and r.json()["status"]["stream_status"] == "idle")
    r = client.post("/api/control/feed", content=b"\x00" * 4)
    check("api: feed when idle is rejected", r.status_code == 409)

    r = client.post("/api/control/start-stream", json={"codec": "opus"})
    check("api: unsupported codec rejected", r.status_code == 400)
    r = client.post("/api/control/start-stream", json={"codec": "aac-ld", "bitrate_kbps": 128})
    check("api: codec implies profile", r.status_code == 200 and r.json()["status"]["profile"] == "aac-ld", r.text)
    client.post("/api/control/stop-stream")

    r = client.get("/api/status/live", headers={"Origin": "http://localhost:5173"})
    check("api: CORS allows the console", r.headers.get("access-control-allow-origin") in ("*", "http://localhost:5173"))

    os.environ["SIGNALPATH_API_TOKEN"] = "secret-token"
    try:
        check("api: token required", client.get("/api/status/codecs").status_code == 401)
        check(
            "api: token accepted",
            client.get("/api/status/codecs", headers={"Authorization": "Bearer secret-token"}).status_code == 200,
        )
    finally:
        os.environ.pop("SIGNALPATH_API_TOKEN", None)


def main() -> int:
    for suite in (test_guard, test_aac_native, test_api):
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
