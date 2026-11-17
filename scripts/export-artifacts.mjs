// Copies the compiled contracts the demo needs out of Foundry's out/ folder into one
// artifacts/contracts.json, so the demo machine only needs Node (no Foundry).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const OUT = "contracts/out";
const pick = {
  ShieldedPool: "ShieldedPool.sol/ShieldedPool.json",
  AttestationRegistry: "AttestationRegistry.sol/AttestationRegistry.json",
  CompositeVerifier: "CompositeVerifier.sol/CompositeVerifier.json",
  MockERC20: "MockERC20.sol/MockERC20.json",
  DepositVerifier: "DepositVerifier.sol/HonkVerifier.json",
  TransferVerifier: "TransferVerifier.sol/HonkVerifier.json",
  WithdrawVerifier: "WithdrawVerifier.sol/HonkVerifier.json",
  "src/verifiers/DepositVerifier.sol:ZKTranscriptLib": "DepositVerifier.sol/ZKTranscriptLib.json",
  "src/verifiers/TransferVerifier.sol:ZKTranscriptLib": "TransferVerifier.sol/ZKTranscriptLib.json",
  "src/verifiers/WithdrawVerifier.sol:ZKTranscriptLib": "WithdrawVerifier.sol/ZKTranscriptLib.json",
  "dependencies/zk-kit-v1/packages/lean-imt/contracts/LeanIMT.sol:LeanIMT": "LeanIMT.sol/LeanIMT.json",
  "dependencies/poseidon-solidity-0.0.5/PoseidonT3.sol:PoseidonT3": "PoseidonT3.sol/PoseidonT3.json",
  "dependencies/poseidon-solidity-0.0.5/PoseidonT5.sol:PoseidonT5": "PoseidonT5.sol/PoseidonT5.json",
};
const all = {};
for (const [key, file] of Object.entries(pick)) {
  const j = JSON.parse(readFileSync(`${OUT}/${file}`, "utf8"));
  all[key] = { abi: j.abi, bytecode: j.bytecode.object, linkReferences: j.bytecode.linkReferences };
}
mkdirSync("artifacts", { recursive: true });
writeFileSync("artifacts/contracts.json", JSON.stringify(all));
// The browser only needs the ABIs of the contracts it talks to.
const abis = Object.fromEntries(["ShieldedPool", "AttestationRegistry", "MockERC20"].map((k) => [k, all[k].abi]));
writeFileSync("artifacts/abis.json", JSON.stringify(abis));
console.log("artifacts/contracts.json:", Object.keys(all).length, "contracts");
