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
// Resumable: `partial` is what an earlier, interrupted run saved through `save`; finished
// steps are skipped, so a retry never pays twice for what is already on-chain.
export async function deployContracts({ pub, wallet, ART, rpcUrl, log = noop, partial = null, save = noop }) {
  const d = { ...(partial?.addresses || {}) };
  let startBlock = partial?.startBlock ?? null;
  const steps = [...DEPLOY_STEPS];
  const persist = () => save({ addresses: { ...d }, startBlock, deployer: wallet.account.address });
  const deploy = async (key, args) => {
    const label = steps.shift();
    if (d[key] && (await pub.getCode({ address: d[key] }))) { log({ label, state: "done", address: d[key] }); return; }
    const r = await deployOne(pub, wallet, ART, key, args, d, label, log);
    if (startBlock === null) startBlock = Number(r.blockNumber);
    persist();
  };
  if (partial && partial.deployer && partial.deployer !== wallet.account.address) throw new Error("This partial deployment belongs to another demo account");
  await deploy(LIB.T3, []);
  await deploy(LIB.T5, []);
  await deploy(LIB.IMT, []);
  for (const c of ["Deposit", "Transfer", "Withdraw"]) {
    await deploy(LIB.ZK(c), []);
    await deploy(`${c}Verifier`, []); // links its own file's ZKTranscriptLib
  }
  await deploy("CompositeVerifier", [d.DepositVerifier, d.TransferVerifier, d.WithdrawVerifier]);
  await deploy("AttestationRegistry", []);
  await deploy("ShieldedPool", [d.CompositeVerifier, d.AttestationRegistry]);
  await deploy("MockERC20", ["Test USD", "tUSD", 0]);
  // These two revert if repeated, so check the chain first.
  let label = steps.shift();
  if (await pub.readContract({ address: d.ShieldedPool, abi: ART.ShieldedPool.abi, functionName: "supportedTokens", args: [d.MockERC20] })) log({ label, state: "done" });
  else await call(pub, wallet, { address: d.ShieldedPool, abi: ART.ShieldedPool.abi, functionName: "addSupportedToken", args: [d.MockERC20] }, label, log);
  label = steps.shift();
  if (await pub.readContract({ address: d.AttestationRegistry, abi: ART.AttestationRegistry.abi, functionName: "isAuthorizedAttester", args: [wallet.account.address] })) log({ label, state: "done" });
  else await call(pub, wallet, { address: d.AttestationRegistry, abi: ART.AttestationRegistry.abi, functionName: "addAttester", args: [wallet.account.address] }, label, log);
  return {
    chainId: await pub.getChainId(), rpcUrl, startBlock, admin: wallet.account.address,
    ShieldedPool: d.ShieldedPool, AttestationRegistry: d.AttestationRegistry, MockERC20: d.MockERC20,
    CompositeVerifier: d.CompositeVerifier, DepositVerifier: d.DepositVerifier, TransferVerifier: d.TransferVerifier, WithdrawVerifier: d.WithdrawVerifier,
  };
}

export const SESSION_STEPS = (o) => [`Approve ${o.nameA}`, `Approve ${o.nameB}`, `Give ${o.nameA} ${o.mintA} tUSD`, `Give ${o.nameB} ${o.mintB} tUSD`,
  `Gas for ${o.nameA}`, `Gas for ${o.nameB}`, "Gas for the relayer"];

// Keys for a new session. Callers save them BEFORE createSession sends anything, so ETH
// sent to these accounts can always be recovered.
export function newSessionKeys(nameA = "Bank A", nameB = "Bank B") {
  return {
    bankA: { name: nameA, ethKey: generatePrivateKey(), ...newShieldedKeys() },
    bankB: { name: nameB, ethKey: generatePrivateKey(), ...newShieldedKeys() },
    relayer: { name: "Relayer", ethKey: generatePrivateKey() },
    done: {},
  };
}
export const sessionAccounts = (k) => [k.bankA, k.bankB, k.relayer].map((x) => ({ name: x.name, ethKey: x.ethKey, address: privateKeyToAccount(x.ethKey).address }));

