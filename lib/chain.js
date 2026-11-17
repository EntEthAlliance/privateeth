// Node-only helpers: .env loading, contract artifacts, library linking and deployment.
import { readFileSync, existsSync } from "node:fs";
export { chainFor, explorerFor, clients } from "./net.js";

export const ART = JSON.parse(readFileSync(new URL("../artifacts/contracts.json", import.meta.url), "utf8"));

export function loadEnv(file = ".env") {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

function link(bytecode, refs, deployed) {
  let code = bytecode.slice(2);
  for (const [file, libs] of Object.entries(refs || {}))
    for (const [name, spots] of Object.entries(libs)) {
      const addr = deployed[`${file}:${name}`];
      if (!addr) throw new Error(`Library ${file}:${name} not deployed yet`);
      for (const { start } of spots) code = code.slice(0, start * 2) + addr.slice(2).toLowerCase() + code.slice(start * 2 + 40);
    }
  return "0x" + code;
}

export async function send(pub, wallet, req, label, log = console.log) {
  const hash = await wallet.writeContract(req);
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 300_000 });
  if (r.status !== "success") throw new Error(`${label} reverted (${hash})`);
  log(`  ✓ ${label}  ${hash}`);
  return r;
}

export async function deployOne(pub, wallet, key, args, deployed, log = console.log) {
  const a = ART[key];
  const hash = await wallet.deployContract({ abi: a.abi, bytecode: link(a.bytecode, a.linkReferences, deployed), args });
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 300_000 });
  if (r.status !== "success" || !r.contractAddress) throw new Error(`Deploy ${key} failed (${hash})`);
  deployed[key] = r.contractAddress;
  log(`  ✓ ${key.split(":").pop().padEnd(22)} ${r.contractAddress}  gas ${r.gasUsed}`);
  return r;
}

// Deploys the whole system: libraries, real verifiers, registry, pool and a demo token.
export async function deployAll(pub, wallet, log = console.log) {
  const d = {};
  const first = await deployOne(pub, wallet, "dependencies/poseidon-solidity-0.0.5/PoseidonT3.sol:PoseidonT3", [], d, log);
  await deployOne(pub, wallet, "dependencies/poseidon-solidity-0.0.5/PoseidonT5.sol:PoseidonT5", [], d, log);
  await deployOne(pub, wallet, "dependencies/zk-kit-v1/packages/lean-imt/contracts/LeanIMT.sol:LeanIMT", [], d, log);
  for (const c of ["Deposit", "Transfer", "Withdraw"]) {
    await deployOne(pub, wallet, `src/verifiers/${c}Verifier.sol:ZKTranscriptLib`, [], d, log);
    // Each verifier links the ZKTranscriptLib from its own file.
    await deployOne(pub, wallet, `${c}Verifier`, [], d, log);
  }
  await deployOne(pub, wallet, "CompositeVerifier", [d.DepositVerifier, d.TransferVerifier, d.WithdrawVerifier], d, log);
  await deployOne(pub, wallet, "AttestationRegistry", [], d, log);
  await deployOne(pub, wallet, "ShieldedPool", [d.CompositeVerifier, d.AttestationRegistry], d, log);
  await deployOne(pub, wallet, "MockERC20", ["Test USD", "tUSD", 0], d, log);
  // Keep only the addresses the wallets use, under readable names.
  return {
    ShieldedPool: d.ShieldedPool, AttestationRegistry: d.AttestationRegistry, MockERC20: d.MockERC20,
    CompositeVerifier: d.CompositeVerifier, DepositVerifier: d.DepositVerifier, TransferVerifier: d.TransferVerifier,
    WithdrawVerifier: d.WithdrawVerifier, startBlock: Number(first.blockNumber),
  };
}
