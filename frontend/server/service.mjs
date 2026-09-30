import { randomUUID } from "node:crypto";
import { mkdir, open, lstat, chmod } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import {
  ACADEMIC_YEAR,
  CODE_PATTERN,
  EDIT_MODULES,
  MODULES,
  additionFor,
  currentAcademicYear,
  normalizeSnapshot,
  validateModule,
} from "./catalog.mjs";
import { BridgeError, serialize } from "./runner.mjs";

function requireObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BridgeError("invalid_request", "リクエストの形式が正しくありません。");
  }
}

function stringSet(values, field) {
  if (
    !Array.isArray(values) || values.length > 300 ||
    values.some((value) => typeof value !== "string" || !value.length || value.length > 80) ||
    new Set(values).size !== values.length
  ) throw new BridgeError("invalid_request", `${field} の形式が正しくありません。`);
  return new Set(values);
}

function signatures(snapshots, excluded = new Set()) {
  return JSON.stringify(Object.keys(MODULES).flatMap((module) =>
    snapshots[module].entries
      .filter((entry) => !excluded.has(entry.code))
      .map(({ code, day, period, intensive }) =>
        JSON.stringify([module, code, day, period, intensive]))
      .sort(),
  ));
}

function codeSet(snapshot) {
  return new Set(snapshot.entries.map((entry) => entry.code));
}

