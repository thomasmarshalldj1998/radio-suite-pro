"""Dynamic spectral tilt.

A 1 kHz complementary split lets the low and high halves move in opposite
directions. ``tilt_db`` is the static balance; ``dynamic_db`` adds extra
low-tilt when the programme is above ``threshold_db``, which keeps loud
passages from becoming thin.

    low  = lowpass(x, 1 kHz); high = x − low
    tilt = tilt_db + dynamic_db × clamp((level − threshold) / 12, 0, 1)
    out  = low × 10^(+tilt/40) + high × 10^(−tilt/40)
"""

from __future__ import annotations

from typing import Sequence

from proc_accel import filter_block
from proc_dsp import Biquad, Envelope, clamp, copy_stereo, level_db

try:
    import numpy as _np
except ImportError:  # pragma: no cover
    _np = None

__all__ = ["DynamicTilt"]


class DynamicTilt:
    def __init__(
        self,
        sample_rate: int = 48_000,
        enabled: bool = False,
        tilt_db: float = 0.0,
        dynamic_db: float = 0.0,
        threshold_db: float = -20.0,
        attack_ms: float = 30.0,
        release_ms: float = 400.0,
    ) -> None:
        if not -12.0 <= tilt_db <= 12.0 or not -12.0 <= dynamic_db <= 12.0:
            raise ValueError("tilt values must be -12…12 dB")
        self.sample_rate = int(sample_rate)
        self.enabled = bool(enabled)
        self.tilt_db = float(tilt_db)
        self.dynamic_db = float(dynamic_db)
        self.threshold_db = float(threshold_db)
        self.attack_ms = max(1.0, float(attack_ms))
        self.release_ms = max(5.0, float(release_ms))
        self.reset()

    def reset(self) -> None:
        fs = self.sample_rate
        self._low_l = Biquad.lowpass(fs, 1_000.0)
        self._low_r = Biquad.lowpass(fs, 1_000.0)
        self._env = Envelope(fs, self.attack_ms, self.release_ms)
        self.applied_tilt_db = self.tilt_db

    def process_stereo(
        self, left: Sequence[float], right: Sequence[float]
    ) -> tuple[list[float], list[float]]:
        l, r = copy_stereo(left, right)
        if not self.enabled or (self.tilt_db == 0.0 and self.dynamic_db == 0.0):
            return l, r
        low_l = filter_block(self._low_l, l)
        low_r = filter_block(self._low_r, r)
        if _np is not None and len(l) >= 64:
            base_l, base_r = _np.asarray(low_l), _np.asarray(low_r)
            env_state = self._env
            last = self.tilt_db
            tilts = _np.empty(len(l))
            for i in range(len(l)):
                env = env_state.process(max(abs(l[i]), abs(r[i])))
                extra = self.dynamic_db * clamp(
                    (level_db(env) - self.threshold_db) / 12.0, 0.0, 1.0
                )
                last = self.tilt_db + extra
                tilts[i] = last
            gl = _np.power(10.0, tilts / 40.0)
            gh = _np.power(10.0, -tilts / 40.0)
            out_l = base_l * gl + (_np.asarray(l) - base_l) * gh
            out_r = base_r * gl + (_np.asarray(r) - base_r) * gh
            self.applied_tilt_db = last
            return out_l.tolist(), out_r.tolist()
        out_l = [0.0] * len(l)
        out_r = [0.0] * len(r)
        last = self.tilt_db
        for i, (xl, xr) in enumerate(zip(l, r)):
            low = low_l[i]
            low2 = low_r[i]
            env = self._env.process(max(abs(xl), abs(xr)))
            extra = self.dynamic_db * clamp(
                (level_db(env) - self.threshold_db) / 12.0, 0.0, 1.0
            )
            tilt = self.tilt_db + extra
            last = tilt
            gl = 10.0 ** (tilt / 40.0)
            gh = 10.0 ** (-tilt / 40.0)
            out_l[i] = low * gl + (xl - low) * gh
            out_r[i] = low2 * gl + (xr - low2) * gh
        self.applied_tilt_db = last
        return out_l, out_r

    def state(self) -> dict[str, float | bool]:
        return {
            "enabled": self.enabled,
            "tilt_db": self.tilt_db,
            "dynamic_db": self.dynamic_db,
            "applied_tilt_db": round(self.applied_tilt_db, 2),
        }
