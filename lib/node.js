// Node-side loaders for the local server and scripts.
import { readFileSync } from "node:fs";
import { makeBank } from "./actions.js";

export const loadCircuitsFromDisk = async () => Object.fromEntries(
  ["deposit", "transfer", "withdraw"].map((n) => [n, JSON.parse(readFileSync(new URL(`../web/public/circuits/${n}.json`, import.meta.url), "utf8"))]));

export function openBank(keyFile, depFile = "deployment.json", rpcOverride) {
  const dep = JSON.parse(readFileSync(depFile, "utf8"));
  const keys = JSON.parse(readFileSync(keyFile, "utf8"));
  const relayerKey = JSON.parse(readFileSync(keyFile.replace(/bank-[ab]\.json$/, "relayer.json"), "utf8")).ethKey;
  return makeBank({ dep, keys, relayerKey, rpcUrl: rpcOverride || process.env.RPC_URL || dep.rpcUrl, loadCircuits: loadCircuitsFromDisk });
}
