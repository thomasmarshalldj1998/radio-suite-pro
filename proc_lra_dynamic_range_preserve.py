"""LRA-aware loudness preservation.

Instead of compressing peaks, this stage rides the overall level slowly toward
a target and only ever reduces gain. Quiet passages are never lifted, so the
short-term-to-loud range is preserved; loud passages are trimmed by a bounded
amount with a long attack and a very long release.

    gain_db = clamp(target − loudness, −max_reduction, 0)
    output  = input × smoothed gain

The measured range between the quietest and loudest short-term estimate is
reported for telemetry. Bypass is bit-exact.
"""

from __future__ import annotations

import math
from typing import Sequence

from proc_dsp import Envelope, clamp, copy_stereo, level_db

__all__ = ["LraDynamicRangePreserve", "LRADynamicRangePreserve"]


class LraDynamicRangePreserve:
    def __init__(
        self,
        sample_rate: int = 48_000,
        enabled: bool = False,
        target_db: float = -18.0,
        max_reduction_db: float = 6.0,
        attack_ms: float = 250.0,
        release_ms: float = 3_000.0,
        window_ms: float = 1_000.0,
    ) -> None:
        if not -40.0 <= target_db <= 0.0:
            raise ValueError("target_db must be -40…0 dB")
        if not 0.0 <= max_reduction_db <= 18.0:
            raise ValueError("max_reduction_db must be 0–18 dB")
        self.sample_rate = int(sample_rate)
        self.enabled = bool(enabled)
        self.target_db = float(target_db)
        self.max_reduction_db = float(max_reduction_db)
        self.attack_ms = max(10.0, float(attack_ms))
        self.release_ms = max(100.0, float(release_ms))
        self.window_ms = max(100.0, float(window_ms))
        self.reset()

    def reset(self) -> None:
        fs = self.sample_rate
        self._env = Envelope(fs, self.window_ms, self.window_ms)
        self._attack = 1.0 - math.exp(-1.0 / (self.attack_ms * fs / 1000.0))
        self._release = 1.0 - math.exp(-1.0 / (self.release_ms * fs / 1000.0))
        self._gain = 1.0
        self.loudness_db = -120.0
        self.range_db = 0.0
        self._min_db = 120.0
        self._max_db = -120.0

    def process_stereo(
        self, left: Sequence[float], right: Sequence[float]
    ) -> tuple[list[float], list[float]]:
        l, r = copy_stereo(left, right)
        if not self.enabled or self.max_reduction_db <= 0.0:
            return l, r
        out_l = [0.0] * len(l)
        out_r = [0.0] * len(r)
        env_state = self._env
        attack_env = env_state.attack
        release_env = env_state.release
        env = env_state.value
        attack = self._attack
        release = self._release
        gain = self._gain
        min_db = self._min_db
        max_db = self._max_db
        target_db = self.target_db
        max_reduction = self.max_reduction_db
        loudness = self.loudness_db
        for i, (xl, xr) in enumerate(zip(l, r)):
            linked = abs(xl)
            other = abs(xr)
            if other > linked:
                linked = other
            coef_env = attack_env if linked > env else release_env
            env += (linked - env) * coef_env
            loudness = -120.0 if env <= 0.0 else 20.0 * math.log10(env)
            if loudness < min_db:
                min_db = loudness
            if loudness > max_db:
                max_db = loudness
            gain_db = target_db - loudness
            if gain_db < -max_reduction:
                gain_db = -max_reduction
            elif gain_db > 0.0:
                gain_db = 0.0
            target = 10.0 ** (gain_db / 20.0)
            coef = attack if target < gain else release
            gain += (target - gain) * coef
            out_l[i] = xl * gain
            out_r[i] = xr * gain
        env_state.value = env
        self._gain = gain
        self.loudness_db = loudness
        self._min_db = min_db
        self._max_db = max_db
        self.range_db = max(0.0, max_db - min_db)
        return out_l, out_r

    def state(self) -> dict[str, float | bool]:
        return {
            "enabled": self.enabled,
            "target_db": self.target_db,
            "loudness_db": round(self.loudness_db, 2),
            "range_db": round(self.range_db, 2),
            "gain_reduction_db": round(-20.0 * math.log10(max(self._gain, 1e-9)), 2),
        }


LRADynamicRangePreserve = LraDynamicRangePreserve
