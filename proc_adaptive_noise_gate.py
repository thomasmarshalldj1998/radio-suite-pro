"""Adaptive noise gate with hysteresis, hold and a linked stereo detector.

The floor is learned from quiet programme, so a noisy source does not open the
gate permanently. The gate opens ``margin_db`` above the learned floor and
closes ``hysteresis_db`` below the open threshold; hold prevents chattering on
speech pauses.

    floor    = slow tracker of the linked envelope
    open if  level > floor + margin + hysteresis     (from closed)
    stay open while level > floor + margin - hysteresis
    gain     = 0 dB open, −range_db closed

Default is bypassed. Bypass is bit-exact and no detector state advances.
"""

from __future__ import annotations

import math
from typing import Sequence

from proc_dsp import Envelope, clamp, copy_stereo, level_db

__all__ = ["AdaptiveNoiseGate"]


class AdaptiveNoiseGate:
    def __init__(
        self,
        sample_rate: int = 48_000,
        enabled: bool = False,
        margin_db: float = 8.0,
        hysteresis_db: float = 3.0,
        range_db: float = 60.0,
        attack_ms: float = 4.0,
        hold_ms: float = 90.0,
        release_ms: float = 220.0,
        adapt_ms: float = 1_200.0,
    ) -> None:
        if not 0.0 <= margin_db <= 30.0:
            raise ValueError("margin_db must be 0–30 dB")
        if not 0.0 <= hysteresis_db <= 12.0:
            raise ValueError("hysteresis_db must be 0–12 dB")
        if not 6.0 <= range_db <= 120.0:
            raise ValueError("range_db must be 6–120 dB")
        self.sample_rate = int(sample_rate)
        self.enabled = bool(enabled)
        self.margin_db = float(margin_db)
        self.hysteresis_db = float(hysteresis_db)
        self.range_db = float(range_db)
        self.attack_ms = max(0.5, float(attack_ms))
        self.hold_ms = max(0.0, float(hold_ms))
        self.release_ms = max(5.0, float(release_ms))
        self.adapt_ms = max(100.0, float(adapt_ms))
        self.reset()

    def reset(self) -> None:
        fs = self.sample_rate
        self._env = Envelope(fs, 2.0, 30.0)
        self._floor = 0.0
        self._floor_down = 1.0 - math.exp(-1.0 / (0.01 * fs))
        self._floor_up = 1.0 - math.exp(-1.0 / (self.adapt_ms * fs / 1000.0))
        self._gain = 1.0
        self._target = 1.0
        self._attack = 1.0 - math.exp(-1.0 / (self.attack_ms * fs / 1000.0))
        self._release = 1.0 - math.exp(-1.0 / (self.release_ms * fs / 1000.0))
        self._hold = max(1, int(round(self.hold_ms * fs / 1000.0)))
        self._hold_left = 0
        self.open = False
        self.floor_db = -120.0
        self.gain_db = 0.0

    def _update_floor(self, env: float) -> None:
        if self._floor <= 0.0 or env < self._floor:
            self._floor += (env - self._floor) * self._floor_down
        else:
            self._floor += (env - self._floor) * self._floor_up

    def process_stereo(
        self, left: Sequence[float], right: Sequence[float]
    ) -> tuple[list[float], list[float]]:
        l, r = copy_stereo(left, right)
        if not self.enabled:
            return l, r
        out_l = [0.0] * len(l)
        out_r = [0.0] * len(r)
        for i, (xl, xr) in enumerate(zip(l, r)):
            env = self._env.process(max(abs(xl), abs(xr)))
            self._update_floor(env)
            level = level_db(env)
            floor = level_db(self._floor)
            open_threshold = floor + self.margin_db + self.hysteresis_db
            close_threshold = floor + self.margin_db - self.hysteresis_db
            if not self.open and level > open_threshold:
                self.open = True
                self._hold_left = self._hold
            elif self.open and level < close_threshold:
                if self._hold_left > 0:
                    self._hold_left -= 1
                else:
                    self.open = False
            elif self.open and self._hold_left > 0:
                self._hold_left -= 1
            self._target = 1.0 if self.open else 10.0 ** (-self.range_db / 20.0)
            coef = self._attack if self._target > self._gain else self._release
            self._gain += (self._target - self._gain) * coef
            out_l[i] = xl * self._gain
            out_r[i] = xr * self._gain
        self.floor_db = level_db(self._floor)
        self.gain_db = 20.0 * math.log10(max(self._gain, 1e-9))
        return out_l, out_r

    def state(self) -> dict[str, float | bool]:
        return {
            "enabled": self.enabled,
            "open": self.open,
            "margin_db": self.margin_db,
            "hysteresis_db": self.hysteresis_db,
            "range_db": self.range_db,
            "floor_db": round(self.floor_db, 2),
            "gain_db": round(self.gain_db, 2),
        }
