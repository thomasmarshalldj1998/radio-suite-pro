"""Adaptive high-frequency hiss reduction.

Hiss is stationary energy above the programme band. The processor follows the
high-band envelope with a fast detector and tracks a slow noise floor; when the
high band sits at the floor it attenuates that band, and when programme energy
rises above the floor it gets out of the way.

    high   = highpass(x, hf_hz)
    floor  = slow minimum tracker of |high|
    gain   = 1 - depth * clamp(floor / |high|, 0, 1)
    output = x + high * (gain - 1)

Only the high band is changed, so body and low-mid tone are untouched. Bypass
is bit-exact and default is bypassed.
"""

from __future__ import annotations

import math
from typing import Sequence

from proc_dsp import Biquad, Envelope, clamp, copy_stereo, level_db

__all__ = ["AdaptiveHissReducer", "NoiseAdaptiveHiss"]


class AdaptiveHissReducer:
    def __init__(
        self,
        sample_rate: int = 48_000,
        enabled: bool = False,
        hf_hz: float = 4_000.0,
        reduction_db: float = 6.0,
        adapt_ms: float = 900.0,
        attack_ms: float = 5.0,
        release_ms: float = 120.0,
    ) -> None:
        if not 2_000.0 <= hf_hz <= 12_000.0:
            raise ValueError("hf_hz must be 2–12 kHz")
        if not 0.0 <= reduction_db <= 18.0:
            raise ValueError("reduction_db must be 0–18 dB")
        self.sample_rate = int(sample_rate)
        self.enabled = bool(enabled)
        self.hf_hz = float(hf_hz)
        self.reduction_db = float(reduction_db)
        self.adapt_ms = max(100.0, float(adapt_ms))
        self.attack_ms = max(0.5, float(attack_ms))
        self.release_ms = max(10.0, float(release_ms))
        self.reset()

    def reset(self) -> None:
        fs = self.sample_rate
        self._hp_l = Biquad.highpass(fs, self.hf_hz)
        self._hp_r = Biquad.highpass(fs, self.hf_hz)
        self._env = Envelope(fs, self.attack_ms, self.release_ms)
        self._floor = 0.0
        self._floor_rise = 1.0 - math.exp(-1.0 / (self.adapt_ms * fs / 1000.0))
        self._floor_fall = 1.0 - math.exp(-1.0 / (0.02 * fs))
        self._depth = 1.0 - 10.0 ** (-self.reduction_db / 20.0)
        self._gain = 1.0
        self._gain_smooth = 1.0 - math.exp(-1.0 / (0.015 * fs))
        self.floor_db = -120.0
        self.gain_reduction_db = 0.0

    def process_stereo(
        self, left: Sequence[float], right: Sequence[float]
    ) -> tuple[list[float], list[float]]:
        l, r = copy_stereo(left, right)
        if not self.enabled or self._depth <= 0.0:
            return l, r
        out_l = [0.0] * len(l)
        out_r = [0.0] * len(r)
        for i, (xl, xr) in enumerate(zip(l, r)):
            hl = self._hp_l.process(xl)
            hr = self._hp_r.process(xr)
            env = self._env.process(max(abs(hl), abs(hr)))
            if self._floor <= 0.0:
                self._floor = env
            elif env < self._floor:
                self._floor += (env - self._floor) * self._floor_fall
            else:
                self._floor += (env - self._floor) * self._floor_rise
            ratio = 1.0 if env <= 1e-12 else clamp(self._floor / env, 0.0, 1.0)
            target = 1.0 - self._depth * ratio
            self._gain += (target - self._gain) * self._gain_smooth
            out_l[i] = xl + hl * (self._gain - 1.0)
            out_r[i] = xr + hr * (self._gain - 1.0)
        self.floor_db = level_db(self._floor)
        self.gain_reduction_db = -20.0 * math.log10(max(self._gain, 1e-9))
        return out_l, out_r

    def state(self) -> dict[str, float | bool]:
        return {
            "enabled": self.enabled,
            "hf_hz": self.hf_hz,
            "reduction_db": self.reduction_db,
            "floor_db": round(self.floor_db, 2),
            "gain_reduction_db": round(self.gain_reduction_db, 2),
        }


# Filename-shaped alias for callers that describe the module by its file name.
NoiseAdaptiveHiss = AdaptiveHissReducer
