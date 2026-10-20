"""Six-band parametric EQ.

Six RBJ peaking filters at fixed musical centres, with per-band gain and Q.
The default frequencies cover sub, bass, low-mid, mid, presence and air. Gains
are bounded to ±18 dB; all-zero gain is bypassed exactly.

    bands = ((60, 0.8, 0), (150, 1.0, 0), (400, 1.0, 0),
             (1000, 1.0, 0), (3000, 1.0, 0), (8000, 1.0, 0))
"""

from __future__ import annotations

from typing import Sequence

from proc_dsp import Biquad, clamp, copy_stereo, peaking

__all__ = ["ParametricEq6Band", "ParametricEQ6Band", "BANDS"]

BANDS = (
    (60.0, 0.8),
    (150.0, 1.0),
    (400.0, 1.0),
    (1_000.0, 1.0),
    (3_000.0, 1.0),
    (8_000.0, 1.0),
)


class ParametricEq6Band:
    def __init__(
        self,
        sample_rate: int = 48_000,
        enabled: bool = False,
        gains_db: Sequence[float] = (0.0, 0.0, 0.0, 0.0, 0.0, 0.0),
        bands: Sequence[tuple[float, float]] = BANDS,
    ) -> None:
        if len(gains_db) != 6 or len(bands) != 6:
            raise ValueError("expected six gains and six bands")
        if any(not 20.0 <= f < sample_rate * 0.45 for f, _ in bands):
            raise ValueError("band frequencies must be in range")
        self.sample_rate = int(sample_rate)
        self.enabled = bool(enabled)
        self.bands = tuple((float(f), float(q)) for f, q in bands)
        self.gains_db = tuple(clamp(float(g), -18.0, 18.0) for g in gains_db)
        self.reset()

    def reset(self) -> None:
        fs = self.sample_rate
        self._filters_l: list[Biquad] = [
            peaking(fs, f, q, g) for (f, q), g in zip(self.bands, self.gains_db)
        ]
        self._filters_r: list[Biquad] = [
            peaking(fs, f, q, g) for (f, q), g in zip(self.bands, self.gains_db)
        ]

    def process_stereo(
        self, left: Sequence[float], right: Sequence[float]
    ) -> tuple[list[float], list[float]]:
        l, r = copy_stereo(left, right)
        if not self.enabled or all(abs(g) < 1e-9 for g in self.gains_db):
            return l, r
        out_l = [0.0] * len(l)
        out_r = [0.0] * len(r)
        for i, (xl, xr) in enumerate(zip(l, r)):
            yl, yr = xl, xr
            for fl, fr in zip(self._filters_l, self._filters_r):
                yl = fl.process(yl)
                yr = fr.process(yr)
            out_l[i], out_r[i] = yl, yr
        return out_l, out_r

    def state(self) -> dict[str, object]:
        return {
            "enabled": self.enabled,
            "bands": [list(b) for b in self.bands],
            "gains_db": list(self.gains_db),
        }


ParametricEQ6Band = ParametricEq6Band
