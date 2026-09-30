import { z } from "zod";

export const TWINS_MODULES = [
  "spring-a",
  "spring-b",
  "spring-c",
  "autumn-a",
  "autumn-b",
  "autumn-c",
  "summer",
  "spring-break",
] as const;

export type TwinsModule = (typeof TWINS_MODULES)[number];

export const TWINS_MODULE_LABELS: Record<TwinsModule, string> = {
  "spring-a": "春 A",
  "spring-b": "春 B",
  "spring-c": "春 C",
  "autumn-a": "秋 A",
  "autumn-b": "秋 B",
  "autumn-c": "秋 C",
  summer: "夏季休業中",
  "spring-break": "春季休業中",
};

const moduleSchema = z.enum(TWINS_MODULES);
const codeSchema = z.string().trim().min(1).max(64);
const timestampSchema = z.iso.datetime({ offset: true });
const daySchema = z.number().int().min(0).max(6);
const periodSchema = z.number().int().min(1).max(9);

export const twinsEntrySchema = z
  .object({
    module: moduleSchema,
    day: daySchema.nullable(),
    period: periodSchema.nullable(),
    code: codeSchema,
    description: z.string(),
    intensive: z.boolean(),
  })
  .superRefine((entry, context) => {
    if (
      entry.intensive
        ? entry.day !== null || entry.period !== null
        : entry.day === null || entry.period === null
    ) {
      context.addIssue({
        code: "custom",
        message: "集中講義と曜日・時限の組み合わせが不正です",
      });
    }
  });

export type TwinsEntry = z.infer<typeof twinsEntrySchema>;

export const twinsSnapshotSchema = z
  .object({
    module: moduleSchema,
    observedAt: timestampSchema,
    entries: z.array(twinsEntrySchema),
  })
  .superRefine((snapshot, context) => {
    for (const [index, entry] of snapshot.entries.entries()) {
      if (entry.module !== snapshot.module) {
        context.addIssue({
          code: "custom",
          path: ["entries", index, "module"],
          message: "時間割に別のモジュールの科目が含まれています",
        });
      }
    }
  });

export type TwinsSnapshot = z.infer<typeof twinsSnapshotSchema>;

export const twinsSnapshotsSchema = z
  .record(moduleSchema, twinsSnapshotSchema)
  .superRefine((snapshots, context) => {
    for (const [module, snapshot] of Object.entries(snapshots)) {
      if (snapshot.module !== module) {
        context.addIssue({
          code: "custom",
          path: [module, "module"],
          message: "時間割のキーと取得したモジュールが一致しません",
        });
      }
    }
  });

const operationBaseSchema = z.object({
  key: z.string().min(1),
  code: codeSchema,
  name: z.string(),
  module: moduleSchema,
  catalogTerm: z.string().optional(),
});

export const twinsAdditionSchema = operationBaseSchema.extend({
  kind: z.literal("add"),
  day: daySchema,
  period: periodSchema,
});

export const twinsRemovalSchema = operationBaseSchema.extend({
  kind: z.literal("remove"),
});

export const twinsPreviewSchema = z
  .object({
    id: z.string().min(1),
    expiresAt: timestampSchema,
    academicYear: z.number().int().min(2000).max(2100),
    before: twinsSnapshotSchema,
    additions: z.array(twinsAdditionSchema),
    removals: z.array(twinsRemovalSchema),
    blocked: z.array(z.object({ code: codeSchema, reason: z.string().min(1) })),
  })
  .superRefine((preview, context) => {
    const keys = new Set<string>();
    for (const operation of [...preview.additions, ...preview.removals]) {
      if (
        keys.has(operation.key) ||
        operation.module !== preview.before.module
      ) {
        context.addIssue({
          code: "custom",
          message: "同期候補の識別子またはモジュールが不正です",
        });
      }
      keys.add(operation.key);
    }
  });

export type TwinsPreview = z.infer<typeof twinsPreviewSchema>;
export type TwinsSyncAction =
  | z.infer<typeof twinsAdditionSchema>
  | z.infer<typeof twinsRemovalSchema>;

export const twinsApplyResultSchema = z
  .object({
    status: z.enum(["verified", "partial", "uncertain"]),
    operations: z.array(
      z.object({
        key: z.string().min(1),
        kind: z.enum(["add", "remove"]),
        code: codeSchema,
        status: z.enum(["verified", "failed", "uncertain", "skipped"]),
        message: z.string().optional(),
      }),
    ),
    after: twinsSnapshotSchema.nullable(),
    snapshots: twinsSnapshotsSchema.nullable().optional(),
    message: z.string().optional(),
  })
  .superRefine((result, context) => {
    if (result.status === "verified" && result.after === null) {
      context.addIssue({
        code: "custom",
        message: "確認済みの結果に時間割がありません",
      });
    }
  });

