"""Vocal presence isolation in the mid channel.

Lead vocals and speech are usually centre-panned. A band-limited lift on the
mid signal adds intelligibility without lifting the whole mix, while reducing
the same band on the side signal keeps the centre focused.

    mid = (L + R) / 2, side = (L − R) / 2
    mid = mid + presence × (g − 1)
    side = side × side_gain
    L = mid + side, R = mid − side
"""

from __future__ import annotations

import math
from typing import Sequence

from proc_dsp import Biquad, clamp, copy_stereo

__all__ = ["VocalPresenceIsolate"]


class VocalPresenceIsolate:
    def __init__(
        self,
        sample_rate: int = 48_000,
        enabled: bool = False,
        presence_hz: float = 2_500.0,
        q: float = 0.8,
        presence_db: float = 3.0,
        side_reduction_db: float = -3.0,
    ) -> None:
        if not 800.0 <= presence_hz <= 5_000.0:
            raise ValueError("presence_hz must be 0.8–5 kHz")
        if not 0.0 <= presence_db <= 12.0:
            raise ValueError("presence_db must be 0–12 dB")
        if not -12.0 <= side_reduction_db <= 0.0:
            raise ValueError("side_reduction_db must be -12…0 dB")
        self.sample_rate = int(sample_rate)
        self.enabled = bool(enabled)
        self.presence_hz = float(presence_hz)
        self.q = max(0.2, float(q))
        self.presence_db = float(presence_db)
        self.side_reduction_db = float(side_reduction_db)
        self.reset()

    def reset(self) -> None:
        fs = self.sample_rate
        self._pres = Biquad.bandpass(fs, self.presence_hz, self.q)
        self.side_gain = 10.0 ** (self.side_reduction_db / 20.0)
        self.presence_gain = 10.0 ** (self.presence_db / 20.0)

    def process_stereo(
        self, left: Sequence[float], right: Sequence[float]
    ) -> tuple[list[float], list[float]]:
        l, r = copy_stereo(left, right)
        if not self.enabled or (self.presence_db == 0.0 and self.side_reduction_db == 0.0):
            return l, r
        out_l = [0.0] * len(l)
        out_r = [0.0] * len(r)
        for i, (xl, xr) in enumerate(zip(l, r)):
            mid = 0.5 * (xl + xr)
            side = 0.5 * (xl - xr)
            presence = self._pres.process(mid)
            mid = mid + presence * (self.presence_gain - 1.0)
            side *= self.side_gain
            out_l[i] = mid + side
            out_r[i] = mid - side
        return out_l, out_r

    def state(self) -> dict[str, float | bool]:
        return {
            "enabled": self.enabled,
            "presence_hz": self.presence_hz,
            "presence_db": self.presence_db,
            "side_reduction_db": self.side_reduction_db,
        }
