import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const dir = fileURLToPath(new URL("../../../.github/workflows/", import.meta.url));
const files = readdirSync(dir).filter((file) => file.endsWith(".yml"));

describe("workflow policy", () => {
  it("finds the workflows", () => {
    expect(files.length).toBeGreaterThan(0);
  });
  for (const file of files) {
    const text = readFileSync(dir + file, "utf8");
    it(`${file} sets a top-level permissions block`, () => {
      expect(text).toMatch(/^permissions:/m);
    });
    it(`${file} does not persist checkout credentials`, () => {
      const checkouts = text.match(/uses: actions\/checkout@/g) ?? [];
      const safe = text.match(/persist-credentials: false/g) ?? [];
      expect(safe.length).toBe(checkouts.length);
    });
  }
});
