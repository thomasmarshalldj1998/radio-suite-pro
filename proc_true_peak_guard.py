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

try:  # optional vectorised detector; scalar path is the reference
    import numpy as _np
except ImportError:  # pragma: no cover
    _np = None

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
        if _np is not None and n >= 64:
            xs = _np.asarray(values, dtype=_np.float64)
            a = _np.empty_like(xs)
            a[0] = xs[0]
            a[1:] = xs[:-1]
            c = _np.empty_like(xs)
            c[-1] = xs[-1]
            c[:-1] = xs[1:]
            d = _np.empty_like(xs)
            d[-1] = xs[-1]
            if n > 1:
                d[-2] = xs[-1]
                d[:-2] = xs[2:]
            curve = _np.abs(xs)
            for step in range(1, self.oversample):
                t = step / self.oversample
                t2 = t * t
                t3 = t2 * t
                point = _np.abs(
                    0.5
                    * (
                        2.0 * xs
                        + (-a + c) * t
                        + (2.0 * a - 5.0 * xs + 4.0 * c - d) * t2
                        + (-a + 3.0 * xs - 3.0 * c + d) * t3
                    )
                )
                _np.maximum(curve, point, out=curve)
                _np.maximum(curve[1:], point[:-1], out=curve[1:])
            return curve.tolist()
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
        curve_l = self._curve(l)
        curve_r = self._curve(r)
        if _np is not None and len(l) >= 64:
            curve = _np.maximum(_np.asarray(curve_l), _np.asarray(curve_r)).tolist()
        else:
            curve = [max(a, b) for a, b in zip(curve_l, curve_r)]
        n = len(l)
        if _np is not None and n >= 64:
            gain_curve = _np.empty(n, dtype=_np.float64)
            gain = self._gain
            hold_left = self._hold_left
            hold = self._hold
            release = self._release
            ceiling = self.ceiling
            for i in range(n):
                peak = curve[i]
                target = 1.0 if peak <= ceiling else ceiling / peak
                if target < gain:
                    gain = target
                    hold_left = hold
                elif hold_left > 0:
                    hold_left -= 1
                else:
                    gain += (1.0 - gain) * release
                gain_curve[i] = gain
            delay = self._delay
            left = _np.asarray(l, dtype=_np.float64)
            right = _np.asarray(r, dtype=_np.float64)
            if delay:
                buf_l = _np.asarray(self._buf_l, dtype=_np.float64)
                buf_r = _np.asarray(self._buf_r, dtype=_np.float64)
                pos = self._pos % delay
                stream_l = _np.concatenate((buf_l[pos:], buf_l[:pos], left))
                stream_r = _np.concatenate((buf_r[pos:], buf_r[:pos], right))
                delayed_l = stream_l[:n]
                delayed_r = stream_r[:n]
                self._buf_l = stream_l[n : n + delay]
                self._buf_r = stream_r[n : n + delay]
                self._pos = 0
            else:
                delayed_l, delayed_r = left, right
            self._gain = gain
            self._hold_left = hold_left
            self.max_reduction_db = max(
                0.0, -20.0 * math.log10(max(float(gain_curve.min()), 1e-9))
            )
            self.true_peak_db = level_db(float(max(curve_l + curve_r)) if n else 0.0)
            return (
                _np.clip(delayed_l * gain_curve, -ceiling, ceiling).tolist(),
                _np.clip(delayed_r * gain_curve, -ceiling, ceiling).tolist(),
            )
        out_l = [0.0] * len(l)
        out_r = [0.0] * len(r)
        latest_peak = 0.0
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
            peak = curve[i]
            target = 1.0 if peak <= ceiling else ceiling / peak
            if target < gain:
                gain = target
                hold_left = hold
            elif hold_left > 0:
                hold_left -= 1
            else:
                gain += (1.0 - gain) * release
            if delay:
                dl = buf_l[pos]
                dr = buf_r[pos]
                buf_l[pos] = xl
                buf_r[pos] = xr
                pos = (pos + 1) % delay
            else:
                dl, dr = xl, xr
            out_l[i] = min(ceiling, max(-ceiling, dl * gain))
            out_r[i] = min(ceiling, max(-ceiling, dr * gain))
            if gain < lowest:
                lowest = gain
            if peak > latest_peak:
                latest_peak = peak
        self._gain = gain
        self._hold_left = hold_left
        self._pos = pos
        self.max_reduction_db = max(0.0, -20.0 * math.log10(max(lowest, 1e-9)))
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
