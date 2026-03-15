# Load Forecast Autoresearch Follow-ups (March 2026)

## Most promising remaining ideas

- Explore very selective asymmetric clipping only on extreme risky under-forecasts.
  The broad target-shaping experiments were too destructive, but a narrowly targeted correction in simultaneous high-price and very-low-solar periods may still help.

- Revisit the boundary around the short-tree winner with a stronger secondary-metric guard.
  The run found a good region around `70` trees, while `50` looked suspicious. A small, explicitly guarded sweep around that boundary may still refine the final tradeoff.

- Consider a 5-minute demand forecast only if scope is intentionally widened.
  This is a larger architectural change and likely needs:
  - 5-minute targets
  - changed feature generation
  - updated inference plumbing
  - replay harness changes

## Before the next autoresearch run

Recommended benchmark cleanup:

1. Remove replay lookahead leakage.
   Make the replay evaluator truncate available history to the replay cutoff date before building candidate and hybrid forecasts.

2. Reconcile training and inference feature contracts.
   The Python trainer now intentionally zeroes forward price / future-solar slots, while the TypeScript inference path still builds values for those positions. Keep the contract explicit and aligned.

3. Add an explicit secondary-metric guardrail.
   Future runs should reject wins that improve `cost_delta_eur` only by obviously collapsing demand realism.

## Suggested acceptance posture

Treat the current merged model as:
- a promising replay-cost-tuned configuration
- suitable for further controlled validation
- not yet the final benchmark-clean production optimum
