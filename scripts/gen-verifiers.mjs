// Regenerates the Solidity verifiers with the same bb.js version the wallet proves with,
// so proofs and on-chain verifiers can never drift apart.
import { readFileSync, writeFileSync } from "node:fs";
import { Barretenberg, UltraHonkBackend } from "@aztec/bb.js";

const api = await Barretenberg.new();
for (const name of ["deposit", "transfer", "withdraw"]) {
  const circuit = JSON.parse(readFileSync(`web/public/circuits/${name}.json`, "utf8"));
  const backend = new UltraHonkBackend(circuit.bytecode, api);
  const vk = await backend.getVerificationKey({ verifierTarget: "evm" });
  const sol = await backend.getSolidityVerifier(vk, { verifierTarget: "evm" });
  const file = `contracts/src/verifiers/${name[0].toUpperCase() + name.slice(1)}Verifier.sol`;
  writeFileSync(file, sol);
  console.log("wrote", file, sol.length, "bytes");
}
await api.destroy();
