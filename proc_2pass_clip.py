"""Two-pass clipping stage (SignalPath v3.1, module B5).

Pass 1 is a true-peak limiter: a 16× windowed-sinc interpolator finds the peak
*between* samples, and the gain envelope is applied to audio delayed by the look-
ahead window, so the ceiling holds for the reconstructed waveform and not only
for the sample grid.

Pass 2 is even-order harmonic saturation: the squared signal (DC removed) is
blended back at 0–15 % in Clean / Warm / Bold voicings. It is off by default;
pass 1 is on by default, as specified.

This is the only module in the suite that starts enabled — a −0.5 dBTP ceiling
that replaces nothing and is the safety net. Pass 2 stays off.
"""

from __future__ import annotations

import math
from typing import Sequence

from proc_accel import filter_block_array, limiter_gain_loop
from stream_encoder_core import Biquad, clamp

try:  # optional acceleration; the stdlib path remains the reference
    import numpy as _np
    from scipy.ndimage import maximum_filter1d as _maximum_filter1d
except ImportError:  # pragma: no cover - exercised on hosts without numpy
    _np = None
    _maximum_filter1d = None

OVERSAMPLE = 16
CEILINGS = (-0.1, -0.5, -1.0)
MODES = ("clean", "warm", "bold")
_MODE_DRIVE = {"clean": 0.5, "warm": 0.8, "bold": 1.2}
_TAPS = 12          # one-sided; 24 coefficients per phase
_PHASES = OVERSAMPLE


def _kaiser(n: int, beta: float) -> list[float]:
    """Kaiser window (I0 series — no numpy in this tree)."""
    denom = _i0(beta)
    return [
        _i0(beta * math.sqrt(max(0.0, 1.0 - (2.0 * i / (n - 1) - 1.0) ** 2))) / denom
        for i in range(n)
    ]


def _i0(x: float) -> float:
    total = 1.0
    term = 1.0
    for k in range(1, 32):
        term *= (x / (2.0 * k)) ** 2
        total += term
        if term < 1e-12 * total:
            break
    return total


def _sinc(x: float) -> float:
    if abs(x) < 1e-12:
        return 1.0
    return math.sin(math.pi * x) / (math.pi * x)


def _build_table(taps: int = _TAPS, phases: int = _PHASES) -> list[list[float]]:
    """Kernels for fractional delays d = p/phases, p = 0…phases−1.

    Coefficients are indexed k = 0…2·taps−1 backwards from the interpolation
    point, so only already-arrived samples are needed.
    """
    table: list[list[float]] = []
    for p in range(phases):
        d = p / phases
        coeffs = []
        for k in range(2 * taps):
            # Centre the kernel on k = taps: d = 0 must reproduce the input
            # sample exactly, otherwise the interpolator attenuates HF.
            offset = k - taps - d
            window = 0.5 + 0.5 * math.cos(math.pi * offset / taps) if abs(offset) <= taps else 0.0
            coeffs.append(_sinc(offset) * window)
        total = sum(coeffs)
        table.append([c / total for c in coeffs])
    return table


_COEFFS = _build_table()

# One float64 view of each kernel, built once: the convolutions run per block.
_COEFF_ARRAYS = (
    [_np.asarray(row, dtype=_np.float64) for row in _COEFFS]
    if _np is not None
    else None
)


def true_peak(samples: Sequence[float], phases: int = _PHASES) -> float:
    """Maximum |x| over the reconstructed waveform, using the whole block."""
    xs = [float(x) for x in samples]
    if not xs:
        return 0.0
    return max(_peak_curve(xs, phases))


def _peak_curve(samples: Sequence[float], phases: int = _PHASES):
    """Per-sample true-peak magnitude (same kernel as `true_peak`).

    The reference implementation is a sample × phase × tap loop. For blocks
    of meaningful size it is equivalent to 15 causal FIR convolutions, so the
    optional NumPy path runs those in C and keeps the Python path as the
    fallback on hosts without NumPy. Kernels and alignment are unchanged.
    The NumPy path returns an ``ndarray`` so callers can fuse further maths
    without list round-trips.
    """
    n = len(samples)
    if n == 0:
        return []
    if _np is not None and n >= 64:
        values = _np.asarray(samples, dtype=_np.float64)
        curve = _np.abs(values)
        for p in range(1, min(phases, _PHASES)):
            # np.convolve(x, c)[i] = Σ x[i-k]·c[k], exactly the causal
            # interpolation kernel used by the reference loop.
            phase = _np.convolve(values, _COEFF_ARRAYS[p], mode="full")[:n]
            _np.maximum(curve, _np.abs(phase), out=curve)
        return curve
    xs = [float(x) for x in samples]
    curve = [0.0] * n
    for i in range(n):
        peak = abs(xs[i])
        for p in range(1, phases):
            coeffs = _COEFFS[p]
            acc = 0.0
            for k, c in enumerate(coeffs):
                idx = i - k
                if idx < 0:
                    if k > _TAPS:
                        break
                    continue
                acc += xs[idx] * c
            if abs(acc) > peak:
                peak = abs(acc)
        curve[i] = peak
    return curve


