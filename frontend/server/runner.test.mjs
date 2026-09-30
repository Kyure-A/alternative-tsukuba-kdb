import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { commandArgs, createRunner, classifyCliFailure, TWINS_FLAKE } from "./runner.mjs";

function fakeChild() {
  const child = new EventEmitter();
  child.pid = 123;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {};
  return child;
}

test("CLI argv is pinned, uses exact allowed verbs, and converts zero-based day once", () => {
  assert.deepEqual(commandArgs({ kind: "read-all" }), ["run", TWINS_FLAKE, "--", "timetable", "--all", "--json"]);
  assert.deepEqual(commandArgs({ kind: "read", module: "autumn-a" }), ["run", TWINS_FLAKE, "--", "timetable", "--module", "autumn-a", "--json"]);
  assert.deepEqual(commandArgs({ kind: "add", module: "autumn-b", code: "AB12345", day: 4, period: 6 }), ["run", TWINS_FLAKE, "--", "registration", "add", "AB12345", "--module", "autumn-b", "--day", "5", "--period", "6", "--yes"]);
  assert.deepEqual(commandArgs({ kind: "remove", module: "autumn-c", code: "AB12345" }), ["run", TWINS_FLAKE, "--", "registration", "remove", "AB12345", "--module", "autumn-c", "--yes"]);
  assert.throws(() => commandArgs({ kind: "login" }), { code: "invalid_operation" });
});

test("runner serializes shared cookie access, disables shell and preserves split UTF-8 output", async () => {
  const children = [];
  const run = createRunner({ spawnProcess: (command, args, options) => {
    assert.equal(command, "nix");
    assert.equal(options.shell, false);
    assert.equal(options.detached, true);
    assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);
    const child = fakeChild();
    children.push(child);
    return child;
  } });
  const first = run({ kind: "read", module: "autumn-a" });
  const second = run({ kind: "read", module: "autumn-b" });
  await new Promise(setImmediate);
  assert.equal(children.length, 1);
  const bytes = Buffer.from("秋A 月曜日");
  children[0].stdout.write(bytes.subarray(0, 1));
  children[0].stdout.write(bytes.subarray(1));
  children[0].emit("close", 0);
  assert.equal(await first, "秋A 月曜日");
  await new Promise(setImmediate);
  assert.equal(children.length, 2);
  children[1].stdout.write("[]");
  children[1].emit("close", 0);
  assert.equal(await second, "[]");
});

test("timeout kills the group and keeps queue held until SIGKILL cleanup, even if parent closes early", async () => {
  const children = [];
  const signals = [];
  const run = createRunner({
    timeoutMs: 10,
    killGraceMs: 20,
    spawnProcess: () => {
      const child = fakeChild();
      children.push(child);
      return child;
    },
    killProcessGroup: (pid, signal) => {
      signals.push([pid, signal]);
      if (signal === "SIGTERM") children[0].emit("close", 1);
      if (signal === "SIGKILL") assert.equal(children.length, 1);
    },
  });
  const first = run({ kind: "add", module: "autumn-a", code: "A", day: 0, period: 1 });
  const assertion = assert.rejects(first, { code: "cli_timeout" });
  const second = run({ kind: "read", module: "autumn-a" });
  await assertion;
  await new Promise(setImmediate);
  assert.deepEqual(signals, [[123, "SIGTERM"], [123, "SIGKILL"]]);
  assert.equal(children.length, 2);
  children[1].stdout.write("[]");
  children[1].emit("close", 0);
  await second;
});

test("raw CLI error output is never returned to API caller", async () => {
  const run = createRunner({ spawnProcess: () => {
    const child = fakeChild();
    setImmediate(() => {
      child.stdout.write("private-response-data");
      child.stderr.write("private-cookie-data");
      child.emit("close", 1);
    });
    return child;
  } });
  await assert.rejects(run({ kind: "read", module: "autumn-a" }), (error) => {
    assert.equal(error.code, "cli_failed");
    assert.doesNotMatch(error.message, /private/);
    return true;
  });
});


test("structured CLI errors classify fixed causes and retain only safe numeric metadata", () => {
  for (const code of ["authentication_required", "http_error", "protocol_error", "io_error", "invalid_argument", "unexpected_error"]) {
    const error = classifyCliFailure(JSON.stringify({ error: {
      code,
      httpStatus: 503,
      message: "private-secret",
      uri: "https://private.invalid/secret",
      token: "private-token",
    } }), 1);
    assert.equal(error.code, `twins_${code}`);
    assert.equal(error.exitCode, 1);
    assert.equal(error.httpStatus, code === "http_error" ? 503 : undefined);
    assert.equal(error.cause, undefined);
    assert.doesNotMatch(JSON.stringify(error), /private|secret|token/);
    assert.doesNotMatch(error.message, /private|secret|token/);
  }
  for (const httpStatus of [99, 600, 401.5, "401", null]) {
    assert.equal(classifyCliFailure(JSON.stringify({ error: { code: "http_error", httpStatus } }), null).httpStatus, undefined);
  }
  assert.equal(classifyCliFailure("unstructured", null).exitCode, undefined);
  assert.equal(classifyCliFailure("unstructured", Number.NaN).exitCode, undefined);
});

test("malformed, unknown and non-JSON prefixed errors remain unclassified without guessing authentication", () => {
  for (const stderr of [
    '{"error":{"code":"authentication_required"}',
    '{"error":{"code":"unknown_private_reason"}}',
    '{"error":{"code":"constructor"}}',
    'twins: {"error":{"code":"authentication_required"}}',
    'session expired: private-secret',
    'null',
    '[]',
  ]) {
    const error = classifyCliFailure(stderr, 1);
    assert.equal(error.code, "cli_failed");
    assert.doesNotMatch(error.message, /private|secret|expired/);
  }
});

test("JSON classification survives split UTF-8 chunks and surrounding Nix warning lines", async () => {
  const run = createRunner({ spawnProcess: () => {
    const child = fakeChild();
    setImmediate(() => {
      const source = Buffer.from('warning: Nix 診断 private-secret\n{"error":{"code":"http_error","httpStatus":503,"message":"秘密 private-secret"}}\nwarning: more noise\n');
      for (let offset = 0; offset < source.length; offset += 2) child.stderr.write(source.subarray(offset, offset + 2));
      child.emit("close", 1);
    });
    return child;
  } });
  await assert.rejects(run({ kind: "read-all" }), (error) => {
    assert.equal(error.code, "twins_http_error");
    assert.equal(error.httpStatus, 503);
    assert.equal(error.exitCode, 1);
    assert.doesNotMatch(error.message, /private|secret|秘密|Nix/);
    assert.doesNotMatch(JSON.stringify(error), /private|secret|秘密/);
    return true;
  });
});

test("stderr is bounded and output overflow kills the group without leaking raw bytes", async () => {
  const signals = [];
  let child;
  const run = createRunner({
    maxOutputBytes: 20,
    killGraceMs: 1,
    spawnProcess: () => {
      child = fakeChild();
      setImmediate(() => child.stderr.write("private-secret ".repeat(10)));
      return child;
    },
    killProcessGroup: (_pid, signal) => {
      signals.push(signal);
      if (signal === "SIGTERM") child.emit("close", 1);
    },
  });
  await assert.rejects(run({ kind: "read-all" }), (error) => {
    assert.equal(error.code, "cli_output_limit");
    assert.doesNotMatch(error.message, /private|secret/);
    return true;
  });
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
});
