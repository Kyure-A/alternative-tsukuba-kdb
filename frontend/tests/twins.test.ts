import assert from "node:assert/strict";
import test from "node:test";

import {
  getDesiredTwinsCodes,
  getTwinsChanges,
  getTwinsTimeslotOverrides,
  isEditableTwinsModule,
  mergeTwinsCourses,
  parseTwinsApplyResult,
  parseTwinsPreview,
  parseTwinsSnapshot,
  projectTwinsTimetable,
  summarizeTwinsCourses,
  syncTwinsCourseBaseline,
  TWINS_MODULES,
  type TwinsEntry,
  type TwinsModule,
  type TwinsPlanBookmark,
  type TwinsSnapshot,
  twinsModuleFromTermCode,
  twinsTermCodeFromModule,
} from "../src/utils/twins.ts";

const entry = (overrides: Partial<TwinsEntry> = {}): TwinsEntry => ({
  module: "autumn-a",
  day: 0,
  period: 1,
  code: "GE10101",
  description: "情報学概論",
  intensive: false,
  ...overrides,
});

const snapshot = (entries: TwinsEntry[] = [entry()]): TwinsSnapshot => ({
  module: "autumn-a",
  observedAt: "2026-09-30T11:00:00+09:00",
  entries,
});

const bookmark = (overrides: Partial<TwinsPlanBookmark> = {}): TwinsPlanBookmark => ({
  year: 2026,
  ta: false,
  memos: ["/必修", null],
  ...overrides,
});

const snapshotSet = (entries: Partial<Record<TwinsModule, TwinsEntry[]>> = {}): Record<TwinsModule, TwinsSnapshot> =>
  Object.fromEntries(TWINS_MODULES.map((module) => [module, { ...snapshot(entries[module] ?? []), module }])) as Record<TwinsModule, TwinsSnapshot>;

test("snapshot parsing accepts empty descriptions and a genuine empty timetable", () => {
  assert.equal(parseTwinsSnapshot(snapshot([entry({ description: "" })])).entries.length, 1);
  assert.equal(parseTwinsSnapshot(snapshot([]), "autumn-a").entries.length, 0);
});

test("snapshot parsing rejects malformed values instead of converting them to empty state", () => {
  for (const invalid of [
    null,
    {},
    { ...snapshot(), observedAt: "yesterday" },
    { ...snapshot(), observedAt: "2026-99-99T11:00:00Z" },
    { ...snapshot(), module: "fall-a" },
    { ...snapshot(), entries: [{ ...entry(), code: " " }] },
    { ...snapshot(), entries: [{ ...entry(), day: "月曜日" }] },
    { ...snapshot(), entries: [entry({ day: -1 })] },
    { ...snapshot(), entries: [entry({ day: 7 })] },
    { ...snapshot(), entries: [entry({ period: 0 })] },
    { ...snapshot(), entries: [entry({ period: 10 })] },
    { ...snapshot(), entries: [entry({ period: 1.5 })] },
    { ...snapshot(), entries: [entry({ day: null })] },
    { ...snapshot(), entries: [entry({ intensive: true })] },
    { ...snapshot(), entries: [entry({ module: "spring-a" })] },
  ]) {
    assert.throws(() => parseTwinsSnapshot(invalid));
  }
  assert.throws(() => parseTwinsSnapshot(snapshot(), "spring-a"));
});

test("course summary deduplicates rows and reports unmatched courses", () => {
  const result = summarizeTwinsCourses(
    snapshot([
      entry(),
      entry({ period: 2 }),
      entry({ code: "UNLISTED" }),
      entry({ code: "UNLISTED", period: 3 }),
      entry({ code: "constructor" }),
    ]),
    { GE10101: {} },
  );
  assert.deepEqual(result, {
    codes: ["GE10101", "UNLISTED", "constructor"],
    matched: ["GE10101"],
    unknown: ["UNLISTED", "constructor"],
  });
});

