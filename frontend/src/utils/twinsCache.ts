import {
  type TwinsModule,
  type TwinsSnapshot,
  twinsSnapshotsSchema,
} from "./twins.ts";

export const TWINS_CACHE_KEY = "kdb_twins";
export type TwinsSnapshots = Record<TwinsModule, TwinsSnapshot>;
type CacheStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function readTwinsCache(
  storage: CacheStorage,
  academicYear: number,
): TwinsSnapshots | null {
  try {
    const raw = storage.getItem(TWINS_CACHE_KEY);
    if (!raw) return null;
    const cache = JSON.parse(raw);
    if (cache.schemaVersion !== 1 || cache.academicYear !== academicYear)
      return null;
    return twinsSnapshotsSchema.parse(cache.snapshots);
  } catch {
    return null;
  }
}

export function saveTwinsCache(
  storage: CacheStorage,
  academicYear: number,
  snapshots: unknown,
): TwinsSnapshots {
  const parsed = twinsSnapshotsSchema.parse(snapshots);
  storage.setItem(
    TWINS_CACHE_KEY,
    JSON.stringify({ schemaVersion: 1, academicYear, snapshots: parsed }),
  );
  return parsed;
}

export function clearTwinsCache(storage: CacheStorage) {
  storage.removeItem(TWINS_CACHE_KEY);
}
