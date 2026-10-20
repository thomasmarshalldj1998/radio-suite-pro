"""Air-band brilliance: high shelf plus restrained HF harmonics.

The shelf opens the top octave; a small amount of soft saturation on the high
band adds harmonics that survive codec low-pass filtering. Drive is deliberately
low (0–4) so the result stays clean on dense programme.

Bypass is exact and the default is bypassed.
"""

from __future__ import annotations

from typing import Sequence

from proc_dsp import Biquad, clamp, copy_stereo, soft_clip

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
        out_l = [0.0] * len(l)
        out_r = [0.0] * len(r)
        drive = 1.0 + self.drive
        for i, (xl, xr) in enumerate(zip(l, r)):
            sl = self._shelf_l.process(xl)
            sr = self._shelf_r.process(xr)
            hl = self._hp_l.process(sl)
            hr = self._hp_r.process(sr)
            sat_l = soft_clip(hl, drive)
            sat_r = soft_clip(hr, drive)
            out_l[i] = sl + (sat_l - hl) * self.mix
            out_r[i] = sr + (sat_r - hr) * self.mix
            self.harmonic_amount = max(
                self.harmonic_amount,
                abs(sat_l - hl),
                abs(sat_r - hr),
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
