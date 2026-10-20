"""Three-band downward compressor.

The programme is split at 200 Hz and 2 kHz, each band is compressed with its
own threshold/ratio/time constants, and the bands are summed. Splitting is
complementary: ``low + mid + high`` reconstructs the input before compression,
so bypass and the unity-gain case are transparent.

Defaults are bypassed. Per-band gain reduction is reported in ``state()``.
"""

from __future__ import annotations

from typing import Sequence

from proc_dsp import Biquad, copy_stereo
from proc_downward_compressor import DownwardCompressor

__all__ = ["MultibandCompressor"]


class MultibandCompressor:
    def __init__(
        self,
        sample_rate: int = 48_000,
        enabled: bool = False,
        crossover_hz: tuple[float, float] = (200.0, 2_000.0),
        thresholds_db: tuple[float, float, float] = (-24.0, -20.0, -18.0),
        ratios: tuple[float, float, float] = (2.5, 2.0, 1.8),
        attack_ms: tuple[float, float, float] = (20.0, 12.0, 6.0),
        release_ms: tuple[float, float, float] = (250.0, 180.0, 100.0),
        makeup_db: tuple[float, float, float] = (0.0, 0.0, 0.0),
    ) -> None:
        if not 20.0 < crossover_hz[0] < crossover_hz[1] < sample_rate * 0.45:
            raise ValueError("crossovers must be ordered and below Nyquist")
        self.sample_rate = int(sample_rate)
        self.enabled = bool(enabled)
        self.crossover_hz = (float(crossover_hz[0]), float(crossover_hz[1]))
        self.thresholds_db = tuple(float(x) for x in thresholds_db)
        self.ratios = tuple(float(x) for x in ratios)
        self.attack_ms = tuple(float(x) for x in attack_ms)
        self.release_ms = tuple(float(x) for x in release_ms)
        self.makeup_db = tuple(float(x) for x in makeup_db)
        if len(self.thresholds_db) != 3:
            raise ValueError("expected three thresholds")
        self.reset()

    def reset(self) -> None:
        fs = self.sample_rate
        self._low_l = Biquad.lowpass(fs, self.crossover_hz[0])
        self._low_r = Biquad.lowpass(fs, self.crossover_hz[0])
        self._mid_l = Biquad.lowpass(fs, self.crossover_hz[1])
        self._mid_r = Biquad.lowpass(fs, self.crossover_hz[1])
        self._bands = [
            DownwardCompressor(
                fs,
                enabled=True,
                threshold_db=self.thresholds_db[i],
                ratio=self.ratios[i],
                attack_ms=self.attack_ms[i],
                release_ms=self.release_ms[i],
                knee_db=6.0,
                makeup_db=self.makeup_db[i],
            )
            for i in range(3)
        ]

    def process_stereo(
        self, left: Sequence[float], right: Sequence[float]
    ) -> tuple[list[float], list[float]]:
        l, r = copy_stereo(left, right)
        if not self.enabled:
            return l, r
        n = len(l)
        low_l, low_r = [0.0] * n, [0.0] * n
        mid_l, mid_r = [0.0] * n, [0.0] * n
        high_l, high_r = [0.0] * n, [0.0] * n
        for i, (xl, xr) in enumerate(zip(l, r)):
            low = self._low_l.process(xl)
            low2 = self._low_r.process(xr)
            mid = self._mid_l.process(xl) - low
            mid2 = self._mid_r.process(xr) - low2
            low_l[i], low_r[i] = low, low2
            mid_l[i], mid_r[i] = mid, mid2
            high_l[i], high_r[i] = xl - low - mid, xr - low2 - mid2
        low_l, low_r = self._bands[0].process_stereo(low_l, low_r)
        mid_l, mid_r = self._bands[1].process_stereo(mid_l, mid_r)
        high_l, high_r = self._bands[2].process_stereo(high_l, high_r)
        return (
            [a + b + c for a, b, c in zip(low_l, mid_l, high_l)],
            [a + b + c for a, b, c in zip(low_r, mid_r, high_r)],
        )

    def state(self) -> dict[str, object]:
        return {
            "enabled": self.enabled,
            "crossover_hz": list(self.crossover_hz),
            "gain_reduction_db": [
                round(band.gain_reduction_db, 2) for band in self._bands
            ],
        }
