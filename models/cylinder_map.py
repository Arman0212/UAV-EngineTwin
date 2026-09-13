"""
Maps an engine's per-cylinder readings onto the four slots the twin carries.

The estimator's state vector and the residual vector the AI layer consumes are
both fixed-width: twelve states, fifteen residual channels, four of them EGT
and four CHT. Those widths are part of the trained checkpoints, so they cannot
follow the cylinder count of whichever engine happens to be fitted.

The engine library, though, holds engines from a two-cylinder 170 cc twin to a
six-cylinder Lycoming TIO-540. Without a mapping, fitting either one indexes
past the end of a list and the service returns HTTP 500.

So the readings are mapped instead of the vector resized:

  * four cylinders  -- identity, which is what keeps the reference engine and
    every shipped checkpoint bit-identical;
  * more than four  -- the first four are carried, and the rest are still
    modelled and drawn, just not estimated;
  * fewer than four -- the last real cylinder fills the spare slots, so the
    residuals it produces are zero-mean rather than garbage.

Diagnosis is already reported as uncalibrated on any engine but the reference
one, which is the honest place for this limitation to land.
"""
from typing import List, Sequence

SLOTS = 4


def to_slots(values: Sequence[float], slots: int = SLOTS) -> List[float]:
    """
    Returns exactly ``slots`` readings from a per-cylinder list of any length.

    :param values: per-cylinder readings, one per cylinder the engine has.
    :param slots: how many slots the fixed-width vector carries.
    :raises ValueError: if ``values`` is empty, which means no engine.
    """
    n = len(values)
    if n == 0:
        raise ValueError("per-cylinder readings are empty; no engine is fitted")
    if n >= slots:
        return list(values[:slots])
    return [values[min(i, n - 1)] for i in range(slots)]
