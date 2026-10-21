"""Stereo-linked lookahead peak limiter.

The detector sees the input before the delayed audio reaches the output, so gain
reduction is already applied when a transient arrives. A short hold prevents
the gain from releasing inside the same peak; release is deliberately slower
than attack.

    delay = lookahead_ms
    out   = delayed(x) × smoothed_gain
    gain  = min(1, ceiling / |x|)

Bypass is bit-exact and the default is bypassed.
"""

from __future__ import annotations

import math
from typing import Sequence

from proc_accel import limiter_gain_loop
from proc_dsp import clamp, copy_stereo, level_db

try:  # optional vectorised detector / delay / output
    import numpy as _np
except ImportError:  # pragma: no cover - fallback hosts
    _np = None

__all__ = ["LookaheadLimiter"]


class LookaheadLimiter:
    def __init__(
        self,
        sample_rate: int = 48_000,
        enabled: bool = False,
        ceiling_db: float = -1.0,
        lookahead_ms: float = 5.0,
        release_ms: float = 120.0,
    ) -> None:
        if not -12.0 <= ceiling_db <= 0.0:
            raise ValueError("ceiling_db must be -12…0 dB")
        if not 0.5 <= lookahead_ms <= 20.0:
            raise ValueError("lookahead_ms must be 0.5–20 ms")
        if not 5.0 <= release_ms <= 2_000.0:
            raise ValueError("release_ms must be 5–2000 ms")
        self.sample_rate = int(sample_rate)
        self.enabled = bool(enabled)
        self.ceiling_db = float(ceiling_db)
        self.ceiling = 10.0 ** (ceiling_db / 20.0)
        self.lookahead_ms = float(lookahead_ms)
        self.release_ms = float(release_ms)
        self.reset()

    def reset(self) -> None:
        fs = self.sample_rate
        self._delay = max(1, int(round(self.lookahead_ms * fs / 1000.0)))
        self._buf_l = [0.0] * self._delay
        self._buf_r = [0.0] * self._delay
        self._pos = 0
        self._release = 1.0 - math.exp(-1.0 / (self.release_ms * fs / 1000.0))
        self._gain = 1.0
        self._hold_left = 0
        self._hold = max(1, self._delay)
        self.max_reduction_db = 0.0
        self.peak_db = -120.0

    @property
    def latency_samples(self) -> int:
        return self._delay

    def process_stereo(
        self, left: Sequence[float], right: Sequence[float]
    ) -> tuple[list[float], list[float]]:
        l, r = copy_stereo(left, right)
        if not self.enabled:
            return l, r
        if _np is not None and len(l) >= 64:
            result = self._process_block(l, r)
            if result is not None:
                return result
        out_l = [0.0] * len(l)
        out_r = [0.0] * len(r)
        peak = 0.0
        gain = self._gain
        hold_left = self._hold_left
        hold = self._hold
        release = self._release
        ceiling = self.ceiling
        buf_l, buf_r = self._buf_l, self._buf_r
        pos = self._pos
        delay = self._delay
        lowest = gain
        for i, (xl, xr) in enumerate(zip(l, r)):
            detector = abs(xl)
            other = abs(xr)
            if other > detector:
                detector = other
            if detector > peak:
                peak = detector
            target = 1.0 if detector <= ceiling else ceiling / detector
            if target < gain:
                gain = target
                hold_left = hold
            elif hold_left > 0:
                hold_left -= 1
            else:
                gain += (1.0 - gain) * release
            dl = buf_l[pos]
            dr = buf_r[pos]
            buf_l[pos] = xl
            buf_r[pos] = xr
            pos = (pos + 1) % delay
            out_l[i] = min(ceiling, max(-ceiling, dl * gain))
            out_r[i] = min(ceiling, max(-ceiling, dr * gain))
            if gain < lowest:
                lowest = gain
        self._gain = gain
        self._hold_left = hold_left
        self._pos = pos
        self.max_reduction_db = -20.0 * math.log10(max(lowest, 1e-9))
        self.peak_db = level_db(peak)
        return out_l, out_r

    def _process_block(
        self, l: Sequence[float], r: Sequence[float]
    ) -> tuple[list[float], list[float]] | None:
        """Detector, delay and output in NumPy; gain recurrence stays scalar."""
        n = len(l)
        xl = _np.asarray(l, dtype=_np.float64)
        xr = _np.asarray(r, dtype=_np.float64)
        detector = _np.maximum(_np.abs(xl), _np.abs(xr))
        ceiling = self.ceiling
        targets = _np.where(
            detector <= ceiling, 1.0, ceiling / _np.maximum(detector, 1e-300)
        ).tolist()
        gains, gain, hold_left = limiter_gain_loop(
            targets, self._gain, self._hold_left, self._hold, self._release
        )
        gain_array = _np.asarray(gains, dtype=_np.float64)
        delay = self._delay
        if delay:
            pos = self._pos % delay
            buf_l = _np.asarray(self._buf_l, dtype=_np.float64)
            buf_r = _np.asarray(self._buf_r, dtype=_np.float64)
            stream_l = _np.concatenate((buf_l[pos:], buf_l[:pos], xl))
            stream_r = _np.concatenate((buf_r[pos:], buf_r[:pos], xr))
            delayed_l, delayed_r = stream_l[:n], stream_r[:n]
            self._buf_l = stream_l[n : n + delay].tolist()
            self._buf_r = stream_r[n : n + delay].tolist()
            self._pos = 0
        else:
            delayed_l, delayed_r = xl, xr
        self._gain = gain
        self._hold_left = hold_left
        self.max_reduction_db = -20.0 * math.log10(max(float(gain_array.min()), 1e-9))
        self.peak_db = level_db(float(detector.max()))
        return (
            _np.clip(delayed_l * gain_array, -ceiling, ceiling).tolist(),
            _np.clip(delayed_r * gain_array, -ceiling, ceiling).tolist(),
        )

    def state(self) -> dict[str, float | int | bool]:
        return {
            "enabled": self.enabled,
            "ceiling_db": self.ceiling_db,
            "lookahead_ms": self.lookahead_ms,
            "latency_samples": self.latency_samples,
            "peak_db": round(self.peak_db, 2),
            "max_reduction_db": round(self.max_reduction_db, 2),
        }
