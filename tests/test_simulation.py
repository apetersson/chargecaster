import json
import unittest
import logging
from pathlib import Path

import core


logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO)


class SimulationTest(unittest.TestCase):
    def setUp(self):
        self.cfg = {
            "battery": {
                "capacity_kwh": 12.0,
                "max_charge_power_w": 500,
                "auto_mode_floor_soc": 5,
            },
            "price": {
                "network_tariff_eur_per_kwh": 0.02,
            },
            "logic": {
                "interval_seconds": 300,
                "min_hold_minutes": 20,
                "house_load_w": 1200,
            },
            "state": {
                "path": "./tmp/state.csv",
            },
        }
        state_file = Path(__file__).parent / "sample_data.json"
        self.raw_state = json.loads(state_file.read_text())
        self.live = {"battery_soc": self.raw_state.get("batterySoc", 40.0)}
        self.cfg["price"]["network_tariff_eur_per_kwh"] = float(self.raw_state.get("tariffGrid", 0.02))
        raw_slots = core.extract_forecast_from_state(self.raw_state)
        self.raw_prices = core.normalize_price_slots(raw_slots)
        logger.info("simulation setup: cfg=%s live=%s forecast_slots=%d", self.cfg, self.live, len(self.raw_prices))

    def test_optimal_soc_high_tariff_window(self):
        slots = self.raw_prices
        house_load_w = float(self.cfg["logic"]["house_load_w"])  # default consumption
        result = core.simulate_optimal_schedule(self.cfg, self.live, slots, house_load_w=house_load_w)
        logger.info("simulation result: initial_soc=%.2f recommended_soc=%.2f projected_cost=%.2f",
                    result["initial_soc_percent"],
                    result["recommended_soc_percent"],
                    result["projected_cost_eur"])
        self.assertGreaterEqual(result["recommended_soc_percent"], 0)
        self.assertLessEqual(result["recommended_soc_percent"], 100)
        self.assertLessEqual(result["recommended_soc_percent"], self.live["battery_soc"])
        self.assertEqual(result["forecast_samples"], len(slots))
        self.assertEqual(result["simulation_runs"], 100)
        self.assertGreater(result["projected_cost_eur"], 0.0)

    def test_hourly_projection_sequence(self):
        slots = self.raw_prices
        self.assertGreater(len(slots), 0)

        horizon_results = []
        current_soc = float(self.live["battery_soc"])

        house_load_w = float(self.cfg["logic"]["house_load_w"])

        for idx, slot in enumerate(slots[:12]):
            window = slots[idx:]
            live_state = {"battery_soc": current_soc}
            result = core.simulate_optimal_schedule(self.cfg, live_state, window, house_load_w=house_load_w)
            horizon_results.append((slot["start"], result["recommended_soc_percent"]))
            current_soc = result["next_step_soc_percent"]

        self.assertEqual(len(horizon_results), 12)
        for ts, soc in horizon_results:
            self.assertIsNotNone(ts)
            self.assertGreaterEqual(soc, 0.0)
            self.assertLessEqual(soc, 100.0)


if __name__ == "__main__":
    unittest.main()
