import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCatalog } from "./catalog.mjs";
import { createBridgeServer } from "./http.mjs";
import { createRunner } from "./runner.mjs";
import { createJournal, createTwinsService } from "./service.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.PORT ?? 4317);
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error("PORT must be an integer from 1024 to 65535");
}
const datasets = await Promise.all(
  ["kdb.json", "kdb-grad.json"].map(async (name) =>
    JSON.parse(await readFile(path.join(root, "src/kdb", name), "utf8")),
  ),
);
const journal = await createJournal(path.join(root, ".twins-state.local"));
const service = createTwinsService({ run: createRunner(), catalog: createCatalog(datasets), journal });
const server = createBridgeServer({ service, distDirectory: path.join(root, "dist"), port });
server.listen(port, "127.0.0.1", () => {
  console.info(`TWINS local bridge: http://127.0.0.1:${port}/alternative-tsukuba-kdb/`);
});
server.on("error", () => {
  console.error("TWINS local bridge could not start. Check PORT and local file permissions.");
  process.exitCode = 1;
});
