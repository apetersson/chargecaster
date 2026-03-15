# Load Forecast Autoresearch (March 2026)

## Goal

Optimize the hourly house-load forecast so replaying the resulting demand forecast through the existing simulator lowers total projected charging cost.

Primary benchmark:
- `cost_delta_eur = candidate_projected_cost_eur - hybrid_projected_cost_eur`
- lower is better
- negative values beat the existing hybrid fallback on the fixed replay windows

Secondary metrics observed during the run:
- `mae`
- `p90_economic_hours_absolute_error`
- `mode_switch_count`
- `mode_switch_delta`

## Final result merged to `main`

Best kept commit from the experiment branch:
- branch: `autoresearch/mar15`
- commit: `5173ca7`
- `cost_delta_eur = -3.609318`
- `mae = 765.757577`
- `p90_economic_hours_absolute_error = 2000.194167`

Net model changes carried back into `main`:
- switch CatBoost from `RMSE` to `Quantile:alpha=0.19`
- reduce `iterations` from `600` to `70`
- increase `l2_leaf_reg` from `5.0` to `15.0`
- remove forward-looking price and future-solar feature values from Python training
- apply moderate sample weighting toward economically risky hours:
  - low solar
  - top-quartile price
  - morning / evening transition hours

## What worked

The search consistently improved replay cost by making the model simpler and more conservative:

1. Remove price-driven demand behavior from training.
   The original model appeared to bake tariff shape into demand and over-trigger charging in expensive periods.

2. Lower the quantile target.
   Good path:
   - `0.4 -> 0.35 -> 0.3 -> 0.25 -> 0.2 -> 0.19`

3. Weight training toward economically risky periods.
   Focused weighting on low-solar, top-price, and transition-hour samples improved the primary metric more than plain quantile tuning alone.

4. Increase regularization.
   Good path:
   - `l2_leaf_reg: 5 -> 7.5 -> 10 -> 15`

5. Shrink the tree count aggressively.
   Good path:
   - `450 -> 400 -> 350 -> 300 -> 250 -> 200 -> 150 -> 100 -> 80 -> 70`

This produced a monotonic replay-cost improvement for a long stretch, but with steadily worsening secondary metrics, so the final selection intentionally stopped before the clearly suspect ultra-short region.

## What was tried and discarded

Discarded because they lost `cost_delta_eur` or won only by collapsing into unsafe under-forecasting:

- tighter regularization on the short model (`l2_leaf_reg = 20`)
- less aggressive quantile on the short model (`alpha = 0.2` after moving to the weighted short-tree setup)
- `75`, `60`, and `50` trees as the model got very short
- baseline-residual target
- day / week anchor residual target
- log-scale target
- mild autoregressive smoothing at inference
- deeper model (`depth = 7`)
- shallower model (`depth = 5`)
- dropping previous-week same-hour memory
- baseline-floor / target-distillation style correction on risky hours

Additional failed or suspect directions from the run:
- `alpha = 0.15`
- early `alpha = 0.18` variants before later simplifications
- removing all solar features
- collapsing solar magnitude to a daylight flag
- recency-weighted sample emphasis

## Interpretation

The winning direction is not “a universally more accurate model.”

It is a model that performs better on the current replay-cost harness by:
- reducing over-forecast bias
- simplifying capacity
- emphasizing the hours that matter most economically

That came with a meaningful tradeoff:
- replay cost improved a lot
- general accuracy metrics degraded materially versus the original baseline and the hybrid fallback

This means the merged model should be treated as a replay-cost-tuned hourly demand model, not as a clean accuracy win.

## Known caveats

These experiment results are useful, but they should not be treated as the final word on production quality yet.

Known benchmark caveats:
- the replay evaluator currently rebuilds demand forecasts using the full stored history instead of truncating history at each replay cutoff, which introduces lookahead leakage into the benchmark
- the Python training path now zeros the future price / future solar feature slots while the TypeScript inference path still knows about those feature positions; this was an intentional simplification during the experiment, but the cross-language feature contract should be revalidated carefully before further tuning

Because of those caveats, the right interpretation is:
- the branch found a promising, materially cheaper replay-cost regime
- the result still deserves a cleaner walk-forward validation pass before broader trust
