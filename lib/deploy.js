// Deployment and demo sessions, shared by the browser setup page and the Node scripts.
// ART is the compiled-contract bundle (web/public/contracts.json); the caller loads it.
import { formatEther } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { newShieldedKeys, publicShielded } from "./core.js";

const LIB = {
  T3: "dependencies/poseidon-solidity-0.0.5/PoseidonT3.sol:PoseidonT3",
  T5: "dependencies/poseidon-solidity-0.0.5/PoseidonT5.sol:PoseidonT5",
  IMT: "dependencies/zk-kit-v1/packages/lean-imt/contracts/LeanIMT.sol:LeanIMT",
  ZK: (c) => `src/verifiers/${c}Verifier.sol:ZKTranscriptLib`,
};

// Rough gas budget, measured on Sepolia after its gas repricing (large contracts cost ~7x
// more to deploy there than on a local chain). Used only to suggest how much ETH to send.
export const GAS_BUDGET = { deploy: 260_000_000n, session: 3_000_000n, bank: 6_000_000n, relayer: 12_000_000n };

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

const noop = () => {};

async function confirm(pub, hash, label) {
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 600_000 });
  if (r.status !== "success") throw new Error(`${label} failed (transaction ${hash})`);
  return r;
}

async function deployOne(pub, wallet, ART, key, args, deployed, label, log) {
  const a = ART[key];
  log({ label, state: "sending" });
  const hash = await wallet.deployContract({ abi: a.abi, bytecode: link(a.bytecode, a.linkReferences, deployed), args });
  log({ label, state: "pending", hash });
  const r = await confirm(pub, hash, label);
  if (!r.contractAddress) throw new Error(`${label}: no contract address in receipt`);
  deployed[key] = r.contractAddress;
  log({ label, state: "done", hash, address: r.contractAddress, gas: r.gasUsed });
  return r;
}

export async function call(pub, wallet, req, label, log = noop) {
  log({ label, state: "sending" });
  const hash = await wallet.writeContract(req);
  log({ label, state: "pending", hash });
  const r = await confirm(pub, hash, label);
  log({ label, state: "done", hash, gas: r.gasUsed });
  return r;
}

// The steps deployContracts performs, for progress lists.
export const DEPLOY_STEPS = [
  "Poseidon hash (T3)", "Poseidon hash (T5)", "Merkle tree library",
  "Deposit verifier library", "Deposit verifier", "Transfer verifier library", "Transfer verifier",
  "Withdraw verifier library", "Withdraw verifier", "Composite verifier", "Attestation registry", "Shielded pool", "Test dollar token (tUSD)",
  "Pool accepts tUSD", "Deployer becomes the compliance attester",
];

// Deploys libraries, the three real proof verifiers, registry, pool and the demo token,
// then makes the deployer the compliance attester.
export async function deployContracts({ pub, wallet, ART, rpcUrl, log = noop }) {
  const d = {};
  const steps = [...DEPLOY_STEPS];
  const next = () => steps.shift();
  const first = await deployOne(pub, wallet, ART, LIB.T3, [], d, next(), log);
  await deployOne(pub, wallet, ART, LIB.T5, [], d, next(), log);
  await deployOne(pub, wallet, ART, LIB.IMT, [], d, next(), log);
  for (const c of ["Deposit", "Transfer", "Withdraw"]) {
    await deployOne(pub, wallet, ART, LIB.ZK(c), [], d, next(), log);
    await deployOne(pub, wallet, ART, `${c}Verifier`, [], d, next(), log); // links its own file's ZKTranscriptLib
  }
  await deployOne(pub, wallet, ART, "CompositeVerifier", [d.DepositVerifier, d.TransferVerifier, d.WithdrawVerifier], d, next(), log);
  await deployOne(pub, wallet, ART, "AttestationRegistry", [], d, next(), log);
  await deployOne(pub, wallet, ART, "ShieldedPool", [d.CompositeVerifier, d.AttestationRegistry], d, next(), log);
  await deployOne(pub, wallet, ART, "MockERC20", ["Test USD", "tUSD", 0], d, next(), log);
  await call(pub, wallet, { address: d.ShieldedPool, abi: ART.ShieldedPool.abi, functionName: "addSupportedToken", args: [d.MockERC20] }, next(), log);
  await call(pub, wallet, { address: d.AttestationRegistry, abi: ART.AttestationRegistry.abi, functionName: "addAttester", args: [wallet.account.address] }, next(), log);
  return {
    chainId: await pub.getChainId(), rpcUrl, startBlock: Number(first.blockNumber), admin: wallet.account.address,
    ShieldedPool: d.ShieldedPool, AttestationRegistry: d.AttestationRegistry, MockERC20: d.MockERC20,
    CompositeVerifier: d.CompositeVerifier, DepositVerifier: d.DepositVerifier, TransferVerifier: d.TransferVerifier, WithdrawVerifier: d.WithdrawVerifier,
  };
}

