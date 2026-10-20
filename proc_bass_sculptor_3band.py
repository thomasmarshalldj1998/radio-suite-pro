"""Three-band bass sculptor.

The low end is split into sub (<60 Hz), punch (60–150 Hz) and warmth
(150–400 Hz) with complementary low-pass residuals. Each band gets an
independent gain; the rest of the spectrum is untouched.

    sub     = LP60(x)
    punch   = LP150(x) − sub
    warmth  = LP400(x) − LP150(x)
    out     = x + sub(g_sub−1) + punch(g_punch−1) + warmth(g_warm−1)
"""

from __future__ import annotations

from typing import Sequence

from proc_dsp import Biquad, clamp, copy_stereo

__all__ = ["BassSculptor3Band"]


class BassSculptor3Band:
    def __init__(
        self,
        sample_rate: int = 48_000,
        enabled: bool = False,
        sub_db: float = 0.0,
        punch_db: float = 0.0,
        warmth_db: float = 0.0,
    ) -> None:
        if any(not -18.0 <= g <= 18.0 for g in (sub_db, punch_db, warmth_db)):
            raise ValueError("bass gains must be -18…18 dB")
        self.sample_rate = int(sample_rate)
        self.enabled = bool(enabled)
        self.sub_db = float(sub_db)
        self.punch_db = float(punch_db)
        self.warmth_db = float(warmth_db)
        self.reset()

    def reset(self) -> None:
        fs = self.sample_rate
        self._lp60_l = Biquad.lowpass(fs, 60.0)
        self._lp60_r = Biquad.lowpass(fs, 60.0)
        self._lp150_l = Biquad.lowpass(fs, 150.0)
        self._lp150_r = Biquad.lowpass(fs, 150.0)
        self._lp400_l = Biquad.lowpass(fs, 400.0)
        self._lp400_r = Biquad.lowpass(fs, 400.0)

    def process_stereo(
        self, left: Sequence[float], right: Sequence[float]
    ) -> tuple[list[float], list[float]]:
        l, r = copy_stereo(left, right)
        if not self.enabled or (
            self.sub_db == 0.0 and self.punch_db == 0.0 and self.warmth_db == 0.0
        ):
            return l, r
        out_l = [0.0] * len(l)
        out_r = [0.0] * len(r)
        gs = 10.0 ** (self.sub_db / 20.0)
        gp = 10.0 ** (self.punch_db / 20.0)
        gw = 10.0 ** (self.warmth_db / 20.0)
        for i, (xl, xr) in enumerate(zip(l, r)):
            sub = self._lp60_l.process(xl)
            sub2 = self._lp60_r.process(xr)
            low150 = self._lp150_l.process(xl)
            low150_2 = self._lp150_r.process(xr)
            low400 = self._lp400_l.process(xl)
            low400_2 = self._lp400_r.process(xr)
            punch = low150 - sub
            punch2 = low150_2 - sub2
            warmth = low400 - low150
            warmth2 = low400_2 - low150_2
            out_l[i] = xl + sub * (gs - 1.0) + punch * (gp - 1.0) + warmth * (gw - 1.0)
            out_r[i] = xr + sub2 * (gs - 1.0) + punch2 * (gp - 1.0) + warmth2 * (gw - 1.0)
        return out_l, out_r

    def state(self) -> dict[str, float | bool]:
        return {
            "enabled": self.enabled,
            "sub_db": self.sub_db,
            "punch_db": self.punch_db,
            "warmth_db": self.warmth_db,
            "crossover_hz": [60.0, 150.0, 400.0],
        }