test("TWINS slots project directly using zero-based days and one-based periods", () => {
  const monday = entry();
  const saturday = entry({ day: 5, period: 6, code: "GE10201" });
  const result = projectTwinsTimetable(snapshot([monday, monday, saturday]));
  assert.equal(result.table.length, 6);
  assert.equal(result.table[0].length, 6);
  assert.deepEqual(result.table[0][0], [monday]);
  assert.deepEqual(result.table[5][5], [saturday]);
  assert.deepEqual(result.table[0][1], []);
  assert.equal(result.table.flat().flat().length, 2);
});

test("overlapping courses are retained and multi-period rows stay in both periods", () => {
  const result = projectTwinsTimetable(snapshot([
    entry(),
    entry({ code: "GE10201" }),
    entry({ period: 2 }),
  ]));
  assert.deepEqual(result.table[0][0].map(({ code }) => code), ["GE10101", "GE10201"]);
  assert.deepEqual(result.table[0][1].map(({ code }) => code), ["GE10101"]);
});

test("intensive, Sunday and late-period courses remain visible outside the 6x6 grid", () => {
  const intensive = entry({ day: null, period: null, intensive: true });
  const sunday = entry({ day: 6 });
  const late = entry({ period: 9 });
  const observed = parseTwinsSnapshot(snapshot([intensive, intensive, sunday, late]));
  const compact = projectTwinsTimetable(observed);
  assert.deepEqual(compact.intensive, [intensive]);
  assert.deepEqual(compact.outsideGrid, [sunday, late]);
  const full = projectTwinsTimetable(observed, "autumn-a", { days: 7, periods: 9 });
  assert.deepEqual(full.table[6][0], [sunday]);
  assert.deepEqual(full.table[0][8], [late]);
  assert.deepEqual(full.outsideGrid, []);
});

test("a snapshot from another selected module never appears in the live grid", () => {
  const result = projectTwinsTimetable(snapshot(), "spring-a");
  assert.equal(result.table.flat().flat().length, 0);
  assert.deepEqual(result.intensive, []);
  assert.deepEqual(projectTwinsTimetable(null).outsideGrid, []);
});

test("observed per-course grids override KdB while unobserved courses retain fallback", () => {
  const overrides = getTwinsTimeslotOverrides(snapshot([
    entry({ day: 2, period: 3 }),
    entry({ day: 2, period: 3 }),
    entry({ day: 2, period: 4 }),
  ]), "autumn-a");
  assert.equal(overrides.GE10101[2][2], true);
  assert.equal(overrides.GE10101[2][3], true);
  assert.equal(overrides.GE10101[0][0], false);
  assert.equal(overrides.GE10101.flat().filter(Boolean).length, 2);
  assert.equal(overrides.UNOBSERVED, undefined);
  assert.deepEqual(getTwinsTimeslotOverrides(snapshot(), "spring-a"), {});
  assert.deepEqual(getTwinsTimeslotOverrides(undefined, "autumn-a"), {});
});

test("intensive and out-of-grid observations override rather than resurrect KdB slots", () => {
  const overrides = getTwinsTimeslotOverrides(snapshot([
    entry({ intensive: true, day: null, period: null }),
    entry({ code: "LATE", day: 6, period: 9 }),
  ]), "autumn-a");
  assert.ok(overrides.GE10101);
  assert.ok(overrides.LATE);
  assert.equal(overrides.GE10101.flat().some(Boolean), false);
  assert.equal(overrides.LATE.flat().some(Boolean), false);
});

test("all six normal module codes and the two supported breaks map explicitly", () => {
  for (let index = 0; index < 6; index++) {
    assert.equal(twinsModuleFromTermCode(index), TWINS_MODULES[index]);
    assert.equal(twinsTermCodeFromModule(TWINS_MODULES[index]), index);
    assert.equal(isEditableTwinsModule(TWINS_MODULES[index]), true);
  }
  assert.equal(twinsModuleFromTermCode(6), "spring-break");
  assert.equal(twinsModuleFromTermCode(7), "summer");
  assert.equal(twinsTermCodeFromModule("spring-break"), 6);
  assert.equal(twinsTermCodeFromModule("summer"), 7);
  assert.equal(isEditableTwinsModule("summer"), false);
  assert.equal(isEditableTwinsModule("spring-break"), false);
  for (const code of [-1, 8, 9, 0.5, Number.NaN]) {
    assert.equal(twinsModuleFromTermCode(code), null);
  }
});