export const SESSION_STEPS = (o) => [`Approve ${o.nameA}`, `Approve ${o.nameB}`, `Give ${o.nameA} ${o.mintA} tUSD`, `Give ${o.nameB} ${o.mintB} tUSD`,
  `Gas for ${o.nameA}`, `Gas for ${o.nameB}`, "Gas for the relayer"];

// A demo session on an existing deployment: two fresh banks, approved by the attester,
// holding test dollars, plus a relayer account. Returns everything the wallets need.
export async function createSession({ pub, wallet, ART, dep, mintA = 1000n, mintB = 500n, fundBank, fundRelayer, nameA = "Bank A", nameB = "Bank B", log = noop }) {
  const bankA = { name: nameA, ethKey: generatePrivateKey(), ...newShieldedKeys() };
  const bankB = { name: nameB, ethKey: generatePrivateKey(), ...newShieldedKeys() };
  const relayer = { name: "Relayer", ethKey: generatePrivateKey() };
  const addr = (k) => privateKeyToAccount(k.ethKey).address;
  const steps = SESSION_STEPS({ nameA, nameB, mintA, mintB });
  const next = () => steps.shift();
  const expires = BigInt(Math.floor(Date.now() / 1000) + 365 * 86400);
  for (const b of [bankA, bankB])
    await call(pub, wallet, { address: dep.AttestationRegistry, abi: ART.AttestationRegistry.abi, functionName: "addAttestation", args: [publicShielded(b).ownerPubkey, expires] }, next(), log);
  await call(pub, wallet, { address: dep.MockERC20, abi: ART.MockERC20.abi, functionName: "mint", args: [addr(bankA), BigInt(mintA)] }, next(), log);
  await call(pub, wallet, { address: dep.MockERC20, abi: ART.MockERC20.abi, functionName: "mint", args: [addr(bankB), BigInt(mintB)] }, next(), log);
  for (const [k, value] of [[bankA, fundBank], [bankB, fundBank], [relayer, fundRelayer]]) {
    const label = next();
    log({ label, state: "sending" });
    const hash = await wallet.sendTransaction({ to: addr(k), value });
    log({ label, state: "pending", hash });
    await confirm(pub, hash, label);
    log({ label, state: "done", hash });
  }
  const directory = Object.fromEntries([bankA, bankB].map((b) => [b.name, { address: addr(b), ...publicShielded(b) }]));
  return { createdAt: Date.now(), bankA, bankB, relayer, relayerAddress: addr(relayer), directory };
}

// Suggested funding for one demo account, given the current fee per gas.
export function suggestFunding(maxFeePerGas, { deploy }) {
  const fee = maxFeePerGas > 0n ? maxFeePerGas : 1n;
  const floor = 2_000_000_000_000_000n; // 0.002 ETH per account, whatever the gas price
  const fundBank = maxOf(fee * GAS_BUDGET.bank * 3n, floor);
  const fundRelayer = maxOf(fee * GAS_BUDGET.relayer * 3n, floor);
  const own = fee * ((deploy ? GAS_BUDGET.deploy : 0n) + GAS_BUDGET.session) * 2n;
  const total = own + 2n * fundBank + fundRelayer;
  return { fundBank, fundRelayer, total, pretty: formatEther(total) };
}
const maxOf = (a, b) => (a > b ? a : b);

// The profile a wallet screen needs (same shape the setup links carry).
export function profilesFor(dep, s) {
  const pubDep = {
    chainId: dep.chainId, rpcUrl: dep.rpcUrl, startBlock: dep.startBlock, ShieldedPool: dep.ShieldedPool,
    AttestationRegistry: dep.AttestationRegistry, MockERC20: dep.MockERC20, relayer: s.relayerAddress, directory: s.directory,
  };
  const bank = (id, k) => ({ id, role: "bank", name: k.name, keys: { name: k.name, ethKey: k.ethKey, spendingKey: k.spendingKey, viewingPriv: k.viewingPriv }, relayerKey: s.relayer.ethKey, dep: pubDep });
  return {
    "bank-a": bank("bank-a", s.bankA),
    "bank-b": bank("bank-b", s.bankB),
    regulator: { id: "regulator", role: "regulator", name: "Regulator", viewingKeys: [s.bankA, s.bankB].map((k) => ({ name: k.name, viewingPriv: k.viewingPriv })), dep: pubDep },
  };
}
// Public, key-free description of a deployment, for the "what the chain sees" page.
export const watchInfo = (dep, s) => ({ chainId: dep.chainId, rpcUrl: dep.rpcUrl, startBlock: dep.startBlock, ShieldedPool: dep.ShieldedPool, MockERC20: dep.MockERC20,
  relayer: s?.relayerAddress, names: s ? Object.fromEntries(Object.entries(s.directory).map(([n, d]) => [d.address, n])) : {} });
