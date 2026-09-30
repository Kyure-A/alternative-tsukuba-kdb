import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCatalog, MODULES, normalizeSnapshot, normalizeSnapshots, additionFor } from "./catalog.mjs";
import { BridgeError } from "./runner.mjs";
import { createTwinsService, createJournal } from "./service.mjs";

const MODULE = "autumn-a";
const desiredModules = (overrides = {}) => Object.fromEntries(
  Object.keys(MODULES).filter((module) => module !== "summer" && module !== "spring-break")
    .map((module) => [module, overrides[module] ?? []]),
);
const row = (code, term = "秋A", schedule = "月1,2") => [code, `Course ${code}`, "1", "1", "1", term, schedule];
const rawEntry = (code, module = MODULE, intensive = false) => ({
  code,
  module: MODULES[module],
  day: intensive ? "その他" : "月曜日",
  period: intensive ? "その他" : "1限",
  description: `Course ${code}`,
  intensive,
});
function fixture(options = {}) {
  const state = Object.fromEntries(Object.keys(MODULES).map((module) => [module, []]));
  state[MODULE] = [rawEntry("A"), rawEntry("B")];
  const calls = [];
  const journal = [];
  let counter = 0;
  const catalog = createCatalog([{ subject: options.rows ?? [row("A"), row("B"), row("C"), row("D")] }]);
  const run = async (operation) => {
    calls.push(operation);
    if (operation.kind === "read" || operation.kind === "read-all") {
      options.onRead?.(operation, calls);
      if (options.failRead?.(operation, calls)) throw new BridgeError("cli_failed", "fixture read failure", 502);
      return JSON.stringify(operation.kind === "read-all" ? { snapshots: state } : state[operation.module]);
    }
    if (options.mutate) return options.mutate(operation, state);
    if (operation.kind === "add") state[operation.module].push(rawEntry(operation.code, operation.module));
    else state[operation.module] = state[operation.module].filter((entry) => entry.code !== operation.code);
    return "success";
  };
  const service = createTwinsService({
    run,
    catalog,
    journal: options.journal ?? (async (entry) => { journal.push(entry); }),
    now: options.now ?? (() => new Date("2026-09-30T04:00:00Z")),
    id: () => `plan-${++counter}`,
    planTtlMs: options.planTtlMs,
  });
  const preview = (desiredCodes) => service.preview({ module: MODULE, academicYear: 2026, desiredByModule: desiredModules({ [MODULE]: desiredCodes }) });
  const apply = (plan, actionKeys) => service.apply({ id: plan.id, actionKeys, academicYear: 2026 });
  return { service, state, calls, journal, preview, apply };
}

test("fresh preview reads all modules and apply removes only explicitly selected course", async () => {
  const f = fixture();
  const plan = await f.preview(["C"]);
  assert.deepEqual(f.calls, [{ kind: "read-all" }]);
  assert.deepEqual(plan.additions.map((action) => action.code), ["C"]);
  assert.deepEqual(plan.removals.map((action) => action.code), ["A", "B"]);
  const result = await f.apply(plan, ["remove:A", "add:C"]);
  assert.equal(result.status, "verified");
  assert.deepEqual(f.calls.filter((call) => call.kind === "add" || call.kind === "remove").map((call) => `${call.kind}:${call.code}`), ["add:C", "remove:A"]);
  assert.deepEqual(result.after.entries.map((entry) => entry.code), ["B", "C"]);
  assert.deepEqual(Object.keys(result.snapshots), Object.keys(MODULES));
  assert.deepEqual(result.snapshots[MODULE], result.after);
  assert.equal(f.calls.filter((call) => call.kind === "read-all").length, 3);
  assert.equal(f.journal[0].kind, "consumed");
  assert.equal(f.journal.at(-1).kind, "result");
});

test("change in any module invalidates a preview before writing", async () => {
  const f = fixture();
  const plan = await f.preview(["A", "B", "C"]);
  f.state["spring-b"].push(rawEntry("D", "spring-b"));
  await assert.rejects(f.apply(plan, ["add:C"]), { code: "stale_plan", status: 409, mutationState: "not_started" });
  assert.equal(f.calls.filter((call) => call.kind === "add" || call.kind === "remove").length, 0);
  await assert.rejects(f.apply(plan, ["add:C"]), { code: "expired_plan" });
});

test("missing preflight read consumes plan but never writes", async () => {
  const f = fixture({ failRead: (_op, calls) => calls.length === 2 });
  const plan = await f.preview(["A", "B", "C"]);
  await assert.rejects(f.apply(plan, ["add:C"]), { code: "preflight_failed", status: 409, mutationState: "not_started" });
  assert.equal(f.calls.filter((call) => call.kind === "add" || call.kind === "remove").length, 0);
});