class _PeakLimiter:
    def __init__(
        self,
        ceiling_db: float,
        lookahead_ms: float = 2.0,
        release_ms: float = 60.0,
        sample_rate: int = 48_000,
    ) -> None:
        self.ceiling_db = ceiling_db
        self.ceiling = 10.0 ** (ceiling_db / 20.0)
        # How far around a sample the limiter looks for the largest
        # reconstructed peak; this is detector context, not audio delay.
        self.radius = max(_TAPS, int(round(lookahead_ms * sample_rate / 1000.0)))
        self.release = 1.0 - math.exp(-1.0 / max(1.0, release_ms * sample_rate / 1000.0))
        self.gain = 1.0
        self.reduction_db = 0.0
        # Hold the gain across one interpolation kernel so every sample the
        # kernel sees during a peak carries the same reduction; without this
        # the reconstructed peak can sit a fraction of a dB above the ceiling.
        self.hold = 2 * _TAPS
        self.hold_left = 0

    def process(
        self, left: Sequence[float], right: Sequence[float]
    ) -> tuple[list[float], list[float]]:
        n = min(len(left), len(right))
        if type(left[0]) is float and type(right[0]) is float:
            source_l = list(left[:n])
            source_r = list(right[:n])
        else:
            source_l = [float(x) for x in left[:n]]
            source_r = [float(x) for x in right[:n]]
        # Interpolate the signed channels, then take the louder one: rectifying
        # first would destroy the waveform the oversampler is reconstructing.
        curve_l = _peak_curve(source_l)
        curve_r = _peak_curve(source_r)
        radius = self.radius
        if _np is not None and n >= 64:
            combined = _np.maximum(curve_l, curve_r)
            # `_peak_curve` reconstructs around input[i - taps], so shift it
            # back onto the sample the peak actually belongs to before taking
            # gain from it; otherwise the reduction lands 12 samples early.
            aligned = _np.concatenate(
                (combined[_TAPS:], _np.full(_TAPS, combined[-1], dtype=_np.float64))
            )
            # Widen to the interpolation kernel: every sample the oversampler
            # can see around i must carry the gain demanded by the largest peak
            # there, otherwise the reconstructed peak slips between samples.
            padded = _np.concatenate(
                (
                    _np.full(radius, -_np.inf, dtype=_np.float64),
                    aligned,
                    _np.full(radius, aligned[-1], dtype=_np.float64),
                )
            )
            curve = _maximum_filter1d(
                padded, size=2 * radius + 1, origin=0, mode="constant", cval=-_np.inf
            )[radius : radius + n]
        else:
            combined = [max(a, b) for a, b in zip(curve_l, curve_r)]
            tail = combined[-1] if combined else 0.0
            aligned = combined[_TAPS:] + [tail] * _TAPS
            curve = [
                max(aligned[max(0, i - radius) : i + radius + 1]) for i in range(n)
            ]

        if _np is not None and n >= 64:
            targets = _np.where(
                curve <= self.ceiling,
                1.0,
                self.ceiling / _np.maximum(curve, 1e-300),
            ).tolist()
            gains, gain, hold_left = limiter_gain_loop(
                targets, self.gain, self.hold_left, self.hold, self.release
            )
            gain_curve = _np.asarray(gains, dtype=_np.float64)
            self.gain = gain
            self.hold_left = hold_left
            self.reduction_db = max(
                0.0, -20.0 * math.log10(max(float(gain_curve.min()), 1e-9))
            )
            return (
                (_np.asarray(source_l, dtype=_np.float64) * gain_curve).tolist(),
                (_np.asarray(source_r, dtype=_np.float64) * gain_curve).tolist(),
            )

        out_l: list[float] = [0.0] * n
        out_r: list[float] = [0.0] * n
        gain = self.gain
        hold_left = self.hold_left
        hold = self.hold
        release = self.release
        ceiling = self.ceiling
        lowest = gain
        for i in range(n):
            # The gain is derived from the reconstructed peak at this sample
            # and held across one kernel, so every sample the oversampler sees
            # during the peak carries the same reduction.
            peak = curve[i]
            target = 1.0 if peak <= ceiling else ceiling / peak
            if target < gain:
                gain = target
                hold_left = hold
            elif hold_left > 0:
                hold_left -= 1
            else:
                gain += (1.0 - gain) * release
            out_l[i] = source_l[i] * gain
            out_r[i] = source_r[i] * gain
            if gain < lowest:
                lowest = gain

        self.gain = gain
        self.hold_left = hold_left
        self.reduction_db = max(0.0, -20.0 * math.log10(max(lowest, 1e-9)))
        return out_l, out_r


