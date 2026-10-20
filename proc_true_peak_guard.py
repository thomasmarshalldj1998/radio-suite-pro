"""True-peak guard.

A 4× Catmull-Rom reconstruction estimates the waveform *between* samples; the
largest absolute value in each neighbourhood drives a look-ahead gain envelope.
The audio is delayed by the look-ahead, so the reduction is already in place
when the reconstructed peak arrives.

The detector is stereo-linked and the output is held at the ceiling. This is a
guard, not a programme limiter: use ``proc_lookahead_limiter`` for musical gain
control and this stage for the final sample-domain safety net.
"""

from __future__ import annotations

import math
from typing import Sequence

from proc_dsp import clamp, copy_stereo, cubic, level_db

__all__ = ["TruePeakGuard"]


class TruePeakGuard:
    def __init__(
        self,
        sample_rate: int = 48_000,
        enabled: bool = False,
        ceiling_db: float = -1.0,
        lookahead_ms: float = 2.0,
        release_ms: float = 80.0,
        oversample: int = 4,
    ) -> None:
        if not -12.0 <= ceiling_db <= 0.0:
            raise ValueError("ceiling_db must be -12…0 dBTP")
        if not 0.0 <= lookahead_ms <= 10.0:
            raise ValueError("lookahead_ms must be 0–10 ms")
        if not 2 <= oversample <= 16:
            raise ValueError("oversample must be 2–16")
        self.sample_rate = int(sample_rate)
        self.enabled = bool(enabled)
        self.ceiling_db = float(ceiling_db)
        self.ceiling = 10.0 ** (ceiling_db / 20.0)
        self.lookahead_ms = float(lookahead_ms)
        self.release_ms = max(5.0, float(release_ms))
        self.oversample = int(oversample)
        self.reset()

    def reset(self) -> None:
        fs = self.sample_rate
        self._delay = max(0, int(round(self.lookahead_ms * fs / 1000.0)))
        self._buf_l = [0.0] * self._delay
        self._buf_r = [0.0] * self._delay
        self._pos = 0
        self._release = 1.0 - math.exp(-1.0 / (self.release_ms * fs / 1000.0))
        self._gain = 1.0
        self._hold = max(1, self._delay)
        self._hold_left = 0
        self.max_reduction_db = 0.0
        self.true_peak_db = -120.0

    @property
    def latency_samples(self) -> int:
        return self._delay

    def _curve(self, values: Sequence[float]) -> list[float]:
        n = len(values)
        if n == 0:
            return []
        curve = [abs(float(x)) for x in values]
        for i in range(n - 1):
            a = float(values[i - 1]) if i > 0 else float(values[i])
            b = float(values[i])
            c = float(values[i + 1])
            d = float(values[i + 2]) if i + 2 < n else c
            for step in range(1, self.oversample):
                point = cubic(a, b, c, d, step / self.oversample)
                if abs(point) > curve[i]:
                    curve[i] = abs(point)
                if abs(point) > curve[i + 1]:
                    curve[i + 1] = abs(point)
        return curve

    def process_stereo(
        self, left: Sequence[float], right: Sequence[float]
    ) -> tuple[list[float], list[float]]:
        l, r = copy_stereo(left, right)
        if not self.enabled:
            return l, r
        curve = [max(a, b) for a, b in zip(self._curve(l), self._curve(r))]
        out_l = [0.0] * len(l)
        out_r = [0.0] * len(r)
        worst = 0.0
        latest_peak = 0.0
        for i, (xl, xr) in enumerate(zip(l, r)):
            target = 1.0 if curve[i] <= self.ceiling else self.ceiling / curve[i]
            if target < self._gain:
                self._gain = target
                self._hold_left = self._hold
            elif self._hold_left > 0:
                self._hold_left -= 1
            else:
                self._gain += (1.0 - self._gain) * self._release
            if self._delay:
                dl = self._buf_l[self._pos]
                dr = self._buf_r[self._pos]
                self._buf_l[self._pos] = xl
                self._buf_r[self._pos] = xr
                self._pos = (self._pos + 1) % self._delay
            else:
                dl, dr = xl, xr
            out_l[i] = clamp(dl * self._gain, -self.ceiling, self.ceiling)
            out_r[i] = clamp(dr * self._gain, -self.ceiling, self.ceiling)
            reduction = -20.0 * math.log10(max(self._gain, 1e-9))
            if reduction > worst:
                worst = reduction
            if curve[i] > latest_peak:
                latest_peak = curve[i]
        self.max_reduction_db = worst
        self.true_peak_db = level_db(latest_peak)
        return out_l, out_r

    def state(self) -> dict[str, float | int | bool]:
        return {
            "enabled": self.enabled,
            "ceiling_db": self.ceiling_db,
            "oversample": self.oversample,
            "latency_samples": self.latency_samples,
            "true_peak_db": round(self.true_peak_db, 2),
            "max_reduction_db": round(self.max_reduction_db, 2),
        }
