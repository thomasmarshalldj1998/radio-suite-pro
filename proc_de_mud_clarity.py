"""De-mud and clarity shaping.

Two complementary moves: a cut in the 200–500 Hz mud region and a presence lift
around 2–4 kHz. The mud cut is level-aware — it deepens only when the mud band
actually carries energy — so the low-mid does not hollow out on thin material.

    mud      = bandpass(x, mud_hz)
    presence = bandpass(x, clarity_hz)
    out      = x + mud × (g_mud − 1) + presence × (g_presence − 1)
"""

from __future__ import annotations

import math
from typing import Sequence

from proc_dsp import Biquad, Envelope, clamp, copy_stereo, level_db

__all__ = ["DeMudClarity"]


class DeMudClarity:
    def __init__(
        self,
        sample_rate: int = 48_000,
        enabled: bool = False,
        mud_hz: float = 320.0,
        mud_cut_db: float = -3.0,
        clarity_hz: float = 2_500.0,
        clarity_db: float = 2.0,
        dynamic: bool = True,
    ) -> None:
        if not 150.0 <= mud_hz <= 600.0:
            raise ValueError("mud_hz must be 150–600 Hz")
        if not 1_500.0 <= clarity_hz <= 5_000.0:
            raise ValueError("clarity_hz must be 1.5–5 kHz")
        if not -12.0 <= mud_cut_db <= 0.0 or not 0.0 <= clarity_db <= 12.0:
            raise ValueError("cut/boost outside range")
        self.sample_rate = int(sample_rate)
        self.enabled = bool(enabled)
        self.mud_hz = float(mud_hz)
        self.mud_cut_db = float(mud_cut_db)
        self.clarity_hz = float(clarity_hz)
        self.clarity_db = float(clarity_db)
        self.dynamic = bool(dynamic)
        self.reset()

    def reset(self) -> None:
        fs = self.sample_rate
        self._mud_l = Biquad.bandpass(fs, self.mud_hz, 1.2)
        self._mud_r = Biquad.bandpass(fs, self.mud_hz, 1.2)
        self._pres_l = Biquad.bandpass(fs, self.clarity_hz, 0.9)
        self._pres_r = Biquad.bandpass(fs, self.clarity_hz, 0.9)
        self._env = Envelope(fs, 20.0, 300.0)
        self.mud_gain_db = self.mud_cut_db
        self.clarity_gain_db = self.clarity_db

    def process_stereo(
        self, left: Sequence[float], right: Sequence[float]
    ) -> tuple[list[float], list[float]]:
        l, r = copy_stereo(left, right)
        if not self.enabled or (self.mud_cut_db == 0.0 and self.clarity_db == 0.0):
            return l, r
        out_l = [0.0] * len(l)
        out_r = [0.0] * len(r)
        mud_gain = 10.0 ** (self.mud_cut_db / 20.0)
        clarity_gain = 10.0 ** (self.clarity_db / 20.0)
        for i, (xl, xr) in enumerate(zip(l, r)):
            mud = 0.5 * (self._mud_l.process(xl) + self._mud_r.process(xr))
            pres = 0.5 * (self._pres_l.process(xl) + self._pres_r.process(xr))
            env = self._env.process(abs(mud))
            if self.dynamic:
                # Only apply the full cut when the mud band is actually busy.
                activity = clamp((level_db(env) + 48.0) / 24.0, 0.15, 1.0)
                mud_gain = 10.0 ** (self.mud_cut_db * activity / 20.0)
            out_l[i] = xl + mud * (mud_gain - 1.0) + pres * (clarity_gain - 1.0)
            out_r[i] = xr + mud * (mud_gain - 1.0) + pres * (clarity_gain - 1.0)
        self.mud_gain_db = 20.0 * math.log10(max(mud_gain, 1e-9))
        self.clarity_gain_db = self.clarity_db
        return out_l, out_r

    def state(self) -> dict[str, float | bool]:
        return {
            "enabled": self.enabled,
            "mud_hz": self.mud_hz,
            "mud_gain_db": round(self.mud_gain_db, 2),
            "clarity_hz": self.clarity_hz,
            "clarity_gain_db": round(self.clarity_gain_db, 2),
        }
