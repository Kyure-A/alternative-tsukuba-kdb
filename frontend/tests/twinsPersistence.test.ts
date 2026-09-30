import assert from "node:assert/strict";
import test from "node:test";

import { BOOKMARKS_KEY, bookmarksSchema } from "../src/utils/bookmarkStorage.ts";
import {
  getTwinsChanges,
  syncTwinsCourseBaseline,
  TWINS_MODULES,
  type TwinsCatalogSubject,
  type TwinsSnapshot,
} from "../src/utils/twins.ts";
import { clearTwinsCache, readTwinsCache, saveTwinsCache, TWINS_CACHE_KEY } from "../src/utils/twinsCache.ts";
import { handleTwinsApplyFailure, requestTwins } from "../src/utils/twinsRequest.ts";

const catalog: Record<string, TwinsCatalogSubject> = {
  REMOTE_CANCEL: { code: "REMOTE_CANCEL", termCodes: [[3, 4]] },
  REMOTE_KEEP: { code: "REMOTE_KEEP", termCodes: [[3]] },
  LOCAL_ADD: { code: "LOCAL_ADD", termCodes: [[0, 1]] },
};

function createDraftFixture() {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  const snapshots = Object.fromEntries(TWINS_MODULES.map((module) => {
    const codes = module === "autumn-a" ? ["REMOTE_CANCEL", "REMOTE_KEEP"] : module === "autumn-b" ? ["REMOTE_CANCEL"] : [];
    const snapshot: TwinsSnapshot = {
      module,
      observedAt: "2026-09-30T12:00:00Z",
      entries: codes.map((code, index) => ({ module, code, description: code, day: 0, period: index + 1, intensive: false })),
    };
    return [module, snapshot];
  }));
  saveTwinsCache(storage, 2026, snapshots);
  const synced = syncTwinsCourseBaseline({}, undefined, ["REMOTE_CANCEL", "REMOTE_KEEP"], catalog, 2026);
  const draft = bookmarksSchema.parse({ version: 1, subjects: synced.subjects, memoHeaders: ["notes"], twinsBaseline: synced.baseline });
  delete draft.subjects.REMOTE_CANCEL;
  draft.subjects.LOCAL_ADD = { year: 2026, ta: false, memos: ["unsent addition", null] };
  draft.subjects.REMOTE_KEEP.memos = ["keep this memo"];
  storage.setItem(BOOKMARKS_KEY, JSON.stringify(draft));
  return { storage, draft };
}

function reloadAndReplayCachedImport(storage: ReturnType<typeof createDraftFixture>["storage"]) {
  // This is the same schema/cache/reconciliation sequence used by useBookmark,
  // useTwins initialization and App's importCodes effect after a full page load.
  const bookmarks = bookmarksSchema.parse(JSON.parse(storage.getItem(BOOKMARKS_KEY) ?? "null"));
  const snapshots = readTwinsCache(storage, 2026);
  assert.ok(snapshots, "a valid cache avoids the fresh-read branch in useTwins");
  const codes = [...new Set(Object.values(snapshots).flatMap((snapshot) => snapshot.entries.map(({ code }) => code)))];
  const replay = syncTwinsCourseBaseline(bookmarks.subjects, bookmarks.twinsBaseline, codes, catalog, 2026);
  const restored = { ...bookmarks, subjects: replay.subjects, twinsBaseline: replay.baseline };
  storage.setItem(BOOKMARKS_KEY, JSON.stringify(restored));
  return { restored, replay, changes: getTwinsChanges(snapshots, restored.subjects, catalog, 2026, restored.twinsBaseline) };
}

test("pending addition and cancellation both survive storage reload and cached baseline replay", () => {
  const { storage, draft } = createDraftFixture();
  const cachedAuthority = storage.getItem(TWINS_CACHE_KEY);
  for (let reload = 0; reload < 2; reload++) {
    const { restored, replay, changes } = reloadAndReplayCachedImport(storage);
    assert.deepEqual(restored, draft);
    assert.equal(restored.subjects.REMOTE_CANCEL, undefined);
    assert.deepEqual(restored.subjects.LOCAL_ADD.memos, ["unsent addition", null]);
    assert.deepEqual(replay.report.added, []);
    assert.deepEqual(replay.report.removed, []);
    assert.equal(changes.dirty, true);
    assert.deepEqual(changes.modules, ["spring-a", "spring-b", "autumn-a", "autumn-b"]);
    assert.deepEqual(changes.desiredByModule["spring-a"], ["LOCAL_ADD"]);
    assert.deepEqual(changes.desiredByModule["spring-b"], ["LOCAL_ADD"]);
    assert.deepEqual(changes.desiredByModule["autumn-a"], ["REMOTE_KEEP"]);
    assert.deepEqual(changes.desiredByModule["autumn-b"], []);
    assert.equal(storage.getItem(TWINS_CACHE_KEY), cachedAuthority);
  }
});

test("a not_started apply failure preserves both drafts and the cached authority through reload", async () => {
  const { storage, draft } = createDraftFixture();
  const beforePlan = storage.getItem(BOOKMARKS_KEY);
  const beforeCache = storage.getItem(TWINS_CACHE_KEY);
  const fetcher: typeof fetch = async () => new Response(JSON.stringify({ error: {
    code: "cli_preflight_failed", message: "事前確認に失敗しました。", mutationState: "not_started",
  } }), { status: 502 });
  await assert.rejects(requestTwins("apply", { id: "fixture", actionKeys: ["add", "remove"], academicYear: 2026 }, fetcher), (cause: unknown) => {
    const failure = handleTwinsApplyFailure(cause, () => clearTwinsCache(storage));
    assert.equal(failure.mutationState, "not_started");
    return true;
  });
  assert.equal(storage.getItem(BOOKMARKS_KEY), beforePlan);
  assert.equal(storage.getItem(TWINS_CACHE_KEY), beforeCache);
  const { restored, changes } = reloadAndReplayCachedImport(storage);
  assert.deepEqual(restored, draft);
  assert.equal(changes.dirty, true);
  assert.deepEqual(changes.modules, ["spring-a", "spring-b", "autumn-a", "autumn-b"]);
});
