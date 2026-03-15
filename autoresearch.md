# Chargecaster Load Forecast Autoresearch

## Objective

Optimize the hourly house-load forecast so replaying the resulting demand forecast through the existing simulator lowers projected charging cost.

Primary metric:
- `cost_delta_eur`
- defined as `candidate_projected_cost_eur - hybrid_projected_cost_eur`
- lower is better

Secondary metrics:
- `mae`
- `p90_economic_hours_absolute_error`
- `mode_switch_count`
- `mode_switch_delta`

## How to Run

- benchmark: `./autoresearch.sh`
- checks: `./autoresearch.checks.sh`

The benchmark:
- trains a temporary load-forecast artifact
- replays recent complete historical UTC days through the simulator
- compares the candidate forecast against the hybrid fallback on fixed replay windows

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

## Research Notes

Durable context lives in:
- `docs/load_forecast_autoresearch_2026_03.md`
- `docs/load_forecast_autoresearch_2026_03_next_steps.md`
- `docs/load_forecast_autoresearch_harness.md`
