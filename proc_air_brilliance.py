"""Air-band brilliance: high shelf plus restrained HF harmonics.

The shelf opens the top octave; a small amount of soft saturation on the high
band adds harmonics that survive codec low-pass filtering. Drive is deliberately
low (0–4) so the result stays clean on dense programme.

Bypass is exact and the default is bypassed.
"""

from __future__ import annotations

import math
from typing import Sequence

from proc_accel import filter_block, filter_block_array
from proc_dsp import Biquad, clamp, copy_stereo, soft_clip

try:
    import numpy as _np
except ImportError:  # pragma: no cover
    _np = None

__all__ = ["AirBrilliance"]


class AirBrilliance:
    def __init__(
        self,
        sample_rate: int = 48_000,
        enabled: bool = False,
        air_hz: float = 10_000.0,
        air_db: float = 3.0,
        drive: float = 0.8,
        mix: float = 1.0,
    ) -> None:
        if not 6_000.0 <= air_hz <= 16_000.0:
            raise ValueError("air_hz must be 6–16 kHz")
        if not -6.0 <= air_db <= 12.0:
            raise ValueError("air_db must be -6…12 dB")
        if not 0.0 <= drive <= 4.0:
            raise ValueError("drive must be 0–4")
        self.sample_rate = int(sample_rate)
        self.enabled = bool(enabled)
        self.air_hz = min(float(air_hz), sample_rate * 0.45)
        self.air_db = float(air_db)
        self.drive = float(drive)
        self.mix = float(clamp(mix, 0.0, 1.0))
        self.reset()

    def reset(self) -> None:
        fs = self.sample_rate
        self._shelf_l = Biquad.high_shelf(fs, self.air_hz, self.air_db)
        self._shelf_r = Biquad.high_shelf(fs, self.air_hz, self.air_db)
        self._hp_l = Biquad.highpass(fs, min(self.air_hz * 0.7, fs * 0.45))
        self._hp_r = Biquad.highpass(fs, min(self.air_hz * 0.7, fs * 0.45))
        self.harmonic_amount = 0.0

    def process_stereo(
        self, left: Sequence[float], right: Sequence[float]
    ) -> tuple[list[float], list[float]]:
        l, r = copy_stereo(left, right)
        if not self.enabled or (self.air_db == 0.0 and self.drive == 0.0):
            return l, r
        drive = 1.0 + self.drive
        if _np is not None and len(l) >= 64:
            sl_a = filter_block_array(self._shelf_l, l)
            sr_a = filter_block_array(self._shelf_r, r)
            if sl_a is not None and sr_a is not None:
                hl_a = filter_block_array(self._hp_l, sl_a)
                hr_a = filter_block_array(self._hp_r, sr_a)
                if hl_a is not None and hr_a is not None:
                    denom = max(math.tanh(drive), 1e-9)
                    sat_l = _np.clip(_np.tanh(hl_a * drive) / denom, -1.0, 1.0)
                    sat_r = _np.clip(_np.tanh(hr_a * drive) / denom, -1.0, 1.0)
                    self.harmonic_amount = max(
                        self.harmonic_amount,
                        float(_np.max(_np.abs(sat_l - hl_a))),
                        float(_np.max(_np.abs(sat_r - hr_a))),
                    )
                    return (
                        (sl_a + (sat_l - hl_a) * self.mix).tolist(),
                        (sr_a + (sat_r - hr_a) * self.mix).tolist(),
                    )
        sl = filter_block(self._shelf_l, l)
        sr = filter_block(self._shelf_r, r)
        hl = filter_block(self._hp_l, sl)
        hr = filter_block(self._hp_r, sr)
        if _np is not None and len(hl) >= 64:
            denom = max(math.tanh(drive), 1e-9)
            sat_l = _np.clip(_np.tanh(_np.asarray(hl) * drive) / denom, -1.0, 1.0)
            sat_r = _np.clip(_np.tanh(_np.asarray(hr) * drive) / denom, -1.0, 1.0)
            out_l = (_np.asarray(sl) + (sat_l - _np.asarray(hl)) * self.mix).tolist()
            out_r = (_np.asarray(sr) + (sat_r - _np.asarray(hr)) * self.mix).tolist()
            self.harmonic_amount = max(
                self.harmonic_amount,
                float(_np.max(_np.abs(sat_l - _np.asarray(hl)))),
                float(_np.max(_np.abs(sat_r - _np.asarray(hr)))),
            )
        else:
            out_l, out_r = [], []
            for a, b, aa, bb in zip(sl, hl, sr, hr):
                sat_l = soft_clip(b, drive)
                sat_r = soft_clip(bb, drive)
                out_l.append(a + (sat_l - b) * self.mix)
                out_r.append(aa + (sat_r - bb) * self.mix)
                self.harmonic_amount = max(
                    self.harmonic_amount,
                    abs(sat_l - b),
                    abs(sat_r - bb),
                )
        return out_l, out_r

    def state(self) -> dict[str, float | bool]:
        return {
            "enabled": self.enabled,
            "air_hz": self.air_hz,
            "air_db": self.air_db,
            "drive": self.drive,
            "harmonic_amount": round(self.harmonic_amount, 5),
        }
