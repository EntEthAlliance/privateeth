// Command-line alternative to the website's setup page: deploys the contracts, creates a
// demo session (two approved banks with test dollars and gas, plus a relayer) and prints
// the private role links.   node scripts/setup.mjs   (RPC_URL and DEPLOYER_KEY from .env)
import { writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { parseEther, formatEther } from "viem";
import { loadEnv, clients, ART, explorerFor } from "../lib/chain.js";
import { deployContracts, createSession, newSessionKeys } from "../lib/deploy.js";
import { printLinks } from "./links.mjs";

loadEnv();
const RPC = process.env.RPC_URL, KEY = process.env.DEPLOYER_KEY;
if (!RPC || !KEY) { console.error("Set RPC_URL and DEPLOYER_KEY in .env (see .env.example)"); process.exit(1); }
const FUND = parseEther(process.env.FUND_ETH || "0.05");

const { pub, wallet, chain } = await clients(RPC, KEY);
console.log(`Chain ${chain.id} · deployer ${wallet.account.address} · balance ${formatEther(await pub.getBalance({ address: wallet.account.address }))} ETH\n`);
const log = (e) => { if (e.state === "done") console.log(`  ✓ ${e.label.padEnd(40)} ${e.address || e.hash || "(already done)"}${e.gas ? "  gas " + e.gas : ""}`); };

// Never overwrite keys that may hold ETH: move earlier ones aside first.
mkdirSync("demo-keys", { recursive: true });
if (["bank-a.json", "bank-b.json", "relayer.json"].some((f) => existsSync(`demo-keys/${f}`))) {
  const dir = `demo-keys/previous-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  mkdirSync(dir, { recursive: true });
  for (const f of ["bank-a.json", "bank-b.json", "relayer.json"]) if (existsSync(`demo-keys/${f}`)) renameSync(`demo-keys/${f}`, `${dir}/${f}`);
  console.log(`Kept the previous session's keys in ${dir}\n`);
}
// Save the new keys before any transaction funds them.
const keys = newSessionKeys();
const writeKeys = () => {
  writeFileSync("demo-keys/bank-a.json", JSON.stringify(keys.bankA, null, 2));
  writeFileSync("demo-keys/bank-b.json", JSON.stringify(keys.bankB, null, 2));
  writeFileSync("demo-keys/relayer.json", JSON.stringify(keys.relayer, null, 2));
};
writeKeys();

console.log("Deploying contracts (real ZK verifiers)…");
const dep = await deployContracts({ pub, wallet, ART, rpcUrl: RPC, log });
console.log("\nCreating the demo session…");
const s = await createSession({ pub, wallet, ART, dep, keys, mintA: BigInt(process.env.MINT_BANK_A || 1000), mintB: BigInt(process.env.MINT_BANK_B || 500), fundBank: FUND, fundRelayer: FUND, rpcUrl: RPC, log });

writeFileSync("deployment.json", JSON.stringify({ ...dep, sessionBlock: s.sessionBlock, explorer: explorerFor(chain.id), relayer: s.relayerAddress, directory: s.directory }, null, 2));
console.log(`\nDone. Wrote deployment.json and demo-keys/. Pool ${dep.ShieldedPool}`);
printLinks(process.env.SITE_URL || "https://hub.entethalliance.org/privateeth/");
