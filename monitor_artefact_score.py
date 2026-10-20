"""Codec artefact score (SignalPath v3.1, module C1).

Compares the programme before the encoder with what came back, and reduces the
comparison to three numbers an operator can act on:

* **SNR (dB)** — residual energy after delay alignment;
* **HF rolloff (kHz)** — the highest frequency the codec still passes at
  −40 dB relative to its own peak;
* **modulation artefact (%)** — envelope error, which is what "swishy" codec
  artefacts sound like.

The composite is 0–100 with the specified verdicts: Good > 90, Fair 75–90,
Poor < 75. Identical signals score 100. Everything is stdlib: an iterative
radix-2 FFT and a decimated cross-correlation for alignment.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Sequence

def _fft(values: Sequence[complex]) -> list[complex]:
    """In-place iterative radix-2 FFT; `len(values)` must be a power of two."""
    n = len(values)
    a = [complex(v) for v in values]
    j = 0
    for i in range(1, n):
        bit = n >> 1
        while j & bit:
            j ^= bit
            bit >>= 1
        j |= bit
        if i < j:
            a[i], a[j] = a[j], a[i]
    size = 2
    while size <= n:
        half = size // 2
        wstep = complex(math.cos(-2 * math.pi / size), math.sin(-2 * math.pi / size))
        for start in range(0, n, size):
            w = 1 + 0j
            for k in range(half):
                u = a[start + k]
                v = a[start + k + half] * w
                a[start + k] = u + v
                a[start + k + half] = u - v
                w *= wstep
        size <<= 1
    return a


def _power_spectrum(samples: Sequence[float], size: int = 4096) -> list[float]:
    n = min(size, len(samples))
    if n < 8:
        return [0.0] * (size // 2)
    window = [(0.5 - 0.5 * math.cos(2 * math.pi * i / (n - 1))) for i in range(n)]
    buf = [complex(samples[i] * window[i], 0.0) for i in range(n)]
    buf.extend([0j] * (size - n))
    spectrum = _fft(buf)
    return [abs(spectrum[i]) ** 2 for i in range(size // 2)]


def _align(pre: Sequence[float], post: Sequence[float], max_lag: int = 2048) -> int:
    """Best lag of `post` behind `pre`, measured on a decimated copy."""
    step = 16
    a = [pre[i] for i in range(0, len(pre), step)]
    b = [post[i] for i in range(0, len(post), step)]
    limit = min(max_lag // step, max(1, len(b) // 4))
    best_lag = 0
    best = -1.0
    for lag in range(0, limit + 1):
        total = 0.0
        count = 0
        for i in range(len(a) - lag):
            total += a[i] * b[i + lag]
            count += 1
        if count and total > best:
            best = total
            best_lag = lag
    return best_lag * step


def _envelope(samples: Sequence[float], sample_rate: int, ms: float = 5.0) -> list[float]:
    coef = 1.0 - math.exp(-1.0 / max(1.0, ms * sample_rate / 1000.0))
    env = []
    state = 0.0
    for value in samples:
        state += (abs(float(value)) - state) * coef
        env.append(state)
    return env


@dataclass
class ArtefactMetrics:
    snr_db: float
    hf_rolloff_khz: float
    modulation_pct: float
    score: float
    grade: str
    lag_samples: int = 0

    def as_dict(self) -> dict[str, float | str]:
        return {
            "snr_db": round(self.snr_db, 2),
            "hf_rolloff_khz": round(self.hf_rolloff_khz, 2),
            "modulation_pct": round(self.modulation_pct, 2),
            "score": round(self.score, 1),
            "grade": self.grade,
            "lag_samples": self.lag_samples,
        }


def grade_for(score: float) -> str:
    """Good > 90, Fair 75–90, Poor < 75 (90 and 75 are Fair)."""
    if score > 90.0:
        return "good"
    if score >= 75.0:
        return "fair"
    return "poor"


def _bandwidth_khz(samples: Sequence[float], sample_rate: int) -> float:
    """Highest frequency within 40 dB of the signal's own peak."""
    power = _power_spectrum(samples)
    if not power:
        return 0.0
    peak = max(power)
    if peak <= 0:
        return 0.0
    floor = peak * 10.0 ** (-40.0 / 10.0)
    highest = 0
    for i, value in enumerate(power):
        if value >= floor:
            highest = i
    return highest * (sample_rate / 2.0) / max(1, len(power))


def score_artefacts(
    pre: Sequence[float],
    post: Sequence[float],
    sample_rate: int = 48_000,
    *,
    align: bool = True,
) -> ArtefactMetrics:
    if not pre or not post:
        raise ValueError("both signals are required")
    lag = _align(pre, post) if align else 0
    n = min(len(pre) - 0, len(post) - lag)
    if n < 8:
        raise ValueError("signals are too short to compare")
    a = [float(x) for x in pre[:n]]
    b = [float(x) for x in post[lag : lag + n]]

    signal = sum(x * x for x in a)
    residual = sum((x - y) ** 2 for x, y in zip(a, b))
    snr = 60.0 if residual <= 1e-12 else min(60.0, 10.0 * math.log10(signal / residual))

    env_a = _envelope(a, sample_rate)
    env_b = _envelope(b, sample_rate)
    env_ref = math.sqrt(sum(x * x for x in env_a) / n)
    env_err = math.sqrt(sum((x - y) ** 2 for x, y in zip(env_a, env_b)) / n)
    modulation = 0.0 if env_ref <= 1e-12 else min(100.0, env_err / env_ref * 100.0)

    # Bandwidth loss, not absolute bandwidth: a 1 kHz tone legitimately has
    # nothing above 1 kHz, so it must not be treated as a rolled-off codec.
    pre_bw = _bandwidth_khz(a, sample_rate)
    post_bw = _bandwidth_khz(b, sample_rate)
    rolloff = post_bw
    lost = max(0.0, pre_bw - post_bw)

    penalty = max(0.0, 40.0 - snr) * 1.2
    penalty += lost * 2.0
    penalty += modulation * 0.6
    score = max(0.0, min(100.0, 100.0 - penalty))
    return ArtefactMetrics(
        snr_db=snr,
        hf_rolloff_khz=rolloff,
        modulation_pct=modulation,
        score=score,
        grade=grade_for(score),
        lag_samples=lag,
    )


__all__ = ["score_artefacts", "ArtefactMetrics", "grade_for"]
