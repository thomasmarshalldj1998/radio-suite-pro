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

__all__ = ["filter_block", "filter_chain", "available"]


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


def filter_block(biquad: Biquad, values: Sequence[float]) -> list[float]:
    """Apply one biquad to a block, preserving its DF1 state."""
    n = len(values)
    if n == 0:
        return []
    if _np is None or _lfilter is None or n < 32:
        return [biquad.process(x) for x in values]
    xs = _np.asarray(values, dtype=_np.float64)
    z1, z2 = _state(biquad)
    b = _np.asarray([biquad.b0, biquad.b1, biquad.b2], dtype=_np.float64)
    a = _np.asarray([biquad.a0, biquad.a1, biquad.a2], dtype=_np.float64)
    y, _ = _lfilter(b, a, xs, zi=_np.asarray([z1, z2], dtype=_np.float64))
    out = y.tolist()
    _store_state(biquad, values, out)
    return out


def filter_chain(filters: Sequence[Biquad], values: Sequence[float]) -> list[float]:
    """Apply a static biquad chain to a block."""
    out = list(map(float, values))
    for biquad in filters:
        out = filter_block(biquad, out)
    return out
