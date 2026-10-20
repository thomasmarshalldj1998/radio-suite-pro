"""SignalPath v3.1 — stream encoder core.

Owns the three things every codec backend in this tree shares:

* a 90 kHz MPEG presentation clock (PTS/DTS) that stays continuous across a
  reconnect instead of restarting at zero;
* the MP3 bit-reservoir / CRC frame model (9 frames, fill / protect / adjust);
* realtime thread setup — SCHED_FIFO / SCHED_RR priority and CPU affinity,
  applied where the kernel allows it and reported (never raised) where it
  does not.

Nothing here is codec-specific: the LAME and libfdk modules feed PCM through
`EncoderCore.submit()` and receive timestamped packets back.
"""

from __future__ import annotations

import math
import os
import struct
import threading
from dataclasses import dataclass
from typing import Callable, Iterable, Sequence

MPEG_CLOCK_HZ = 90_000
"""MPEG system clock: every PTS/DTS in this project is in 90 kHz ticks."""

# Encoder delay in milliseconds per codec profile, used to derive DTS from PTS.
# (Values are the encoder + decoder pipeline delay a muxer must signal.)
CODEC_DELAY_MS = {
    "mp3": 26.0,
    "aac-lc": 21.3,
    "he-aac": 48.0,
    "he-aacv2": 48.0,
    "aac-ld": 15.0,
    "opus": 6.5,
    "flac": 0.0,
}


def db_to_lin(db: float) -> float:
    return 10.0 ** (db / 20.0)


def lin_to_db(value: float) -> float:
    return -120.0 if value <= 0.0 else 20.0 * math.log10(value)


def clamp(value: float, low: float, high: float) -> float:
    return low if value < low else high if value > high else value


class Biquad:
    """Direct-form-I biquad (RBJ cookbook coefficients).

    Every processor in this tree uses the same primitive; keeping the state
    explicit means a filter can be reset between takes and its response can be
    measured offline.
    """

    def __init__(self, b0: float, b1: float, b2: float, a0: float, a1: float, a2: float) -> None:
        self.b0, self.b1, self.b2, self.a0, self.a1, self.a2 = b0, b1, b2, a0, a1, a2
        self.reset()

    def reset(self) -> None:
        self.x1 = self.x2 = self.y1 = self.y2 = 0.0

    def process(self, x: float) -> float:
        y = (
            self.b0 * x
            + self.b1 * self.x1
            + self.b2 * self.x2
            - self.a1 * self.y1
            - self.a2 * self.y2
        ) / self.a0
        self.x2, self.x1 = self.x1, x
        self.y2, self.y1 = self.y1, y
        return y

    def process_block(self, xs: Sequence[float]) -> list[float]:
        return [self.process(x) for x in xs]

    @classmethod
    def lowpass(cls, fs: float, freq: float, q: float = 0.70710678) -> "Biquad":
        w0 = 2.0 * math.pi * min(freq, fs * 0.49) / fs
        alpha = math.sin(w0) / (2.0 * q)
        cw = math.cos(w0)
        return cls((1 - cw) / 2, 1 - cw, (1 - cw) / 2, 1 + alpha, -2 * cw, 1 - alpha)

    @classmethod
    def highpass(cls, fs: float, freq: float, q: float = 0.70710678) -> "Biquad":
        w0 = 2.0 * math.pi * min(freq, fs * 0.49) / fs
        alpha = math.sin(w0) / (2.0 * q)
        cw = math.cos(w0)
        return cls((1 + cw) / 2, -(1 + cw), (1 + cw) / 2, 1 + alpha, -2 * cw, 1 - alpha)

    @classmethod
    def bandpass(cls, fs: float, freq: float, q: float = 0.70710678) -> "Biquad":
        """Constant 0 dB peak gain bandpass."""
        w0 = 2.0 * math.pi * min(freq, fs * 0.49) / fs
        alpha = math.sin(w0) / (2.0 * q)
        cw = math.cos(w0)
        return cls(alpha, 0.0, -alpha, 1 + alpha, -2 * cw, 1 - alpha)

    @classmethod
    def high_shelf(cls, fs: float, freq: float, gain_db: float, q: float = 0.7072) -> "Biquad":
        """RBJ high shelf at `freq` with `gain_db` (BS.1770 stage 1)."""
        a = 10.0 ** (gain_db / 40.0)
        w0 = 2.0 * math.pi * min(freq, fs * 0.49) / fs
        alpha = math.sin(w0) / (2.0 * q)
        cw = math.cos(w0)
        sa = 2.0 * math.sqrt(a) * alpha
        return cls(
            a * ((a + 1) + (a - 1) * cw + sa),
            -2 * a * ((a - 1) + (a + 1) * cw),
            a * ((a + 1) + (a - 1) * cw - sa),
            (a + 1) - (a - 1) * cw + sa,
            2 * ((a - 1) - (a + 1) * cw),
            (a + 1) - (a - 1) * cw - sa,
        )


