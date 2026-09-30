import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { BridgeError } from "./runner.mjs";

const API = "/api/twins/";
const BASE = "/alternative-tsukuba-kdb/";
const MAX_BODY = 32 * 1024;
const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
};

export function isAllowedRequest(request, port, isApi) {
  const host = request.headers.host;
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  if (!allowedHosts.has(host)) return false;
  if (!isApi) return true;
  const origin = request.headers.origin;
  if (origin !== undefined && origin !== `http://${host}`) return false;
  const site = request.headers["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin" && site !== "none") return false;
  if (request.method === "POST" && origin !== `http://${host}`) return false;
  return true;
}

async function readJson(request) {
  if (request.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new BridgeError("json_required", "JSON 形式のリクエストが必要です。", 415);
  }
  if (Number(request.headers["content-length"]) > MAX_BODY) {
    throw new BridgeError("body_too_large", "リクエストが大きすぎます。", 413);
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > MAX_BODY) throw new BridgeError("body_too_large", "リクエストが大きすぎます。", 413);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new BridgeError("invalid_json", "JSON を読み取れませんでした。");
  }
}

function json(response, status, value) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store, max-age=0",
    Pragma: "no-cache",
    "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Resource-Policy": "same-origin",
  });
  response.end(JSON.stringify(value));
}

export function createBridgeServer({ service, distDirectory, port = 4317 }) {
  const server = createServer(async (request, response) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      const isApi = url.pathname.startsWith(API);
      // During tests port 0 uses the actual assigned port. Production binds only
      // to 127.0.0.1; the Host check also prevents DNS rebinding aliases.
      const listeningPort = server.address()?.port ?? port;
      if (!isAllowedRequest(request, listeningPort, isApi)) {
        throw new BridgeError("forbidden_origin", "同じローカル画面からアクセスしてください。", 403);
      }
      if (isApi) {
        if (request.method === "GET" && url.pathname === `${API}timetables`) {
          return json(response, 200, await service.timetables());
        }
        if (request.method === "GET" && url.pathname === `${API}timetable`) {
          return json(response, 200, await service.timetable(url.searchParams.get("module")));
        }
        if (request.method === "POST" && url.pathname === `${API}preview`) {
          return json(response, 200, await service.preview(await readJson(request)));
        }
        if (request.method === "POST" && url.pathname === `${API}apply`) {
          return json(response, 200, await service.apply(await readJson(request)));
        }
        throw new BridgeError("not_found", "API が見つからないか、HTTP メソッドが異なります。", 404);
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        throw new BridgeError("method_not_allowed", "この HTTP メソッドは使用できません。", 405);
      }
      if (url.pathname === "/" || url.pathname === BASE.slice(0, -1)) {
        response.writeHead(302, { Location: BASE, "Cache-Control": "no-store" });
        return response.end();
      }
      if (!url.pathname.startsWith(BASE)) throw new BridgeError("not_found", "ページが見つかりません。", 404);
      let relative;
      try {
        relative = decodeURIComponent(url.pathname.slice(BASE.length));
      } catch {
        throw new BridgeError("not_found", "ページが見つかりません。", 404);
      }
      if (relative.includes("\0") || relative.includes("\\")) {
        throw new BridgeError("not_found", "ページが見つかりません。", 404);
      }
      let file = path.resolve(distDirectory, relative || "index.html");
      if (!file.startsWith(`${path.resolve(distDirectory)}${path.sep}`)) {
        throw new BridgeError("not_found", "ページが見つかりません。", 404);
      }
      try {
        if (!(await stat(file)).isFile()) throw new Error("Not a file");
      } catch {
        if (path.extname(relative)) throw new BridgeError("not_found", "ファイルが見つかりません。", 404);
        file = path.join(distDirectory, "index.html");
      }
      let body;
      try {
        body = await readFile(file);
      } catch {
        throw new BridgeError("build_required", "フロントエンドを先にビルドしてください。", 503);
      }
      response.writeHead(200, {
        "Content-Type": CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream",
        "Cache-Control": "no-store",
      });
      response.end(request.method === "HEAD" ? undefined : body);
    } catch (error) {
      if (response.headersSent) return response.end();
      const known = error instanceof BridgeError;
      json(response, known ? error.status : 500, {
        error: {
          code: known ? error.code : "internal_error",
          message: known ? error.message : "ローカル連携でエラーが発生しました。状態を確認してからやり直してください。",
        },
      });
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  // CLI requests can include 8 module reads before and after mutation. Do not
  // sever the response while the serialized operation is still being verified.
  server.timeout = 0;
  return server;
}
