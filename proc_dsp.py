"""Shared DSP primitives for the SignalPath full-chain processors.

The v3.1 modules established the house style: pure Python, explicit state,
``process_stereo()``, bit-exact bypass, and a JSON-able ``state()``. The
full-chain modules in this tree reuse these small helpers rather than growing
a second set of filter/envelope implementations.

No audio is allocated per sample beyond the output list itself; filters are
``stream_encoder_core.Biquad`` instances so coefficients and state stay
inspectable offline.
"""

from __future__ import annotations

import math
from typing import Sequence

from stream_encoder_core import Biquad, clamp, db_to_lin, lin_to_db

__all__ = [
    "Biquad",
    "clamp",
    "db_to_lin",
    "lin_to_db",
    "Envelope",
    "LinkedEnvelope",
    "copy_stereo",
    "peak",
    "rms",
    "mean_square",
    "level_db",
    "peaking",
    "low_shelf",
    "allpass",
    "soft_clip",
    "cubic",
    "band_energy",
]


def copy_stereo(left: Sequence[float], right: Sequence[float]) -> tuple[list[float], list[float]]:
    """Float copies, truncated to the shared length (bypass-safe)."""
    n = min(len(left), len(right))
    # map(float, …) is roughly twice as fast as a comprehension here, and this
    # runs once per module per block in the 43-stage chain.
    return list(map(float, left[:n])), list(map(float, right[:n]))


def peak(values: Sequence[float]) -> float:
    return max((abs(float(x)) for x in values), default=0.0)


def mean_square(values: Sequence[float]) -> float:
    n = len(values)
    return sum(float(x) * float(x) for x in values) / n if n else 0.0


def rms(values: Sequence[float]) -> float:
    return math.sqrt(mean_square(values))


def level_db(value: float) -> float:
    return -120.0 if value <= 0.0 else 20.0 * math.log10(value)


def band_energy(values: Sequence[float]) -> float:
    return mean_square(values)


class Envelope:
    """One-pole peak/RMS envelope with independent attack and release."""

    def __init__(
        self,
        sample_rate: int,
        attack_ms: float,
        release_ms: float,
        initial: float = 0.0,
    ) -> None:
        fs = max(1, int(sample_rate))
        self.attack = 1.0 - math.exp(-1.0 / max(1.0, attack_ms * fs / 1000.0))
        self.release = 1.0 - math.exp(-1.0 / max(1.0, release_ms * fs / 1000.0))
        self.value = float(initial)

    def reset(self, initial: float = 0.0) -> None:
        self.value = float(initial)

    def process(self, x: float) -> float:
        target = abs(float(x))
        coef = self.attack if target > self.value else self.release
        self.value += (target - self.value) * coef
        return self.value


class LinkedEnvelope:
    """Stereo-linked envelope: one gain decision for both channels."""

    def __init__(
        self,
        sample_rate: int,
        attack_ms: float,
        release_ms: float,
        initial: float = 0.0,
    ) -> None:
        self._env = Envelope(sample_rate, attack_ms, release_ms, initial)

    @property
    def value(self) -> float:
        return self._env.value

    def reset(self, initial: float = 0.0) -> None:
        self._env.reset(initial)

    def process(self, left: float, right: float) -> float:
        return self._env.process(max(abs(float(left)), abs(float(right))))


def peaking(fs: float, freq: float, q: float, gain_db: float) -> Biquad:
    """RBJ peaking EQ with 0 dB gain at DC and Nyquist."""
    a = 10.0 ** (gain_db / 40.0)
    w0 = 2.0 * math.pi * min(max(freq, 1.0), fs * 0.49) / fs
    alpha = math.sin(w0) / (2.0 * max(q, 0.05))
    cw = math.cos(w0)
    return Biquad(
        1.0 + alpha * a,
        -2.0 * cw,
        1.0 - alpha * a,
        1.0 + alpha / a,
        -2.0 * cw,
        1.0 - alpha / a,
    )


def low_shelf(fs: float, freq: float, gain_db: float, q: float = 0.7071) -> Biquad:
    """RBJ low shelf."""
    a = 10.0 ** (gain_db / 40.0)
    w0 = 2.0 * math.pi * min(max(freq, 1.0), fs * 0.49) / fs
    alpha = math.sin(w0) / (2.0 * max(q, 0.05))
    cw = math.cos(w0)
    sa = 2.0 * math.sqrt(a) * alpha
    return Biquad(
        a * ((a + 1) - (a - 1) * cw + sa),
        2 * a * ((a - 1) - (a + 1) * cw),
        a * ((a + 1) - (a - 1) * cw - sa),
        (a + 1) + (a - 1) * cw + sa,
        -2 * ((a - 1) + (a + 1) * cw),
        (a + 1) + (a - 1) * cw - sa,
    )


def allpass(fs: float, freq: float, q: float = 0.7071) -> Biquad:
    """Second-order all-pass; used for fractional phase alignment."""
    w0 = 2.0 * math.pi * min(max(freq, 1.0), fs * 0.49) / fs
    alpha = math.sin(w0) / (2.0 * max(q, 0.05))
    cw = math.cos(w0)
    return Biquad(1 - alpha, -2 * cw, 1 + alpha, 1 + alpha, -2 * cw, 1 - alpha)


def soft_clip(x: float, drive: float = 1.0, ceiling: float = 1.0) -> float:
    """Odd tanh knee with a hard output ceiling."""
    shaped = math.tanh(float(x) * max(0.0, float(drive))) / max(math.tanh(max(0.0, float(drive))), 1e-9)
    return clamp(shaped, -ceiling, ceiling)


def cubic(a: float, b: float, c: float, d: float, t: float) -> float:
    """Catmull-Rom interpolation between b and c (t in 0..1)."""
    t2 = t * t
    t3 = t2 * t
    return 0.5 * (
        2.0 * b
        + (-a + c) * t
        + (2.0 * a - 5.0 * b + 4.0 * c - d) * t2
        + (-a + 3.0 * b - 3.0 * c + d) * t3
    )
