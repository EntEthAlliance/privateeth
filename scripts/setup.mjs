// One-time setup: creates the demo keys, deploys the contracts, approves both banks,
// mints test dollars to the banks and funds every account with a little ETH for gas.
//   node scripts/setup.mjs            (uses RPC_URL and DEPLOYER_KEY from .env)
import { writeFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { parseEther, formatEther } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { loadEnv, clients, deployAll, send, ART, explorerFor } from "../lib/chain.js";
import { newShieldedKeys, publicShielded } from "../lib/core.js";
import { printLinks } from "./links.mjs";

loadEnv();
const RPC = process.env.RPC_URL, KEY = process.env.DEPLOYER_KEY;
if (!RPC || !KEY) { console.error("Set RPC_URL and DEPLOYER_KEY in .env (see .env.example)"); process.exit(1); }
const MINT_A = BigInt(process.env.MINT_BANK_A || 1000), MINT_B = BigInt(process.env.MINT_BANK_B || 500);
const FUND = parseEther(process.env.FUND_ETH || "0.05");

const { pub, wallet, chain } = await clients(RPC, KEY);
const me = wallet.account.address;
console.log(`Chain ${chain.id} · deployer ${me} · balance ${formatEther(await pub.getBalance({ address: me }))} ETH\n`);

// 1. Keys (kept if they already exist, so re-running never strands funds)
mkdirSync("demo-keys", { recursive: true });
const mk = (file, extra) => {
  const path = `demo-keys/${file}`;
  if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8"));
  const k = { ethKey: generatePrivateKey(), ...extra };
  writeFileSync(path, JSON.stringify(k, null, 2));
  return k;
};
const bankA = mk("bank-a.json", { name: "Bank A", ...newShieldedKeys() });
const bankB = mk("bank-b.json", { name: "Bank B", ...newShieldedKeys() });
const relayer = mk("relayer.json", { name: "Relayer" });
const addr = (k) => privateKeyToAccount(k.ethKey).address;

// 2. Contracts
console.log("Deploying contracts (real ZK verifiers)…");
const dep = await deployAll(pub, wallet);
const regAbi = ART.AttestationRegistry.abi, poolAbi = ART.ShieldedPool.abi, tokAbi = ART.MockERC20.abi;

// 3. Configure: token, attester, approve both banks for one year
console.log("\nConfiguring…");
await send(pub, wallet, { address: dep.ShieldedPool, abi: poolAbi, functionName: "addSupportedToken", args: [dep.MockERC20] }, "pool accepts tUSD");
await send(pub, wallet, { address: dep.AttestationRegistry, abi: regAbi, functionName: "addAttester", args: [me] }, "deployer is the compliance attester");
const expires = BigInt(Math.floor(Date.now() / 1000) + 365 * 86400);
for (const b of [bankA, bankB])
  await send(pub, wallet, { address: dep.AttestationRegistry, abi: regAbi, functionName: "addAttestation", args: [publicShielded(b).ownerPubkey, expires] }, `approve ${b.name}`);

// 4. Money: test dollars to the banks, ETH for gas to everyone
await send(pub, wallet, { address: dep.MockERC20, abi: tokAbi, functionName: "mint", args: [addr(bankA), MINT_A] }, `mint ${MINT_A} tUSD to Bank A`);
await send(pub, wallet, { address: dep.MockERC20, abi: tokAbi, functionName: "mint", args: [addr(bankB), MINT_B] }, `mint ${MINT_B} tUSD to Bank B`);
for (const k of [bankA, bankB, relayer]) {
  const hash = await wallet.sendTransaction({ to: addr(k), value: FUND });
  await pub.waitForTransactionReceipt({ hash });
  console.log(`  ✓ ${formatEther(FUND)} ETH to ${k.name}  ${hash}`);
}

// 5. Directory: the public half of each bank, so they can pay each other
const directory = Object.fromEntries([bankA, bankB].map((b) => [b.name, { address: addr(b), ...publicShielded(b) }]));
const deployment = { chainId: chain.id, rpcUrl: RPC, explorer: explorerFor(chain.id), ...dep, relayer: addr(relayer), directory };
writeFileSync("deployment.json", JSON.stringify(deployment, null, 2));
console.log(`\nDone. Wrote deployment.json\n  Bank A ${addr(bankA)}\n  Bank B ${addr(bankB)}\n  Relayer ${addr(relayer)}\n  Pool   ${dep.ShieldedPool}`);
printLinks(process.env.SITE_URL || "https://hub.entethalliance.org/privateeth/");
