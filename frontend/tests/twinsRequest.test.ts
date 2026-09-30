import assert from "node:assert/strict";
import test from "node:test";

import { parseTwinsApplyResult } from "../src/utils/twins.ts";
import {
  handleTwinsApplyFailure,
  requestTwins,
  TwinsRequestError,
} from "../src/utils/twinsRequest.ts";

const jsonResponse = (status: number, body: unknown): typeof fetch =>
  async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

test("explicit before-write HTTP failure preserves code, status, exact message and cache", async () => {
  const serverError = { code: "cli_preflight_failed", message: "TWINS の事前確認に失敗しました。", mutationState: "not_started" };
  let cleared = 0;
  await assert.rejects(
    requestTwins("apply", { id: "review", actionKeys: ["add-one"], academicYear: 2026 }, jsonResponse(502, { error: serverError })),
    (cause: unknown) => {
      assert.ok(cause instanceof TwinsRequestError);
      const failure = handleTwinsApplyFailure(cause, () => { cleared++; });
      assert.deepEqual(failure, { code: serverError.code, status: 502, mutationState: "not_started", message: serverError.message });
      return true;
    },
  );
  assert.equal(cleared, 0);
});

test("HTTP status alone never implies a before-write failure", async () => {
  let cleared = 0;
  await assert.rejects(
    requestTwins("apply", {}, jsonResponse(400, { error: { code: "rejected", message: "Request failed" } })),
    (cause: unknown) => {
      const failure = handleTwinsApplyFailure(cause, () => { cleared++; });
      assert.equal(failure.code, "rejected");
      assert.equal(failure.mutationState, "unknown");
      assert.equal(failure.status, 400);
      return true;
    },
  );
  assert.equal(cleared, 1);
});

test("an explicit unknown write outcome invalidates cache and gives one short recovery message", async () => {
  let cleared = 0;
  await assert.rejects(
    requestTwins("apply", {}, jsonResponse(500, { error: { code: "verification_failed", message: "details", mutationState: "unknown" } })),
    (cause: unknown) => {
      const failure = handleTwinsApplyFailure(cause, () => { cleared++; });
      assert.equal(failure.code, "verification_failed");
      assert.equal(failure.mutationState, "unknown");
      assert.equal(failure.message, "反映結果を確認できませんでした。TWINS から取得して確認してください。");
      return true;
    },
  );
  assert.equal(cleared, 1);
});

test("transport failure is ambiguous even when cache invalidation also throws", async () => {
  const fetcher: typeof fetch = async () => { throw new TypeError("Failed to fetch"); };
  let attempted = false;
  await assert.rejects(requestTwins("apply", {}, fetcher), (cause: unknown) => {
    const failure = handleTwinsApplyFailure(cause, () => {
      attempted = true;
      throw new Error("Storage disabled");
    });
    assert.equal(failure.mutationState, "unknown");
    assert.equal(failure.code, null);
    assert.doesNotMatch(failure.message, /Storage|Failed to fetch/);
    return true;
  });
  assert.equal(attempted, true);
});

test("unreadable HTTP success cannot preserve the old baseline", async () => {
  const fetcher: typeof fetch = async () => new Response("<html>server unavailable</html>", { status: 200 });
  let cleared = 0;
  await assert.rejects(requestTwins("apply", {}, fetcher), (cause: unknown) => {
    const failure = handleTwinsApplyFailure(cause, () => { cleared++; });
    assert.equal(failure.code, "invalid_response");
    assert.equal(failure.mutationState, "unknown");
    return true;
  });
  assert.equal(cleared, 1);
});

test("malformed success payload is ambiguous even when it contains a not_started string", async () => {
  const payload = await requestTwins("apply", {}, jsonResponse(200, { status: "verified", mutationState: "not_started" }));
  let cleared = 0;
  assert.throws(() => parseTwinsApplyResult(payload));
  try {
    parseTwinsApplyResult(payload);
  } catch (cause) {
    const failure = handleTwinsApplyFailure(cause, () => { cleared++; });
    assert.equal(failure.mutationState, "unknown");
    assert.doesNotMatch(failure.message, /Zod|Invalid|expected/);
  }
  assert.equal(cleared, 1);
});

test("apply requests send academicYear without a confirmation flag", async () => {
  const fetcher: typeof fetch = async (_input, init) => {
    assert.equal(init?.method, "POST");
    assert.deepEqual(JSON.parse(String(init?.body)), { id: "review", actionKeys: ["add-one"], academicYear: 2026 });
    return new Response("{}", { status: 200 });
  };
  await requestTwins("apply", { id: "review", actionKeys: ["add-one"], academicYear: 2026 }, fetcher);
});