test("failure stops the batch, preserves unselected courses, and verifies actual partial state", async () => {
  const f = fixture({ mutate: (operation, state) => {
    if (operation.code === "D") throw new BridgeError("cli_failed", "fixture write failure", 502);
    state[operation.module].push(rawEntry(operation.code));
  } });
  const plan = await f.preview(["C", "D"]);
  const result = await f.apply(plan, ["add:C", "add:D", "remove:A"]);
  assert.equal(result.status, "partial");
  assert.deepEqual(result.operations.map((operation) => operation.status), ["verified", "failed", "skipped"]);
  assert.deepEqual(result.after.entries.map((entry) => entry.code), ["A", "B", "C"]);
  assert.deepEqual(f.calls.filter((call) => call.kind === "add" || call.kind === "remove").map((call) => call.code), ["C", "D"]);
  await assert.rejects(f.apply(plan, ["add:D"]), { code: "expired_plan" });
});

test("write may complete before a CLI failure; independent reads establish actual result without retry", async () => {
  const f = fixture({ mutate: (operation, state) => {
    state[operation.module].push(rawEntry(operation.code));
    throw new BridgeError("cli_timeout", "fixture timeout", 502);
  } });
  const plan = await f.preview(["A", "B", "C"]);
  const result = await f.apply(plan, ["add:C"]);
  assert.equal(result.status, "verified");
  assert.equal(result.operations[0].status, "verified");
  assert.equal(f.calls.filter((call) => call.kind === "add" || call.kind === "remove").length, 1);
});

test("unverifiable write is uncertain and never automatically retried", async () => {
  const f = fixture({ failRead: (_op, calls) => calls.some((call) => call.kind === "add") });
  const plan = await f.preview(["A", "B", "C"]);
  const result = await f.apply(plan, ["add:C"]);
  assert.equal(result.status, "uncertain");
  assert.equal(result.after, null);
  assert.equal(result.snapshots, null);
  assert.equal(result.operations[0].status, "uncertain");
  assert.equal(f.calls.filter((call) => call.kind === "add" || call.kind === "remove").length, 1);
});

test("unexpected cross-module modification to unselected course marks outcome uncertain", async () => {
  const f = fixture({ mutate: (operation, state) => {
    state[operation.module].push(rawEntry(operation.code));
    state["spring-a"].push(rawEntry("A", "spring-a"));
  } });
  const plan = await f.preview(["A", "B", "C"]);
  const result = await f.apply(plan, ["add:C"]);
  assert.equal(result.status, "uncertain");
  assert.equal(result.operations[0].status, "uncertain");
});

test("unknown regular courses require explicit removal; existing intensive course stays protected", async () => {
  const f = fixture();
  f.state[MODULE].push(rawEntry("UNKNOWN"), rawEntry("INTENSIVE", MODULE, true));
  const plan = await f.preview(["A", "B"]);
  assert.deepEqual(plan.removals.map((action) => action.code), ["UNKNOWN"]);
  assert.equal(plan.blocked[0].code, "INTENSIVE");
  const result = await f.apply(plan, ["remove:UNKNOWN"]);
  assert.equal(result.status, "verified");
  assert.ok(result.after.entries.some((entry) => entry.code === "INTENSIVE"));
});

test("invented operations, duplicate codes, empty actions, wrong year and holiday writes are rejected", async () => {
  const f = fixture();
  await assert.rejects(async () => f.preview(["A", "A"]), { code: "invalid_request" });
  await assert.rejects(async () => f.preview(["--eval"]), { code: "invalid_code" });
  await assert.rejects(async () => f.service.preview({ module: "summer", academicYear: 2026, desiredByModule: desiredModules() }), { code: "invalid_module" });
  const plan = await f.preview(["C"]);
  await assert.rejects(f.apply(plan, ["remove:INVENTED"]), { code: "invalid_actions" });
  await assert.rejects(async () => f.apply(plan, []), { code: "no_actions" });
  await assert.rejects(async () => f.service.apply({ id: plan.id, actionKeys: ["add:C"], academicYear: 2025 }), { code: "academic_year_mismatch" });
  assert.equal(f.calls.filter((call) => call.kind === "add" || call.kind === "remove").length, 0);
});

