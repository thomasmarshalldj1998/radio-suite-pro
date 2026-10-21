"""Tape character without a tape machine.

Three behaviours are modelled in series:

* a softly saturating record/playback transfer (tanh),
* the low-frequency head bump around 60 Hz,
* the gentle high-frequency loss of tape and its playback head.

The stage is intentionally subtle. Bypass is exact and default is bypassed.
"""

from __future__ import annotations

import math
from typing import Sequence

from proc_accel import filter_block
from proc_dsp import Biquad, clamp, copy_stereo, low_shelf, soft_clip

try:
    import numpy as _np
except ImportError:  # pragma: no cover
    _np = None

__all__ = ["TapeEmulation"]


class TapeEmulation:
    def __init__(
        self,
        sample_rate: int = 48_000,
        enabled: bool = False,
        drive: float = 1.3,
        head_bump_db: float = 1.5,
        hf_hz: float = 14_000.0,
        mix: float = 1.0,
    ) -> None:
        if not 1.0 <= drive <= 6.0:
            raise ValueError("drive must be 1–6")
        if not -6.0 <= head_bump_db <= 6.0:
            raise ValueError("head_bump_db must be -6…6 dB")
        if not 4_000.0 <= hf_hz <= sample_rate * 0.48:
            raise ValueError("hf_hz outside range")
        self.sample_rate = int(sample_rate)
        self.enabled = bool(enabled)
        self.drive = float(drive)
        self.head_bump_db = float(head_bump_db)
        self.hf_hz = float(hf_hz)
        self.mix = float(clamp(mix, 0.0, 1.0))
        self.reset()

    def reset(self) -> None:
        fs = self.sample_rate
        self._bump_l = low_shelf(fs, 60.0, self.head_bump_db)
        self._bump_r = low_shelf(fs, 60.0, self.head_bump_db)
        self._hf_l = Biquad.lowpass(fs, self.hf_hz, 0.7)
        self._hf_r = Biquad.lowpass(fs, self.hf_hz, 0.7)
        self._gain = 1.0
        self.harmonic_level = 0.0

    def process_stereo(
        self, left: Sequence[float], right: Sequence[float]
    ) -> tuple[list[float], list[float]]:
        l, r = copy_stereo(left, right)
        if not self.enabled or self.mix <= 0.0:
            return l, r
        drive_norm = max(math.tanh(self.drive), 1e-9)
        if _np is not None and len(l) >= 64:
            left = _np.asarray(l, dtype=_np.float64)
            right = _np.asarray(r, dtype=_np.float64)
            sl = _np.clip(_np.tanh(left * self.drive) / drive_norm, -1.0, 1.0)
            sr = _np.clip(_np.tanh(right * self.drive) / drive_norm, -1.0, 1.0)
            bl = filter_block(self._bump_l, sl.tolist())
            br = filter_block(self._bump_r, sr.tolist())
            yl = _np.asarray(filter_block(self._hf_l, bl)) * drive_norm
            yr = _np.asarray(filter_block(self._hf_r, br)) * drive_norm
            out_l = (left + (yl - left) * self.mix).tolist()
            out_r = (right + (yr - right) * self.mix).tolist()
            self.harmonic_level = float(max(_np.max(_np.abs(yl - left)), _np.max(_np.abs(yr - right))))
            return out_l, out_r
        out_l = [0.0] * len(l)
        out_r = [0.0] * len(r)
        worst = 0.0
        for i, (xl, xr) in enumerate(zip(l, r)):
            sl = soft_clip(xl, self.drive)
            sr = soft_clip(xr, self.drive)
            bl = self._bump_l.process(sl)
            br = self._bump_r.process(sr)
            yl = self._hf_l.process(bl) * drive_norm
            yr = self._hf_r.process(br) * drive_norm
            out_l[i] = xl + (yl - xl) * self.mix
            out_r[i] = xr + (yr - xr) * self.mix
            worst = max(worst, abs(yl - xl), abs(yr - xr))
        self.harmonic_level = worst
        return out_l, out_r

    def state(self) -> dict[str, float | bool]:
        return {
            "enabled": self.enabled,
            "drive": self.drive,
            "head_bump_db": self.head_bump_db,
            "hf_hz": self.hf_hz,
            "character": round(self.harmonic_level, 5),
        }
