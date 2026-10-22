import assert from "node:assert/strict";
import test from "node:test";
import { applyAction, evolvePet, isColor, isTheme, petMood } from "../src/lib/game";

const stats = { hunger: 80, happiness: 80, energy: 80, cleanliness: 80 };
test("needs evolve by server elapsed time", () => {
  assert.deepEqual(evolvePet(stats, "2026-01-01T00:00:00Z", new Date("2026-01-01T02:00:00Z")), { hunger: 72, happiness: 74, energy: 76, cleanliness: 74 });
});
test("decay is bounded and future timestamps do not increase needs", () => {
  const now = new Date("2026-01-01T00:00:00Z");
  assert.deepEqual(evolvePet(stats, "2026-01-02T00:00:00Z", now), stats);
  assert.deepEqual(evolvePet(stats, "2025-01-01T00:00:00Z", now), { hunger: 0, happiness: 0, energy: 0, cleanliness: 0 });
});
test("care actions have costs and clamp stats", () => {
  assert.equal(applyAction(stats, "feed").hunger, 100);
  assert.equal(applyAction(stats, "play").energy, 68);
  assert.equal(applyAction(stats, "sleep").energy, 100);
  assert.equal(applyAction(stats, "clean").cleanliness, 100);
  assert.equal(applyAction({ ...stats, energy: 1 }, "play").energy, 0);
});
test("theme and color inputs reject unknown values and injection", () => {
  assert.ok(isTheme("meadow"));
  assert.ok(!isTheme("__proto__"));
  assert.ok(isColor("#a78bfa"));
  assert.ok(!isColor("red;background:url(x)"));
  assert.ok(!isColor("#fff"));
  assert.equal(petMood({ ...stats, hunger: 5 }), "Precisando de carinho");
});