test("desired codes follow every normal module, including grouped and year-round courses", () => {
  const catalog = {
    ALL: { code: "ALL", termCodes: [[0, 1, 2, 3, 4, 5]] },
    SPRING: { code: "SPRING", termCodes: [[0, 1], [2]] },
    AUTUMN: { code: "AUTUMN", termCodes: [[3], [4, 5]] },
    SUMMER: { code: "SUMMER", termCodes: [[7]] },
  };
  const subjects = Object.fromEntries(Object.keys(catalog).map((code) => [code, bookmark()]));
  for (let index = 0; index < 6; index++) {
    assert.deepEqual(
      getDesiredTwinsCodes(subjects, catalog, TWINS_MODULES[index], 2026),
      index < 3 ? ["ALL", "SPRING"] : ["ALL", "AUTUMN"],
    );
  }
  assert.deepEqual(getDesiredTwinsCodes(subjects, catalog, "summer", 2026), ["SUMMER"]);
});

test("desired codes exclude other years, TA roles, unknown courses and unmatched terms", () => {
  const subjects = {
    GOOD: bookmark(),
    PAST: bookmark({ year: 2025 }),
    FUTURE: bookmark({ year: 2027 }),
    TA: bookmark({ ta: true }),
    UNKNOWN: bookmark(),
    SPRING: bookmark(),
    constructor: bookmark(),
  };
  const catalog = Object.fromEntries(
    ["GOOD", "PAST", "FUTURE", "TA"].map((code) => [code, { code, termCodes: [[3]] }]),
  );
  catalog.SPRING = { code: "SPRING", termCodes: [[0]] };
  assert.deepEqual(getDesiredTwinsCodes(subjects, catalog, "autumn-a", 2026), ["GOOD"]);
});

test("live registered bookmarks survive catalog term mismatches without retaining other years or TA", () => {
  const subjects = {
    MISMATCH: bookmark(),
    MISSING: bookmark(),
    PAST: bookmark({ year: 2025 }),
    TA: bookmark({ ta: true }),
  };
  const catalog = {
    MISMATCH: { code: "MISMATCH", termCodes: [[0]] },
    PAST: { code: "PAST", termCodes: [[3]] },
    TA: { code: "TA", termCodes: [[3]] },
  };
  assert.deepEqual(
    getDesiredTwinsCodes(subjects, catalog, "autumn-a", 2026, ["MISMATCH", "MISSING", "PAST", "TA", "NOT_BOOKMARKED"]),
    ["MISMATCH", "MISSING"],
  );
});

test("import merges idempotently without overwriting notes, previous years or TA roles", () => {
  const subjects = {
    EXISTING: bookmark(),
    PAST: bookmark({ year: 2025 }),
    TA: bookmark({ ta: true }),
  };
  const original = structuredClone(subjects);
  const catalog = { EXISTING: {}, PAST: {}, TA: {}, NEW: {} };
  const codes = ["EXISTING", "PAST", "TA", "NEW", "NEW", "UNKNOWN"];
  const first = mergeTwinsCourses(subjects, codes, catalog, 2026);
  assert.deepEqual(subjects, original);
  assert.deepEqual(first.subjects.EXISTING, original.EXISTING);
  assert.deepEqual(first.subjects.PAST, original.PAST);
  assert.deepEqual(first.subjects.TA, original.TA);
  assert.deepEqual(first.subjects.NEW, { year: 2026, ta: false, memos: [""] });
  assert.deepEqual(first.report.added, ["NEW"]);
  assert.deepEqual(first.report.alreadyPresent, ["EXISTING"]);
  assert.deepEqual(first.report.unknown, ["UNKNOWN"]);
  assert.deepEqual(first.report.conflicts, [
    { code: "PAST", reason: "different-year", year: 2025 },
    { code: "TA", reason: "ta-role", year: 2026 },
  ]);
  const second = mergeTwinsCourses(first.subjects, codes, catalog, 2026);
  assert.deepEqual(second.subjects, first.subjects);
  assert.deepEqual(second.report.added, []);
});

