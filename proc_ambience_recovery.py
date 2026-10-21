"""Ambience recovery from the side channel.

Reverb and room tone live mostly in the difference signal. This stage band-
limits the side channel and adds that detail back, optionally with extra width,
without changing the centre.

    side = (L−R)/2
    amb  = bandpass(side, freq)
    side = side + amb × amount
    L = mid + side, R = mid − side
"""

from __future__ import annotations

import math
from typing import Sequence

from proc_accel import filter_block
from proc_dsp import Biquad, Envelope, clamp, copy_stereo, level_db

try:
    import numpy as _np
except ImportError:  # pragma: no cover
    _np = None

__all__ = ["AmbienceRecovery"]


class AmbienceRecovery:
    def __init__(
        self,
        sample_rate: int = 48_000,
        enabled: bool = False,
        freq: float = 3_000.0,
        q: float = 0.7,
        amount: float = 30.0,
        max_amount: float = 150.0,
    ) -> None:
        if not 800.0 <= freq <= 10_000.0:
            raise ValueError("freq must be 0.8–10 kHz")
        if not 0.0 <= amount <= max_amount:
            raise ValueError("amount outside range")
        self.sample_rate = int(sample_rate)
        self.enabled = bool(enabled)
        self.freq = float(freq)
        self.q = max(0.2, float(q))
        self.amount = float(amount)
        self.max_amount = float(max_amount)
        self.reset()

    def reset(self) -> None:
        self._amb = Biquad.bandpass(self.sample_rate, self.freq, self.q)
        self._env = Envelope(self.sample_rate, 10.0, 200.0)
        self.ambience_db = -120.0

    def process_stereo(
        self, left: Sequence[float], right: Sequence[float]
    ) -> tuple[list[float], list[float]]:
        l, r = copy_stereo(left, right)
        if not self.enabled or self.amount <= 0.0:
            return l, r
        gain = self.amount / 100.0
        if _np is not None and len(l) >= 64:
            xl, xr = _np.asarray(l), _np.asarray(r)
            mid = 0.5 * (xl + xr)
            side = 0.5 * (xl - xr)
            amb = _np.asarray(filter_block(self._amb, side.tolist()))
            side = side + amb * gain
            env = self._env
            for value in _np.abs(amb).tolist():
                env.process(value)
            self.ambience_db = level_db(env.value)
            return (mid + side).tolist(), (mid - side).tolist()
        out_l = [0.0] * len(l)
        out_r = [0.0] * len(r)
        for i, (xl, xr) in enumerate(zip(l, r)):
            mid = 0.5 * (xl + xr)
            side = 0.5 * (xl - xr)
            amb = self._amb.process(side)
            side += amb * gain
            out_l[i] = mid + side
            out_r[i] = mid - side
            self._env.process(abs(amb))
        self.ambience_db = level_db(self._env.value)
        return out_l, out_r

    def state(self) -> dict[str, float | bool]:
        return {
            "enabled": self.enabled,
            "freq": self.freq,
            "amount": self.amount,
            "ambience_db": round(self.ambience_db, 2),
        }
