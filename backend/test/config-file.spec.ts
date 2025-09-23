import { readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { describe, expect, it } from "vitest";

import { parseConfigDocument } from "../src/config/schemas";

const fixturePath = join(process.cwd(), "..", "config.local.yaml");

describe("config document parsing", () => {
  it("parses local config file", () => {
    const raw = readFileSync(fixturePath, "utf-8");
    const parsed = parseConfigDocument(YAML.parse(raw));

    expect(parsed.dry_run).toBe(true);
    expect(parsed.fronius?.host).toBeDefined();
    expect(parsed.battery?.capacity_kwh).toBeGreaterThan(0);
  });
});