def k_weighting(fs: float) -> tuple[Biquad, Biquad]:
    """ITU-R BS.1770 K-weighting: 4 dB high shelf + 38 Hz high-pass."""
    shelf = Biquad.high_shelf(fs, 1681.9744509555319, 3.99984385397, 0.7071752369554196)
    hpf = Biquad.highpass(fs, 38.13547087602444, 0.5003270373238773)
    return shelf, hpf


def lufs_from_mean_square(ms: float, offset_db: float = -0.691) -> float:
    return -120.0 if ms <= 0.0 else offset_db + 10.0 * math.log10(ms)


class PtsClock:
    """Continuous 90 kHz presentation clock.

    Ticks are accumulated as an exact integer numerator so a frame duration
    that is not an integer number of ticks (e.g. 1152 samples at 44.1 kHz =
    2351.02 ticks) never drifts. `pts` is the timestamp of the *next* frame;
    `advance()` consumes one frame and returns the frame that just started.

    A reconnect must not jump: `advance()` keeps counting from the last PTS, so
    the muxer sees `last_pts + frame_duration` across the gap. `restart()` is
    the explicit "new session, new timeline" call.
    """

    def __init__(
        self,
        sample_rate: int = 48_000,
        frame_samples: int = 1152,
        start_pts: int = 0,
        codec: str = "mp3",
        delay_ms: float | None = None,
    ) -> None:
        if sample_rate <= 0 or frame_samples <= 0:
            raise ValueError("sample_rate and frame_samples must be positive")
        self.sample_rate = int(sample_rate)
        self.frame_samples = int(frame_samples)
        self.codec = codec
        self.delay_ms = (
            float(delay_ms) if delay_ms is not None else CODEC_DELAY_MS.get(codec, 0.0)
        )
        self._start = int(start_pts)
        self._units = int(start_pts) * self.sample_rate
        self._frames = 0
        self._gaps = 0

    # ── clock arithmetic ────────────────────────────────────────────────
    @property
    def pts(self) -> int:
        """PTS of the next frame, in 90 kHz ticks."""
        return self._units // self.sample_rate

    @property
    def frame_duration(self) -> int:
        """Duration of one frame in 90 kHz ticks (rounded, ≥ 1)."""
        return max(1, round(self.frame_samples * MPEG_CLOCK_HZ / self.sample_rate))

    @property
    def delay_ticks(self) -> int:
        return round(self.delay_ms * MPEG_CLOCK_HZ / 1000.0)

    @property
    def dts(self) -> int:
        """Decode timestamp: PTS minus the codec delay, never negative."""
        return max(0, self.pts - self.delay_ticks)

    def advance(self) -> tuple[int, int, int]:
        """Consume one frame; return (pts, dts, duration) of that frame."""
        pts = self.pts
        dts = self.dts
        duration = self.frame_duration
        self._units += self.frame_samples * MPEG_CLOCK_HZ
        self._frames += 1
        return pts, dts, duration

    def peek(self, count: int = 1) -> list[tuple[int, int, int]]:
        """Timestamps for the next `count` frames without consuming them."""
        out: list[tuple[int, int, int]] = []
        for i in range(max(0, int(count))):
            pts = (self._units + i * self.frame_samples * MPEG_CLOCK_HZ) // self.sample_rate
            out.append((pts, max(0, pts - self.delay_ticks), self.frame_duration))
        return out

    def seconds(self) -> float:
        return self.pts / MPEG_CLOCK_HZ

    def reconnect(self) -> int:
        """A transport reconnect happened: keep the timeline, count the gap."""
        self._gaps += 1
        return self.pts

    def restart(self, start_pts: int | None = None) -> None:
        self._start = self.pts if start_pts is None else int(start_pts)
        self._units = self._start * self.sample_rate
        self._frames = 0
        self._gaps = 0

    def snapshot(self) -> dict[str, float | int | str]:
        return {
            "codec": self.codec,
            "clock_hz": MPEG_CLOCK_HZ,
            "sample_rate": self.sample_rate,
            "frame_samples": self.frame_samples,
            "frame_duration_ticks": self.frame_duration,
            "pts": self.pts,
            "dts": self.dts,
            "delay_ticks": self.delay_ticks,
            "frames": self._frames,
            "reconnects": self._gaps,
        }