export type TwinsApplyResult = z.infer<typeof twinsApplyResultSchema>;

export function parseTwinsSnapshot(
  input: unknown,
  expectedModule?: TwinsModule,
): TwinsSnapshot {
  const snapshot = twinsSnapshotSchema.parse(input);
  if (expectedModule && snapshot.module !== expectedModule) {
    throw new Error("要求したモジュールと取得した時間割が一致しません");
  }
  return snapshot;
}

export function parseTwinsPreview(
  input: unknown,
  expectedModule?: TwinsModule,
  expectedAcademicYear?: number,
): TwinsPreview {
  const preview = twinsPreviewSchema.parse(input);
  if (expectedModule && preview.before.module !== expectedModule) {
    throw new Error("要求したモジュールと同期候補が一致しません");
  }
  if (
    expectedAcademicYear !== undefined &&
    preview.academicYear !== expectedAcademicYear
  ) {
    throw new Error("要求した年度と同期候補が一致しません");
  }
  return preview;
}

export function parseTwinsApplyResult(
  input: unknown,
  expectedModule?: TwinsModule,
): TwinsApplyResult {
  const result = twinsApplyResultSchema.parse(input);
  if (
    result.after &&
    expectedModule &&
    result.after.module !== expectedModule
  ) {
    throw new Error("要求したモジュールと更新後の時間割が一致しません");
  }
  return result;
}

/** KdB normal terms are 0–5, then spring/summer/autumn/winter breaks. */
export function twinsModuleFromTermCode(termCode: number): TwinsModule | null {
  if (Number.isInteger(termCode) && termCode >= 0 && termCode <= 5) {
    return TWINS_MODULES[termCode];
  }
  if (termCode === 6) return "spring-break";
  if (termCode === 7) return "summer";
  return null;
}

export function twinsTermCodeFromModule(module: TwinsModule): number {
  if (module === "spring-break") return 6;
  if (module === "summer") return 7;
  return TWINS_MODULES.indexOf(module);
}

export function isEditableTwinsModule(module: TwinsModule): boolean {
  return module !== "summer" && module !== "spring-break";
}

export interface TwinsCatalogSubject {
  code: string;
  termCodes: readonly (readonly number[])[];
}

export interface TwinsPlanBookmark {
  year: number;
  ta: boolean;
  memos: (string | null)[];
}

const hasOwn = (
  record: Readonly<Record<string, unknown>>,
  key: string,
): boolean => Object.getOwnPropertyDescriptor(record, key) !== undefined;

export function summarizeTwinsCourses(
  snapshot: TwinsSnapshot,
  catalog: Readonly<Record<string, unknown>>,
): { codes: string[]; matched: string[]; unknown: string[] } {
  const codes = [
    ...new Set(snapshot.entries.map((entry) => entry.code)),
  ].sort();
  const matched = codes.filter((code) => hasOwn(catalog, code));
  const unknown = codes.filter((code) => !hasOwn(catalog, code));
  return { codes, matched, unknown };
}

/** Project the observed TWINS slots directly, without looking them up in KdB. */
export function projectTwinsTimetable(
  snapshot: TwinsSnapshot | null,
  module: TwinsModule = snapshot?.module ?? "spring-a",
  dimensions: { days?: number; periods?: number } = {},
): {
  table: TwinsEntry[][][];
  intensive: TwinsEntry[];
  outsideGrid: TwinsEntry[];
} {
  const days = dimensions.days ?? 6;
  const periods = dimensions.periods ?? 6;
  if (!Number.isInteger(days) || days < 1 || days > 7) {
    throw new Error("曜日数は 1〜7 で指定してください");
  }
  if (!Number.isInteger(periods) || periods < 1 || periods > 9) {
    throw new Error("時限数は 1〜9 で指定してください");
  }
  const table: TwinsEntry[][][] = Array.from({ length: days }, () =>
    Array.from({ length: periods }, () => []),
  );
  const intensive: TwinsEntry[] = [];
  const outsideGrid: TwinsEntry[] = [];
  if (!snapshot || snapshot.module !== module) {
    return { table, intensive, outsideGrid };
  }
  const seen = new Set<string>();
  for (const entry of snapshot.entries) {
    const key = JSON.stringify([entry.code, entry.day, entry.period]);
    if (entry.module !== module || seen.has(key)) continue;
    seen.add(key);
    if (entry.intensive) {
      intensive.push(entry);
    } else if (
      entry.day !== null &&
      entry.period !== null &&
      entry.day < days &&
      entry.period <= periods
    ) {
      table[entry.day][entry.period - 1].push(entry);
    } else {
      outsideGrid.push(entry);
    }
  }
  return { table, intensive, outsideGrid };
}

