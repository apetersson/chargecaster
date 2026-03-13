# Load Forecasting V2 Plan

## Goal

Build a stronger demand forecasting pipeline for Chargecaster using gradient-boosted tree models
(LightGBM or CatBoost), with the optimizer consuming a direct forecast of `house_power_w`.

This v2 plan assumes:

- `house_power_w` already captures the effective site demand behavior we care about for optimization.
- Correlation between household demand and PV production should be learned implicitly through features,
  so we do **not** train or store a separate `direct_pv_use_w` target in v2.
- EV charging is too opportunistic and policy-driven to be a reliable optimizer input today.
  EV should therefore be excluded from the core optimizer forecast path in v2.
- EV prediction may remain as an optional analytics track later, potentially conditioned on
  vehicle SoC, calendar signals, and charging intent, but it is out of scope for the optimizer.

## Why This Direction

The current hybrid heuristic is a good first step, but it still relies on hand-tuned blending logic.
A boosted-tree model should improve accuracy because it can learn nonlinear interactions between:

- hour of day
- weekday / weekend
- month / season
- weather forecast
- PV forecast
- recent load history
- tariff / price context

This should give us a stronger `house_power_w` forecast without forcing us to manually model
PV overlap as a separate variable.

## Scope

### In Scope

- Train and serve a model for hourly `house_power_w`
- Use weather, PV, calendar, price, and short-term lag features
- Compare LightGBM and CatBoost on the same dataset and evaluation harness
- Replace the current demand hybrid model when the new model clearly beats it
- Keep a safe cold-start / fallback path

### Out of Scope

- Deep learning models
- EV charging prediction for optimizer control
- A separate `direct_pv_use_w` model
- A separate `residual_house_power_w` model
- Real-time online learning during every seed run

## Target Variable

### Primary Target

- `house_power_w`

This should be built from the historical telemetry already stored in SQLite, aggregated to the same
hourly horizon used by the optimizer.

### Optional Secondary Analytics Targets

- `ev_power_w` for reporting only
- forecast uncertainty / confidence band

These are optional and should not block the main v2 rollout.

## Data Pipeline

### Source Tables

- local history from `data/db/backend.sqlite`
- cached weather history and forecast data
- price forecast history where available
- PV forecast history and realized solar telemetry

### Training Grain

- hourly rows

Each training row should represent one forecastable optimizer slot and include:

- target: hourly average `house_power_w`
- timestamp metadata
- weather features
- PV features
- price features
- lag features
- calendar features

### Data Hygiene

Training preparation should:

- drop corrupt or incomplete timestamps
- cap obvious telemetry outliers only when physically impossible
- mark missing external inputs explicitly instead of silently zero-filling them
- preserve enough metadata to replay training windows deterministically

## Feature Set

### Calendar Features

- local hour
- day of week
- weekend flag
- week of year
- month
- season
- holiday / public holiday flag if available later

### Weather Features

- temperature
- apparent temperature if available
- cloud cover
- precipitation
- wind speed
- humidity if available later

### PV / Solar Features

- forecast solar power for the hour
- rolling solar forecast for next 2 to 4 hours
- recent realized solar power
- sunrise / sunset proximity if useful

### Price Features

- current slot price
- rolling mean price over next 3 / 6 / 12 hours
- rank of current price within the next day
- cheap / expensive bucket flags

### Autoregressive Features

- previous hour `house_power_w`
- rolling mean of last 3 hours
- rolling mean of last 6 hours
- same hour yesterday
- same hour one week ago
- recent slope / delta features

### Interaction Features

Most interactions should be left to the model, but we should explicitly consider:

- hour x weekday
- hour x season
- solar x cloud cover
- temperature x hour
- price x hour

CatBoost can often learn these interactions well without much manual engineering.

## Model Strategy

### Candidates

Evaluate both:

- LightGBM regressor
- CatBoost regressor

### Recommendation

Start with CatBoost if we want the easiest handling of categorical calendar features and robust defaults.
Start with LightGBM if we want maximum training speed and very simple deployment.

The implementation should support both behind one common interface so we can benchmark them fairly.

### Serving Strategy

- Offline training job writes a versioned model artifact
- Runtime forecasting service loads the latest approved artifact
- Seed runs perform inference only, not training

This is important because the current on-the-fly heuristic is cheap, but a proper model should be
trained in a repeatable pipeline rather than re-fit ad hoc during every simulation refresh.

## Evaluation Design

### Validation Method

Use walk-forward validation, not random train/test splitting.

For each evaluation window:

1. train on all data before the cutoff
2. predict the next 24 to 72 hours
3. compare to actuals
4. roll forward and repeat

This mirrors the real production use case.

### Baselines

Always compare against:

- fixed `2200 W` baseline
- current hybrid heuristic forecast
- hour-of-week recency-weighted baseline

### Metrics

- MAE
- RMSE
- p50 absolute error
- p90 absolute error
- MAPE or sMAPE, only where denominator issues are controlled
- calibration quality for confidence output if implemented

