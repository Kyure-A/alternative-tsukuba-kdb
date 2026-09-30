import { BridgeError } from "./runner.mjs";

export const ACADEMIC_YEAR = 2026;
export const MODULES = {
  "spring-a": "春A",
  "spring-b": "春B",
  "spring-c": "春C",
  summer: "夏休",
  "autumn-a": "秋A",
  "autumn-b": "秋B",
  "autumn-c": "秋C",
  "spring-break": "春休",
};
export const EDIT_MODULES = Object.keys(MODULES).filter(
  (module) => module !== "summer" && module !== "spring-break",
);
const DAYS = ["月", "火", "水", "木", "金", "土", "日"];
export const CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,31}$/;

export function validateModule(module, editing = false) {
  if (
    typeof module !== "string" ||
    !Object.hasOwn(MODULES, module) ||
    (editing && !EDIT_MODULES.includes(module))
  ) {
    throw new BridgeError("invalid_module", "対象の学期・モジュールを選び直してください。");
  }
  return module;
}

export function currentAcademicYear(now) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "numeric",
  }).formatToParts(now);
  const year = Number(parts.find((part) => part.type === "year").value);
  const month = Number(parts.find((part) => part.type === "month").value);
  return year - (month < 4 ? 1 : 0);
}

function termModules(term) {
  const modules = new Set();
  let remaining = term.replace(/\s+/g, "");
  remaining = remaining.replace(/通年/g, () => {
    for (const module of EDIT_MODULES) modules.add(module);
    return "";
  });
  remaining = remaining.replace(/(春|秋)学期/g, (_, season) => {
    const prefix = season === "春" ? "spring" : "autumn";
    for (const part of ["a", "b", "c"]) modules.add(`${prefix}-${part}`);
    return "";
  });
  remaining = remaining.replace(/(春|秋)([ABC]+)/g, (_, season, parts) => {
    const prefix = season === "春" ? "spring" : "autumn";
    for (const part of parts) modules.add(`${prefix}-${part.toLowerCase()}`);
    return "";
  });
  remaining = remaining.replace(/(春|夏|秋|冬)季休業中/g, () => "");
  return remaining.length ? null : modules;
}

// Full-match the syntax, including inherited weekdays after commas. Never guess
// a start slot from intensive, negotiated, or otherwise unparseable schedules.
export function parseSlots(source) {
  const slots = [];
  let days = [];
  for (const token of source.trim().split(/[\s,]+/).filter(Boolean)) {
    const match = /^([月火水木金土日](?:・[月火水木金土日])*)?([1-9])(?:-([1-9]))?$/.exec(token);
    if (!match) return null;
    if (match[1]) days = match[1].split("・").map((day) => DAYS.indexOf(day));
    if (!days.length) return null;
    const start = Number(match[2]);
    const end = Number(match[3] ?? match[2]);
    if (end < start) return null;
    for (const day of days) {
      for (let period = start; period <= end; period++) slots.push({ day, period });
    }
  }
  return slots.length ? slots : null;
}

export function createCatalog(datasets) {
  const catalog = new Map();
  for (const dataset of datasets) {
    if (!Array.isArray(dataset.subject)) throw new Error("Invalid KdB dataset");
    for (const row of dataset.subject) {
      const [code, name, , , , term, schedule] = row;
      if (![code, name, term, schedule].every((value) => typeof value === "string")) {
        throw new Error("Invalid KdB course");
      }
      if (!CODE_PATTERN.test(code)) continue;
      if (catalog.has(code)) {
        const prior = catalog.get(code);
        if (prior.name !== name || prior.term !== term || prior.schedule !== schedule) {
          catalog.set(code, { ...prior, ambiguous: true });
        }
      } else {
        catalog.set(code, { code, name, term, schedule });
      }
    }
  }
  return catalog;
}

export function additionFor(catalog, code, module) {
  const course = catalog.get(code);
  if (!course) return { code, reason: "現在の KdB データにない科目です。TWINS で確認してください。" };
  if (course.ambiguous) return { code, reason: "同じ科目番号の開講情報が複数あるため、TWINS で登録してください。" };
  const terms = course.term.trim().split(/\s+/).filter(Boolean);
  const schedules = course.schedule.trim().split(/\s+/).filter(Boolean);
  let applicable = [];
  if (terms.length === 1) {
    const modules = termModules(terms[0]);
    if (!modules) return { code, reason: "開講モジュールの表記を安全に解釈できません。" };
    if (modules.has(module)) applicable = schedules;
  } else if (schedules.length === 1) {
    const parsed = terms.map(termModules);
    if (parsed.some((modules) => !modules)) return { code, reason: "開講モジュールの表記を安全に解釈できません。" };
    if (parsed.some((modules) => modules.has(module))) applicable = schedules;
  } else if (terms.length === schedules.length) {
    for (let index = 0; index < terms.length; index++) {
      const modules = termModules(terms[index]);
      if (!modules) return { code, reason: "開講モジュールの表記を安全に解釈できません。" };
      if (modules.has(module)) applicable.push(schedules[index]);
    }
  } else {
    return { code, reason: "開講モジュールと曜日時限の対応が曖昧なため、TWINS で登録してください。" };
  }
  if (!applicable.length) return { code, reason: "選択中のモジュールに通常授業の開講情報がありません。" };
  const slots = parseSlots(applicable.join(" "));
  if (!slots) return { code, reason: "集中・応談・随時など、通常の曜日時限を確定できない科目は TWINS で登録してください。" };
  slots.sort((a, b) => a.day - b.day || a.period - b.period);
  return {
    key: `add:${code}`,
    kind: "add",
    code,
    name: course.name,
    catalogTerm: course.term,
    expectedModules: [...(termModules(course.term) ?? new Set([module]))],
    module,
    ...slots[0],
  };
}

export function normalizeSnapshot(raw, module, now) {
  let rows;
  try {
    rows = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    throw new BridgeError("invalid_snapshot", "TWINS の時間割データを読み取れませんでした。", 502);
  }
  if (!Array.isArray(rows) || rows.length > 5_000) {
    throw new BridgeError("invalid_snapshot", "TWINS の時間割の形式が想定と異なります。", 502);
  }
  const entries = rows.map((row) => {
    if (
      !row || row.module !== MODULES[module] ||
      typeof row.code !== "string" || !CODE_PATTERN.test(row.code) ||
      typeof row.description !== "string" ||
      typeof row.intensive !== "boolean"
    ) throw new BridgeError("invalid_snapshot", "TWINS の時間割の形式が想定と異なります。", 502);
    const day = DAYS.findIndex((label) => row.day === `${label}曜日`);
    const periodMatch = /^([1-9])限$/.exec(row.period);
    if (!row.intensive && (day < 0 || !periodMatch)) {
      throw new BridgeError("unsupported_snapshot", "TWINS の通常授業に未対応の曜日時限があります。", 502);
    }
    return {
      module,
      day: row.intensive ? null : day,
      period: row.intensive ? null : Number(periodMatch[1]),
      code: row.code,
      description: row.description,
      intensive: row.intensive,
    };
  });
  return { module, observedAt: now.toISOString(), entries };
}
