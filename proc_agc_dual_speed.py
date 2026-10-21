"""Dual-speed AGC: slow loudness riding plus a fast peak guard.

The slow loop measures programme over ~1.5 s and moves level toward the target
within ±range. The fast loop watches a 15 ms peak and adds only downward gain
when the signal approaches the fast ceiling, so a transient never rides the
slow gain up into a clip. The two gains are combined before the output.

Default bypassed; bypass is bit-exact.
"""

from __future__ import annotations

import math
from typing import Sequence

from proc_dsp import Envelope, clamp, copy_stereo, level_db

try:  # optional vectorised gain targets; scalar path is the reference
    import numpy as _np
except ImportError:  # pragma: no cover
    _np = None

__all__ = ["AgcDualSpeed", "AGCDualSpeed"]


class AgcDualSpeed:
    def __init__(
        self,
        sample_rate: int = 48_000,
        enabled: bool = False,
        target_db: float = -18.0,
        max_boost_db: float = 12.0,
        max_cut_db: float = 12.0,
        fast_ceiling_db: float = -6.0,
        slow_ms: float = 1_500.0,
        fast_ms: float = 15.0,
        attack_ms: float = 120.0,
        release_ms: float = 900.0,
    ) -> None:
        if not 0.0 <= max_boost_db <= 24.0 or not 0.0 <= max_cut_db <= 24.0:
            raise ValueError("AGC ranges must be 0–24 dB")
        if fast_ceiling_db <= target_db:
            raise ValueError("fast ceiling must sit above the target")
        self.sample_rate = int(sample_rate)
        self.enabled = bool(enabled)
        self.target_db = float(target_db)
        self.max_boost_db = float(max_boost_db)
        self.max_cut_db = float(max_cut_db)
        self.fast_ceiling_db = float(fast_ceiling_db)
        self.slow_ms = max(100.0, float(slow_ms))
        self.fast_ms = max(2.0, float(fast_ms))
        self.attack_ms = max(1.0, float(attack_ms))
        self.release_ms = max(10.0, float(release_ms))
        self.reset()

    def reset(self) -> None:
        fs = self.sample_rate
        # Start at the target amplitude: AGC must not open with a 12 dB boost
        # on the first block before the slow detector has seen programme.
        target_amp = 10.0 ** (self.target_db / 20.0)
        self._slow = Envelope(fs, self.slow_ms, self.slow_ms, initial=target_amp)
        self._fast = Envelope(fs, 1.0, 40.0)
        self._attack = 1.0 - math.exp(-1.0 / (self.attack_ms * fs / 1000.0))
        self._release = 1.0 - math.exp(-1.0 / (self.release_ms * fs / 1000.0))
        self._gain = 1.0
        self.slow_gain_db = 0.0
        self.fast_gain_db = 0.0
        self.output_gain_db = 0.0

    def _target_gain(self, slow_db: float, fast_db: float) -> float:
        slow_gain = clamp(self.target_db - slow_db, -self.max_cut_db, self.max_boost_db)
        fast_gain = min(0.0, self.fast_ceiling_db - fast_db)
        self.slow_gain_db = slow_gain
        self.fast_gain_db = fast_gain
        return 10.0 ** ((slow_gain + fast_gain) / 20.0)

    def process_stereo(
        self, left: Sequence[float], right: Sequence[float]
    ) -> tuple[list[float], list[float]]:
        l, r = copy_stereo(left, right)
        if not self.enabled:
            return l, r
        n = len(l)
        if _np is not None and n >= 64:
            slow_env = self._slow.value
            fast_env = self._fast.value
            slow_a, slow_r = self._slow.attack, self._slow.release
            fast_a, fast_r = self._fast.attack, self._fast.release
            slow_levels = _np.empty(n, dtype=_np.float64)
            fast_levels = _np.empty(n, dtype=_np.float64)
            for i in range(n):
                linked = abs(l[i])
                other = abs(r[i])
                if other > linked:
                    linked = other
                coef = slow_a if linked > slow_env else slow_r
                slow_env += (linked - slow_env) * coef
                coef = fast_a if linked > fast_env else fast_r
                fast_env += (linked - fast_env) * coef
                slow_levels[i] = slow_env
                fast_levels[i] = fast_env
            self._slow.value = slow_env
            self._fast.value = fast_env
            slow_db = 20.0 * _np.log10(_np.maximum(slow_levels, 1e-12))
            fast_db = 20.0 * _np.log10(_np.maximum(fast_levels, 1e-12))
            slow_gain_db = _np.clip(
                self.target_db - slow_db, -self.max_cut_db, self.max_boost_db
            )
            fast_gain_db = _np.minimum(0.0, self.fast_ceiling_db - fast_db)
            targets = _np.power(10.0, (slow_gain_db + fast_gain_db) / 20.0).tolist()
            gains = [0.0] * n
            gain = self._gain
            attack, release = self._attack, self._release
            for i in range(n):
                target = targets[i]
                coef = attack if target < gain else release
                gain += (target - gain) * coef
                gains[i] = gain
            self._gain = gain
            self.slow_gain_db = float(slow_gain_db[-1])
            self.fast_gain_db = float(fast_gain_db[-1])
            self.output_gain_db = 20.0 * math.log10(max(gain, 1e-9))
            gain_array = _np.asarray(gains, dtype=_np.float64)
            return (
                (_np.asarray(l) * gain_array).tolist(),
                (_np.asarray(r) * gain_array).tolist(),
            )
        out_l = [0.0] * len(l)
        out_r = [0.0] * len(r)
        slow_env = self._slow.value
        fast_env = self._fast.value
        slow_a, slow_r = self._slow.attack, self._slow.release
        fast_a, fast_r = self._fast.attack, self._fast.release
        attack = self._attack
        release = self._release
        gain = self._gain
        target_db = self.target_db
        max_boost = self.max_boost_db
        max_cut = self.max_cut_db
        fast_ceiling = self.fast_ceiling_db
        slow_gain_db = self.slow_gain_db
        fast_gain_db = self.fast_gain_db
        for i, (xl, xr) in enumerate(zip(l, r)):
            linked = abs(xl)
            other = abs(xr)
            if other > linked:
                linked = other
            coef = slow_a if linked > slow_env else slow_r
            slow_env += (linked - slow_env) * coef
            coef = fast_a if linked > fast_env else fast_r
            fast_env += (linked - fast_env) * coef
            slow_db = level_db(slow_env)
            fast_db = level_db(fast_env)
            slow_gain_db = clamp(target_db - slow_db, -max_cut, max_boost)
            fast_gain_db = min(0.0, fast_ceiling - fast_db)
            target = 10.0 ** ((slow_gain_db + fast_gain_db) / 20.0)
            coef = attack if target < gain else release
            gain += (target - gain) * coef
            out_l[i] = xl * gain
            out_r[i] = xr * gain
        self._slow.value = slow_env
        self._fast.value = fast_env
        self._gain = gain
        self.slow_gain_db = slow_gain_db
        self.fast_gain_db = fast_gain_db
        self.output_gain_db = 20.0 * math.log10(max(gain, 1e-9))
        return out_l, out_r

    def state(self) -> dict[str, float | bool]:
        return {
            "enabled": self.enabled,
            "target_db": self.target_db,
            "slow_gain_db": round(self.slow_gain_db, 2),
            "fast_gain_db": round(self.fast_gain_db, 2),
            "output_gain_db": round(self.output_gain_db, 2),
        }


AGCDualSpeed = AgcDualSpeed
