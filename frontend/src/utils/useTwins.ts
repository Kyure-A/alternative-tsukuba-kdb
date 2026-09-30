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

async function request(path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`/api/twins/${path}`, {
    method: body === undefined ? "GET" : "POST",
    cache: "no-store",
    credentials: "same-origin",
    headers:
      body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let result: unknown;
  try {
    result = await response.json();
  } catch {
    throw new Error(
      "TWINS 連携サーバーに接続できません。ローカル版から開いてください。",
    );
  }
  if (!response.ok) {
    const message = (result as { error?: { message?: unknown } })?.error
      ?.message;
    throw new Error(
      typeof message === "string" ? message : "TWINS の取得に失敗しました。",
    );
  }
  return result;
}

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
    setBusy("全モジュールの登録状況を照合中… 数分かかることがあります。");
    setError(null);
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

  const apply = async (actionKeys: string[], confirmedAcademicYear: number) => {
    if (!preview) return;
    const id = preview.id;
    const module = preview.before.module;
    setPreview(null);
    setError(null);
    setBusy(
      "TWINS に反映し、全モジュールを再照会しています。画面を閉じずにお待ちください。",
    );
    try {
      const next = parseTwinsApplyResult(
        await request("apply", { id, actionKeys, confirmedAcademicYear }),
        module,
      );
      setSnapshots(
        next.snapshots ??
          (next.after ? { [next.after.module]: next.after } : {}),
      );
      if (next.snapshots) {
        saveTwinsCache(localStorage, CURRENT_YEAR, next.snapshots);
        setImportCodes(snapshotCodes(next.snapshots));
      } else {
        clearTwinsCache(localStorage);
      }
      setResult(next);
    } catch (cause) {
      clearTwinsCache(localStorage);
      setSnapshots({});
      setError(
        `${cause instanceof Error ? cause.message : "反映結果を受信できませんでした。"} 結果が不明な場合は TWINS を読み直して確認してください。自動再送はしません。`,
      );
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
    importCodes,
    reload,
    review,
    apply,
  };
};