# ── MP3 bit reservoir + CRC ─────────────────────────────────────────────


def crc16_mpeg(data: bytes, init: int = 0xFFFF) -> int:
    """CRC-16/MPEG (poly 0x8005, MSB-first, init 0xFFFF, no final XOR)."""
    crc = init & 0xFFFF
    for byte in data:
        crc ^= byte << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x8005) & 0xFFFF if crc & 0x8000 else (crc << 1) & 0xFFFF
    return crc


def crc_bytes(data: bytes) -> bytes:
    return struct.pack(">H", crc16_mpeg(data))


class BitReservoir:
    """MP3 main-data reservoir: nine frames of borrowable payload.

    The model is deliberately byte-based: each committed frame adds its unused
    payload to the pool, and a frame that needs more than its own slot borrows
    from what earlier frames stored. `mode` decides how eagerly it borrows:

    ``fill``     never borrow (the pool just grows to capacity);
    ``protect``  borrow only while at least 25 % of the pool stays reserved;
    ``adjust``   borrow up to the request, reporting underflow when short.

    `underflow_ratio` is the fraction of frames that could not be satisfied;
    the UI raises its warning as soon as `fill_ratio < 0.25`.
    """

    MODES = ("fill", "protect", "adjust")

    def __init__(self, frame_bytes: int = 417, frames: int = 9, mode: str = "adjust") -> None:
        if frames < 1 or frame_bytes < 1:
            raise ValueError("frame_bytes and frames must be positive")
        if mode not in self.MODES:
            raise ValueError(f"mode must be one of {self.MODES}")
        self.frame_bytes = int(frame_bytes)
        self.frames = int(frames)
        self.capacity = self.frame_bytes * self.frames
        self.mode = mode
        self.available = self.capacity
        self.borrowed_total = 0
        self.committed = 0
        self.underflows = 0
        self._crc_errors = 0
        self._bad_frames: list[int] = []
        self._history: list[dict[str, int | bool]] = []

    # ── state ───────────────────────────────────────────────────────────
    @property
    def fill_ratio(self) -> float:
        return self.available / self.capacity if self.capacity else 0.0

    @property
    def fill_frames(self) -> float:
        return self.available / self.frame_bytes

    @property
    def underflow_warning(self) -> bool:
        """Spec threshold: reservoir below 25 % raises the UI alert."""
        return self.fill_ratio < 0.25

    @property
    def underflow_ratio(self) -> float:
        return self.underflows / self.committed if self.committed else 0.0

    @property
    def crc_errors(self) -> int:
        return self._crc_errors

    @property
    def bad_frames(self) -> list[int]:
        return list(self._bad_frames)

    def reset(self, mode: str | None = None) -> None:
        if mode is not None:
            if mode not in self.MODES:
                raise ValueError(f"mode must be one of {self.MODES}")
            self.mode = mode
        self.available = self.capacity
        self.borrowed_total = 0
        self.committed = 0
        self.underflows = 0
        self._crc_errors = 0
        self._bad_frames = []
        self._history = []

    # ── framing ─────────────────────────────────────────────────────────
    def commit(
        self,
        payload: bytes,
        need: int | None = None,
        crc_ok: bool = True,
        index: int | None = None,
    ) -> dict[str, int | bool]:
        """Account one encoded frame; returns what the muxer needs.

        `payload` is the frame's own data, `need` the bytes it wants to borrow
        from the pool (default: nothing). The reservoir is refilled with what
        the frame did not use.
        """
        size = len(payload)
        want = max(0, int(need if need is not None else 0))
        if self.mode == "fill":
            want = 0
        elif self.mode == "protect":
            want = min(want, max(0, self.available - self.capacity // 4))
        borrowed = min(want, self.available)
        if borrowed < want:
            self.underflows += 1
        self.available -= borrowed
        self.borrowed_total += borrowed

        # Unused payload refills the pool (bounded), so the reservoir recovers
        # after a dense passage instead of staying empty for the rest of the
        # stream.
        slack = max(0, self.frame_bytes - size - borrowed)
        self.available = min(self.capacity, self.available + slack)
        self.committed += 1

        if not crc_ok:
            self._crc_errors += 1
            self._bad_frames.append(self.committed - 1 if index is None else index)

        entry: dict[str, int | bool] = {
            "frame": self.committed - 1 if index is None else index,
            "bytes": size,
            "borrowed": borrowed,
            "fill": self.available,
            "crc_ok": bool(crc_ok),
        }
        self._history.append(entry)
        if len(self._history) > 512:
            del self._history[: len(self._history) - 512]
        return entry

    def stats(self) -> dict[str, float | int | bool | str]:
        return {
            "mode": self.mode,
            "frames": self.frames,
            "capacity_bytes": self.capacity,
            "available_bytes": self.available,
            "fill_ratio": round(self.fill_ratio, 4),
            "fill_frames": round(self.fill_frames, 2),
            "borrowed_total": self.borrowed_total,
            "underflows": self.underflows,
            "underflow_ratio": round(self.underflow_ratio, 4),
            "crc_errors": self._crc_errors,
            "warning": self.underflow_warning,
        }


# ── realtime thread setup ───────────────────────────────────────────────


@dataclass
class RealtimeStatus:
    requested_policy: str
    requested_priority: int
    requested_cpu: int | None
    policy: str = "other"
    priority: int = 0
    cpu: int | None = None
    applied: bool = False
    realtime: bool = False
    reason: str = ""

    def as_dict(self) -> dict[str, object]:
        return {
            "requested_policy": self.requested_policy,
            "requested_priority": self.requested_priority,
            "requested_cpu": self.requested_cpu,
            "policy": self.policy,
            "priority": self.priority,
            "cpu": self.cpu,
            "applied": self.applied,
            "realtime": self.realtime,
            "reason": self.reason,
        }


_POLICY_IDS = {}


def _policy_map() -> dict[str, int]:
    if _POLICY_IDS:
        return _POLICY_IDS
    for name, attr in (("fifo", "SCHED_FIFO"), ("rr", "SCHED_RR"), ("other", "SCHED_OTHER")):
        value = getattr(os, attr, None)
        if value is not None:
            _POLICY_IDS[name] = int(value)
    return _POLICY_IDS


class RealtimeSetup:
    """Apply encoder-thread scheduling without ever taking the process down.

    On a stock Linux desktop SCHED_FIFO needs CAP_SYS_NICE, so the common result
    is `applied=False, reason="EPERM …"` with audio continuing at normal
    priority. Affinity is attempted independently: a pinned core is still worth
    having when the scheduling class could not be raised.
    """

    def __init__(self) -> None:
        self.status = RealtimeStatus("fifo", 80, None)
        self._previous: tuple[int, int] | None = None

    def configure(
        self, policy: str = "fifo", priority: int = 80, cpu: int | None = None
    ) -> RealtimeStatus:
        policy = policy.lower()
        status = RealtimeStatus(
            requested_policy=policy,
            requested_priority=int(priority),
            requested_cpu=cpu,
            cpu=cpu,
            policy="other",
            reason="",
        )
        problems: list[str] = []
        policies = _policy_map()

        if hasattr(os, "sched_setscheduler") and policy in policies:
            try:
                param = os.sched_param(int(priority))
                self._previous = (os.sched_getscheduler(0), os.sched_getparam(0).sched_priority)
                os.sched_setscheduler(0, policies[policy], param)
                status.policy = policy
                status.priority = int(priority)
                status.realtime = policy in ("fifo", "rr")
                status.applied = True
            except (AttributeError, PermissionError, OSError) as exc:
                problems.append(f"{type(exc).__name__}: {exc}")
        else:
            problems.append("sched_setscheduler unavailable on this platform")

        if cpu is not None and hasattr(os, "sched_setaffinity"):
            try:
                os.sched_setaffinity(0, {int(cpu)})
                status.cpu = int(cpu)
            except (AttributeError, PermissionError, OSError, ValueError) as exc:
                problems.append(f"affinity {type(exc).__name__}: {exc}")
        elif cpu is not None:
            problems.append("sched_setaffinity unavailable")

        if not status.realtime:
            status.priority = 0
            if not problems:
                problems.append("kernel refused realtime priority")
        status.reason = "; ".join(problems)
        self.status = status
        return status

    def restore(self) -> None:
        if self._previous and hasattr(os, "sched_setscheduler"):
            policy, priority = self._previous
            try:
                os.sched_setscheduler(0, policy, os.sched_param(priority))
            except (PermissionError, OSError):
                pass
        self._previous = None
        self.status = RealtimeStatus("fifo", 80, None, reason="restored")


class EncoderThread:
    """The encoder thread, with its scheduling applied *on that thread*.

    `os.sched_setscheduler(0, …)` and `os.sched_setaffinity(0, …)` act on the
    calling thread, so they must run inside the worker rather than before it is
    created. The target receives this object and should poll `stop_event` when
    it runs a loop;

    * `start()` returns the scheduling status (never raises for a refused
      priority — read `status.reason`);
    * `stop()` signals and joins the worker, and restores the previous policy;
    * `error` holds a target exception so a caller can surface it without the
      process dying on an unhandled thread exception.
    """

    def __init__(
        self,
        target: Callable[["EncoderThread"], None],
        *,
        name: str = "signalpath-encoder",
        policy: str = "fifo",
        priority: int = 80,
        cpu: int | None = None,
        realtime: bool = True,
    ) -> None:
        self.target = target
        self.name = name
        self.realtime = bool(realtime)
        self.policy = policy
        self.priority = int(priority)
        self.cpu = cpu
        self.stop_event = threading.Event()
        self.scheduling = RealtimeStatus(policy, int(priority), cpu)
        self.error: BaseException | None = None
        self._setup = RealtimeSetup()
        self._ready = threading.Event()
        self._thread: threading.Thread | None = None
        self._running = False

    @property
    def running(self) -> bool:
        return self._running and self._thread is not None and self._thread.is_alive()

    @property
    def ident(self) -> int | None:
        return self._thread.ident if self._thread else None

    def _run(self) -> None:
        self._running = True
        try:
            if self.realtime:
                self.scheduling = self._setup.configure(self.policy, self.priority, self.cpu)
            else:
                self.scheduling = RealtimeStatus(
                    self.policy, self.priority, self.cpu, reason="realtime not requested"
                )
            self._ready.set()
            self.target(self)
        except BaseException as exc:  # keep the worker's failure inspectable
            self.error = exc
        finally:
            self._ready.set()
            if self.realtime:
                self._setup.restore()
            self._running = False

    def start(self, timeout: float = 2.0) -> RealtimeStatus:
        if self._thread is not None:
            raise RuntimeError("encoder thread already started")
        self._thread = threading.Thread(target=self._run, name=self.name, daemon=True)
        self._thread.start()
        self._ready.wait(timeout)
        return self.scheduling

    def join(self, timeout: float | None = None) -> bool:
        if self._thread is None:
            return True
        self._thread.join(timeout)
        return not self._thread.is_alive()

    def stop(self, timeout: float = 2.0) -> bool:
        self.stop_event.set()
        return self.join(timeout)

    def status(self) -> dict[str, object]:
        return {
            "running": self.running,
            "thread": self.ident,
            "scheduling": self.scheduling.as_dict(),
            "error": str(self.error) if self.error else None,
        }


# ── encoder orchestration ───────────────────────────────────────────────


@dataclass
class Packet:
    pts: int
    dts: int
    duration: int
    payload: bytes
    crc: bytes = b""
    crc_ok: bool = True
    frame: int = 0

    @property
    def pts_seconds(self) -> float:
        return self.pts / MPEG_CLOCK_HZ


class EncoderCore:
    """Timestamp + reservoir wrapper around any packetizer.

    `packetizer(pcm, frame_index)` returns the encoded frame bytes (or `None`
    while a codec is still priming). The core is what guarantees that whatever
    the backend does, every packet carries a monotonic 90 kHz PTS, a DTS
    derived from the codec delay, and per-frame CRC when it is enabled.
    """

    def __init__(
        self,
        packetizer: Callable[[Sequence[float], int], bytes | None] | None = None,
        *,
        codec: str = "mp3",
        sample_rate: int = 48_000,
        frame_samples: int = 1152,
        bitrate_kbps: int = 128,
        delay_ms: float | None = None,
        crc: bool = False,
        reservoir_mode: str = "adjust",
        reservoir_frames: int = 9,
        clock: PtsClock | None = None,
        realtime: RealtimeSetup | None = None,
    ) -> None:
        self.codec = codec
        self.sample_rate = int(sample_rate)
        self.frame_samples = int(frame_samples)
        self.bitrate_kbps = int(bitrate_kbps)
        self.crc = bool(crc)
        self.packetizer = packetizer
        self.clock = clock or PtsClock(
            sample_rate=sample_rate,
            frame_samples=frame_samples,
            codec=codec,
            delay_ms=delay_ms,
        )
        frame_bytes = max(1, round(bitrate_kbps * 1000 / 8 * frame_samples / sample_rate))
        self.reservoir = BitReservoir(frame_bytes, reservoir_frames, reservoir_mode)
        self.realtime = realtime or RealtimeSetup()
        self.packets: list[Packet] = []
        self.frames = 0
        self.bytes = 0
        self.errors = 0

    def submit(self, pcm: Sequence[float], borrow: int | None = None) -> Packet | None:
        """Encode one frame of PCM and return its timestamped packet."""
        pts, dts, duration = self.clock.advance()
        payload: bytes | None = None
        if self.packetizer is not None:
            try:
                payload = self.packetizer(pcm, self.frames)
            except Exception as exc:  # a backend failure must not kill the clock
                self.errors += 1
                raise RuntimeError(f"{self.codec} packetizer failed: {exc}") from exc
        if payload is None:
            self.frames += 1
            return None

        digest = crc_bytes(payload) if self.crc else b""
        ok = True
        if self.crc and len(payload) >= 2:
            ok = crc16_mpeg(payload[:-2]) == struct.unpack(">H", payload[-2:])[0]
        if borrow is None:
            # A frame bigger than its nominal slot is exactly the case the MP3
            # reservoir exists for: borrow the excess from earlier frames.
            borrow = max(0, len(payload) - self.reservoir.frame_bytes)
        self.reservoir.commit(payload, borrow, crc_ok=ok, index=self.frames)
        packet = Packet(
            pts=pts,
            dts=dts,
            duration=duration,
            payload=payload,
            crc=digest,
            crc_ok=ok,
            frame=self.frames,
        )
        self.packets.append(packet)
        self.frames += 1
        self.bytes += len(payload)
        if len(self.packets) > 4096:
            del self.packets[: len(self.packets) - 4096]
        return packet

    def reconnect(self) -> int:
        """Keep the timeline across a transport reconnect; returns next PTS."""
        return self.clock.reconnect()

    def stats(self) -> dict[str, object]:
        return {
            "codec": self.codec,
            "clock": self.clock.snapshot(),
            "reservoir": self.reservoir.stats(),
            "frames": self.frames,
            "bytes": self.bytes,
            "errors": self.errors,
            "realtime": self.realtime.status.as_dict(),
        }


def frame_pcm(pcm: Iterable[float], frame_samples: int) -> list[list[float]]:
    """Split a PCM stream into exact codec frames (dropping an incomplete tail)."""
    frame: list[float] = []
    out: list[list[float]] = []
    for sample in pcm:
        frame.append(float(sample))
        if len(frame) == frame_samples:
            out.append(frame)
            frame = []
    return out


__all__ = [
    "MPEG_CLOCK_HZ",
    "CODEC_DELAY_MS",
    "PtsClock",
    "BitReservoir",
    "Biquad",
    "k_weighting",
    "lufs_from_mean_square",
    "crc16_mpeg",
    "crc_bytes",
    "RealtimeSetup",
    "RealtimeStatus",
    "EncoderThread",
    "EncoderCore",
    "Packet",
    "frame_pcm",
    "db_to_lin",
    "lin_to_db",
    "clamp",
]