test("plan expiration and JST academic-year rollover block edits", async () => {
  let now = new Date("2026-09-30T04:00:00Z");
  const f = fixture({ now: () => now, planTtlMs: 100 });
  const plan = await f.preview(["A", "B", "C"]);
  now = new Date(now.getTime() + 101);
  await assert.rejects(f.apply(plan, ["add:C"]), { code: "expired_plan" });
  now = new Date("2027-03-31T15:00:00Z");
  await assert.rejects(async () => f.preview(["C"]), { code: "academic_year_mismatch" });
  // Read-only import remains available even when editing the old dataset is blocked.
  assert.equal((await f.service.timetable(MODULE)).module, MODULE);
});

test("journal must persist consumed plan before mutations", async () => {
  const f = fixture({ journal: async () => { throw new Error("disk full"); } });
  const plan = await f.preview(["A", "B", "C"]);
  await assert.rejects(f.apply(plan, ["add:C"]), { code: "journal_unavailable" });
  assert.equal(f.calls.filter((call) => call.kind === "add" || call.kind === "remove").length, 0);
  await assert.rejects(f.apply(plan, ["add:C"]), { code: "expired_plan" });
});

test("journal directory and file have private permissions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "twins-journal-"));
  try {
    const directory = path.join(root, ".twins-state.local");
    const journal = await createJournal(directory);
    await journal({ kind: "fixture" });
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(directory, "operations.jsonl"))).mode & 0o777, 0o600);
    assert.equal(JSON.parse(await readFile(path.join(directory, "operations.jsonl"), "utf8")).kind, "fixture");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("catalog resolves selected-module slots and blocks intensive or ambiguous schedules", () => {
  const catalog = createCatalog([{ subject: [
    row("SWITCH", "春AB\n秋ABC", "月2\n金5,6"),
    row("INTENSIVE", "秋ABC", "集中"),
    row("AMBIGUOUS", "春A\n秋A\n秋B", "月1\n金5"),
    row("SEMESTER", "秋学期", "木3-5"),
  ] }]);
  assert.deepEqual(additionFor(catalog, "SWITCH", MODULE), {
    key: "add:SWITCH", kind: "add", code: "SWITCH", name: "Course SWITCH", catalogTerm: "春AB\n秋ABC", expectedModules: ["spring-a", "spring-b", "autumn-a", "autumn-b", "autumn-c"], module: MODULE, day: 4, period: 5,
  });
  assert.ok(additionFor(catalog, "INTENSIVE", MODULE).reason);
  assert.ok(additionFor(catalog, "AMBIGUOUS", MODULE).reason);
  assert.equal(additionFor(catalog, "SEMESTER", MODULE).day, 3);
});

test("snapshot normalization rejects unexpected labels, module mismatch and HTML without guessing", () => {
  const now = new Date("2026-09-30T04:00:00Z");
  assert.equal(normalizeSnapshot([rawEntry("A")], MODULE, now).entries[0].day, 0);
  assert.equal(normalizeSnapshot([rawEntry("I", MODULE, true)], MODULE, now).entries[0].day, null);
  assert.throws(() => normalizeSnapshot([{ ...rawEntry("A"), day: "unknown" }], MODULE, now), { code: "unsupported_snapshot" });
  assert.throws(() => normalizeSnapshot([rawEntry("A", "spring-a")], MODULE, now), { code: "invalid_snapshot" });
  assert.throws(() => normalizeSnapshot("<html>Login</html>", MODULE, now), { code: "invalid_snapshot" });
});


test("an add is not verified when catalog expected modules are missing", async () => {
  const f = fixture({ rows: [row("A"), row("B"), row("C", "秋ABC")] });
  const plan = await f.preview(["A", "B", "C"]);
  assert.deepEqual(plan.additions[0].expectedModules, ["autumn-a", "autumn-b", "autumn-c"]);
  const result = await f.apply(plan, ["add:C"]);
  assert.equal(result.status, "partial");
  assert.equal(result.operations[0].status, "failed");
});

test("removal is not verified while the same course remains in another module", async () => {
  const f = fixture();
  f.state["autumn-b"].push(rawEntry("A", "autumn-b"));
  const plan = await f.preview(["B"]);
  const result = await f.apply(plan, ["remove:A"]);
  assert.equal(result.status, "partial");
  assert.equal(result.operations[0].status, "failed");
});

test("successful CLI exit without target state does not count as verified", async () => {
  const f = fixture({ mutate: () => "success" });
  const plan = await f.preview(["A", "B", "C"]);
  const result = await f.apply(plan, ["add:C"]);
  assert.equal(result.status, "partial");
  assert.equal(result.operations[0].status, "failed");
});

