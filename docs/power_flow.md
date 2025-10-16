# Power Flow Rules and Constraints

Date: 2025-10-16

This document defines how Chargecaster models electrical power flows between the grid, PV array, battery, and house load. It captures regulatory constraints, hardware limits, and decision rules implemented in the current simulator and reflected in the UI.

## Scope
- Applies to the backend simulation (optimum schedule and oracle entries) and the frontend visualisation of tariff/strategy.
- Focuses on single-home, AC-coupled PV + battery with grid connection.

## Key Terms and Symbols
- BP: Base house load (W), from `logic.house_load_w`.
- PV: PV power (W) during the slot (we work in energy internally; formulas below use power for clarity).
- r: Direct-use ratio in [0,1], from `solar.direct_use_ratio`.

[//]: # (todo check PVdirect and EP logic)
- PVdirect = min(BP, r · PV) — PV consumed instantly by the house. 
- EP = BP − PVdirect — expected residual house load after direct PV.
- PVavail = max(0, PV − PVdirect) — PV available for battery or feed-in.
- BC — battery charge power for the slot (W). Positive = charge, negative = discharge.
- FI — feed-in power (W). Positive = export to grid, negative = import from grid.
- Grid power = −FI = EP + BC − PVavail.
- Slot duration: typically 60 min price slots; the simulator handles variable slot lengths.

## Regulatory Constraints
- Battery MUST NOT discharge to the grid.
  - If `logic.allow_battery_export = false`, the optimizer forbids any schedule that would export battery-origin energy beyond the PV-only baseline.
  - PV-only export (surplus after direct use and battery solar charge) is allowed only when the battery cannot accept more solar this slot or is considered full (see “PV-first before feed‑in”).

## Hardware/Configuration Limits
- Battery energy capacity: `battery.capacity_kwh`.
- Battery discharge cap: `battery.max_discharge_power_w` (W).
  - 0 disables discharge entirely. When >0, discharge serves the house load only; never to grid.
- Battery charge caps (per slot):
  - From grid: `battery.max_charge_power_w` (W).
  - From PV: `battery.max_charge_power_solar_w` (W).
  - Total: we do not configure an explicit total cap; instead, the simulator enforces “solar‑first” and then allows the grid to fill only the shortfall, each within its own cap.
- SOC floor in auto mode: `battery.auto_mode_floor_soc` (%).
- SOC charging ceiling: `battery.max_charge_soc` (%) (optional; defaults to 100 if not set).
  - Product intent: avoid calibration losses near 100% by capping routine charging (e.g., 95%).

## PV‑First Before Feed‑In (Export)
- Rule (hard constraint): If a candidate plan would export energy (FI > 0), export is suppressed whenever the battery can still accept additional solar charge in the current slot.
  - “Can still accept” means BOTH:
    - SOC headroom remains relative to 100% SOC (the routine ceiling `max_charge_soc` does NOT prevent PV-only charging for the purpose of avoiding feed‑in), AND
    - PV charging headroom exists this slot (bounded by `max_charge_power_solar_w`, available PV, and slot duration).
- The simulator enforces this by increasing PV-only charging (ignoring `max_charge_soc` up to 100%) so that grid power is non‑negative in those slots.
- Only after this PV headroom is saturated or the battery reaches 100% may export occur (PV-only export).
- The above rule applies in both “auto” and “charge” strategies.

## Solar‑First Charge Split (Source Priority)
- When BC > 0 in a slot, the simulator allocates charging as:
  1) From PV up to the per‑slot PV limit and available PV: `BC_solar = min(BC, PVavail, PV_cap_slot)`.
  2) From grid only for the remainder: `BC_grid = min(BC − BC_solar, Grid_cap_slot)`.
- This guarantees the grid only provides charge that PV could not supply in that slot.

