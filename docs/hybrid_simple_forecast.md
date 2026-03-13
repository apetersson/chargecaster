The hybrid forecast is the non-ML fallback in [demand-forecast.service.ts] It predicts `house_power_w` hour by hour from recent history, calendar structure, weather, solar context, and price, but without a trained CatBoost model.

It works in four layers:

1. **Hourly history aggregation**
   Historical raw measurements are grouped into hourly buckets by `aggregateHistoryByHour` in [demand-forecast.service.ts](chargecaster/backend/src/config/demand-forecast.service.ts).  
   For each hour it computes:
- average `home_power_w`
- average `solar_power_w`
- average `price_eur_per_kwh`

Then the service enriches those hours with weather from [weather.service.ts](chargecaster/backend/src/config/weather.service.ts):
- temperature
- cloud cover
- wind
- precipitation

2. **Baseline model**
   `buildBaselines` creates recency-weighted averages for:
- `weekday + hour`
- `season + hour`
- `hour only`

Newer history counts more than older history via exponential decay.  
Then `predictBaselineHousePower` blends those baselines:
- if all 3 exist: `hourWeek * 0.55 + seasonHour * 0.25 + hourOnly * 0.2`
- otherwise it falls back to whichever subset exists
- if nothing exists: `2200 W`

So this baseline is basically “what does the house usually consume around this kind of hour?”

3. **Nearest-neighbor similarity model**
   `predictFromNeighbors` searches historical hours that look similar to the target hour.

It scores each past hour by penalties for differences in:
- hour of day
- weekday/weekend
- season
- temperature
- cloud cover
- wind
- precipitation
- solar power
- price
- recent load context

Then it applies a recency weight and keeps the best neighbors.  
The weighted average of those similar historical hours becomes the neighbor prediction.

So this part says:  
“find past hours that looked like this upcoming hour in terms of weather, calendar, solar, and recent load.”

4. **Short-term correction and final blend**
   `buildHybridFallbackForecast` combines:
- the baseline forecast
- the neighbor forecast
- the recent 3-hour rolling mean
- a recent bias correction from the last 3 observed hours

The exact blend is:

- `baseline * 0.5`
- `neighbor * 0.35`
- `lag3 * 0.15`
- `recentBias * 0.4`

Then for the first forecast slot only, if live house load exists, it mixes that in too:
- `housePower = housePower * 0.55 + liveHomePowerW * 0.45`

After that it clamps the result into a sane range:
- minimum `150 W`
- maximum `15000 W`

There’s also a small confidence score from `computeConfidence`, but that’s only a rough metadata signal, not a probabilistic uncertainty model.

So in plain English, the hybrid says:

- start with “what is normal for this weekday/hour/season”
- adjust toward past hours that had similar weather, solar, and price
- nudge toward what the house has been doing in the last few hours
- correct for recent systematic over/under-baseline behavior
- anchor the first slot a bit to the current live load if available

That’s why it works fairly well even with limited data: it doesn’t need formal training, and it stays interpretable.