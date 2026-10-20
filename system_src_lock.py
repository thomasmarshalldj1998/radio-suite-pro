"""Sample-rate conversion and drift lock (SignalPath v3.1, module D3).

The encoder clock and the input device never run at exactly the same rate. Left
alone, a 5 ppm mismatch accumulates a whole sample every 2.5 minutes and a click
every time the buffer wraps. This module measures the drift, corrects it at
0.1 ppm resolution with a 512-tap polyphase resampler, and raises a warning when
the *measured* drift stays above 1 ppm.

`detect_sample_rate` recovers a device's real rate from a known test tone (the
console's 1 kHz alignment tone), so a 44.1 kHz source plugged into a 48 kHz
session is identified instead of silently resampled as if it were 48 kHz.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Sequence

COMMON_RATES = (44100, 48000, 88200, 96000, 176400, 192000)
TAPS = 512
PHASES = 128
CUTOFF = 0.95
BETA = 14.0  # Kaiser β ≈ 14 → ~144 dB stopband


def _i0(x: float) -> float:
    total = 1.0
    term = 1.0
    for k in range(1, 48):
        term *= (x / (2.0 * k)) ** 2
        total += term
        if term < 1e-14 * total:
            break
    return total


def _sinc(x: float) -> float:
    if abs(x) < 1e-12:
        return 1.0
    return math.sin(math.pi * x) / (math.pi * x)


_TABLE: list[list[float]] | None = None


def coefficient_table(taps: int = TAPS, phases: int = PHASES) -> list[list[float]]:
    """Kaiser-windowed sinc, one 512-tap kernel per fractional phase."""
    global _TABLE
    if _TABLE is not None and taps == TAPS and phases == PHASES:
        return _TABLE
    denom = _i0(BETA)
    table: list[list[float]] = []
    for p in range(phases):
        d = p / phases
        coeffs = []
        for k in range(taps):
            # Kernel centred so that d = 0 passes the input sample unchanged.
            x = taps / 2.0 + d - k
            window = (
                _i0(BETA * math.sqrt(max(0.0, 1.0 - (2.0 * x / taps) ** 2))) / denom
                if abs(x) <= taps / 2.0
                else 0.0
            )
            coeffs.append(CUTOFF * _sinc(CUTOFF * x) * window)
        total = sum(coeffs)
        table.append([c / total for c in coeffs])
    if taps == TAPS and phases == PHASES:
        _TABLE = table
    return table


class PolyphaseResampler:
    """Arbitrary-ratio resampler; `step` input samples per output sample."""

    def __init__(self, taps: int = TAPS, phases: int = PHASES) -> None:
        self.taps = taps
        self.phases = phases
        self.table = coefficient_table(taps, phases)

    def resample(self, samples: Sequence[float], step: float = 1.0) -> list[float]:
        if step <= 0:
            raise ValueError("step must be positive")
        n = len(samples)
        if n == 0:
            return []
        count = int(n / step)
        out: list[float] = []
        half = self.taps // 2
        for m in range(count):
            pos = m * step
            index = int(pos)
            frac = pos - index
            phase = min(self.phases - 1, int(frac * self.phases + 0.5))
            coeffs = self.table[phase]
            acc = 0.0
            base = index - half
            for k, c in enumerate(coeffs):
                j = base + k
                if 0 <= j < n:
                    acc += samples[j] * c
            out.append(acc)
        return out


def detect_sample_rate(
    samples: Sequence[float], nominal: int = 48_000, tone_hz: float = 1000.0
) -> int:
    """Infer the capture rate from a known alignment tone.

    Zero crossings of a clean tone give the tone's frequency in *captured*
    samples; comparing that with the expected tone frequency scales the nominal
    rate. Results within 0.5 % of a standard rate snap to it.
    """
    if len(samples) < 64:
        raise ValueError("need at least 64 samples")
    peak = max(abs(float(x)) for x in samples) or 1.0
    threshold = peak * 0.02
    state = 0
    crossings: list[int] = []
    for index, value in enumerate(samples):
        level = 1 if value > threshold else -1 if value < -threshold else 0
        if level == 0:
            continue
        if state and level != state:
            crossings.append(index)
        state = level
    if len(crossings) < 2:
        raise ValueError("no usable tone found")
    # Frequency from the interval between the first and last crossing: using
    # the whole block length would count a partial final half-cycle as a full
    # one and bias the rate estimate by ~0.5 %.
    span = crossings[-1] - crossings[0]
    intervals = len(crossings) - 1
    measured = nominal * intervals / (2.0 * span)
    rate = tone_hz * nominal / measured
    for common in COMMON_RATES:
        if abs(rate - common) / common <= 0.005:
            return common
    return int(round(rate))


@dataclass
class DriftStatus:
    measured_ppm: float
    correction_ppm: float
    warning: bool
    corrections: int
    input_samples: int
    output_samples: int


class DriftLock:
    """Measure drift, quantise the correction to 0.1 ppm, resample.

    `set_measured_ppm` is fed by the clock comparison (input timestamps versus
    encoder timestamps). The correction is an EWMA so a single late buffer does
    not move the resampler; the warning requires the filtered value to stay
    above 1 ppm for three consecutive measurement windows.
    """

    def __init__(
        self,
        nominal_rate: int = 48_000,
        *,
        warn_ppm: float = 1.0,
        sustained_windows: int = 3,
        resampler: PolyphaseResampler | None = None,
    ) -> None:
        self.nominal_rate = int(nominal_rate)
        self.warn_ppm = float(warn_ppm)
        self.sustained_windows = int(sustained_windows)
        self.resampler = resampler or PolyphaseResampler()
        self.measured_ppm = 0.0
        self.correction_ppm = 0.0
        self._warn_windows = 0
        self._windows = 0
        self.corrections = 0
        self.input_samples = 0
        self.output_samples = 0

    def set_measured_ppm(self, ppm: float) -> float:
        self._windows += 1
        self.measured_ppm = ppm if self._windows == 1 else self.measured_ppm * 0.6 + ppm * 0.4
        # 0.1 ppm quantisation — the resolution the specification calls for.
        self.correction_ppm = round(self.measured_ppm * 10.0) / 10.0
        if abs(self.measured_ppm) > self.warn_ppm:
            self._warn_windows += 1
        else:
            self._warn_windows = 0
        return self.correction_ppm

    @property
    def warning(self) -> bool:
        return self._warn_windows >= self.sustained_windows

    def process(self, samples: Sequence[float]) -> list[float]:
        step = 1.0 + self.correction_ppm * 1e-6
        out = self.resampler.resample(samples, step)
        self.input_samples += len(samples)
        self.output_samples += len(out)
        self.corrections += 1
        return out

    @property
    def observed_ppm(self) -> float:
        if self.output_samples <= 0:
            return 0.0
        return (self.input_samples / self.output_samples - 1.0) * 1e6

    def status(self) -> DriftStatus:
        return DriftStatus(
            measured_ppm=round(self.measured_ppm, 3),
            correction_ppm=self.correction_ppm,
            warning=self.warning,
            corrections=self.corrections,
            input_samples=self.input_samples,
            output_samples=self.output_samples,
        )


__all__ = [
    "detect_sample_rate",
    "DriftLock",
    "DriftStatus",
    "PolyphaseResampler",
    "coefficient_table",
    "COMMON_RATES",
    "TAPS",
    "PHASES",
]