test("complete initial sync imports all matched codes and stores a deduplicated baseline", () => {
  const synced = syncTwinsCourseBaseline({}, undefined, ["NEW", "NEW", "UNKNOWN"], { NEW: {} }, 2026);
  assert.deepEqual(synced.report.added, ["NEW"]);
  assert.deepEqual(synced.report.unknown, ["UNKNOWN"]);
  assert.deepEqual(synced.baseline, { year: 2026, codes: ["NEW", "UNKNOWN"] });
});

test("persisted baseline preserves pending cancellations after reload and imports newly observed courses", () => {
  const catalog = { REMOVED_LOCALLY: {}, KEPT: {}, NEW_REMOTE: {} };
  const initial = syncTwinsCourseBaseline({}, undefined, ["REMOVED_LOCALLY", "KEPT"], catalog, 2026);
  delete initial.subjects.REMOVED_LOCALLY;
  initial.subjects.KEPT.memos = ["my plan"];
  const reloaded = JSON.parse(JSON.stringify(initial));
  const next = syncTwinsCourseBaseline(reloaded.subjects, reloaded.baseline, ["REMOVED_LOCALLY", "KEPT", "NEW_REMOTE"], catalog, 2026);
  assert.equal(next.subjects.REMOVED_LOCALLY, undefined);
  assert.deepEqual(next.subjects.KEPT.memos, ["my plan"]);
  assert.deepEqual(next.report.added, ["NEW_REMOTE"]);
  const replay = syncTwinsCourseBaseline(next.subjects, next.baseline, next.baseline.codes, catalog, 2026);
  assert.deepEqual(replay.subjects, next.subjects);
  assert.deepEqual(replay.report.added, []);
});

test("keeping the baseline when clearing the plan preserves every pending cancellation", () => {
  const result = syncTwinsCourseBaseline({}, { year: 2026, codes: ["OLD"] }, ["OLD"], { OLD: {} }, 2026);
  assert.deepEqual(result.subjects, {});
  assert.deepEqual(result.report.added, []);
});

test("a previous-year baseline does not suppress current-year remote imports", () => {
  const result = syncTwinsCourseBaseline({}, { year: 2025, codes: ["COURSE"] }, ["COURSE"], { COURSE: {} }, 2026);
  assert.deepEqual(result.report.added, ["COURSE"]);
  assert.equal(result.subjects.COURSE.year, 2026);
  assert.equal(result.baseline.year, 2026);
});

test("pull adopts remote removals, archives notes and remains clean instead of proposing re-registration", () => {
  const planned = bookmark({ memos: ["course notes", null] });
  const catalog = { COURSE: { code: "COURSE", termCodes: [[3]] } };
  const result = syncTwinsCourseBaseline({ COURSE: planned }, { year: 2026, codes: ["COURSE"] }, [], catalog, 2026);
  assert.equal(result.subjects.COURSE, undefined);
  assert.deepEqual(result.report.removed, ["COURSE"]);
  assert.deepEqual(result.baseline.archivedSubjects?.COURSE, planned);
  assert.deepEqual(result.baseline.codes, []);
  assert.equal(getTwinsChanges(snapshotSet(), result.subjects, catalog, 2026, result.baseline).dirty, false);
  const reappeared = syncTwinsCourseBaseline(result.subjects, result.baseline, ["COURSE"], catalog, 2026);
  assert.deepEqual(reappeared.subjects.COURSE, planned);
  assert.deepEqual(reappeared.report.added, ["COURSE"]);
  assert.equal(reappeared.baseline.archivedSubjects, undefined);
});

