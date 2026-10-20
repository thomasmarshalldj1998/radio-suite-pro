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

from proc_dsp import clamp, copy_stereo, level_db

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
        out_l = [0.0] * len(l)
        out_r = [0.0] * len(r)
        worst = 0.0
        peak = 0.0
        for i, (xl, xr) in enumerate(zip(l, r)):
            detector = max(abs(xl), abs(xr))
            peak = max(peak, detector)
            target = 1.0 if detector <= self.ceiling else self.ceiling / detector
            if target < self._gain:
                self._gain = target
                self._hold_left = self._hold
            elif self._hold_left > 0:
                self._hold_left -= 1
            else:
                self._gain += (1.0 - self._gain) * self._release
            dl = self._buf_l[self._pos]
            dr = self._buf_r[self._pos]
            self._buf_l[self._pos] = xl
            self._buf_r[self._pos] = xr
            self._pos = (self._pos + 1) % self._delay
            out_l[i] = clamp(dl * self._gain, -self.ceiling, self.ceiling)
            out_r[i] = clamp(dr * self._gain, -self.ceiling, self.ceiling)
            worst = max(worst, -20.0 * math.log10(max(self._gain, 1e-9)))
        self.max_reduction_db = worst
        self.peak_db = level_db(peak)
        return out_l, out_r

    def state(self) -> dict[str, float | int | bool]:
        return {
            "enabled": self.enabled,
            "ceiling_db": self.ceiling_db,
            "lookahead_ms": self.lookahead_ms,
            "latency_samples": self.latency_samples,
            "peak_db": round(self.peak_db, 2),
            "max_reduction_db": round(self.max_reduction_db, 2),
        }
