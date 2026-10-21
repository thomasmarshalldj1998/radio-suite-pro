"""SignalPath encoder API — Python encoder ↔ TypeScript console.

    uvicorn api_bridge:app --host 127.0.0.1 --port 8000

The bridge owns one encoder session at a time. Starting a stream opens the
native libfdk encoder (falling back to `fdkaac` when only the CLI exists), and
`/api/control/feed` accepts interleaved 16-bit PCM from the console so audio
actually reaches it. `/api/status/live` reports measured stream values; fields
the bridge cannot measure (output loudness, true peak) are null rather than
invented, and the console keeps using its own Web Audio meters for those.

Authentication is optional: set `SIGNALPATH_API_TOKEN` and every `/api` call
must send `Authorization: Bearer <token>`. Without it the bridge is open — bind
it to localhost.
"""

from __future__ import annotations

import array
import json
import math
import os
import sys
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Optional

from fastapi import Body, FastAPI, Header, HTTPException, Query, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from aac_streaming_encoder import AACEncoderError, StreamingAACEncoder
from codec_backend_guard import CodecStatus, codec_backend
from dsp_chain_state import PUBLIC_PRESETS, dsp_state

VERSION = "3.1.0"
SUPPORTED = {"aac", "he-aacv2", "aac-ld", "aac-lc"}

app = FastAPI(title="SignalPath Encoder API", version=VERSION)

