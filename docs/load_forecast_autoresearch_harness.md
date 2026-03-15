# Load Forecast Autoresearch Harness

## Purpose

This repo now contains a tracked autoresearch harness so recurring forecast-research loops can be rerun from any clean checkout or git worktree.

Tracked harness files:
- `autoresearch.md`
- `autoresearch.sh`
- `autoresearch.checks.sh`
- `backend/scripts/replay-load-forecast.ts`

Supporting docs:
- `docs/load_forecast_autoresearch_2026_03.md`
- `docs/load_forecast_autoresearch_2026_03_next_steps.md`

## Intended workflow

Use a dedicated git worktree for each experiment run so discarded edits and temporary artifacts never affect `main`.

Example:

```bash
cd /Users/andreas/Documents/code/chargecaster/main-chargecaster
git worktree add ../experiments/chargecaster-apr01 -b autoresearch/apr01
cd /Users/andreas/Documents/code/chargecaster/experiments/chargecaster-apr01
```

Prepare the runtime:

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r backend/ml/requirements.txt
pnpm install --frozen-lockfile
```

Smoke-test the benchmark:

```bash
./autoresearch.sh
./autoresearch.checks.sh
```

Then start Pi in that worktree and use the tracked root files directly.

## Benchmark contract

`./autoresearch.sh` must:
- train a temporary load-forecast artifact
- run the replay evaluator
- print stable `METRIC name=value` lines

Current metrics:
- `cost_delta_eur`
- `mae`
- `p90_economic_hours_absolute_error`
- `mode_switch_count`
- `mode_switch_delta`

`./autoresearch.checks.sh` runs:
- focused backend tests
- backend typecheck

## What the replay evaluator does

`backend/scripts/replay-load-forecast.ts`:
- loads historical data from the configured DB
- selects recent complete UTC days
- builds historical price and solar slots from actual stored history
- generates candidate demand forecasts from a temporary model artifact
- generates hybrid fallback forecasts as the comparison baseline
- runs both through the existing simulator
- reports average replay-cost and secondary metrics across windows

The evaluator uses a no-op simulation storage shim for replay runs so benchmark execution does not write snapshots or history back into the real DB.

## Known caveats

Current limitations to keep in mind when interpreting results:

- replay still uses full stored history when rebuilding demand forecasts, so the current harness has lookahead leakage relative to a strict walk-forward backtest
- Python training now intentionally zeroes forward price and future-solar feature slots, while the TypeScript inference side still understands those feature positions; keep this contract explicit if future work widens or rewires the feature set
- the current benchmark is hourly and cost-focused; a future 5-minute forecast loop would be a larger scope change, not a small continuation

## Recommended rerun triggers

Rerun related research loops when:
- materially more history is available
- tariff behavior changes enough to justify retuning
- you want to test different risk weighting
- you want to revisit slot handling or value integration / differentiation ideas
- you intentionally widen scope to a 5-minute forecasting path
