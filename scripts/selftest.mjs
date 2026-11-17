// Runs the whole story without the UI: deposits, a private payment, the recipient finding it
// on-chain, a withdrawal, and a rejected replay. Use it to rehearse against Sepolia.
import { loadEnv } from "../lib/chain.js";
import { deposit, sendPrivate, withdraw, replay, publicBalance } from "../lib/actions.js";
import { openBank } from "../lib/node.js";

loadEnv();
const A = openBank("demo-keys/bank-a.json"), B = openBank("demo-keys/bank-b.json");
const log = (b) => (s, h) => console.log(`  [${b.name}] ${s}${h ? " " + h : ""}`);
const show = async () => {
  for (const b of [A, B]) {
    await b.scan.sync();
    const priv = b.scan.unspent().reduce((s, n) => s + BigInt(n.amount), 0n);
    console.log(`  ${b.name}: public ${await publicBalance(b)} · private ${priv}`);
  }
};
const t0 = Date.now();
console.log("1. Bank A deposits 1000"); await deposit(A, 1000, log(A)); await show();
console.log("2. Bank B deposits 500"); await deposit(B, 500, log(B)); await show();
console.log("3. Bank A pays Bank B 700 privately");
const tx = await sendPrivate(A, A.dep.directory["Bank B"], 700, log(A)); await show();
const got = B.scan.notes.find((n) => n.txHash === tx.hash);
console.log(`   Bank B found the payment on-chain: ${got ? got.amount + " (" + got.memo + ")" : "NOT FOUND"}`);
if (!got) process.exit(1);
console.log("4. Bank B withdraws the 700 note to a fresh address");
const w = await withdraw(B, got.commitment, log(B));
console.log(`   fresh address ${w.recipient} holds ${await publicBalance(B, w.recipient)} tUSD`); await show();
console.log("5. Replay the same withdrawal");
const r = await replay(B, w.args);
console.log(`   replay status: ${r.status} (expected: reverted)`);
console.log(`\nAll steps passed in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
await (await A.prover()).destroy(); await (await B.prover()).destroy();
process.exit(r.status === "reverted" ? 0 : 1);
