"""Three-band downward compressor.

The programme is split at 200 Hz and 2 kHz, each band is compressed with its
own threshold/ratio/time constants, and the bands are summed. Splitting is
complementary: ``low + mid + high`` reconstructs the input before compression,
so bypass and the unity-gain case are transparent.

Defaults are bypassed. Per-band gain reduction is reported in ``state()``.
"""

from __future__ import annotations

from typing import Sequence

from proc_accel import filter_block
from proc_dsp import Biquad, copy_stereo
from proc_downward_compressor import DownwardCompressor

try:
    import numpy as _np
except ImportError:  # pragma: no cover
    _np = None

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
        low_l = filter_block(self._low_l, l)
        low_r = filter_block(self._low_r, r)
        mid_lp_l = filter_block(self._mid_l, l)
        mid_lp_r = filter_block(self._mid_r, r)
        if _np is not None and n >= 64:
            ll, lr = _np.asarray(low_l), _np.asarray(low_r)
            ml, mr = _np.asarray(mid_lp_l) - ll, _np.asarray(mid_lp_r) - lr
            hl = _np.asarray(l) - ll - ml
            hr = _np.asarray(r) - lr - mr
            low_l, low_r = ll.tolist(), lr.tolist()
            mid_l, mid_r = ml.tolist(), mr.tolist()
            high_l, high_r = hl.tolist(), hr.tolist()
        else:
            mid_l, mid_r = [0.0] * n, [0.0] * n
            high_l, high_r = [0.0] * n, [0.0] * n
            for i, (xl, xr) in enumerate(zip(l, r)):
                mid = mid_lp_l[i] - low_l[i]
                mid2 = mid_lp_r[i] - low_r[i]
                mid_l[i], mid_r[i] = mid, mid2
                high_l[i], high_r[i] = xl - low_l[i] - mid, xr - low_r[i] - mid2
        low_l, low_r = self._bands[0].process_stereo(low_l, low_r)
        mid_l, mid_r = self._bands[1].process_stereo(mid_l, mid_r)
        high_l, high_r = self._bands[2].process_stereo(high_l, high_r)
        if _np is not None and n >= 64:
            return (
                (_np.asarray(low_l) + _np.asarray(mid_l) + _np.asarray(high_l)).tolist(),
                (_np.asarray(low_r) + _np.asarray(mid_r) + _np.asarray(high_r)).tolist(),
            )
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
