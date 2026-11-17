// Bank wallet server. One process per screen:
//   node local/server.mjs a    Bank A on http://localhost:3001
//   node local/server.mjs b    Bank B on http://localhost:3002
//   node local/server.mjs regulator  Regulator (viewing keys only) on http://localhost:3003
import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { decodeEventLog, hexToBytes, bytesToHex } from "viem";
import { loadEnv, ART, clients } from "../lib/chain.js";
import { deposit, sendPrivate, withdraw, replay, publicBalance } from "../lib/actions.js";
import { openBank } from "../lib/node.js";
import { openNote, unpackEnvelopes, commitmentOf } from "../lib/core.js";

loadEnv();
const who = (process.argv[2] || "a").toLowerCase();
const PORT = Number(process.env.PORT || { a: 3001, b: 3002, regulator: 3003 }[who] || 3001);
const dep = JSON.parse(readFileSync("deployment.json", "utf8"));
const isReg = who === "regulator";

// Regulator: holds the viewing keys it has been given, nothing that can spend.
const viewingKeys = [];
for (const f of ["demo-keys/bank-a.json", "demo-keys/bank-b.json"])
  if (existsSync(f)) { const k = JSON.parse(readFileSync(f, "utf8")); viewingKeys.push({ name: k.name, viewingPriv: k.viewingPriv }); }

const bank = isReg ? null : openBank(`demo-keys/bank-${who}.json`);
const { pub } = isReg ? await clients(process.env.RPC_URL || dep.rpcUrl) : { pub: bank.pub };
const myName = isReg ? "Regulator" : bank.name;
const myKeys = isReg ? viewingKeys : viewingKeys.filter((k) => k.name === myName);

let job = null, lastWithdrawArgs = null, publicBal = 0n;
const activity = [];
const fresh = [];
const known = new Set();
let firstSync = true;

function addActivity(e) { activity.unshift({ ts: Date.now(), ...e }); activity.length = Math.min(activity.length, 30); }

async function refresh() {
  if (isReg) return;
  await bank.scan.sync();
  publicBal = await publicBalance(bank);
  for (const f of fresh) f.balance = String(await publicBalance(bank, f.address));
  for (const n of bank.scan.notes) {
    if (known.has(n.commitment)) continue;
    known.add(n.commitment);
    const incoming = n.memo && n.memo.startsWith("from ");
    if (incoming) addActivity({ type: "receive", text: `Received ${n.amount} tUSD privately (${n.memo})`, hash: n.txHash, block: n.block, flash: !firstSync });
    else if (firstSync && n.kind === "Deposit") addActivity({ type: "deposit", text: `Deposited ${n.amount} tUSD into the pool (public)`, hash: n.txHash, block: n.block });
    else if (firstSync && n.memo === "change") addActivity({ type: "send", text: `Paid privately (${n.amount} tUSD change kept)`, hash: n.txHash, block: n.block });
  }
  firstSync = false;
}
setInterval(() => refresh().catch((e) => console.error("sync:", e.shortMessage || e.message)), 3000);
await refresh().catch((e) => console.error("first sync:", e.message));
if (!isReg) bank.prover().then(() => console.log("prover ready"));

async function run(label, type, fn) {
  if (job && !job.done) throw new Error("Another action is still running");
  job = { label, stages: [], done: false, error: null, hash: null };
  const stage = (s, hash) => { job.stages.push(s); if (hash) job.hash = hash; };
  (async () => {
    try {
      const r = await fn(stage);
      job.hash = r.hash; job.block = r.block;
      stage(r.status === "reverted" ? `Rejected by the contract in block ${r.block}` : `Confirmed in block ${r.block}`);
      addActivity({ type, text: r.text, hash: r.hash, block: r.block });
      await refresh();
    } catch (e) {
      job.error = e.shortMessage || e.message;
      console.error(e);
    } finally { job.done = true; }
  })();
}