test("expiry during slow preflight prevents the first write", async () => {
  let now = new Date("2026-09-30T04:00:00Z");
  const f = fixture({ now: () => now, planTtlMs: 100, onRead: (_operation, calls) => {
    if (calls.length === 2) now = new Date(now.getTime() + 101);
  } });
  const plan = await f.preview(["A", "B", "C"]);
  await assert.rejects(f.apply(plan, ["add:C"]), { code: "expired_plan" });
  assert.equal(f.calls.filter((call) => call.kind === "add" || call.kind === "remove").length, 0);
});

test("failure to persist action start prevents its command and reports uncertainty", async () => {
  const f = fixture({ journal: async (record) => {
    if (record.kind === "started") throw new Error("disk full");
  } });
  const plan = await f.preview(["A", "B", "C"]);
  const result = await f.apply(plan, ["add:C"]);
  assert.equal(result.status, "uncertain");
  assert.equal(result.operations[0].status, "skipped");
  assert.equal(f.calls.filter((call) => call.kind === "add" || call.kind === "remove").length, 0);
});


test("all-module import returns all eight snapshots atomically in one serialized operation", async () => {
  const f = fixture();
  const all = f.service.timetables();
  const single = f.service.timetable("spring-a");
  const result = await all;
  assert.deepEqual(Object.keys(result.snapshots), Object.keys(MODULES));
  assert.deepEqual(result.snapshots[MODULE].entries.map((entry) => entry.code), ["A", "B"]);
  await single;
  assert.deepEqual(f.calls, [{ kind: "read-all" }, { kind: "read", module: "spring-a" }]);
});

test("all-module import rejects as a whole when one module cannot be read", async () => {
  const f = fixture({ failRead: (operation) => operation.kind === "read-all" });
  await assert.rejects(f.service.timetables(), { code: "cli_failed" });
  assert.deepEqual(f.calls, [{ kind: "read-all" }]);
});

test("batch normalization requires every module even when its timetable is empty", () => {
  const now = new Date("2026-09-30T04:00:00Z");
  const snapshots = Object.fromEntries(Object.keys(MODULES).map((module) => [module, []]));
  assert.deepEqual(Object.keys(normalizeSnapshots({ snapshots }, now)), Object.keys(MODULES));
  const missing = { ...snapshots };
  delete missing.summer;
  for (const raw of [{ snapshots: missing }, { snapshots: { ...snapshots, unexpected: [] } }, { snapshots: [] }, {}]) {
    assert.throws(() => normalizeSnapshots(raw, now), { code: "incomplete_snapshot" });
  }
  assert.throws(() => normalizeSnapshots("not json", now), { code: "invalid_snapshot" });
  assert.throws(() => normalizeSnapshots({ snapshots: { ...snapshots, "spring-a": [rawEntry("A", "autumn-a")] } }, now), { code: "invalid_snapshot" });
});

test("incomplete batch during preflight is a known non-mutation and preserves the reason", async () => {
  let reads = 0;
  let writes = 0;
  const snapshots = Object.fromEntries(Object.keys(MODULES).map((module) => [module, []]));
  const service = createTwinsService({
    run: async ({ kind }) => {
      if (kind !== "read-all") { writes++; throw new Error("Unexpected mutation"); }
      reads++;
      return JSON.stringify({ snapshots: reads === 1 ? snapshots : {} });
    },
    catalog: createCatalog([{ subject: [row("C")] }]),
    journal: async () => {},
    now: () => new Date("2026-09-30T04:00:00Z"),
  });
  const plan = await service.preview({ module: MODULE, academicYear: 2026, desiredByModule: desiredModules({ [MODULE]: ["C"] }) });
  await assert.rejects(service.apply({ id: plan.id, actionKeys: ["add:C"], academicYear: 2026 }), (error) => {
    assert.equal(error.code, "preflight_failed");
    assert.equal(error.mutationState, "not_started");
    assert.match(error.message, /全モジュールを取得できませんでした/);
    assert.match(error.message, /履修は変更していません/);
    assert.doesNotMatch(error.message, /結果が不明/);
    return true;
  });
  assert.equal(writes, 0);
});

const globalPreview = (f, overrides) => f.service.preview({
  module: MODULE,
  academicYear: 2026,
  desiredByModule: desiredModules(overrides),
});