test("pull preserves untracked local additions and pending cancellations while accepting remote deletions", () => {
  const subjects = { REMOTE_REMOVED: bookmark(), LOCAL_ADDED: bookmark(), HISTORIC: bookmark({ year: 2025 }), TA: bookmark({ ta: true }) };
  const catalog = Object.fromEntries(["REMOTE_REMOVED", "LOCAL_ADDED", "LOCAL_CANCELLED", "HISTORIC", "TA"].map((code) => [code, { code, termCodes: [[3]] }]));
  const result = syncTwinsCourseBaseline(subjects, { year: 2026, codes: ["REMOTE_REMOVED", "LOCAL_CANCELLED", "HISTORIC", "TA"] }, ["LOCAL_CANCELLED"], catalog, 2026);
  assert.deepEqual(result.report.removed, ["REMOTE_REMOVED"]);
  assert.deepEqual(result.subjects.LOCAL_ADDED, subjects.LOCAL_ADDED);
  assert.equal(result.subjects.LOCAL_CANCELLED, undefined);
  assert.deepEqual(result.subjects.HISTORIC, subjects.HISTORIC);
  assert.deepEqual(result.subjects.TA, subjects.TA);
  const changes = getTwinsChanges(snapshotSet({ "autumn-a": [entry({ code: "LOCAL_CANCELLED" })] }), result.subjects, catalog, 2026, result.baseline);
  assert.equal(changes.dirty, true);
  assert.deepEqual(changes.desiredByModule["autumn-a"], ["LOCAL_ADDED"]);
});

test("an imported course stays clean even when KdB lists broader or different modules", () => {
  const snapshots = snapshotSet({ "autumn-a": [entry(), entry({ period: 2 })] });
  const catalog = { GE10101: { code: "GE10101", termCodes: [[0, 1, 2, 3, 4, 5]] } };
  const result = getTwinsChanges(snapshots, { GE10101: bookmark() }, catalog, 2026, { year: 2026, codes: ["GE10101"] });
  assert.equal(result.dirty, false);
  assert.deepEqual(result.modules, []);
  assert.deepEqual(result.desiredByModule["autumn-a"], ["GE10101"]);
  assert.deepEqual(result.desiredByModule["spring-a"], []);
  assert.deepEqual(result.desiredByModule["autumn-b"], []);
});

test("pending cancellations are dirty only after the course has been imported into the baseline", () => {
  const snapshots = snapshotSet({ "autumn-a": [entry()] });
  const catalog = { GE10101: { code: "GE10101", termCodes: [[3]] } };
  assert.equal(getTwinsChanges(snapshots, {}, catalog, 2026).dirty, false);
  const result = getTwinsChanges(snapshots, {}, catalog, 2026, { year: 2026, codes: ["GE10101"] });
  assert.equal(result.dirty, true);
  assert.deepEqual(result.modules, ["autumn-a"]);
  assert.deepEqual(result.desiredByModule["autumn-a"], []);
});

test("new local courses mark every relevant editable module, regardless of the active tab", () => {
  const result = getTwinsChanges(snapshotSet(), { NEW: bookmark(), TA: bookmark({ ta: true }), OLD: bookmark({ year: 2025 }) }, {
    NEW: { code: "NEW", termCodes: [[0, 1], [4]] },
    TA: { code: "TA", termCodes: [[0]] },
    OLD: { code: "OLD", termCodes: [[0]] },
  }, 2026, { year: 2026, codes: [] });
  assert.equal(result.dirty, true);
  assert.deepEqual(result.modules, ["spring-a", "spring-b", "autumn-b"]);
  assert.deepEqual(result.desiredByModule["spring-a"], ["NEW"]);
  assert.deepEqual(result.desiredByModule["autumn-b"], ["NEW"]);
  assert.deepEqual(result.desiredByModule["autumn-a"], []);
});

test("unknown registered courses and conflicting historical or TA bookmarks do not create false changes", () => {
  const snapshots = snapshotSet({ "autumn-a": [entry({ code: "UNKNOWN" }), entry({ code: "PAST" }), entry({ code: "TA" })] });
  const catalog = { PAST: { code: "PAST", termCodes: [[3]] }, TA: { code: "TA", termCodes: [[3]] } };
  const result = getTwinsChanges(snapshots, { PAST: bookmark({ year: 2025 }), TA: bookmark({ ta: true }) }, catalog, 2026, { year: 2026, codes: ["UNKNOWN", "PAST", "TA"] });
  assert.equal(result.dirty, false);
  assert.deepEqual(result.desiredByModule["autumn-a"], ["PAST", "TA", "UNKNOWN"]);
});