/** Presence, including an empty grid for intensive courses, overrides KdB slots. */
export function getTwinsTimeslotOverrides(
  snapshot: TwinsSnapshot | undefined,
  module: TwinsModule | null,
): Record<string, boolean[][]> {
  if (!snapshot || snapshot.module !== module) return {};
  const { table } = projectTwinsTimetable(snapshot);
  return Object.fromEntries(
    [...new Set(snapshot.entries.map(({ code }) => code))].map((code) => [
      code,
      table.map((day) =>
        day.map((entries) => entries.some((entry) => entry.code === code)),
      ),
    ]),
  );
}

/** Only this academic year's non-TA plan entries in the selected term. */
export function getDesiredTwinsCodes(
  subjects: Readonly<Record<string, Pick<TwinsPlanBookmark, "year" | "ta">>>,
  catalog: Readonly<Record<string, TwinsCatalogSubject>>,
  module: TwinsModule,
  academicYear: number,
  observedCodes: readonly string[] = [],
): string[] {
  const termCode = twinsTermCodeFromModule(module);
  const observed = new Set(observedCodes);
  return Object.keys(subjects)
    .filter((code) => {
      const bookmark = subjects[code];
      const subject = hasOwn(catalog, code) ? catalog[code] : undefined;
      return (
        bookmark.year === academicYear &&
        !bookmark.ta &&
        (subject?.termCodes.some((group) => group.includes(termCode)) ||
          observed.has(code))
      );
    })
    .sort();
}

export interface TwinsImportReport {
  added: string[];
  alreadyPresent: string[];
  unknown: string[];
  conflicts: {
    code: string;
    reason: "different-year" | "ta-role";
    year: number;
  }[];
}

export const twinsBaselineSchema = z.object({
  year: z.number().int(),
  codes: z.array(codeSchema),
});

export type TwinsBaseline = z.infer<typeof twinsBaselineSchema>;

/** Import is additive. Existing notes, years and TA choices are never changed. */
export function mergeTwinsCourses(
  subjects: Readonly<Record<string, TwinsPlanBookmark>>,
  codes: readonly string[],
  catalog: Readonly<Record<string, unknown>>,
  academicYear: number,
): { subjects: Record<string, TwinsPlanBookmark>; report: TwinsImportReport } {
  const nextSubjects = { ...subjects };
  const report: TwinsImportReport = {
    added: [],
    alreadyPresent: [],
    unknown: [],
    conflicts: [],
  };
  for (const code of [...new Set(codes)]) {
    if (!hasOwn(catalog, code)) {
      report.unknown.push(code);
      continue;
    }
    const existing = subjects[code];
    if (existing && (existing.year !== academicYear || existing.ta)) {
      report.conflicts.push({
        code,
        reason: existing.year !== academicYear ? "different-year" : "ta-role",
        year: existing.year,
      });
    } else if (existing) {
      report.alreadyPresent.push(code);
    } else {
      nextSubjects[code] = { year: academicYear, ta: false, memos: [""] };
      report.added.push(code);
    }
  }
  return { subjects: nextSubjects, report };
}

/**
 * Only a complete remote read can advance the baseline. Unchanged remote codes
 * are not re-imported: their absence locally may be a pending cancellation.
 * Remote removals leave local plans and notes intact; they can still represent
 * courses the user intends to register. A new academic year starts a new baseline.
 */
export function syncTwinsCourseBaseline(
  subjects: Readonly<Record<string, TwinsPlanBookmark>>,
  baseline: TwinsBaseline | undefined,
  observedCodes: readonly string[],
  catalog: Readonly<Record<string, unknown>>,
  academicYear: number,
): {
  subjects: Record<string, TwinsPlanBookmark>;
  baseline: TwinsBaseline;
  report: TwinsImportReport;
} {
  const previousCodes = new Set(
    baseline?.year === academicYear ? baseline.codes : [],
  );
  const codes = [...new Set(observedCodes)].sort();
  const merged = mergeTwinsCourses(
    subjects,
    codes.filter((code) => !previousCodes.has(code)),
    catalog,
    academicYear,
  );
  return { ...merged, baseline: { year: academicYear, codes } };
}