test("global preview deduplicates course-level additions and removals across modules", async () => {
  const f = fixture({
    rows: [row("A", "春A秋B"), row("B", "秋C"), row("C", "秋AB"), row("D", "春B")],
    mutate: (operation, state) => {
      if (operation.kind === "add") {
        for (const module of operation.expectedModules) state[module].push(rawEntry(operation.code, module));
      } else {
        for (const module of Object.keys(MODULES)) state[module] = state[module].filter((entry) => entry.code !== operation.code);
      }
    },
  });
  f.state[MODULE] = [];
  f.state["spring-a"] = [rawEntry("A", "spring-a")];
  f.state["autumn-b"] = [rawEntry("A", "autumn-b")];
  f.state["autumn-c"] = [rawEntry("B", "autumn-c")];
  const plan = await globalPreview(f, {
    "spring-b": ["D"],
    "autumn-a": ["C"],
    "autumn-b": ["C"],
  });
  assert.equal(plan.scope, "all");
  assert.equal(plan.before.module, MODULE);
  assert.deepEqual(plan.additions.map((action) => [action.code, action.module]), [["D", "spring-b"], ["C", "autumn-a"]]);
  assert.deepEqual(plan.removals.map((action) => [action.code, action.module]), [["A", "spring-a"], ["B", "autumn-c"]]);
  const result = await f.apply(plan, [...plan.removals, ...plan.additions].map((action) => action.key));
  assert.equal(result.status, "verified");
  assert.deepEqual(f.calls.filter((call) => call.kind === "add" || call.kind === "remove").map((call) => call.key), ["add:D", "add:C", "remove:A", "remove:B"]);
  assert.deepEqual(result.snapshots["spring-b"].entries.map((entry) => entry.code), ["D"]);
  assert.deepEqual(result.snapshots["autumn-b"].entries.map((entry) => entry.code), ["C"]);
});

test("a course still desired in another module is never removed or re-added", async () => {
  const f = fixture();
  f.state["autumn-b"] = [rawEntry("A", "autumn-b")];
  const plan = await globalPreview(f, { "autumn-a": ["B"], "autumn-b": ["A"] });
  assert.equal(plan.additions.length, 0);
  assert.equal(plan.removals.length, 0);
  assert.equal(plan.blocked.length, 0);
});

test("already registered course missing a requested module is reported without duplicate add", async () => {
  const f = fixture();
  const plan = await globalPreview(f, { "autumn-a": ["B"], "autumn-b": ["A"] });
  assert.equal(plan.additions.length, 0);
  assert.equal(plan.removals.length, 0);
  assert.equal(plan.blocked[0].code, "A");
});

test("global preview chooses a catalog-validated slot from the requested modules", async () => {
  const f = fixture({ rows: [row("A"), row("B"), row("C", "秋B", "金5,6")] });
  const plan = await globalPreview(f, { "autumn-a": ["A", "B", "C"], "autumn-b": ["C"] });
  assert.equal(plan.additions.length, 1);
  assert.equal(plan.additions[0].module, "autumn-b");
  assert.equal(plan.additions[0].day, 4);
  assert.equal(plan.additions[0].period, 5);
});

test("global preview requires a complete, valid six-module map", async () => {
  const f = fixture();
  const base = { module: MODULE, academicYear: 2026 };
  const missing = desiredModules();
  delete missing["spring-c"];
  for (const desiredByModule of [undefined, null, [], missing, { ...desiredModules(), summer: [] }]) {
    await assert.rejects(async () => f.service.preview({ ...base, desiredByModule }));
  }
  await assert.rejects(async () => f.service.preview({ ...base, desiredByModule: desiredModules({ "spring-a": ["A", "A"] }) }), { code: "invalid_request" });
  await assert.rejects(async () => f.service.preview({ ...base, desiredByModule: desiredModules({ "spring-a": ["--eval"] }) }), { code: "invalid_code" });
  assert.equal(f.calls.length, 0);
});

test("global preview protects intensive rows in any module and holiday-only registrations", async () => {
  const f = fixture();
  f.state.summer = [rawEntry("A", "summer", true), rawEntry("HOLIDAY", "summer")];
  const plan = await globalPreview(f, { "autumn-a": ["B"] });
  assert.equal(plan.removals.length, 0);
  assert.deepEqual(plan.blocked.map((entry) => entry.code), ["A"]);
});

test("global apply rejects a stale module outside the active viewport before any writes", async () => {
  const f = fixture();
  const plan = await globalPreview(f, { "autumn-a": ["A", "B", "C"] });
  f.state["spring-c"] = [rawEntry("D", "spring-c")];
  await assert.rejects(f.apply(plan, ["add:C"]), { code: "stale_plan", status: 409, mutationState: "not_started" });
  assert.equal(f.calls.filter((call) => call.kind === "add" || call.kind === "remove").length, 0);
});