_origins = [o.strip() for o in os.environ.get("SIGNALPATH_CORS", "*").split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins or ["*"],
    # Wildcard origins cannot be combined with credentials; the token header
    # is what protects the bridge, not a cookie.
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


class DspValueRequest(BaseModel):
    module: str
    param: str
    value: Any


class LoadPresetRequest(BaseModel):
    name: str
    morph_time: float = 2.0


class BlockSizeRequest(BaseModel):
    block_size: int = Field(default=1024, ge=256, le=8192)


class StartRequest(BaseModel):
    mount: str = Field(default="/stream", max_length=256)
    codec: str = "aac"
    bitrate_kbps: int = Field(default=64, ge=24, le=320)
    profile: str = "he-aacv2"
    sample_rate: int = Field(default=48_000, ge=8_000, le=96_000)


class _Meter:
    """Peak, K-weighted short-term and gated integrated loudness of fed PCM."""

    def __init__(self, sample_rate: int, channels: int) -> None:
        from stream_encoder_core import k_weighting

        self.sample_rate = sample_rate
        self.channels = channels
        self.shelf_l, self.hpf_l = k_weighting(sample_rate)
        self.shelf_r, self.hpf_r = k_weighting(sample_rate)
        self.peak_db: float | None = None
        self.rms_db: float | None = None
        self.lufs_s: float | None = None
        self.lufs_integrated: float | None = None
        self._sum_l = 0.0
        self._sum_r = 0.0
        self._count = 0
        self._window = max(1, sample_rate)  # 1 s of squares per channel
        self._since = 0
        # BS.1770 gating: 400 ms blocks, absolute gate at -70 LUFS.
        self._block_l = 0.0
        self._block_r = 0.0
        self._block_count = 0
        self._block_len = max(1, int(sample_rate * 0.4))
        self._blocks: list[float] = []

    def reset(self) -> None:
        self.peak_db = self.rms_db = self.lufs_s = self.lufs_integrated = None
        self._sum_l = self._sum_r = 0.0
        self._count = self._since = 0
        self._block_l = self._block_r = 0.0
        self._block_count = 0
        self._blocks = []

    def update(self, pcm: bytes) -> None:
        samples = array.array("h")
        samples.frombytes(pcm[: len(pcm) - (len(pcm) % 2)])
        if sys.byteorder == "big":
            samples.byteswap()
        if not samples:
            return
        peak = max(abs(v) for v in samples) / 32768.0
        self.peak_db = -120.0 if peak <= 0 else 20 * math.log10(peak)
        frames = len(samples) / max(1, self.channels)
        if frames <= 0:
            return
        rms = math.sqrt(sum(float(v) * v for v in samples) / len(samples)) / 32768.0
        self.rms_db = -120.0 if rms <= 0 else 20 * math.log10(rms)

        for i in range(0, len(samples) - self.channels + 1, self.channels):
            left = samples[i] / 32768.0
            right = samples[i + 1] / 32768.0 if self.channels > 1 else left
            kl = self.hpf_l.process(self.shelf_l.process(left))
            kr = self.hpf_r.process(self.shelf_r.process(right))
            self._sum_l += kl * kl
            self._sum_r += kr * kr
            self._block_l += kl * kl
            self._block_r += kr * kr
        self._count += frames
        self._since += frames
        self._block_count += frames
        # Keep a one-second window without storing the samples themselves.
        if self._since >= self._window:
            keep = self._window / max(1, self._count)
            self._sum_l *= keep
            self._sum_r *= keep
            self._count = self._window
            self._since = 0
        mean_square = (self._sum_l + self._sum_r) / (2.0 * max(1, self._count))
        self.lufs_s = (
            -120.0 if mean_square <= 0 else -0.691 + 10.0 * math.log10(mean_square)
        )

        # Close 400 ms gating blocks. Only absolute-gated blocks are kept;
        # the relative gate is applied when the integrated value is computed.
        if self._block_count >= self._block_len:
            block_ms = (self._block_l + self._block_r) / (2.0 * self._block_count)
            block_lufs = (
                -120.0
                if block_ms <= 0
                else -0.691 + 10.0 * math.log10(block_ms)
            )
            if block_lufs > -70.0:
                self._blocks.append(block_lufs)
            self._block_l = self._block_r = 0.0
            self._block_count = 0
        if self._blocks:
            energies = [10.0 ** ((l + 0.691) / 10.0) for l in self._blocks]
            mean_energy = sum(energies) / len(energies)
            relative_gate = -0.691 + 10.0 * math.log10(mean_energy) - 10.0
            gated = [
                energy
                for lufs, energy in zip(self._blocks, energies)
                if lufs > relative_gate
            ]
            if gated:
                self.lufs_integrated = -0.691 + 10.0 * math.log10(
                    sum(gated) / len(gated)
                )


@dataclass
class EncoderSession:
    mount: str
    codec: str
    bitrate_kbps: int
    profile: str
    sample_rate: int
    encoder: StreamingAACEncoder
    started_at: float
    meter: _Meter
    frames: int = 0
    bytes_in: int = 0
    bytes_out: int = 0
    last_output_at: float = 0.0
    error: str | None = None
    lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def feed(self, pcm: bytes) -> int:
        with self.lock:
            out = self.encoder.encode(pcm)
            self.bytes_in += len(pcm)
            self.bytes_out += len(out)
            self.meter.update(pcm)
            if out:
                self.frames += 1
                self.last_output_at = time.time()
            return len(out)

    def live_status(self) -> dict[str, Any]:
        now = time.time()
        running = self.encoder.started
        status = "live"
        if not running:
            status = "error" if self.error else "idle"
        elif self.last_output_at == 0.0:
            status = "connecting"
        # Settle the average over at least one second so the first poll does
        # not report a burst as the stream bitrate.
        measured_kbps = (
            self.bytes_out * 8 / max(1.0, now - self.started_at) / 1000
            if running
            else 0.0
        )
        return {
            "stream_status": status,
            "active_mount": self.mount,
            "uptime_seconds": round(now - self.started_at, 2),
            "dropped_frames": 0,
            "codec": self.codec,
            "profile": self.profile,
            "bitrate_kbps": round(measured_kbps, 1),
            "target_bitrate_kbps": self.bitrate_kbps,
            "latency_ms": round(self.encoder.latency_ms, 1),
            "frames": self.frames,
            "bytes_in": self.bytes_in,
            "bytes_out": self.bytes_out,
            "input_level_db": None if self.meter.peak_db is None else round(self.meter.peak_db, 1),
            "output_level_db": None,
            "lufs_integrated": (
                None if self.meter.lufs_integrated is None else round(self.meter.lufs_integrated, 2)
            ),
            "lufs_short_term": None if self.meter.lufs_s is None else round(self.meter.lufs_s, 2),
            "true_peak_db": None,
            "lra": None,
            "source": "python",
        }

    def close(self) -> bytes:
        with self.lock:
            tail = self.encoder.stop()
            self.bytes_out += len(tail)
            self.error = self.encoder.error
            return tail


class SessionManager:
    def __init__(self) -> None:
        self.session: Optional[EncoderSession] = None
        self.lock = threading.Lock()

    def start(self, req: StartRequest) -> EncoderSession:
        with self.lock:
            if self.session is not None:
                raise HTTPException(status_code=409, detail="A stream is already running")
            if req.codec not in SUPPORTED:
                raise HTTPException(status_code=400, detail=f"Unsupported codec {req.codec!r}")
            codec_backend.probe_all()
            info = codec_backend.infos["fdkaac"]
            if info.status == CodecStatus.UNAVAILABLE:
                raise HTTPException(
                    status_code=503,
                    detail="No AAC encoder installed — install libfdk-aac2 or fdkaac",
                )
            # The codec pick may imply the profile; an explicit profile wins
            # only when the codec is the generic "aac" entry.
            profile = req.profile
            if req.codec in ("he-aacv2", "aac-ld", "aac-lc"):
                profile = req.codec
            if profile == "aac":
                profile = "he-aacv2"
            try:
                encoder = StreamingAACEncoder(
                    bitrate=req.bitrate_kbps * 1000,
                    sample_rate=req.sample_rate,
                    profile=profile,
                    channels=2,
                    crc=True,
                )
            except AACEncoderError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
            if not encoder.start():
                raise HTTPException(
                    status_code=503,
                    detail=encoder.error or "Encoder failed to start",
                )
            session = EncoderSession(
                mount=req.mount,
                codec=req.codec,
                bitrate_kbps=req.bitrate_kbps,
                profile=profile,
                sample_rate=req.sample_rate,
                encoder=encoder,
                started_at=time.time(),
                meter=_Meter(req.sample_rate, 2),
            )
            self.session = session
            return session

    def stop(self) -> tuple[bytes, dict[str, Any]]:
        with self.lock:
            if self.session is None:
                raise HTTPException(status_code=409, detail="No stream is running")
            session = self.session
            tail = session.close()
            status = session.live_status()
            self.session = None
            return tail, status

    def feed(self, pcm: bytes) -> int:
        with self.lock:
            if self.session is None:
                raise HTTPException(status_code=409, detail="No stream is running")
            return self.session.feed(pcm)

    def status(self) -> dict[str, Any]:
        with self.lock:
            if self.session is None:
                return {
                    "stream_status": "idle",
                    "active_mount": None,
                    "uptime_seconds": 0,
                    "dropped_frames": 0,
                    "codec": None,
                    "profile": None,
                    "bitrate_kbps": 0,
                    "latency_ms": 0,
                    "frames": 0,
                    "bytes_in": 0,
                    "bytes_out": 0,
                    "input_level_db": None,
                    "output_level_db": None,
                    "lufs_integrated": None,
                    "lufs_short_term": None,
                    "true_peak_db": None,
                    "lra": None,
                    "source": "python",
                }
            return self.session.live_status()


manager = SessionManager()


def _require_token(authorization: str | None) -> None:
    token = os.environ.get("SIGNALPATH_API_TOKEN", "")
    if not token:
        return
    if authorization != f"Bearer {token}":
        raise HTTPException(status_code=401, detail="Invalid or missing API token")


# ── routes ──────────────────────────────────────────────────────────────


@app.get("/api/health")
def health() -> dict[str, Any]:
    return {"ok": True, "version": VERSION, "service": "signalpath-encoder"}


# ── full DSP chain control plane ──────────────────────────────────────


@app.get("/api/dsp/modules")
def dsp_modules(authorization: str | None = Header(default=None)) -> dict[str, Any]:
    _require_token(authorization)
    return {"modules": dsp_state.modules(), "presets": list(PUBLIC_PRESETS)}


@app.post("/api/dsp/set-value")
def dsp_set_value(
    req: DspValueRequest | None = Body(default=None),
    module: str | None = Query(default=None),
    param: str | None = Query(default=None),
    value: str | None = Query(default=None),
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    """Accept JSON (console) or query parameters (simple scripts)."""
    _require_token(authorization)
    if req is None:
        if module is None or param is None or value is None:
            raise HTTPException(status_code=422, detail="module, param and value are required")
        try:
            parsed: Any = json.loads(value)
        except (TypeError, ValueError):
            parsed = value
        req = DspValueRequest(module=module, param=param, value=parsed)
    try:
        return dsp_state.set_value(req.module, req.param, req.value)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=f"Unknown DSP parameter {exc}") from exc
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/dsp/load-preset")
def dsp_load_preset(
    req: LoadPresetRequest | None = Body(default=None),
    name: str | None = Query(default=None),
    morph_time: float = Query(default=2.0, ge=1.0, le=5.0),
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    _require_token(authorization)
    if req is None:
        if name is None:
            raise HTTPException(status_code=422, detail="name is required")
        req = LoadPresetRequest(name=name, morph_time=morph_time)
    try:
        return dsp_state.load_preset(req.name, req.morph_time)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=f"Unknown preset {exc}") from exc


@app.post("/api/dsp/config")
def dsp_config(req: BlockSizeRequest, authorization: str | None = Header(default=None)) -> dict[str, Any]:
    _require_token(authorization)
    dsp_state.block_size = int(req.block_size)
    dsp_state._perf_at = 0.0
    return {"ok": True, "block_size": dsp_state.block_size}


@app.get("/api/status/performance")
def dsp_performance(
    force: bool = False, authorization: str | None = Header(default=None)
) -> dict[str, Any]:
    _require_token(authorization)
    return dsp_state.performance(force=force)


@app.get("/api/status/codecs")
def codec_status(authorization: str | None = Header(default=None)) -> dict[str, Any]:
    _require_token(authorization)
    codec_backend.probe_all()
    return {"codecs": codec_backend.details()}


@app.get("/api/status/live")
def live_metrics(authorization: str | None = Header(default=None)) -> dict[str, Any]:
    _require_token(authorization)
    return manager.status()


@app.post("/api/control/start-stream")
def start_stream(req: StartRequest, authorization: str | None = Header(default=None)) -> dict[str, Any]:
    _require_token(authorization)
    session = manager.start(req)
    return {
        "ok": True,
        "mount": session.mount,
        "mode": session.encoder.mode,
        "latency_ms": round(session.encoder.latency_ms, 1),
        "status": session.live_status(),
    }


@app.post("/api/control/stop-stream")
def stop_stream(authorization: str | None = Header(default=None)) -> dict[str, Any]:
    _require_token(authorization)
    tail, status = manager.stop()
    return {"ok": True, "tail_bytes": len(tail), "status": status}


@app.post("/api/control/feed")
async def feed(request: Request, authorization: str | None = Header(default=None)) -> dict[str, Any]:
    """Feed interleaved s16le PCM (stereo) to the running encoder."""
    _require_token(authorization)
    pcm = await request.body()
    if len(pcm) % 4 != 0:
        raise HTTPException(status_code=400, detail="PCM must be stereo 16-bit frames")
    # Encoding is CPU-bound and must not stall the event loop that serves
    # the meter polls and stop control at 5 Hz.
    written = await run_in_threadpool(manager.feed, pcm)
    return {"ok": True, "bytes_out": written, "frames": manager.status()["frames"]}


@app.exception_handler(AACEncoderError)
def encoder_error(_: Request, exc: AACEncoderError) -> JSONResponse:
    return JSONResponse(status_code=500, content={"ok": False, "error": str(exc)})


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8000)
