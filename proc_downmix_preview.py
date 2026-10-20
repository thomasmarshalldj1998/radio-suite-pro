"""Downmix preview for mono and difference checks.

The programme is not meant to be broadcast from this stage; it renders a
preview that lets an operator hear the fold-down before committing:

* ``mono``       — (L+R)/2 on both channels;
* ``sum``        — (L+R) (unattenuated);
* ``difference`` — (L−R)/2 on both channels.

Bypass is bit-exact and the default is bypassed.
"""

from __future__ import annotations

import math
from typing import Sequence

from proc_dsp import copy_stereo

__all__ = ["DownmixPreview"]


class DownmixPreview:
    def __init__(
        self,
        sample_rate: int = 48_000,
        enabled: bool = False,
        mode: str = "mono",
        gain_db: float = 0.0,
    ) -> None:
        if mode not in ("mono", "sum", "difference"):
            raise ValueError("mode must be mono, sum or difference")
        if not -24.0 <= gain_db <= 12.0:
            raise ValueError("gain_db must be -24…12 dB")
        self.sample_rate = int(sample_rate)
        self.enabled = bool(enabled)
        self.mode = mode
        self.gain_db = float(gain_db)
        self.preview_db = -120.0

    def reset(self) -> None:
        self.preview_db = -120.0

    def process_stereo(
        self, left: Sequence[float], right: Sequence[float]
    ) -> tuple[list[float], list[float]]:
        l, r = copy_stereo(left, right)
        if not self.enabled:
            return l, r
        gain = 10.0 ** (self.gain_db / 20.0)
        mono = [0.0] * len(l)
        for i, (xl, xr) in enumerate(zip(l, r)):
            if self.mode == "difference":
                value = 0.5 * (xl - xr)
            elif self.mode == "sum":
                value = xl + xr
            else:
                value = 0.5 * (xl + xr)
            mono[i] = value * gain
        peak = max((abs(v) for v in mono), default=0.0)
        self.preview_db = -120.0 if peak <= 0.0 else 20.0 * math.log10(peak)
        return mono, list(mono)

    def state(self) -> dict[str, float | bool | str]:
        return {
            "enabled": self.enabled,
            "mode": self.mode,
            "gain_db": self.gain_db,
            "preview_db": round(self.preview_db, 2),
        }
