// The bank actions, shared by the browser wallet, the local server and the self-test.
// Nothing here touches the filesystem: callers pass in the deployment, keys and circuits.
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import ABI from "../artifacts/abis.json" with { type: "json" };
import { makeClients } from "./net.js";
import { Scanner, Prover, buildDeposit, buildTransfer, buildWithdraw } from "./core.js";

// dep: deployment (addresses, chainId, rpcUrl, startBlock, relayer, directory)
// keys: { name, ethKey, spendingKey, viewingPriv }; relayerKey: gas account for private actions
// loadCircuits: async () => ({ deposit, transfer, withdraw })
export function makeBank({ dep, keys, relayerKey, rpcUrl, loadCircuits }) {
  const rpc = rpcUrl || dep.rpcUrl;
  const { pub, wallet: bankWallet } = makeClients(rpc, dep.chainId, keys.ethKey);
  const { wallet: relayer } = makeClients(rpc, dep.chainId, relayerKey);
  const scan = new Scanner(pub, dep, keys);
  let proverPromise;
  // Load once; if loading fails, the next call tries again.
  const prover = () => (proverPromise ||= loadCircuits().then((c) => Prover.create(c)).catch((e) => { proverPromise = null; throw e; }));
  return { dep, keys, pub, bankWallet, relayer, scan, prover, name: keys.name, address: bankWallet.account.address };
}

const wait = async (pub, hash) => {
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 300_000 });
  if (r.status !== "success") throw Object.assign(new Error("Transaction reverted"), { hash });
  return r;
};

// After a confirmed transaction, refreshing local state is best effort: the next poll
// catches up, and a hiccup here must not turn a confirmed transaction into "Failed".
const settle = (b) => b.scan.sync().catch((e) => console.warn("post-confirmation sync:", e?.message || e));

export async function publicBalance(b, who = b.address) {
  return b.pub.readContract({ address: b.dep.MockERC20, abi: ABI.MockERC20, functionName: "balanceOf", args: [who] });
}

// Deposit: public by design. Sent from the bank's own address (the contract requires it).
export async function deposit(b, amount, stage = () => {}) {
  await b.scan.sync();
  stage("Approving the pool to take tUSD");
  const ah = await b.bankWallet.writeContract({ address: b.dep.MockERC20, abi: ABI.MockERC20, functionName: "approve", args: [b.dep.ShieldedPool, BigInt(amount)] });
  await wait(b.pub, ah);
  const prover = await b.prover();
  stage("Generating zero-knowledge proof");
  const t = Date.now();
  const d = await buildDeposit(prover, b.scan, { token: b.dep.MockERC20, amount, funding: b.address });
  stage(`Proof ready in ${((Date.now() - t) / 1000).toFixed(1)}s · submitting`);
  const hash = await b.bankWallet.writeContract({ address: b.dep.ShieldedPool, abi: ABI.ShieldedPool, functionName: "deposit",
    args: [d.proof, d.commitment, b.dep.MockERC20, BigInt(amount), b.address, d.payload] });
  stage("Waiting for the block", hash);
  const r = await wait(b.pub, hash);
  await settle(b);
  return { hash, block: Number(r.blockNumber) };
}

// Private transfer: submitted by the relayer, so the bank's address never appears.
export async function sendPrivate(b, to, amount, stage = () => {}) {
  await b.scan.sync();
  const prover = await b.prover();
  stage("Generating zero-knowledge proof");
  const t = Date.now();
  const x = await buildTransfer(prover, b.scan, { token: b.dep.MockERC20, amount, to, memo: `from ${b.name}` });
  stage(`Proof ready in ${((Date.now() - t) / 1000).toFixed(1)}s · relayer submitting`);
  const hash = await b.relayer.writeContract({ address: b.dep.ShieldedPool, abi: ABI.ShieldedPool, functionName: "transfer",
    args: [x.proof, x.nullifiers, x.commitments, x.root, x.payload] });
  stage("Waiting for the block", hash);
  const r = await wait(b.pub, hash);
  await settle(b);
  return { hash, block: Number(r.blockNumber), payload: x.payload };
}

// Withdraw one whole note to a brand-new address.
export async function withdraw(b, commitment, stage = () => {}, recipient) {
  await b.scan.sync();
  recipient ||= privateKeyToAccount(generatePrivateKey()).address;
  const prover = await b.prover();
  stage("Generating zero-knowledge proof");
  const t = Date.now();
  const w = await buildWithdraw(prover, b.scan, { commitment, recipient });
  stage(`Proof ready in ${((Date.now() - t) / 1000).toFixed(1)}s · relayer submitting`);
  const args = [w.proof, w.nullifier, w.token, w.amount, recipient, w.root];
  const hash = await b.relayer.writeContract({ address: b.dep.ShieldedPool, abi: ABI.ShieldedPool, functionName: "withdraw", args });
  stage("Waiting for the block", hash);
  const r = await wait(b.pub, hash);
  await settle(b);
  return { hash, block: Number(r.blockNumber), recipient, args };
}

// Replays an already-used withdrawal to show the double-spend check. Sent with a fixed gas
// limit so it lands on-chain as a visible failed transaction instead of failing locally.
export async function replay(b, args) {
  const hash = await b.relayer.writeContract({ address: b.dep.ShieldedPool, abi: ABI.ShieldedPool, functionName: "withdraw", args, gas: 3_000_000n });
  const r = await b.pub.waitForTransactionReceipt({ hash, timeout: 300_000 });
  return { hash, status: r.status, block: Number(r.blockNumber) };
}
