import { z } from "zod";
import { twinsBaselineSchema } from "./twins.ts";

export const BOOKMARKS_KEY = "kdb_bookmarks";
export const BOOKMARKS_VERSION = 1;

const bookmarkSubjectSchema = z.object({
  year: z.number(),
  ta: z.boolean(),
  memos: z.array(z.string().nullable()),
});

export const bookmarksSchema = z.object({
  version: z.literal(BOOKMARKS_VERSION),
  subjects: z.record(z.string(), bookmarkSubjectSchema),
  memoHeaders: z.array(z.string().nullable()),
  twinsBaseline: twinsBaselineSchema.optional(),
});

export type BookmarkSubject = z.infer<typeof bookmarkSubjectSchema>;
export type Bookmarks = z.infer<typeof bookmarksSchema>;
