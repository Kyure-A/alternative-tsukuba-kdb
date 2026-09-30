import { spawn } from "node:child_process";

export const TWINS_FLAKE =
  "github:Kyure-A/twins-cli/13367cec6fc82ee8ba07c7289c6b78c1657446ab";

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
          // Drain stderr without retaining or logging potentially private output.
          child.stderr.on("data", (chunk) => {
            bytes += chunk.length;
            if (bytes > maxOutputBytes) {
              abort("cli_output_limit", "TWINS の応答サイズが上限を超えました。");
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
              return reject(failure);
            }
            if (code !== 0) {
              return reject(
                new BridgeError(
                  "cli_failed",
                  "TWINS CLI が処理を完了できませんでした。ログイン状態・履修登録期間・TWINS の画面を確認してください。",
                  502,
                ),
              );
            }
            resolve(Buffer.concat(stdout).toString("utf8"));
          });
        }),
    );
}
