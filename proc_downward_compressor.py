"""Downward compressor with a soft knee and linked stereo detector.

Above the threshold the gain is reduced by ``over × (1 − 1/ratio)``. A soft
knee spreads that transition over ``knee_db``; attack and release smooth the
gain itself. Makeup gain and a dry/wet mix are provided for chain building.

Bypass is bit-exact and the default is bypassed.
"""

from __future__ import annotations

import math
from typing import Sequence

from proc_dsp import Envelope, clamp, copy_stereo, level_db

__all__ = ["DownwardCompressor"]


class DownwardCompressor:
    def __init__(
        self,
        sample_rate: int = 48_000,
        enabled: bool = False,
        threshold_db: float = -18.0,
        ratio: float = 3.0,
        attack_ms: float = 10.0,
        release_ms: float = 150.0,
        knee_db: float = 6.0,
        makeup_db: float = 0.0,
        mix: float = 1.0,
    ) -> None:
        if not 1.0 <= ratio <= 20.0:
            raise ValueError("ratio must be 1–20")
        if knee_db < 0.0:
            raise ValueError("knee_db must be >= 0")
        self.sample_rate = int(sample_rate)
        self.enabled = bool(enabled)
        self.threshold_db = float(threshold_db)
        self.ratio = float(ratio)
        self.attack_ms = max(0.1, float(attack_ms))
        self.release_ms = max(1.0, float(release_ms))
        self.knee_db = float(knee_db)
        self.makeup_db = float(makeup_db)
        self.mix = float(clamp(mix, 0.0, 1.0))
        self.reset()

    def reset(self) -> None:
        fs = self.sample_rate
        self._env = Envelope(fs, 1.0, 50.0)
        self._attack = 1.0 - math.exp(-1.0 / (self.attack_ms * fs / 1000.0))
        self._release = 1.0 - math.exp(-1.0 / (self.release_ms * fs / 1000.0))
        self._gain = 1.0
        self._makeup = 10.0 ** (self.makeup_db / 20.0)
        self.gain_reduction_db = 0.0
        self.input_db = -120.0

    def _target_gain(self, level: float) -> float:
        over = level - self.threshold_db
        slope = 1.0 - 1.0 / self.ratio
        if over <= -self.knee_db / 2.0:
            reduction = 0.0
        elif over >= self.knee_db / 2.0:
            reduction = over * slope
        else:
            x = over + self.knee_db / 2.0
            reduction = slope * x * x / (2.0 * max(self.knee_db, 1e-9))
        return 10.0 ** (-max(0.0, reduction) / 20.0)

    def process_stereo(
        self, left: Sequence[float], right: Sequence[float]
    ) -> tuple[list[float], list[float]]:
        l, r = copy_stereo(left, right)
        if not self.enabled or self.mix <= 0.0:
            return l, r
        out_l = [0.0] * len(l)
        out_r = [0.0] * len(r)
        # Hot loop: keep every coefficient and state value in a local so the
        # block costs one loop, not one attribute lookup per sample.
        env_state = self._env
        attack_env = env_state.attack
        release_env = env_state.release
        env = env_state.value
        attack = self._attack
        release = self._release
        gain = self._gain
        makeup = self._makeup
        mix = self.mix
        threshold = self.threshold_db
        slope = 1.0 - 1.0 / self.ratio
        knee_half = self.knee_db / 2.0
        knee = max(self.knee_db, 1e-9)
        log10 = math.log10
        # Below this envelope the sample is outside the knee, so the target is
        # exactly unity; skip both the log and the polar conversion.
        quiet_limit = 10.0 ** ((threshold - knee_half) / 20.0)
        # Above it, the law is target = (threshold_lin / env) ** slope: one
        # divide + pow instead of a log10 and a 10**. The soft-knee strip is
        # the only place that still needs the level in dB.
        threshold_lin = 10.0 ** (threshold / 20.0)
        knee_hi_limit = quiet_limit * 10.0 ** (self.knee_db / 20.0)
        power = math.pow
        unit_makeup = makeup == 1.0
        full_mix = mix >= 1.0
        for i, (xl, xr) in enumerate(zip(l, r)):
            linked = xl if xl >= 0.0 else -xl
            other = xr if xr >= 0.0 else -xr
            if other > linked:
                linked = other
            coef_env = attack_env if linked > env else release_env
            env += (linked - env) * coef_env
            if env <= quiet_limit:
                target = 1.0
            elif env >= knee_hi_limit:
                target = power(threshold_lin / env, slope)
            else:
                level = 20.0 * log10(env)
                over = level - threshold
                x = over + knee_half
                reduction = slope * x * x / (2.0 * knee)
                target = 10.0 ** (-reduction / 20.0)
            smooth = attack if target < gain else release
            gain += (target - gain) * smooth
            wet_factor = gain if unit_makeup else gain * makeup
            wet_l = xl * wet_factor
            wet_r = xr * wet_factor
            out_l[i] = wet_l if full_mix else xl + (wet_l - xl) * mix
            out_r[i] = wet_r if full_mix else xr + (wet_r - xr) * mix
        env_state.value = env
        self._gain = gain
        self.input_db = -120.0 if env <= 0.0 else 20.0 * log10(env)
        self.gain_reduction_db = -20.0 * log10(max(gain, 1e-9))
        return out_l, out_r

    def state(self) -> dict[str, float | bool]:
        return {
            "enabled": self.enabled,
            "threshold_db": self.threshold_db,
            "ratio": self.ratio,
            "knee_db": self.knee_db,
            "input_db": round(self.input_db, 2),
            "gain_reduction_db": round(self.gain_reduction_db, 2),
            "makeup_db": self.makeup_db,
        }
