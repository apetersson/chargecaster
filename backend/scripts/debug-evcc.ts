import { extractForecastFromState, extractSolarForecastFromState } from "../src/simulation/simulation.service";

const chunks: Buffer[] = [];
process.stdin.on("data", (chunk) => chunks.push(chunk as Buffer));
process.stdin.on("end", () => {
  const raw = Buffer.concat(chunks).toString("utf-8");
  const state = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  const forecast = extractForecastFromState(state);
  const solar = extractSolarForecastFromState(state);
  console.log(JSON.stringify({ forecastLength: forecast.length, solarLength: solar.length, firstSolar: solar[0] ?? null }, null, 2));
});
process.stdin.resume();
