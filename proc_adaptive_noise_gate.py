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
        # Comparing levels in the linear domain removes two log10s per sample:
        # level > floor + margin ± hysteresis is env > floor × ratio.
        open_ratio = 10.0 ** ((self.margin_db + self.hysteresis_db) / 20.0)
        close_ratio = 10.0 ** ((self.margin_db - self.hysteresis_db) / 20.0)
        closed_gain = 10.0 ** (-self.range_db / 20.0)
        env_state = self._env
        attack_env = env_state.attack
        release_env = env_state.release
        env = env_state.value
        floor = self._floor
        floor_down = self._floor_down
        floor_up = self._floor_up
        gain = self._gain
        attack = self._attack
        release = self._release
        is_open = self.open
        hold_left = self._hold_left
        hold = self._hold
        for i, (xl, xr) in enumerate(zip(l, r)):
            peak = xl if xl >= 0.0 else -xl
            other = xr if xr >= 0.0 else -xr
            if other > peak:
                peak = other
            env += (peak - env) * (attack_env if peak > env else release_env)
            if floor <= 0.0 or env < floor:
                floor += (env - floor) * floor_down
            else:
                floor += (env - floor) * floor_up
            if not is_open and env > floor * open_ratio:
                is_open = True
                hold_left = hold
            elif is_open and env < floor * close_ratio:
                if hold_left > 0:
                    hold_left -= 1
                else:
                    is_open = False
            elif is_open and hold_left > 0:
                hold_left -= 1
            target = 1.0 if is_open else closed_gain
            coef = attack if target > gain else release
            gain += (target - gain) * coef
            out_l[i] = xl * gain
            out_r[i] = xr * gain
        env_state.value = env
        self._floor = floor
        self._gain = gain
        self.open = is_open
        self._hold_left = hold_left
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
