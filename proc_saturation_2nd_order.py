"""Second-order (even-harmonic) saturation.

A squared term generates the even harmonics that add warmth and body. DC is
removed from the squared signal so the stage does not shift the programme
offset. A dry/wet mix and output trim keep the level under control.

    driven = x × 10^(drive/20)
    even   = highpass(driven², 20 Hz)
    out    = driven + even × amount
"""

from __future__ import annotations

import math
from typing import Sequence

from proc_dsp import Biquad, clamp, copy_stereo

__all__ = ["SecondOrderSaturation", "Saturation2ndOrder"]


class SecondOrderSaturation:
    def __init__(
        self,
        sample_rate: int = 48_000,
        enabled: bool = False,
        drive_db: float = 6.0,
        amount: float = 0.25,
        mix: float = 1.0,
        output_db: float = 0.0,
    ) -> None:
        if not 0.0 <= drive_db <= 24.0:
            raise ValueError("drive_db must be 0–24 dB")
        if not 0.0 <= amount <= 1.0:
            raise ValueError("amount must be 0–1")
        self.sample_rate = int(sample_rate)
        self.enabled = bool(enabled)
        self.drive_db = float(drive_db)
        self.amount = float(amount)
        self.mix = float(clamp(mix, 0.0, 1.0))
        self.output_db = float(clamp(output_db, -12.0, 12.0))
        self.reset()

    def reset(self) -> None:
        fs = self.sample_rate
        self._dc_l = Biquad.highpass(fs, 20.0)
        self._dc_r = Biquad.highpass(fs, 20.0)
        self._drive = 10.0 ** (self.drive_db / 20.0)
        self._trim = 10.0 ** (self.output_db / 20.0)
        self.harmonic_level = 0.0

    def process_stereo(
        self, left: Sequence[float], right: Sequence[float]
    ) -> tuple[list[float], list[float]]:
        l, r = copy_stereo(left, right)
        if not self.enabled or self.mix <= 0.0 or self.drive_db == 0.0:
            return l, r
        out_l = [0.0] * len(l)
        out_r = [0.0] * len(r)
        worst = 0.0
        for i, (xl, xr) in enumerate(zip(l, r)):
            dl = xl * self._drive
            dr = xr * self._drive
            even_l = self._dc_l.process(dl * dl) * self.amount
            even_r = self._dc_r.process(dr * dr) * self.amount
            wet_l = (dl + even_l) * self._trim
            wet_r = (dr + even_r) * self._trim
            out_l[i] = xl + (wet_l - xl) * self.mix
            out_r[i] = xr + (wet_r - xr) * self.mix
            worst = max(worst, abs(even_l), abs(even_r))
        self.harmonic_level = worst
        return out_l, out_r

    def state(self) -> dict[str, float | bool]:
        return {
            "enabled": self.enabled,
            "drive_db": self.drive_db,
            "amount": self.amount,
            "mix": self.mix,
            "harmonic_level": round(self.harmonic_level, 5),
        }


Saturation2ndOrder = SecondOrderSaturation