test("an intensive registration in any module protects that code in every normal module", () => {
  const snapshots = snapshotSet({
    "autumn-a": [entry()],
    summer: [entry({ module: "summer", intensive: true, day: null, period: null })],
  });
  const result = getTwinsChanges(snapshots, {}, { GE10101: { code: "GE10101", termCodes: [[3], [7]] } }, 2026, { year: 2026, codes: ["GE10101"] });
  assert.equal(result.dirty, false);
  assert.deepEqual(result.desiredByModule["autumn-a"], ["GE10101"]);
  assert.equal(Object.keys(result.desiredByModule).length, 6);
});

test("missing remote snapshots never imply verified dirty state", () => {
  const result = getTwinsChanges({}, { NEW: bookmark() }, { NEW: { code: "NEW", termCodes: [[0]] } }, 2026);
  assert.equal(result.dirty, false);
  assert.deepEqual(result.modules, []);
});

const preview = () => ({
  id: "preview-1",
  expiresAt: "2026-09-30T11:10:00+09:00",
  academicYear: 2026,
  before: snapshot(),
  additions: [{ key: "add-1", kind: "add", code: "GE10201", name: "演習", module: "autumn-a", day: 0, period: 1 }],
  removals: [{ key: "remove-1", kind: "remove", code: "GE10101", name: "情報学概論", module: "autumn-a" }],
  blocked: [{ code: "GE10301", reason: "複数の候補があります" }],
});

test("preview parsing verifies module, academic year, operation keys and concrete addition slots", () => {
  assert.equal(parseTwinsPreview(preview(), "autumn-a", 2026).additions.length, 1);
  assert.throws(() => parseTwinsPreview(preview(), "spring-a", 2026));
  assert.throws(() => parseTwinsPreview(preview(), "autumn-a", 2025));
  const duplicate = preview();
  duplicate.removals[0].key = "add-1";
  assert.throws(() => parseTwinsPreview(duplicate));
  const crossModule = preview();
  crossModule.additions[0].module = "spring-a";
  assert.throws(() => parseTwinsPreview(crossModule));
  const invalidSlot = preview();
  invalidSlot.additions[0].period = 0;
  assert.throws(() => parseTwinsPreview(invalidSlot));
});

test("all-module previews allow operations outside the selected review module", () => {
  const global = { ...preview(), scope: "all" };
  global.additions[0].module = "spring-a";
  assert.equal(parseTwinsPreview(global, "autumn-a", 2026).additions[0].module, "spring-a");
  global.removals[0].key = global.additions[0].key;
  assert.throws(() => parseTwinsPreview(global));
});

test("apply parsing keeps partial/uncertain states and rejects verified results without observations", () => {
  const result = {
    status: "verified",
    operations: [{ key: "add-1", kind: "add", code: "GE10201", status: "verified" }],
    after: snapshot(),
  };
  assert.equal(parseTwinsApplyResult(result, "autumn-a").status, "verified");
  assert.throws(() => parseTwinsApplyResult(result, "spring-a"));
  assert.throws(() => parseTwinsApplyResult({ ...result, after: null }));
  assert.equal(parseTwinsApplyResult({ ...result, status: "uncertain", after: null }).status, "uncertain");
  assert.equal(parseTwinsApplyResult({ ...result, status: "partial" }).status, "partial");
});

test("apply accepts all-module observations only when all eight keys match their snapshots", () => {
  const snapshots = Object.fromEntries(TWINS_MODULES.map((module) => [module, { ...snapshot([]), module }]));
  const result = { status: "verified", operations: [], after: snapshot(), snapshots };
  assert.equal(Object.keys(parseTwinsApplyResult(result).snapshots ?? {}).length, 8);
  assert.equal(parseTwinsApplyResult({ ...result, snapshots: null }).snapshots, null);
  const missingModule = { ...snapshots };
  delete missingModule.summer;
  assert.throws(() => parseTwinsApplyResult({ ...result, snapshots: missingModule }));
  const wrongModule = { ...snapshots, summer: snapshots["spring-break"] };
  assert.throws(() => parseTwinsApplyResult({ ...result, snapshots: wrongModule }));
  assert.throws(() => parseTwinsApplyResult({ ...result, snapshots: { ...snapshots, unexpected: snapshot() } }));
});