## Mode Semantics
- Auto mode
  - Primary goal: minimize cost while respecting constraints above.
  - Surplus PV always prefers battery charge up to caps/SOC headroom before any feed‑in.
  - Discharge (if enabled via `max_discharge_power_w > 0`) may cover house load but never creates export.
- Charge mode
  - Intent: raise SOC cost‑effectively; still respects solar‑first then grid fill and all export rules.

## Cost & Tariffs
- Import cost uses the energy price plus grid fee:
  - Import price per kWh = `slot.price_eur_per_kwh + price.grid_fee_eur_per_kwh`.
- Feed‑in revenue uses only the feed‑in tariff:
  - Export price per kWh = `price.feed_in_tariff_eur_per_kwh`.
- Grid fee is NOT applied to exported energy.
- When available in the source state, a snapshot price may provide a default grid fee; otherwise, configure it explicitly.

## Slot Math Recap
- Given BP, PV, and r:
  - PVdirect = min(BP, r · PV)
  - EP = BP − PVdirect
  - PVavail = max(0, PV − PVdirect)
- Battery charge in a slot:
  - Auto: `BC = clamp(PVavail − EP, −Pdis_cap, +Ppv_cap)` subject to SOC headroom and export rules.
  - Charge: choose BC ≥ 0 within caps/headroom; PV covers first, grid fills any remaining up to `max_charge_power_w`.
- Feed‑in and grid power:
  - FI = PVavail − EP − BC (positive export / negative import)
  - Grid power = −FI = EP + BC − PVavail

## Special Cases & Invariants
- No battery‑origin export to grid when `allow_battery_export = false`.
- PV-only export allowed only after PV charging headroom is saturated for the slot (or battery considered full for charging).
- With `max_charge_soc` set below 100%, export may appear once SOC reaches that configured ceiling; set it to 100% to fully suppress export prior to full charge.
- Simulator sanity guardrails (tests) ensure grid power magnitudes remain within realistic bounds.

## Frontend Visualisation Conventions
- Tariff bars tint by recommended strategy for each future slot:
  - Auto: slightly pink‑ish blue
  - Charge: slightly green‑ish blue
- Grid, solar, and SOC series follow consistent color palettes. History vs forecast segments are styled distinctly.

## Examples (Worked)
- Example: PV = 3140.18 W, BP = 2200 W, r = 0.6
  - PVdirect = min(2200, 0.6·3140.18) = 1884.108 W
  - EP = 2200 − 1884.108 = 315.892 W
  - PVavail = 3140.18 − 1884.108 = 1256.072 W
  - Auto/Charge with ample PV cap and SOC headroom:
    - Prefer PV charge up to requested BC; if BC ≤ 1256 W, grid import = 0 and FI = 1256 − BC − 315.9.
    - If BC equals the PV surplus (≈ 940 W to eliminate export), FI ≈ 0, grid import = 0.

## Configuration Summary
- battery
  - `capacity_kwh`
  - `max_charge_power_w` (grid charge cap)
  - `max_charge_power_solar_w` (PV charge cap)
  - `max_discharge_power_w` (0 disables discharge)
  - `auto_mode_floor_soc` (auto mode floor %)
  - `max_charge_soc` (routine charge ceiling %, optional; default 100)
- price
  - `grid_fee_eur_per_kwh`
  - `feed_in_tariff_eur_per_kwh`
- logic
  - `house_load_w`
  - `interval_seconds`
  - `allow_battery_export` (false forbids battery‑origin export)
- solar
  - `direct_use_ratio`

## Product Notes / Decisions
- PV-first before feed‑in is a hard rule driven by regulation and homeowner priority on self‑consumption.
- Configurable `max_charge_soc` enables avoiding 100% calibration cycles; consider pairing with a policy toggle if you want feed‑in gating tied strictly to 100% SOC regardless of the configured charging ceiling.
- No explicit total charge cap is modeled; instead, PV and grid caps are applied with solar‑first sourcing and export gating.