export async function createJournal(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe journal directory");
  await chmod(directory, 0o700);
  const journalPath = path.join(directory, "operations.jsonl");
  // A local journal is an audit aid only. Plans live in memory and cannot replay
  // after restart, even if a previous write completed without an HTTP response.
  return async (record) => {
    const file = await open(
      journalPath,
      constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await file.chmod(0o600);
      await file.write(`${JSON.stringify(record)}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
  };
}

export function createTwinsService({
  run,
  catalog,
  journal,
  now = () => new Date(),
  id = randomUUID,
  planTtlMs = 10 * 60_000,
}) {
  if (typeof journal !== "function") throw new Error("A durable journal is required");
  const exclusive = serialize();
  const plans = new Map();
  const validateYear = (year) => {
    if (year !== ACADEMIC_YEAR || currentAcademicYear(now()) !== ACADEMIC_YEAR) {
      throw new BridgeError(
        "academic_year_mismatch",
        `${ACADEMIC_YEAR} 年度のデータと現在の年度が一致する場合のみ変更できます。TWINS の年度も画面で確認してください。`,
        409,
      );
    }
  };
  const read = async (module) =>
    normalizeSnapshot(await run({ kind: "read", module }), module, now());
  const readAll = async () => {
    const snapshots = {};
    for (const module of Object.keys(MODULES)) snapshots[module] = await read(module);
    return snapshots;
  };
  const record = async (value) => {
    try {
      await journal({ recordedAt: now().toISOString(), ...value });
    } catch {
      throw new BridgeError("journal_unavailable", "ローカル操作記録を保存できません。状態を確認してから差分を作り直してください。", 503);
    }
  };

  return {
    timetables() {
      return exclusive(async () => ({ snapshots: await readAll() }));
    },
    timetable(module) {
      validateModule(module);
      return exclusive(() => read(module));
    },
    preview(body) {
      requireObject(body);
      const module = validateModule(body.module, true);
      validateYear(body.academicYear);
      requireObject(body.desiredByModule);
      if (
        Object.keys(body.desiredByModule).length !== EDIT_MODULES.length ||
        EDIT_MODULES.some((key) => !Object.hasOwn(body.desiredByModule, key))
      ) throw new BridgeError("invalid_modules", "全 6 モジュールの履修予定を指定してください。");
      const desiredByModule = Object.fromEntries(EDIT_MODULES.map((key) => [
        key,
        stringSet(body.desiredByModule[key], `${MODULES[key]} の履修予定`),
      ]));
      const desired = new Set(Object.values(desiredByModule).flatMap((codes) => [...codes]));
      if (desired.size > 300) throw new BridgeError("invalid_request", "履修予定の科目数が上限を超えています。");
      if ([...desired].some((code) => !CODE_PATTERN.test(code))) {
        throw new BridgeError("invalid_code", "科目番号の形式が正しくありません。");
      }
      return exclusive(async () => {
        const snapshots = await readAll();
        const before = snapshots[module];
        const allEntries = Object.values(snapshots).flatMap((snapshot) => snapshot.entries);
        const existing = new Set(allEntries.map((entry) => entry.code));
        const additions = [];
        const removals = [];
        const blocked = [];
        for (const code of desired) {
          const requestedModules = EDIT_MODULES.filter((key) => desiredByModule[key].has(code));
          if (existing.has(code)) {
            if (requestedModules.some((key) =>
              !snapshots[key].entries.some((entry) => entry.code === code),
            )) {
              blocked.push({ code, reason: "この科目は別のモジュールで既に登録されています。予定と TWINS の開講モジュールが一致しないため、TWINS で確認してください。" });
            }
            continue;
          }
          const candidates = requestedModules.map((key) => additionFor(catalog, code, key));
          const action = candidates.find((candidate) => candidate.kind);
          if (action) additions.push(action);
          else blocked.push(candidates[0]);
        }
        for (const code of existing) {
          if (desired.has(code)) continue;
          const editableRows = allEntries.filter((entry) => entry.code === code && EDIT_MODULES.includes(entry.module));
          // Holiday-only registrations are outside the editable normal modules.
          if (!editableRows.length) continue;
          if (allEntries.some((entry) => entry.code === code && entry.intensive)) {
            blocked.push({ code, reason: "既存の集中・その他科目は自動変更せず保持します。削除する場合は TWINS で確認してください。" });
            continue;
          }
          const registeredRow = editableRows.find((entry) => entry.module === module) ?? editableRows[0];
          const course = catalog.get(code);
          removals.push({
            key: `remove:${code}`,
            kind: "remove",
            code,
            name: course?.name ?? registeredRow.description,
            catalogTerm: course?.term ?? "KdB 未掲載（TWINS で確認）",
            module: registeredRow.module,
          });
        }
        const created = now();
        // Expiry begins after reads complete, so slow reads do not exhaust it.
        const review = {
          id: id(),
          scope: "all",
          academicYear: ACADEMIC_YEAR,
          expiresAt: new Date(created.getTime() + planTtlMs).toISOString(),
          before,
          additions,
          removals,
          blocked,
        };
        for (const [key, plan] of plans) {
          if (Date.parse(plan.review.expiresAt) <= created.getTime()) plans.delete(key);
        }
        if (plans.size >= 32) plans.delete(plans.keys().next().value);
        plans.set(review.id, { review, snapshots });
        return structuredClone(review);
      });
    },
    apply(body) {
      requireObject(body);
      validateYear(body.confirmedAcademicYear);
      if (typeof body.id !== "string" || body.id.length > 100) {
        throw new BridgeError("invalid_request", "差分 ID が正しくありません。");
      }
      const selected = stringSet(body.actionKeys, "適用する操作");
      if (!selected.size) throw new BridgeError("no_actions", "適用する操作を選択してください。");
      return exclusive(async () => {
        validateYear(body.confirmedAcademicYear);
        const plan = plans.get(body.id);
        if (!plan || Date.parse(plan.review.expiresAt) <= now().getTime()) {
          plans.delete(body.id);
          throw new BridgeError("expired_plan", "差分が期限切れか使用済みです。もう一度差分を確認してください。", 409);
        }
        const available = [...plan.review.additions, ...plan.review.removals];
        if ([...selected].some((key) => !available.some((action) => action.key === key))) {
          throw new BridgeError("invalid_actions", "この差分に含まれない操作が指定されました。");
        }
        // Additions precede removals, regardless of request order. A failed add
        // must never trigger a later removal to make room automatically.
        const actions = available.filter((action) => selected.has(action.key));
        plans.delete(body.id);
        await record({ kind: "consumed", planId: body.id, module: plan.review.before.module, academicYear: ACADEMIC_YEAR, actions });
        let current;
        try {
          current = await readAll();
        } catch (error) {
          await record({ kind: "preflight_failed", planId: body.id, code: error.code ?? "read_failed" });
          throw new BridgeError("preflight_failed", "適用前の TWINS 再確認に失敗しました。変更は行っていません。差分を作り直してください。", 409);
        }
        if (signatures(current) !== signatures(plan.snapshots)) {
          await record({ kind: "stale", planId: body.id });
          throw new BridgeError("stale_plan", "差分確認後に TWINS の時間割が変わりました。変更は行っていません。差分を作り直してください。", 409);
        }
        validateYear(body.confirmedAcademicYear);
        if (Date.parse(plan.review.expiresAt) <= now().getTime()) {
          await record({ kind: "expired_during_preflight", planId: body.id });
          throw new BridgeError("expired_plan", "適用前の再確認中に差分の有効期限が切れました。変更は行っていません。差分を作り直してください。", 409);
        }
        const operations = actions.map(({ key, kind, code }) => ({ key, kind, code, status: "skipped" }));
        const attempted = new Set();
        let stopped = false;
        let journalFailed = false;
        for (let index = 0; index < actions.length; index++) {
          const action = actions[index];
          const operation = operations[index];
          try {
            await record({ kind: "started", planId: body.id, actionKey: action.key });
          } catch {
            operation.message = "操作記録を保存できなかったため、この操作以降を停止しました。";
            stopped = true;
            journalFailed = true;
            break;
          }
          attempted.add(action.code);
          try {
            await run(action);
            operation.status = "uncertain";
          } catch (error) {
            operation.status = "uncertain";
            operation.message = error instanceof BridgeError ? error.message : "TWINS の操作を完了できませんでした。";
            stopped = true;
          }
          try {
            await record({ kind: "command_finished", planId: body.id, operation });
          } catch {
            stopped = true;
            journalFailed = true;
          }
          if (stopped) break;
        }
        let afterAll = null;
        let verificationError = null;
        try {
          afterAll = await readAll();
        } catch {
          verificationError = "適用後の時間割を確認できませんでした。再実行せず TWINS で現在の状態を確認してください。";
        }
        let unexpectedChange = false;
        if (afterAll) {
          unexpectedChange = signatures(current, attempted) !== signatures(afterAll, attempted);
          const finalCodes = Object.fromEntries(Object.keys(MODULES).map((module) => [module, codeSet(afterAll[module])]));
          for (const operation of operations) {
            if (!attempted.has(operation.code)) continue;
            const action = actions.find((candidate) => candidate.key === operation.key);
            const matches = operation.kind === "add"
              ? action.expectedModules.every((module) => finalCodes[module].has(operation.code))
              : Object.keys(MODULES).every((module) => !finalCodes[module].has(operation.code));
            operation.status = unexpectedChange ? "uncertain" : matches ? "verified" : "failed";
            if (!matches && !unexpectedChange) operation.message = "再取得した全学期の時間割で、この操作の結果を確認できませんでした。";
          }
        }
        const result = {
          status: !afterAll || unexpectedChange || journalFailed
            ? "uncertain"
            : operations.every((operation) => operation.status === "verified") ? "verified" : "partial",
          operations,
          after: afterAll?.[plan.review.before.module] ?? null,
          snapshots: afterAll,
        };
        if (verificationError) result.message = verificationError;
        else if (unexpectedChange) result.message = "選択していない科目にも変更が見つかりました。再実行せず TWINS で全学期の状態を確認してください。";
        else if (journalFailed) result.message = "操作記録の保存に失敗しました。TWINS で状態を確認してから新しい差分を作成してください。";
        else if (stopped || result.status === "partial") result.message = "途中で停止しました。結果を確認し、必要な変更は新しい差分から行ってください。";
        try {
          await record({ kind: "result", planId: body.id, result });
        } catch {
          result.status = "uncertain";
          result.message = "最終結果の記録を保存できませんでした。再実行せず TWINS で状態を確認してください。";
        }
        return result;
      });
    },
  };
}
