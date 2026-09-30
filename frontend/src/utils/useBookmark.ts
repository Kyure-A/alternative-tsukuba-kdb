import { useCallback, useMemo, useRef, useState } from "react";
import { z } from "zod";

import { CURRENT_YEAR, kdb, type Subject } from "./subject";
import {
  createEmptyTimeslotTable,
  fillTimetable,
  getTimeslotsLength,
} from "./timetable";
import {
  getDesiredTwinsCodes,
  getTwinsTimeslotOverrides,
  mergeTwinsCourses,
  syncTwinsCourseBaseline,
  type TwinsModule,
  type TwinsSnapshot,
  twinsBaselineSchema,
  twinsModuleFromTermCode,
} from "./twins";

const BOOKMARKS_KEY = "kdb_bookmarks";
const BOOKMARKS_VERSION = 1;

const bookmarkSubjectSchema = z.object({
  year: z.number(),
  ta: z.boolean(),
  memos: z.array(z.string().nullable()),
});

const bookmarksSchema = z.object({
  version: z.literal(BOOKMARKS_VERSION),
  subjects: z.record(z.string(), bookmarkSubjectSchema),
  memoHeaders: z.array(z.string().nullable()),
  twinsBaseline: twinsBaselineSchema.optional(),
});

type BookmarkSubject = z.infer<typeof bookmarkSubjectSchema>;
type Bookmarks = z.infer<typeof bookmarksSchema>;

const createEmptyBookmarkSubject = (): BookmarkSubject => {
  return { year: CURRENT_YEAR, ta: false, memos: [""] };
};

const createEmptyBookmarks = (): Bookmarks => {
  return { version: BOOKMARKS_VERSION, subjects: {}, memoHeaders: [] };
};

const getLocalBookmarks = (): Bookmarks => {
  const value = localStorage.getItem(BOOKMARKS_KEY);

  // データが存在しない場合は空のブックマークを返す
  if (value === null) {
    return createEmptyBookmarks();
  }

  // 新バージョンのデータを読込
  try {
    const result = bookmarksSchema.safeParse(JSON.parse(value));
    if (!result.success) {
      console.error(result.error);
      return createEmptyBookmarks();
    }
    return result.data;
  } catch {
    // pass
  }

  try {
    // 旧バージョンのデータ（科目番号カンマ区切り）を変換
    const array =
      value !== null
        ? decodeURIComponent(value)
            .split(",")
            .filter((code) => code !== "")
        : [];
    const bookmarks: Bookmarks = createEmptyBookmarks();
    for (const item of array) {
      bookmarks.subjects[item] = createEmptyBookmarkSubject();
    }
    return bookmarks;
  } catch {
    return createEmptyBookmarks();
  }
};

const localStorageBookmarks = getLocalBookmarks();

const saveBookmarks = (bookmarks: Bookmarks) => {
  localStorage.setItem(BOOKMARKS_KEY, JSON.stringify(bookmarks));
};

