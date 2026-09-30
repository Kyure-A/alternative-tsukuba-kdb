export type TwinsMutationState = "not_started" | "unknown";

export class TwinsRequestError extends Error {
  readonly code: string | null;
  readonly status: number;
  readonly mutationState: TwinsMutationState;

  constructor(
    message: string,
    status: number,
    code: string | null,
    mutationState: TwinsMutationState = "unknown",
  ) {
    super(message);
    this.name = "TwinsRequestError";
    this.status = status;
    this.code = code;
    this.mutationState = mutationState;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export async function requestTwins(
  path: string,
  body?: unknown,
  fetcher: typeof fetch = fetch,
): Promise<unknown> {
  const response = await fetcher(`/api/twins/${path}`, {
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
    throw new TwinsRequestError(
      "TWINS 連携サーバーの応答を読み取れませんでした。",
      response.status,
      "invalid_response",
    );
  }
  if (!response.ok) {
    const error =
      isRecord(result) && isRecord(result.error) ? result.error : {};
    throw new TwinsRequestError(
      typeof error.message === "string" && error.message.trim()
        ? error.message
        : "TWINS との通信に失敗しました。",
      response.status,
      typeof error.code === "string" ? error.code : null,
      error.mutationState === "not_started" ? "not_started" : "unknown",
    );
  }
  return result;
}

export interface TwinsApplyFailure {
  code: string | null;
  status: number | null;
  mutationState: TwinsMutationState;
  message: string;
}

/** Only an explicit before-write outcome allows the saved snapshot to remain. */
export function handleTwinsApplyFailure(
  cause: unknown,
  clearCachedSnapshot: () => void,
): TwinsApplyFailure {
  const structured = cause instanceof TwinsRequestError ? cause : null;
  const mutationState = structured?.mutationState ?? "unknown";
  if (mutationState === "unknown") {
    try {
      clearCachedSnapshot();
    } catch {
      // A storage failure must not replace the original write outcome.
    }
  }
  return {
    code: structured?.code ?? null,
    status: structured?.status ?? null,
    mutationState,
    message:
      mutationState === "not_started" && structured
        ? structured.message
        : "反映結果を確認できませんでした。TWINS から取得して確認してください。",
  };
}