### Slice Analysis

Report metrics by:

- season
- weekday vs weekend
- daylight vs nighttime
- high-PV vs low-PV hours
- high-price vs normal-price hours

This matters because a model that only wins on average but fails during the economically important
hours is not good enough for optimizer use.

## Runtime Architecture

### New Components

- `TrainingDatasetBuilder`
- `LoadForecastModelTrainer`
- `LoadForecastModelRegistry`
- `LoadForecastInferenceService`
- `LoadForecastEvaluationService`

### Suggested Layout

- `backend/src/forecasting/load-forecast.dataset.ts`
- `backend/src/forecasting/load-forecast.trainer.ts`
- `backend/src/forecasting/load-forecast.inference.ts`
- `backend/src/forecasting/load-forecast.registry.ts`
- `backend/src/forecasting/load-forecast.evaluation.ts`
- `backend/scripts/train-load-forecast.ts`
- `backend/scripts/evaluate-load-forecast.ts`

### Model Artifact Format

Store:

- model type
- model version
- training date
- feature schema version
- training data window
- evaluation summary
- serialized model artifact

Artifacts may live in a local file path first and later move to object storage if needed.

## Integration With Existing Simulation Flow

### Replace Current Demand Heuristic

The current `DemandForecastService` should become a thin orchestration layer:

- gather forecast contexts
- request inference from the trained model
- apply post-processing
- emit `demand_forecast` entries

### Output Shape

For v2, each forecast row should minimally contain:

- `start`
- `end`
- `house_power_w`
- `baseline_house_power_w`
- `confidence` if available
- `source`

### Post-Processing Rules

- clamp predictions to physically plausible bounds
- optionally smooth unrealistic hour-to-hour spikes
- keep cold-start fallback when model or features are unavailable

### Optimizer Input

The optimizer should consume:

- `houseLoadWattsPerSlot`

Only this demand forecast should drive the charging strategy in v2.

## Fallback Strategy

If the model cannot run because of missing artifact, schema mismatch, or insufficient features:

1. use the current hybrid heuristic if still present
2. otherwise use hour-of-week baseline
3. otherwise fall back to `2200 W`

This keeps rollout safe while we validate the new model in production-like runs.

## Confidence / Uncertainty

Confidence is useful for UI and future control logic.

Possible v2.1 approaches:

- residual model on top of point forecast
- quantile regression with LightGBM
- ensemble spread between multiple models / folds

This should not block the initial v2 rollout.

## Implementation Phases

### Phase 1: Dataset and Evaluation Harness

- build a deterministic hourly training dataset from the SQLite DB
- add walk-forward evaluation
- compare current heuristic vs hour-of-week baseline
- export evaluation tables for inspection

### Phase 2: First ML Model

- implement LightGBM and CatBoost adapters
- train first point-forecast model for `house_power_w`
- compare against all baselines
- choose the winning model family

### Phase 3: Runtime Inference Integration

- load the selected model artifact during backend startup
- run inference in seed preparation
- emit `demand_forecast`
- feed `houseLoadWattsPerSlot` into the optimizer

### Phase 4: Shadow Mode

- keep the current heuristic as production control
- run ML forecast in parallel
- store both predictions and compare them to actuals
- verify that ML wins consistently before switching control

### Phase 5: Switchover

- make ML forecast the default optimizer input
- keep heuristic fallback behind a feature flag or safety switch

## Testing Plan

### Unit Tests

- dataset aggregation
- feature generation
- missing-value handling
- model registry loading
- fallback behavior
- prediction post-processing bounds

### Integration Tests

- seed run with model artifact present
- seed run with missing artifact
- snapshot payload includes ML-based `demand_forecast`
- optimizer consumes forecast slots correctly

### Smoke Tests

- train on the current local DB
- evaluate on the latest holdout window
- print a table with:
  - timestamp
  - actual house load
  - heuristic forecast
  - ML forecast
  - absolute error of both

## Acceptance Criteria

The model is ready for production control only if:

- it beats the current hybrid heuristic on walk-forward MAE
- it beats the heuristic on p90 absolute error during economically relevant hours
- it does not introduce unstable hour-to-hour spikes that degrade optimizer behavior
- fallback paths are tested and reliable

## Open Questions

- Should the target remain raw `house_power_w`, or should we try net site demand variants as a parallel experiment?
- Do we want Austria holiday features for occupancy-sensitive load?
- Should price remain a feature if household consumption is mostly price-inelastic?
- Should we add occupancy proxies later, such as sunrise/sunset or repeated daily presence patterns?

## Practical Recommendation

For this project, the most realistic v2 path is:

1. build the evaluation harness first
2. train both LightGBM and CatBoost on the same hourly dataset
3. keep only the better model family
4. deploy in shadow mode before handing control to the optimizer

This gives us a meaningful ML upgrade without overcommitting to a heavy modeling stack too early.
