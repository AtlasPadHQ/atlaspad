import { strict as assert } from "node:assert";
import { test } from "node:test";
import { vectors } from "../scripts/gen-vectors.ts";
import V from "./vectors.json" with { type: "json" };

test("committed test/vectors.json equals the generator output (regenerate with `npm run vectors`)", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(vectors())), V);
});

test("vectors cover all 16 instructions", () => {
  const discs = new Set(V.instructions.map((i) => parseInt(i.dataHex.slice(0, 2), 16)));
  assert.deepEqual([...discs].sort((a, b) => a - b), [...Array(16).keys()]);
});
