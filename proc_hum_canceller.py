"""Mains hum canceller — narrow notches at the fundamental and harmonics.

A bank of high-Q peaking filters is centred on the selected mains frequency
(50 or 60 Hz) and its harmonics. High Q keeps the notches narrow enough that
the surrounding bass is not audibly removed.

    for h in 1…harmonics:
        x = peaking(x, h × mains_hz, q, depth_db)

The detected hum level is reported for telemetry. The stage is bypassed by
default; bypass is a bit-exact copy.
"""

from __future__ import annotations

import math
from typing import Sequence

from proc_accel import filter_block, filter_chain
from proc_dsp import Biquad, Envelope, copy_stereo, level_db, peaking

__all__ = ["HumCanceller"]


class HumCanceller:
    def __init__(
        self,
        sample_rate: int = 48_000,
        enabled: bool = False,
        mains_hz: float = 50.0,
        harmonics: int = 4,
        q: float = 24.0,
        depth_db: float = -24.0,
    ) -> None:
        if mains_hz not in (50.0, 60.0):
            raise ValueError("mains_hz must be 50 or 60")
        if not 1 <= harmonics <= 8:
            raise ValueError("harmonics must be 1–8")
        if not 2.0 <= q <= 80.0:
            raise ValueError("q must be 2–80")
        if not -60.0 <= depth_db <= -3.0:
            raise ValueError("depth_db must be -60…-3 dB")
        self.sample_rate = int(sample_rate)
        self.enabled = bool(enabled)
        self.mains_hz = float(mains_hz)
        self.harmonics = int(harmonics)
        self.q = float(q)
        self.depth_db = float(depth_db)
        self.reset()

    def reset(self) -> None:
        fs = self.sample_rate
        self._filters_l: list[Biquad] = []
        self._filters_r: list[Biquad] = []
        for h in range(1, self.harmonics + 1):
            freq = self.mains_hz * h
            if freq >= fs * 0.45:
                break
            self._filters_l.append(peaking(fs, freq, self.q, self.depth_db))
            self._filters_r.append(peaking(fs, freq, self.q, self.depth_db))
        self._hum_bp_l = Biquad.bandpass(fs, self.mains_hz, 8.0)
        self._hum_bp_r = Biquad.bandpass(fs, self.mains_hz, 8.0)
        self._env = Envelope(fs, 20.0, 250.0)
        self.hum_db = -120.0
        self.frequencies = [round(self.mains_hz * h, 1) for h in range(1, len(self._filters_l) + 1)]

    def process_stereo(
        self, left: Sequence[float], right: Sequence[float]
    ) -> tuple[list[float], list[float]]:
        l, r = copy_stereo(left, right)
        if not self.enabled:
            return l, r
        # Detector and notch chains are static; run the biquads in C when
        # SciPy is available and keep the per-sample path as the fallback.
        detector_l = filter_block(self._hum_bp_l, l)
        detector_r = filter_block(self._hum_bp_r, r)
        env = self._env
        value = env.value
        attack, release = env.attack, env.release
        for dl, dr in zip(detector_l, detector_r):
            level = abs(dl)
            other = abs(dr)
            if other > level:
                level = other
            coef = attack if level > value else release
            value += (level - value) * coef
        env.value = value
        out_l = filter_chain(self._filters_l, l)
        out_r = filter_chain(self._filters_r, r)
        self.hum_db = level_db(value)
        return out_l, out_r

    def state(self) -> dict[str, float | int | bool | list[float]]:
        return {
            "enabled": self.enabled,
            "mains_hz": self.mains_hz,
            "harmonics": self.harmonics,
            "q": self.q,
            "depth_db": self.depth_db,
            "frequencies": self.frequencies,
            "hum_db": round(self.hum_db, 2),
        }
