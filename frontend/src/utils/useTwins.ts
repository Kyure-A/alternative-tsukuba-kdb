import { useCallback, useEffect, useRef, useState } from "react";
import { CURRENT_YEAR } from "./subject";

import {
  parseTwinsApplyResult,
  parseTwinsPreview,
  parseTwinsSnapshot,
  TWINS_MODULES,
  type TwinsApplyResult,
  type TwinsModule,
  type TwinsPreview,
  type TwinsSnapshot,
} from "./twins";
import { clearTwinsCache, readTwinsCache, saveTwinsCache } from "./twinsCache";
import {
  handleTwinsApplyFailure,
  requestTwins as request,
  type TwinsApplyFailure,
} from "./twinsRequest";

export const twinsPlanKey = (
  desiredByModule: Partial<Record<TwinsModule, string[]>>,
) =>
  TWINS_MODULES.map(
    (module) =>
      `${module}:${[...new Set(desiredByModule[module] ?? [])].sort().join(",")}`,
  ).join(";");

const snapshotCodes = (
  snapshots: Partial<Record<TwinsModule, TwinsSnapshot>>,
) => [
  ...new Set(
    Object.values(snapshots).flatMap((snapshot) =>
      snapshot.entries.map((entry) => entry.code),
    ),
  ),
];

export const useTwins = () => {
  const [initialCache] = useState(() =>
    readTwinsCache(localStorage, CURRENT_YEAR),
  );
  const [snapshots, setSnapshots] = useState<
    Partial<Record<TwinsModule, TwinsSnapshot>>
  >(initialCache ?? {});
  const [preview, setPreview] = useState<TwinsPreview | null>(null);
  const [reviewKey, setReviewKey] = useState("");
  const [result, setResult] = useState<TwinsApplyResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applyFailure, setApplyFailure] = useState<TwinsApplyFailure | null>(
    null,
  );
  const [importCodes, setImportCodes] = useState<string[] | null>(
    initialCache ? snapshotCodes(initialCache) : null,
  );
  const started = useRef(false);
  const available = ["localhost", "127.0.0.1"].includes(
    window.location.hostname,
  );

  const reload = useCallback(async () => {
    setBusy("TWINS の時間割を取得中…");
    setError(null);
    setApplyFailure(null);
    setPreview(null);
    try {
      const data = (await request("timetables")) as {
        snapshots?: Record<string, unknown>;
      };
      const next: Partial<Record<TwinsModule, TwinsSnapshot>> = {};
      for (const module of TWINS_MODULES) {
        next[module] = parseTwinsSnapshot(data.snapshots?.[module], module);
      }
      const jstDate = new Date(Date.now() + 9 * 60 * 60 * 1000);
      const academicYear =
        jstDate.getUTCFullYear() - (jstDate.getUTCMonth() < 3 ? 1 : 0);
      if (academicYear !== CURRENT_YEAR) {
        throw new Error(
          "TWINS と KdB の年度を確認し、科目データを更新してください。自動取り込みを停止しました。",
        );
      }
      saveTwinsCache(localStorage, CURRENT_YEAR, next);
      setSnapshots(next);
      setImportCodes(snapshotCodes(next));
      return true;
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "時間割を取得できませんでした。",
      );
      return false;
    } finally {
      setBusy(null);
    }
  }, []);

  useEffect(() => {
    // StrictMode replays effects; a page load still starts one read only.
    if (!available || initialCache || started.current) return;
    started.current = true;
    void reload();
  }, [available, initialCache, reload]);

  const review = async (
    module: TwinsModule,
    academicYear: number,
    desiredByModule: Partial<Record<TwinsModule, string[]>>,
  ) => {
    setBusy("TWINS の登録状況を確認中…");
    setError(null);
    setApplyFailure(null);
    setPreview(null);
    setResult(null);
    try {
      const next = parseTwinsPreview(
        await request("preview", { module, academicYear, desiredByModule }),
        module,
        academicYear,
      );
      setReviewKey(twinsPlanKey(desiredByModule));
      setPreview(next);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "差分を取得できませんでした。",
      );
    } finally {
      setBusy(null);
    }
  };

  const apply = async (actionKeys: string[], academicYear: number) => {
    if (!preview) return;
    const id = preview.id;
    const module = preview.before.module;
    setPreview(null);
    setError(null);
    setApplyFailure(null);
    setResult(null);
    setBusy(
      "TWINS に反映し、全モジュールを再照会しています。画面を閉じずにお待ちください。",
    );
    try {
      const next = parseTwinsApplyResult(
        await request("apply", { id, actionKeys, academicYear }),
        module,
      );
      setSnapshots(
        next.snapshots ??
          (next.after ? { [next.after.module]: next.after } : {}),
      );
      setResult(next);
      setImportCodes(next.snapshots ? snapshotCodes(next.snapshots) : null);
      try {
        if (next.snapshots) {
          saveTwinsCache(localStorage, CURRENT_YEAR, next.snapshots);
        } else {
          clearTwinsCache(localStorage);
        }
      } catch {
        try {
          clearTwinsCache(localStorage);
        } catch {
          // Keep the received result even when browser storage is unavailable.
        }
        setError("取得結果のブラウザー保存に失敗しました。");
      }
    } catch (cause) {
      const failure = handleTwinsApplyFailure(cause, () =>
        clearTwinsCache(localStorage),
      );
      if (failure.mutationState !== "not_started") {
        setSnapshots({});
        setImportCodes(null);
      }
      setApplyFailure(failure);
      setError(failure.message);
    } finally {
      setBusy(null);
    }
  };

  return {
    available,
    snapshots,
    preview,
    reviewKey,
    result,
    busy,
    error,
    applyFailure,
    importCodes,
    reload,
    review,
    apply,
  };
};
