"""Optional block acceleration shared by the full-chain processors.

The reference path is the per-sample ``Biquad`` loop. When NumPy + SciPy are
present, static biquad chains are run through ``scipy.signal.lfilter`` in C.
The filter state is converted exactly between direct-form I (Biquad) and
transposed direct-form II (lfilter), so a block boundary does not change the
difference equation.

NumPy is an optional dependency: without it every helper falls back to the
stdlib loop, and the output remains the reference implementation.
"""

from __future__ import annotations

from typing import Sequence

from stream_encoder_core import Biquad

try:  # optional acceleration
    import numpy as _np
except ImportError:  # pragma: no cover - fallback hosts
    _np = None

try:  # optional acceleration
    from scipy.signal import lfilter as _lfilter
except ImportError:  # pragma: no cover - fallback hosts
    _lfilter = None

__all__ = [
    "filter_block",
    "filter_block_array",
    "filter_chain",
    "filter_chain_array",
    "instant_attack_gain_curve",
    "limiter_gain_loop",
    "available",
]


def available() -> bool:
    return _np is not None and _lfilter is not None


def _state(biquad: Biquad) -> tuple[float, float]:
    """DF1 history → transposed-DF2 initial conditions."""
    a0, a1, a2 = biquad.a0, biquad.a1, biquad.a2
    b1, b2 = biquad.b1 / a0, biquad.b2 / a0
    z1 = b1 * biquad.x1 + b2 * biquad.x2 - (a1 / a0) * biquad.y1 - (a2 / a0) * biquad.y2
    z2 = b2 * biquad.x1 - (a2 / a0) * biquad.y1
    return z1, z2


def _store_state(biquad: Biquad, values: Sequence[float], output: Sequence[float]) -> None:
    old_x1 = biquad.x1
    old_y1 = biquad.y1
    if len(values) >= 2:
        biquad.x1, biquad.x2 = float(values[-1]), float(values[-2])
    elif values:
        biquad.x1, biquad.x2 = float(values[-1]), old_x1
    if len(output) >= 2:
        biquad.y1, biquad.y2 = float(output[-1]), float(output[-2])
    elif output:
        biquad.y1, biquad.y2 = float(output[-1]), old_y1


def filter_block_array(biquad: Biquad, values: Sequence[float]):
    """Array-native biquad block; ``None`` when SciPy is unavailable.

    Callers that chain several filters or do further NumPy maths can avoid the
    two list↔array conversions per stage. The difference equation and state
    transfer are identical to :func:`filter_block`.
    """
    n = len(values)
    if n == 0:
        return _np.zeros(0) if _np is not None else None
    if _np is None or _lfilter is None or n < 32:
        return None
    if isinstance(values, _np.ndarray):
        xs = values
        if xs.dtype != _np.float64:
            xs = xs.astype(_np.float64)
    else:
        xs = _np.asarray(values, dtype=_np.float64)
    z1, z2 = _state(biquad)
    b = _np.asarray([biquad.b0, biquad.b1, biquad.b2], dtype=_np.float64)
    a = _np.asarray([biquad.a0, biquad.a1, biquad.a2], dtype=_np.float64)
    y, _ = _lfilter(b, a, xs, zi=_np.asarray([z1, z2], dtype=_np.float64))
    _store_state(biquad, values, y)
    return y


def filter_block(biquad: Biquad, values: Sequence[float]) -> list[float]:
    """Apply one biquad to a block, preserving its DF1 state."""
    n = len(values)
    if n == 0:
        return []
    y = filter_block_array(biquad, values)
    if y is None:
        return [biquad.process(x) for x in values]
    return y.tolist()


def filter_chain(filters: Sequence[Biquad], values: Sequence[float]) -> list[float]:
    """Apply a static biquad chain to a block.

    The array path keeps the signal in float64 across every stage, so an
    eight-notch chain costs eight ``lfilter`` calls rather than sixteen
    list↔array conversions.
    """
    if _np is not None and _lfilter is not None and len(values) >= 32:
        out = filter_chain_array(filters, values)
        if out is not None:
            return out.tolist()
    out = list(map(float, values))
    for biquad in filters:
        out = filter_block(biquad, out)
    return out


def filter_chain_array(filters: Sequence[Biquad], values: Sequence[float]):
    """Array-native biquad chain; ``None`` when SciPy is unavailable."""
    out = values
    for biquad in filters:
        out = filter_block_array(biquad, out)
        if out is None:
            return None
    return out


def instant_attack_gain_curve(
    targets: Sequence[float], gain: float, release: float
) -> list[float] | None:
    """Vectorised instant-attack / exponential-release gain curve.

    ``h = 1 - gain`` follows ``h = max(attack, h × (1 - release))``. With no
    hold, that is a cumulative maximum of the decayed attacks, so it is exact
    in closed form. Returns ``None`` when NumPy is unavailable.
    """
    n = len(targets)
    if _np is None or n == 0:
        return None
    decay = 1.0 - float(release)
    if not 0.0 < decay <= 1.0:
        return None
    target = _np.asarray(targets, dtype=_np.float64)
    attack = 1.0 - target
    _np.maximum(attack, 0.0, out=attack)
    idx = _np.arange(n, dtype=_np.float64)
    curve = _np.maximum.accumulate(attack * _np.power(decay, -idx))
    initial = (1.0 - float(gain)) * decay
    if initial > 0.0:
        _np.maximum(curve, initial, out=curve)
    curve *= _np.power(decay, idx)
    gains = 1.0 - curve
    _np.clip(gains, 0.0, 1.0, out=gains)
    return gains.tolist()


def limiter_gain_loop(
    targets: Sequence[float],
    gain: float,
    hold_left: int,
    hold: int,
    release: float,
) -> tuple[list[float], float, int]:
    """Instant-attack / hold / exponential-release gain curve.

    The recurrence is stateful in both the gain *and* the hold counter, so it
    stays scalar; everything around it (detection, delay, output scaling) is
    vectorised by the limiter modules. ``targets`` may be any float sequence.
    """
    n = len(targets)
    out = [0.0] * n
    for i in range(n):
        target = targets[i]
        if target < gain:
            gain = target
            hold_left = hold
        elif hold_left > 0:
            hold_left -= 1
        else:
            gain += (1.0 - gain) * release
        out[i] = gain
    return out, gain, hold_left
