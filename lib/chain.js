// Node-only helpers: .env loading and the compiled-contract bundle.
import { readFileSync, existsSync } from "node:fs";
export { chainFor, explorerFor, clients } from "./net.js";

export const ART = JSON.parse(readFileSync(new URL("../web/public/contracts.json", import.meta.url), "utf8"));

export function loadEnv(file = ".env") {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