class _Saturation:
    def __init__(self, fs: int, blend_pct: float, mode: str) -> None:
        self.amount = clamp(blend_pct, 0.0, 15.0) / 100.0 * _MODE_DRIVE[mode]
        self.dc_l = Biquad.highpass(fs, 20.0)
        self.dc_r = Biquad.highpass(fs, 20.0)

    def process(
        self, left: Sequence[float], right: Sequence[float]
    ) -> tuple[list[float], list[float]]:
        if _np is not None and len(left) >= 64:
            xl = _np.asarray(left, dtype=_np.float64)
            xr = _np.asarray(right, dtype=_np.float64)
            dl = filter_block_array(self.dc_l, xl * xl)
            dr = filter_block_array(self.dc_r, xr * xr)
            if dl is not None and dr is not None:
                return (
                    (xl + self.amount * dl).tolist(),
                    (xr + self.amount * dr).tolist(),
                )
        out_l, out_r = [], []
        for l, r in zip(left, right):
            xl, xr = float(l), float(r)
            out_l.append(xl + self.amount * self.dc_l.process(xl * xl))
            out_r.append(xr + self.amount * self.dc_r.process(xr * xr))
        return out_l, out_r


class TwoPassClip:
    def __init__(
        self,
        sample_rate: int = 48_000,
        pass1: bool = True,
        ceiling_db: float = -0.5,
        oversample: int = OVERSAMPLE,
        pass2: bool = False,
        blend_pct: float = 0.0,
        mode: str = "warm",
        lookahead_ms: float = 2.0,
    ) -> None:
        if oversample != OVERSAMPLE:
            raise ValueError("pass 1 is specified at 16× oversampling")
        if mode not in MODES:
            raise ValueError(f"mode must be one of {MODES}")
        self.sample_rate = int(sample_rate)
        self.pass1 = bool(pass1)
        self.pass2 = bool(pass2)
        self.ceiling_db = float(ceiling_db)
        self.blend_pct = float(clamp(blend_pct, 0.0, 15.0))
        self.mode = mode
        self.oversample = oversample
        self._limiter = _PeakLimiter(ceiling_db, lookahead_ms, sample_rate=sample_rate)
        self._sat = _Saturation(self.sample_rate, self.blend_pct, mode)

    @property
    def enabled(self) -> bool:
        return self.pass1 or self.pass2

    def process_stereo(
        self, left: Sequence[float], right: Sequence[float]
    ) -> tuple[list[float], list[float]]:
        l = [float(x) for x in left]
        r = [float(x) for x in right]
        if not self.enabled:
            return l, r
        if self.pass1:
            l, r = self._limiter.process(l, r)
        if self.pass2 and self.blend_pct > 0:
            l, r = self._sat.process(l, r)
        return l, r

    def state(self) -> dict[str, float | bool | str | int]:
        return {
            "pass1": self.pass1,
            "ceiling_db": self.ceiling_db,
            "oversample": self.oversample,
            "pass2": self.pass2,
            "blend_pct": self.blend_pct,
            "mode": self.mode,
            "reduction_db": round(self._limiter.reduction_db, 2),
            "latency_samples": 0,
            "detector_window_ms": round(self._limiter.radius * 1000.0 / self.sample_rate, 2),
        }


__all__ = [
    "TwoPassClip",
    "true_peak",
    "OVERSAMPLE",
    "CEILINGS",
    "MODES",
]
