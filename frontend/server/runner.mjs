import { spawn } from "node:child_process";

export const TWINS_FLAKE =
  "github:Kyure-A/twins-cli/5e07a38f5e1da91658d5bce8afb67b6bbc7a8250";

export class BridgeError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function serialize() {
  let tail = Promise.resolve();
  return (work) => {
    const result = tail.then(work);
    tail = result.catch(() => {});
    return result;
  };
}

// Only these internally constructed CLI operations can ever be spawned.
export function commandArgs(operation) {
  const args = ["run", TWINS_FLAKE, "--"];
  if (operation.kind === "read-all") {
    return [...args, "timetable", "--all", "--json"];
  }
  if (operation.kind === "read") {
    return [...args, "timetable", "--module", operation.module, "--json"];
  }
  if (operation.kind === "add") {
    return [
      ...args,
      "registration",
      "add",
      operation.code,
      "--module",
      operation.module,
      "--day",
      String(operation.day + 1),
      "--period",
      String(operation.period),
      "--yes",
    ];
  }
  if (operation.kind === "remove") {
    return [
      ...args,
      "registration",
      "remove",
      operation.code,
      "--module",
      operation.module,
      "--yes",
    ];
  }
  throw new BridgeError("invalid_operation", "未対応の操作です。");
}

const SAFE_CLI_ERRORS = {
  authentication_required: "TWINS のセッションがないか、有効期限が切れています。ログインし直してから取得してください。",
  http_error: "TWINS が HTTP エラーを返しました。時間を置いてから状態を確認してください。",
  protocol_error: "TWINS の応答形式を読み取れませんでした。TWINS の画面と連携設定を確認してください。",
  io_error: "TWINS CLI の通信またはローカル状態の読み書きに失敗しました。",
  invalid_argument: "TWINS CLI に渡した条件が不正です。連携設定を確認してください。",
  unexpected_error: "TWINS CLI 内で予期しないエラーが発生しました。",
};

function safeExitCode(error, exitCode) {
  if (Number.isFinite(exitCode)) error.exitCode = exitCode;
  return error;
}

// Interpret only the pinned CLI's complete, structured error lines. Nix warning
// lines and unstructured error text never become messages, causes, or metadata.
export function classifyCliFailure(stderr, exitCode) {
  let cause = null;
  for (const line of stderr.split(/\r?\n/)) {
    try {
      const value = JSON.parse(line.trim());
      const error = value?.error;
      if (error && typeof error === "object" && !Array.isArray(error) &&
          typeof error.code === "string" && Object.hasOwn(SAFE_CLI_ERRORS, error.code)) {
        cause = { code: error.code };
        if (error.code === "http_error" && Number.isInteger(error.httpStatus) &&
            error.httpStatus >= 100 && error.httpStatus <= 599) {
          cause.httpStatus = error.httpStatus;
        }
      }
    } catch {}
  }
  const failure = cause
    ? new BridgeError(`twins_${cause.code}`, SAFE_CLI_ERRORS[cause.code], 502)
    : new BridgeError(
      "cli_failed",
      "TWINS CLI が処理を完了できませんでした。原因を特定できないため、TWINS の画面とローカル連携の状態を確認してください。",
      502,
    );
  if (cause?.httpStatus !== undefined) failure.httpStatus = cause.httpStatus;
  return safeExitCode(failure, exitCode);
}

export function createRunner({
  spawnProcess = spawn,
  timeoutMs = 90_000,
  maxOutputBytes = 8 * 1024 * 1024,
  killGraceMs = 1_000,
  killProcessGroup = (pid, signal) => process.kill(-pid, signal),
} = {}) {
  const exclusive = serialize();
  return (operation) =>
    exclusive(
      () =>
        new Promise((resolve, reject) => {
          let child;
          try {
            child = spawnProcess("nix", commandArgs(operation), {
              shell: false,
              detached: true,
              stdio: ["ignore", "pipe", "pipe"],
              env: process.env,
            });
          } catch {
            reject(
              new BridgeError(
                "cli_unavailable",
                "TWINS CLI を起動できません。Nix の設定を確認してください。",
                503,
              ),
            );
            return;
          }
          const stdout = [];
          const stderr = [];
          let bytes = 0;
          let failure = null;
          let killTimer;
          let cleanup = Promise.resolve();
          const killGroup = (signal) => {
            try {
              // detached makes the child the leader of its entire process group.
              killProcessGroup(child.pid, signal);
            } catch {
              try {
                child.kill(signal);
              } catch {}
            }
          };
          const abort = (code, message) => {
            if (failure) return;
            failure = new BridgeError(code, message, 502);
            cleanup = new Promise((resolveCleanup) => {
              killTimer = setTimeout(() => {
                killGroup("SIGKILL");
                resolveCleanup();
              }, killGraceMs);
            });
            killGroup("SIGTERM");
          };
          const timer = setTimeout(
            () =>
              abort(
                "cli_timeout",
                "TWINS の応答が時間切れになりました。操作は自動再試行しません。",
              ),
            timeoutMs,
          );
          child.stdout.on("data", (chunk) => {
            bytes += chunk.length;
            if (bytes > maxOutputBytes) {
              abort("cli_output_limit", "TWINS の応答サイズが上限を超えました。");
            } else {
              stdout.push(Buffer.from(chunk));
            }
          });
          // Retain bounded bytes only until completion; expose allowlisted structured
          // error fields, never raw stderr, messages, URLs, or response bodies.
          child.stderr.on("data", (chunk) => {
            bytes += chunk.length;
            if (bytes > maxOutputBytes) {
              abort("cli_output_limit", "TWINS の応答サイズが上限を超えました。");
            } else {
              stderr.push(Buffer.from(chunk));
            }
          });
          child.once("error", () => {
            failure ??= new BridgeError(
              "cli_unavailable",
              "TWINS CLI を起動できません。Nix とログイン状態を確認してください。",
              503,
            );
          });
          child.once("close", async (code) => {
            clearTimeout(timer);
            if (!failure) clearTimeout(killTimer);
            if (failure) {
              await cleanup;
              return reject(safeExitCode(failure, code));
            }
            if (code !== 0) {
              return reject(classifyCliFailure(Buffer.concat(stderr).toString("utf8"), code));
            }
            resolve(Buffer.concat(stdout).toString("utf8"));
          });
        }),
    );
}
