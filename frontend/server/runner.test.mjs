import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { commandArgs, createRunner, TWINS_FLAKE } from "./runner.mjs";

function fakeChild() {
  const child = new EventEmitter();
  child.pid = 123;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {};
  return child;
}

test("CLI argv is pinned, uses exact allowed verbs, and converts zero-based day once", () => {
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