// A demo session on an existing deployment: two banks approved by the attester, holding
// test dollars, plus a relayer account. Resumable: `keys.done` records finished steps and
// `save(keys)` is called after each one; funding and minting are also checked on-chain.
export async function createSession({ pub, wallet, ART, dep, keys, mintA = 1000n, mintB = 500n, fundBank, fundRelayer, rpcUrl, log = noop, save = noop }) {
  const { bankA, bankB, relayer } = keys;
  const done = (keys.done ||= {});
  const addr = (k) => privateKeyToAccount(k.ethKey).address;
  const labels = SESSION_STEPS({ nameA: bankA.name, nameB: bankB.name, mintA, mintB });
  if (!keys.sessionBlock) { keys.sessionBlock = Number(await pub.getBlockNumber()); save(keys); }
  const step = async (id, label, skipIf, fn) => {
    if (done[id] || (skipIf && (await skipIf()))) { done[id] = true; save(keys); log({ label, state: "done" }); return; }
    await fn(label);
    done[id] = true; save(keys);
  };
  const expires = BigInt(Math.floor(Date.now() / 1000) + 365 * 86400);
  const tokenBal = (a) => pub.readContract({ address: dep.MockERC20, abi: ART.MockERC20.abi, functionName: "balanceOf", args: [a] });
  await step("attestA", labels[0], null, (l) => call(pub, wallet, { address: dep.AttestationRegistry, abi: ART.AttestationRegistry.abi, functionName: "addAttestation", args: [publicShielded(bankA).ownerPubkey, expires] }, l, log));
  await step("attestB", labels[1], null, (l) => call(pub, wallet, { address: dep.AttestationRegistry, abi: ART.AttestationRegistry.abi, functionName: "addAttestation", args: [publicShielded(bankB).ownerPubkey, expires] }, l, log));
  await step("mintA", labels[2], async () => (await tokenBal(addr(bankA))) >= BigInt(mintA), (l) => call(pub, wallet, { address: dep.MockERC20, abi: ART.MockERC20.abi, functionName: "mint", args: [addr(bankA), BigInt(mintA)] }, l, log));
  await step("mintB", labels[3], async () => (await tokenBal(addr(bankB))) >= BigInt(mintB), (l) => call(pub, wallet, { address: dep.MockERC20, abi: ART.MockERC20.abi, functionName: "mint", args: [addr(bankB), BigInt(mintB)] }, l, log));
  const fundIds = [["fundA", bankA, fundBank, labels[4]], ["fundB", bankB, fundBank, labels[5]], ["fundR", relayer, fundRelayer, labels[6]]];
  for (const [id, k, value, label] of fundIds)
    await step(id, label, async () => (await pub.getBalance({ address: addr(k) })) >= value, async (l) => {
      log({ label: l, state: "sending" });
      const hash = await wallet.sendTransaction({ to: addr(k), value });
      log({ label: l, state: "pending", hash });
      await confirm(pub, hash, l);
      log({ label: l, state: "done", hash });
    });
  const directory = Object.fromEntries([bankA, bankB].map((b) => [b.name, { address: addr(b), ...publicShielded(b) }]));
  return { createdAt: Date.now(), bankA, bankB, relayer, relayerAddress: addr(relayer), directory, sessionBlock: keys.sessionBlock, rpcUrl: rpcUrl || dep.rpcUrl };
}

// What the demo account needs, at a given fee per gas. Each figure already doubles the gas
// estimate; the banks and relayer get a fixed minimum so a fee spike mid-demo is covered.
export function fundingPlan(maxFeePerGas) {
  const fee = maxFeePerGas > 0n ? maxFeePerGas : 1n;
  const floor = 2_000_000_000_000_000n; // 0.002 ETH per account, whatever the gas price
  const fundBank = maxOf(fee * GAS_BUDGET.bank * 3n, floor);
  const fundRelayer = maxOf(fee * GAS_BUDGET.relayer * 3n, floor);
  const sessionNeed = 2n * fundBank + fundRelayer + fee * GAS_BUDGET.session * 2n;
  const deployNeed = fee * GAS_BUDGET.deploy * 2n;
  return { fee, fundBank, fundRelayer, sessionNeed, deployNeed };
}
const maxOf = (a, b) => (a > b ? a : b);
export const ethText = (wei) => Number(formatEther(wei)).toFixed(4);

// Browsers and the audience use a public RPC: a presenter's private URL (with an API key in
// it) never goes into a shareable link. Local test nodes are kept as they are.
export const PUBLIC_RPC = { 11155111: "https://ethereum-sepolia-rpc.publicnode.com" };
const isLocal = (u) => { try { return ["127.0.0.1", "localhost"].includes(new URL(u).hostname); } catch { return false; } };
export const publicRpcFor = (chainId, rpcUrl) => (isLocal(rpcUrl) ? rpcUrl : PUBLIC_RPC[chainId] || rpcUrl);

// The profile a wallet screen needs (same shape the setup links carry).
export function profilesFor(dep, s) {
  const pubDep = {
    chainId: dep.chainId, rpcUrl: s.rpcUrl || dep.rpcUrl, startBlock: dep.startBlock, sessionBlock: s.sessionBlock ?? dep.startBlock, ShieldedPool: dep.ShieldedPool,
    AttestationRegistry: dep.AttestationRegistry, MockERC20: dep.MockERC20, relayer: s.relayerAddress, directory: s.directory,
  };
  const bank = (id, k) => ({ id, role: "bank", name: k.name, keys: { name: k.name, ethKey: k.ethKey, spendingKey: k.spendingKey, viewingPriv: k.viewingPriv }, relayerKey: s.relayer.ethKey, dep: pubDep });
  return {
    "bank-a": bank("bank-a", s.bankA),
    "bank-b": bank("bank-b", s.bankB),
    regulator: { id: "regulator", role: "regulator", name: "Regulator", viewingKeys: [s.bankA, s.bankB].map((k) => ({ name: k.name, viewingPriv: k.viewingPriv })), dep: pubDep },
  };
}
// Public, key-free description of one session, for the audience view. Starts at the
// session's first block, so earlier sessions on the same contracts do not show up.
export const watchInfo = (dep, s) => {
  const w = { chainId: dep.chainId, startBlock: s?.sessionBlock ?? dep.startBlock, ShieldedPool: dep.ShieldedPool, MockERC20: dep.MockERC20,
    relayer: s?.relayerAddress, names: s ? Object.fromEntries(Object.entries(s.directory).map(([n, d]) => [d.address, n])) : {} };
  const rpc = publicRpcFor(dep.chainId, s?.rpcUrl || dep.rpcUrl);
  if (rpc !== PUBLIC_RPC[dep.chainId]) w.rpcUrl = rpc; // only for local test nodes
  return w;
};
