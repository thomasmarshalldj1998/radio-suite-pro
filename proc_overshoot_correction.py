"""Post-chain overshoot correction.

Some processors (saturation, EQ boosts, summed bands) can push a sample above
the previous ceiling. This final safety stage catches those overshoots with an
instant attack and a short release. It is intentionally not a musical limiter;
it should normally remove only rare samples.

Bypass is exact and the default is bypassed.
"""

from __future__ import annotations

import math
from typing import Sequence

from proc_accel import instant_attack_gain_curve
from proc_dsp import clamp, copy_stereo, level_db

try:  # optional vectorised detector; scalar path is the reference
    import numpy as _np
except ImportError:  # pragma: no cover
    _np = None

__all__ = ["OvershootCorrection"]


class OvershootCorrection:
    def __init__(
        self,
        sample_rate: int = 48_000,
        enabled: bool = False,
        ceiling_db: float = -0.1,
        release_ms: float = 40.0,
        max_reduction_db: float = 12.0,
    ) -> None:
        if not -12.0 <= ceiling_db <= 0.0:
            raise ValueError("ceiling_db must be -12…0 dB")
        if not 1.0 <= release_ms <= 1_000.0:
            raise ValueError("release_ms must be 1–1000 ms")
        if not 0.0 <= max_reduction_db <= 30.0:
            raise ValueError("max_reduction_db must be 0–30 dB")
        self.sample_rate = int(sample_rate)
        self.enabled = bool(enabled)
        self.ceiling_db = float(ceiling_db)
        self.ceiling = 10.0 ** (ceiling_db / 20.0)
        self.release_ms = float(release_ms)
        self.max_reduction_db = float(max_reduction_db)
        self.reset()

    def reset(self) -> None:
        self._release = 1.0 - math.exp(
            -1.0 / (self.release_ms * self.sample_rate / 1000.0)
        )
        self._gain = 1.0
        self.max_overshoot_db = 0.0

    def process_stereo(
        self, left: Sequence[float], right: Sequence[float]
    ) -> tuple[list[float], list[float]]:
        l, r = copy_stereo(left, right)
        if not self.enabled:
            return l, r
        n = len(l)
        if _np is not None and n >= 64:
            left = _np.asarray(l, dtype=_np.float64)
            right = _np.asarray(r, dtype=_np.float64)
            detector = _np.maximum(_np.abs(left), _np.abs(right))
            ceiling = self.ceiling
            floor_gain = 10.0 ** (-self.max_reduction_db / 20.0)
            targets = _np.clip(
                _np.where(detector <= ceiling, 1.0, ceiling / _np.maximum(detector, 1e-300)),
                floor_gain,
                1.0,
            )
            gains = instant_attack_gain_curve(targets, self._gain, self._release)
            if gains is not None:
                gain_array = _np.asarray(gains, dtype=_np.float64)
                self._gain = float(gain_array[-1])
                self.max_overshoot_db = max(
                    0.0, -20.0 * math.log10(max(float(gain_array.min()), 1e-9))
                )
                return (
                    _np.clip(left * gain_array, -ceiling, ceiling).tolist(),
                    _np.clip(right * gain_array, -ceiling, ceiling).tolist(),
                )
        out_l = [0.0] * len(l)
        out_r = [0.0] * len(r)
        gain = self._gain
        release = self._release
        ceiling = self.ceiling
        floor_gain = 10.0 ** (-self.max_reduction_db / 20.0)
        lowest = gain
        for i, (xl, xr) in enumerate(zip(l, r)):
            detector = abs(xl)
            other = abs(xr)
            if other > detector:
                detector = other
            target = 1.0 if detector <= ceiling else ceiling / detector
            if target < floor_gain:
                target = floor_gain
            if target < gain:
                gain = target
            else:
                gain += (target - gain) * release
            out_l[i] = min(ceiling, max(-ceiling, xl * gain))
            out_r[i] = min(ceiling, max(-ceiling, xr * gain))
            if gain < lowest:
                lowest = gain
        self._gain = gain
        self.max_overshoot_db = max(0.0, -20.0 * math.log10(max(lowest, 1e-9)))
        return out_l, out_r

    def state(self) -> dict[str, float | bool]:
        return {
            "enabled": self.enabled,
            "ceiling_db": self.ceiling_db,
            "max_overshoot_db": round(self.max_overshoot_db, 2),
        }
