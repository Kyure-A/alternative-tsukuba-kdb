import assert from "node:assert/strict";
import test from "node:test";
import { TWINS_MODULES } from "../src/utils/twins.ts";
import { clearTwinsCache, readTwinsCache, saveTwinsCache, TWINS_CACHE_KEY } from "../src/utils/twinsCache.ts";

function storage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  };
}
const snapshots = Object.fromEntries(TWINS_MODULES.map((module) => [module, {
  module, observedAt: "2026-09-30T00:00:00Z", entries: [],
}]));

test("a complete cached timetable restores synchronously from local storage", () => {
  const saved = storage();
  assert.equal(readTwinsCache(saved, 2026), null);
  saveTwinsCache(saved, 2026, snapshots);
  assert.deepEqual(readTwinsCache(saved, 2026), snapshots);
  assert.deepEqual(readTwinsCache(saved, 2026), snapshots);
});

test("wrong-year and corrupt caches require a fresh read", () => {
  const saved = storage();
  saveTwinsCache(saved, 2026, snapshots);
  assert.equal(readTwinsCache(saved, 2027), null);
  saved.setItem(TWINS_CACHE_KEY, "broken");
  assert.equal(readTwinsCache(saved, 2026), null);
});

test("a partial snapshot never overwrites a complete cache", () => {
  const saved = storage();
  saveTwinsCache(saved, 2026, snapshots);
  assert.throws(() => saveTwinsCache(saved, 2026, { "spring-a": snapshots["spring-a"] }));
  assert.deepEqual(readTwinsCache(saved, 2026), snapshots);
});

test("invalid module identities cannot be restored", () => {
  const saved = storage();
  saved.setItem(TWINS_CACHE_KEY, JSON.stringify({ schemaVersion: 1, academicYear: 2026, snapshots: { ...snapshots, "spring-a": snapshots["autumn-a"] } }));
  assert.equal(readTwinsCache(saved, 2026), null);
});

test("unknown write outcomes invalidate the cached authority", () => {
  const saved = storage();
  saveTwinsCache(saved, 2026, snapshots);
  clearTwinsCache(saved);
  assert.equal(readTwinsCache(saved, 2026), null);
});
