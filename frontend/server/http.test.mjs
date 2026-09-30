import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { get } from "node:http";
import { createBridgeServer, isAllowedRequest } from "./http.mjs";

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "twins-http-"));
  await writeFile(path.join(directory, "index.html"), "<!doctype html><title>Fixture</title>");
  const calls = [];
  const service = Object.fromEntries(["timetable", "timetables", "preview", "apply"].map((name) => [name, async (value) => {
    calls.push({ name, value });
    return { fixture: true };
  }]));
  const server = createBridgeServer({ service, distDirectory: directory, port: 0 });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  return { origin, calls };
}

test("loopback Host, exact Origin and fetch-site guards reject remote and rebinding requests", () => {
  const allowed = (headers, method = "GET") => isAllowedRequest({ method, headers }, 4317, true);
  assert.equal(allowed({ host: "127.0.0.1:4317" }), true);
  assert.equal(allowed({ host: "localhost:4317", origin: "http://localhost:4317", "sec-fetch-site": "same-origin" }, "POST"), true);
  for (const headers of [
    { host: "evil.example:4317" },
    { host: "127.0.0.1.evil.example:4317" },
    { host: "127.0.0.1:4317", origin: "https://evil.example" },
    { host: "127.0.0.1:4317", origin: "null" },
    { host: "127.0.0.1:4317", origin: "http://localhost:4317" },
    { host: "127.0.0.1:4317", "sec-fetch-site": "cross-site" },
    { host: "127.0.0.1:4317", "sec-fetch-site": "same-site" },
  ]) assert.equal(allowed(headers), false);
  assert.equal(allowed({ host: "127.0.0.1:4317" }, "POST"), false);
});

test("same-origin JSON API works, stays no-store, and rejects other request types before service", async (t) => {
  const f = await fixture(t);
  const response = await fetch(`${f.origin}/api/twins/timetable?module=autumn-a`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control"), /no-store/);
  assert.deepEqual(f.calls, [{ name: "timetable", value: "autumn-a" }]);
  const missingOrigin = await fetch(`${f.origin}/api/twins/apply`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(missingOrigin.status, 403);
  const crossOrigin = await fetch(`${f.origin}/api/twins/apply`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://evil.example" }, body: "{}" });
  assert.equal(crossOrigin.status, 403);
  const text = await fetch(`${f.origin}/api/twins/apply`, { method: "POST", headers: { "Content-Type": "text/plain", Origin: f.origin }, body: "{}" });
  assert.equal(text.status, 415);
  const invalid = await fetch(`${f.origin}/api/twins/apply`, { method: "POST", headers: { "Content-Type": "application/json", Origin: f.origin }, body: "{" });
  assert.equal(invalid.status, 400);
  const tooLarge = await fetch(`${f.origin}/api/twins/apply`, { method: "POST", headers: { "Content-Type": "application/json", Origin: f.origin }, body: `"${"x".repeat(33 * 1024)}"` });
  assert.equal(tooLarge.status, 413);
  assert.equal(f.calls.length, 1);
  const valid = await fetch(`${f.origin}/api/twins/preview`, { method: "POST", headers: { "Content-Type": "application/json", Origin: f.origin }, body: '{"module":"autumn-a"}' });
  assert.equal(valid.status, 200);
  assert.deepEqual(f.calls.at(-1), { name: "preview", value: { module: "autumn-a" } });
});

test("only built frontend files are served, with HTTP Host enforced", async (t) => {
  const f = await fixture(t);
  const page = await fetch(`${f.origin}/alternative-tsukuba-kdb/`);
  assert.match(await page.text(), /Fixture/);
  assert.equal(page.headers.get("x-frame-options"), "DENY");
  assert.equal((await fetch(`${f.origin}/alternative-tsukuba-kdb/%2e%2e%2fpackage.json`)).status, 404);
  assert.equal((await fetch(`${f.origin}/server/index.mjs`)).status, 404);
  assert.equal((await fetch(`${f.origin}/api/twins/login`, { method: "POST", headers: { Origin: f.origin } })).status, 404);
  const hostStatus = await new Promise((resolve, reject) => {
    get(`${f.origin}/api/twins/timetable?module=x`, { headers: { Host: "evil.example:4317" } }, (response) => {
      response.resume();
      resolve(response.statusCode);
    }).on("error", reject);
  });
  assert.equal(hostStatus, 403);
});


test("all-module endpoint performs a single service call and never caches the response", async (t) => {
  const f = await fixture(t);
  const response = await fetch(`${f.origin}/api/twins/timetables`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control"), /no-store/);
  assert.deepEqual(f.calls, [{ name: "timetables", value: undefined }]);
});


test("root serves the built page directly outside the old PWA scope without caching", async (t) => {
  const f = await fixture(t);
  const response = await fetch(`${f.origin}/`, { redirect: "manual" });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("location"), null);
  assert.match(response.headers.get("cache-control"), /no-store/);
  assert.match(response.headers.get("content-type"), /text\/html/);
  assert.match(await response.text(), /Fixture/);
  const base = await fetch(`${f.origin}/alternative-tsukuba-kdb/`);
  assert.equal(base.status, 200);
  assert.match(await base.text(), /Fixture/);
});
