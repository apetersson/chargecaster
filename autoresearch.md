# Chargecaster Load Forecast Autoresearch

## Objective

Optimize the hourly house-load forecast so replaying the resulting demand forecast through the existing simulator lowers projected charging cost.

Workspace:
- run the benchmark from the repo root with `./autoresearch.sh`
- run fast validation checks with `./autoresearch.checks.sh`
- when using parallel experiments, run Pi inside a Git worktree under `../experiments/`

Primary metric:
- `cost_delta_eur`
- defined as `candidate_projected_cost_eur - hybrid_projected_cost_eur`
- lower is better
- negative values beat the current hybrid fallback on the fixed replay windows

Secondary metrics:
- `mae`
- `p90_economic_hours_absolute_error`
- `mode_switch_count`
- `mode_switch_delta`

## How to Run

- benchmark: `./autoresearch.sh`
- checks: `./autoresearch.checks.sh`

The benchmark:
- trains a candidate load-forecast artifact into a temporary folder
- evaluates recent complete historical UTC days on a fixed 24h replay horizon
- uses actual historical price and solar as oracle exogenous inputs
- rebuilds the house-load forecast from the candidate model
- replays those horizons through the existing simulator
- compares the candidate simulator cost against the hybrid fallback cost on the same windows

Useful manual one-off commands:
```bash
cd backend
pnpm run load-forecast:replay-evaluate -- --config ../config.local.yaml --db ../data/db/backend.sqlite --model-dir /absolute/path/to/model-base
```

Notes:
- the replay evaluator expects `--model-dir` to be a base directory containing `current/model.cbm` and its companion manifest files
- `docs/autoresearch_replay_evaluator.md` documents the fixed manual command chain

## Files in Scope

- `backend/ml/load_forecast_lib.py`
- `backend/scripts/replay-load-forecast.ts` when the evaluator itself needs fixing
- `autoresearch.md`
- `autoresearch.checks.sh`
- `autoresearch.sh`

## Off Limits

- `backend/src/simulation/optimal-schedule.ts` unless the experiment scope is explicitly widened
- broad app architecture changes unrelated to hourly demand forecasting
- benchmark-contract changes without updating docs

## Constraints

- prefer changes that improve replay cost without obviously collapsing into unsafe under-forecasting
- treat large MAE / economic-error blowups as a red flag even if primary metric improves
- keep the evaluator deterministic and read-only against the real DB
- reject changes that increase cost or create obvious instability, even if MAE improves a little
- prefer simpler feature changes when results are close

## Current Best

Merged winner from the March 2026 run:
- `Quantile:alpha=0.19`
- `iterations=70`
- `l2_leaf_reg=15.0`
- forward price and future-solar values zeroed in Python training
- weighted samples for low-solar, high-price, and transition-hour periods

Result at merge time:
- `cost_delta_eur=-3.609318`
- `mae=765.757577`
- `p90_economic_hours_absolute_error=2000.194167`

## What's Been Tried

- Baseline CatBoost started badly underwater on replay cost (`cost_delta_eur` about `+2.00`).
- Dropping all price features from training helped immediately; the forecast was overfitting tariff shape into demand.
- Lowering the quantile objective kept improving replay cost from `0.4 -> 0.35 -> 0.3 -> 0.25 -> 0.2`.
- Dropping future-solar lookahead while keeping current-hour solar improved the `0.2` model further and reduced one obvious oracle dependency.
- The current best is `Quantile:alpha=0.19` with no price features, no future-solar lookahead, economically weighted samples, `l2_leaf_reg=15`, and `iterations=70` (`cost_delta_eur=-3.609318`).
- Nearby quantiles now bracket a local tradeoff: `0.22` recovers some accuracy but loses too much replay-cost gain; `0.2` also loses primary-metric ground on the simpler weighted models; `0.18` improves MAE/p90 versus `0.19` but also loses primary-metric ground.
- Weighting training samples toward economically risky periods helped: a focused mix of low-solar, top-price, and transition-hour weights beat the plain `0.19` model, while broader or more aggressive weighting schemes lost ground.
- Stronger regularization also helped on top of that weighting (`l2_leaf_reg: 5 -> 7.5 -> 10 -> 15` kept improving replay cost; `20` slipped slightly).
- Fewer trees kept improving the primary metric on the weighted and regularized model through `300 -> 250 -> 200 -> 150 -> 100 -> 80 -> 70`, but MAE and economic-hour error drift upward steadily.
- `75` trees were a non-material nudge and `60` trees gave back a bit of replay cost, so `70` currently looks like the local iteration optimum worth trusting.
- `50` trees looked too aggressive: it improved the replay metric again, but MAE and economic-hour error jumped enough to look like benchmark-specific under-forecasting, so treat that region as suspect.
- More radical target reshaping paths looked unsafe: baseline-residual targets, day/week-anchor residual targets, and log-scale targets all collapsed into the same extreme under-forecast regime.
- Mild autoregressive smoothing of predictions had no meaningful effect, and depth changes in either direction (`5` or `7`) lost replay-cost ground.
- A simple baseline-floor or target-distillation attempt on risky hours lost too much replay-cost gain.
- Clearly too aggressive or overfit directions so far: `alpha=0.15`, `alpha=0.18` before future-solar removal, removing all solar features, and collapsing solar magnitude to a daylight flag. Those lowered replay cost by making demand look unrealistically small.
- Neutral dead end: weather features are effectively unused; zeroing them changed nothing on the benchmark.
- Recency-weighted training samples and shallower trees both lost the current primary-metric win.

## Research Notes

Durable context lives in:
- `docs/load_forecast_autoresearch_2026_03.md`
- `docs/load_forecast_autoresearch_2026_03_next_steps.md`
- `docs/load_forecast_autoresearch_harness.md`
