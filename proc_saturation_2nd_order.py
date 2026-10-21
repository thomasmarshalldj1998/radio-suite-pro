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

from proc_accel import filter_block
from proc_dsp import Biquad, clamp, copy_stereo

try:
    import numpy as _np
except ImportError:  # pragma: no cover
    _np = None

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
        drive = self._drive
        amount = self.amount
        trim = self._trim
        mix = self.mix
        drive_l = [x * drive for x in l]
        drive_r = [x * drive for x in r]
        even_l = filter_block(self._dc_l, [x * x for x in drive_l])
        even_r = filter_block(self._dc_r, [x * x for x in drive_r])
        if _np is not None and len(l) >= 64:
            xl, xr = _np.asarray(l), _np.asarray(r)
            el = _np.asarray(even_l) * amount
            er = _np.asarray(even_r) * amount
            wet_l = (_np.asarray(drive_l) + el) * trim
            wet_r = (_np.asarray(drive_r) + er) * trim
            out_l = (xl + (wet_l - xl) * mix).tolist()
            out_r = (xr + (wet_r - xr) * mix).tolist()
            self.harmonic_level = float(max(_np.max(_np.abs(el)), _np.max(_np.abs(er))))
            return out_l, out_r
        out_l = [0.0] * len(l)
        out_r = [0.0] * len(r)
        worst = 0.0
        for i, (xl, xr) in enumerate(zip(l, r)):
            el = even_l[i] * amount
            er = even_r[i] * amount
            wet_l = (drive_l[i] + el) * trim
            wet_r = (drive_r[i] + er) * trim
            out_l[i] = xl + (wet_l - xl) * mix
            out_r[i] = xr + (wet_r - xr) * mix
            worst = max(worst, abs(el), abs(er))
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