export const useBookmark = (
  timetableTermCode: number,
  setTimetableTermCode: React.Dispatch<React.SetStateAction<number>>,
  twinsSnapshot?: TwinsSnapshot,
) => {
  const [bookmarks, setBookmarks] = useState<Bookmarks>(localStorageBookmarks);
  const bookmarksRef = useRef(bookmarks);

  const persistBookmarks = useCallback((nextBookmarks: Bookmarks) => {
    saveBookmarks(nextBookmarks);
    bookmarksRef.current = nextBookmarks;
    setBookmarks(nextBookmarks);
  }, []);

  // 年度ごとの単位数の合計
  const yearCredits = useMemo(() => {
    const result: Record<number, number> = {};
    for (const [code, bookmarkSubject] of Object.entries(bookmarks.subjects)) {
      const subject = kdb.subjectMap[code];
      if (subject && !bookmarkSubject.ta) {
        if (!(bookmarkSubject.year in result)) {
          result[bookmarkSubject.year] = 0;
        }
        result[bookmarkSubject.year] += subject.credit;
      }
    }
    return result;
  }, [bookmarks]);

  // 全ての単位数の合計
  const totalCredits = useMemo(
    () =>
      Object.values(yearCredits).reduce((prev, credits) => prev + credits, 0),
    [yearCredits],
  );

  const [
    bookmarkTimeslotTable, // 現在のタームの TimeslotTable
    bookmarkSubjectTable, // 現在のタームの時間割
    currentCredits, // 現在のタームの単位数
    currentTimeslots, // 現在のタームのコマ数
  ] = useMemo(() => {
    const table = createEmptyTimeslotTable();
    const subjectTable = fillTimetable<Subject[]>([]);
    const twinsTimeslots = getTwinsTimeslotOverrides(
      twinsSnapshot,
      twinsModuleFromTermCode(timetableTermCode),
    );
    let credits = 0;
    let timeslots = 0;

    for (const [code, bookmarkSubject] of Object.entries(bookmarks.subjects)) {
      const subject = kdb.subjectMap[code];
      if (!subject) {
        continue;
      }
      if (bookmarkSubject.year !== CURRENT_YEAR) {
        continue;
      }

      // タームコードを含むグループを探索
      const termIndex = subject.termCodes.findIndex((codes) =>
        codes.includes(timetableTermCode),
      );
      const observedTimeslots = twinsTimeslots[code];
      if (termIndex === -1 && !observedTimeslots) {
        continue;
      }

      const subjectTimeslotTable =
        observedTimeslots ?? subject.timeslotTables[termIndex];
      if (subjectTimeslotTable) {
        for (let day = 0; day < table.length; day++) {
          for (let period = 0; period < table[day].length; period++) {
            // 科目がコマを含めば追加
            if (subjectTimeslotTable[day][period]) {
              table[day][period] = true;
              subjectTable[day][period].push(subject);
            }
          }
        }
        timeslots += getTimeslotsLength(subjectTimeslotTable);
      }
      if (!bookmarkSubject.ta) {
        credits += subject.credit;
      }
    }
    return [table, subjectTable, credits, timeslots];
  }, [bookmarks, timetableTermCode, twinsSnapshot]);

  const memoLength = 9;

  const memoTotals = useMemo(() => {
    const totals: number[] = [...Array(memoLength)].map(() => 0);
    for (let i = 0; i < memoLength; i++) {
      for (const bookmarkSubject of Object.values(bookmarks.subjects)) {
        const memo = bookmarkSubject.memos[i];
        if (memo !== null) {
          const number = Number.parseFloat(memo);
          if (!Number.isNaN(number)) {
            totals[i] += number;
          }
        }
      }
    }
    return totals;
  }, [bookmarks]);

  const memoSlashLineCredits = useMemo(() => {
    const totals: Record<string, number> = {};
    for (const [code, bookmarkSubject] of Object.entries(bookmarks.subjects)) {
      const subject = kdb.subjectMap[code];
      if (!subject) {
        continue;
      }
      const set = new Set<string>();

      // スラッシュから始まるメモを集計
      for (let i = 0; i < memoLength; i++) {
        const memo = bookmarkSubject.memos[i];
        if (!memo) {
          continue;
        }
        for (const line of memo.split("\n")) {
          const trimmed = line.trim();
          if (trimmed.startsWith("/")) {
            set.add(trimmed);
          }
        }
      }

      // totals に追加
      for (const item of set) {
        if (!(item in totals)) {
          totals[item] = 0;
        }
        totals[item] += subject.credit;
      }
    }
    return totals;
  }, [bookmarks]);

  const bookmarksHas = useCallback(
    (subjectCode: string) => subjectCode in bookmarks.subjects,
    [bookmarks],
  );

  const getBookmarkSubject = useCallback(
    (subjectCode: string): BookmarkSubject | undefined =>
      bookmarks.subjects[subjectCode],
    [bookmarks],
  );

  const switchBookmark = useCallback(
    (subjectCode: string) => {
      const newBookmarks = structuredClone(bookmarksRef.current);
      if (subjectCode in newBookmarks.subjects) {
        delete newBookmarks.subjects[subjectCode];
      } else {
        const subject = kdb.subjectMap[subjectCode];
        if (!subject) {
          return;
        }
        newBookmarks.subjects[subjectCode] = createEmptyBookmarkSubject();
        const termCode = subject.termCodes[0]?.[0];
        if (termCode !== undefined) {
          setTimetableTermCode(termCode);
        }
      }
      persistBookmarks(newBookmarks);
    },
    [persistBookmarks, setTimetableTermCode],
  );

  const updateBookmark = (
    subjectCode: string,
    value: Partial<BookmarkSubject>,
  ) => {
    const newBookmarks = structuredClone(bookmarksRef.current);
    const bookmarkSubject = newBookmarks.subjects[subjectCode];
    if (!bookmarkSubject) {
      return;
    }
    if (value.year !== undefined) {
      bookmarkSubject.year = value.year;
    }
    if (value.ta !== undefined) {
      bookmarkSubject.ta = value.ta;
    }
    if (value.memos !== undefined) {
      bookmarkSubject.memos = value.memos;
    }
    persistBookmarks(newBookmarks);
  };

  const clearBookmarks = useCallback(() => {
    const ok = window.confirm(
      "すべてのお気に入りの科目が削除されます。よろしいですか？",
    );
    if (ok) {
      persistBookmarks({
        ...createEmptyBookmarks(),
        twinsBaseline: bookmarksRef.current.twinsBaseline,
      });
    }
  }, [persistBookmarks]);

  const updateMemoHeaders = useCallback(
    (memoHeaders: (string | null)[]) => {
      const newBookmarks = structuredClone(bookmarksRef.current);
      newBookmarks.memoHeaders = memoHeaders;
      persistBookmarks(newBookmarks);
    },
    [persistBookmarks],
  );

  const exportToTwinte = useCallback(() => {
    // cf. https://github.com/twin-te/twinte-front/pull/529
    const baseUrl = "https://app.twinte.net/import?codes=";
    const codes = Object.keys(bookmarks.subjects).filter((key) => {
      return bookmarks.subjects[key].year === CURRENT_YEAR;
    });
    window.open(baseUrl + codes.join(","));
  }, [bookmarks.subjects]);

  const getTwinsPlanCodes = useCallback(
    (module: TwinsModule, observedCodes: readonly string[] = []) =>
      getDesiredTwinsCodes(
        bookmarks.subjects,
        kdb.subjectMap,
        module,
        CURRENT_YEAR,
        observedCodes,
      ),
    [bookmarks.subjects],
  );

  const importTwinsCourses = useCallback(
    (codes: string[]) => {
      const currentBookmarks = bookmarksRef.current;
      const { subjects, report } = mergeTwinsCourses(
        currentBookmarks.subjects,
        codes,
        kdb.subjectMap,
        CURRENT_YEAR,
      );
      if (report.added.length > 0) {
        persistBookmarks({ ...currentBookmarks, subjects });
      }
      return {
        added: report.added,
        existing: report.alreadyPresent,
        skipped: [
          ...report.unknown,
          ...report.conflicts.map(({ code }) => code),
        ],
        unknown: report.unknown,
        conflicts: report.conflicts,
      };
    },
    [persistBookmarks],
  );

  const syncTwinsCourses = useCallback(
    (codes: string[]) => {
      const currentBookmarks = bookmarksRef.current;
      const { subjects, baseline, report } = syncTwinsCourseBaseline(
        currentBookmarks.subjects,
        currentBookmarks.twinsBaseline,
        codes,
        kdb.subjectMap,
        CURRENT_YEAR,
      );
      // Save subjects and the observation baseline together, including empty reads.
      persistBookmarks({
        ...currentBookmarks,
        subjects,
        twinsBaseline: baseline,
      });
      return {
        added: report.added,
        existing: report.alreadyPresent,
        skipped: [
          ...report.unknown,
          ...report.conflicts.map(({ code }) => code),
        ],
        unknown: report.unknown,
        conflicts: report.conflicts,
      };
    },
    [persistBookmarks],
  );

  return {
    bookmarkTimeslotTable,
    bookmarkSubjectTable,
    yearCredits,
    totalCredits,
    currentCredits,
    currentTimeslots,
    memoHeaders: bookmarks.memoHeaders,
    memoLength,
    memoTotals,
    memoSlashLineCredits,
    bookmarksHas,
    getBookmarkSubject,
    switchBookmark,
    updateBookmark,
    clearBookmarks,
    updateMemoHeaders,
    exportToTwinte,
    getTwinsPlanCodes,
    importTwinsCourses,
    syncTwinsCourses,
  };
};