// Explains a transaction the way a block explorer sees it, then opens what our keys can open.
async function inspect(hash) {
  const [tx, rcpt] = await Promise.all([pub.getTransaction({ hash }), pub.getTransactionReceipt({ hash })]);
  const label = tx.from.toLowerCase() === (dep.relayer || "").toLowerCase() ? "relayer"
    : Object.entries(dep.directory).find(([, d]) => d.address.toLowerCase() === tx.from.toLowerCase())?.[0] || null;
  const out = { hash, from: tx.from, fromLabel: label, to: tx.to, status: rcpt.status, block: Number(rcpt.blockNumber), events: [] };
  for (const log of rcpt.logs) {
    if (log.address.toLowerCase() !== dep.ShieldedPool.toLowerCase()) continue;
    let ev; try { ev = decodeEventLog({ abi: ART.ShieldedPool.abi, data: log.data, topics: log.topics }); } catch { continue; }
    const a = ev.args, payload = a.encryptedNote || a.encryptedNotes;
    const pubFields = Object.entries(a).filter(([k]) => !/encrypted/i.test(k)).map(([k, v]) => [k, String(v)]);
    // A note only counts if it re-hashes to a commitment this event actually put on-chain.
    const onchain = [a.commitment, a.commitment1, a.commitment2].filter(Boolean).map((c) => BigInt(c));
    const envelopes = payload ? unpackEnvelopes(hexToBytes(payload)).map((env) => {
      let opened = null;
      for (const k of myKeys) { const n = openNote(env, k.viewingPriv); if (n && onchain.includes(commitmentOf(n))) { opened = { by: k.name, amount: n.amount, memo: n.memo, owner: n.owner }; break; } }
      return { bytes: bytesToHex(env).slice(0, 26) + "…", size: env.length, opened };
    }) : [];
    out.events.push({ name: ev.eventName, fields: pubFields, envelopes });
  }
  return out;
}

function state() {
  const ex = dep.explorer;
  const base = { mode: isReg ? "regulator" : "bank", name: myName, explorer: ex, pool: dep.ShieldedPool, token: dep.MockERC20, chainId: dep.chainId };
  if (isReg) return { ...base, keys: myKeys.map((k) => k.name) };
  const notes = bank.scan.notes.filter((n) => BigInt(n.amount) > 0n).map((n) => ({ amount: n.amount, memo: n.memo, spent: n.spent, commitment: n.commitment, hash: n.txHash }));
  return {
    ...base, address: bank.address, ownerPubkey: bank.scan.pub.ownerPubkey,
    approved: !!bank.scan.attestation, publicBalance: String(publicBal),
    privateBalance: String(bank.scan.unspent().reduce((s, n) => s + BigInt(n.amount), 0n)),
    notes, activity, job, fresh, counterparties: Object.keys(dep.directory).filter((n) => n !== myName),
    canReplay: !!lastWithdrawArgs,
  };
}

const routes = {
  "GET /api/state": async () => state(),
  "POST /api/deposit": async ({ amount }) => run(`Move ${amount} tUSD into the pool`, "deposit", async (s) => ({ ...(await deposit(bank, BigInt(amount), s)), text: `Deposited ${amount} tUSD into the pool (public)` })),
  "POST /api/send": async ({ to, amount }) => run(`Pay ${to} ${amount} tUSD privately`, "send", async (s) => ({ ...(await sendPrivate(bank, dep.directory[to], BigInt(amount), s)), text: `Paid ${to} ${amount} tUSD privately` })),
  "POST /api/withdraw": async ({ commitment }) => run("Withdraw to a new address", "withdraw", async (s) => {
    const r = await withdraw(bank, commitment, s);
    lastWithdrawArgs = r.args;
    fresh.push({ address: r.recipient, balance: "0" });
    return { ...r, text: `Withdrew ${r.args[3]} tUSD to new address ${r.recipient.slice(0, 8)}…` };
  }),
  "POST /api/replay": async () => run("Replay the last withdrawal", "replay", async (s) => {
    s("Sending the same withdrawal again");
    const r = await replay(bank, lastWithdrawArgs);
    return { ...r, text: r.status === "reverted" ? "Replay rejected by the contract (note already spent)" : "Replay unexpectedly succeeded" };
  }),
  "POST /api/inspect": async ({ hash }) => inspect(hash.trim()),
};

const page = readFileSync(new URL("./wallet.html", import.meta.url), "utf8");
// Holds live keys: reachable from this machine only, and only under its own host name
// (blocks other devices on the venue network and DNS-rebinding pages).
const allowedHosts = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);
http.createServer(async (req, res) => {
  if (!allowedHosts.has(req.headers.host || "")) { res.writeHead(403); return res.end("forbidden"); }
  if (req.method === "POST" && !(req.headers["content-type"] || "").startsWith("application/json")) { res.writeHead(415); return res.end("json only"); }
  const key = `${req.method} ${req.url.split("?")[0]}`;
  if (key === "GET /" || key === "GET /index.html") { res.writeHead(200, { "content-type": "text/html" }); return res.end(page); }
  const h = routes[key];
  if (!h) { res.writeHead(404); return res.end("not found"); }
  let body = "";
  for await (const c of req) body += c;
  try {
    const r = await h(body ? JSON.parse(body) : {});
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(r ?? { ok: true }, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
  } catch (e) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: e.shortMessage || e.message }));
  }
}).listen(PORT, "127.0.0.1", () => console.log(`${myName} → http://localhost:${PORT}`));
