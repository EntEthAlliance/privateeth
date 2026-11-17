// Console: the whole story on one screen, with real transactions on Sepolia.
// Both banks and the regulator's keys live in this tab; one proof engine serves both banks.
import QRCode from "qrcode";
import { decodeFunctionData } from "viem";
import { makeBank, sharedProver, deposit, sendPrivate, withdraw, replay, publicBalance } from "../../lib/actions.js";
import ABI from "../../artifacts/abis.json" with { type: "json" };
import { makeClients } from "../../lib/net.js";
import { $, esc, n, isHash, json, unjson, store, txLink, lockup, footer, copy } from "./util.js";
import { createStage } from "./stage.js";
import { ChainFeed } from "./feed.js";
import { inspectTx, inspectHtml } from "./inspect.js";
import { loadCircuits } from "./roles.js";
import { watchLinkFor, watchFromDep } from "./profiles.js";
import { verifyHtml } from "./verify.js";

// One proof engine for the page, whatever the session; it retries after a failed load.
const prover = sharedProver(loadCircuits);
const engine = { ready: false, error: null, loading: false };
function loadEngine() {
  engine.error = null; engine.loading = true;
  prover().then(() => { engine.ready = true; paintTop(); }, (e) => { engine.error = e.message; engine.loading = false; paintTop(); });
}

let C = null; // the console's session, kept for the life of the tab
const here = () => location.hash === "#console";

function build(prof) {
  const [pa, pb] = prof.banks, dep = pa.dep;
  const A = makeBank({ dep, keys: pa.keys, relayerKey: pa.relayerKey, loadCircuits, prover });
  const B = makeBank({ dep: pb.dep, keys: pb.keys, relayerKey: pb.relayerKey, loadCircuits, prover });
  const { pub } = makeClients(dep.rpcUrl, dep.chainId);
  const names = Object.fromEntries(Object.entries(dep.directory).map(([nm, d]) => [d.address.toLowerCase(), nm]));
  // The public strip covers this session only; the banks' scanners still read the whole pool.
  const feed = new ChainFeed(pub, { ShieldedPool: dep.ShieldedPool, startBlock: dep.sessionBlock ?? dep.startBlock, relayer: dep.relayer, names });
  const key = "privateeth.console." + dep.ShieldedPool.toLowerCase() + "." + A.address.toLowerCase();
  let saved = {}; try { saved = unjson(store.get(key) || "{}"); } catch {}
  C = { prof, dep, A, B, pub, feed, key, chainId: dep.chainId, viewingKeys: prof.regulator.viewingKeys,
    flags: saved.flags || {}, withdrawArgs: saved.withdrawArgs || null, fresh: saved.fresh || null, lastHash: saved.lastHash || null,
    state: null, job: null, synced: false, hold: false, inspect: null, syncError: null };
}
const save = (me) => store.set(me.key, json({ flags: me.flags, withdrawArgs: me.withdrawArgs, fresh: me.fresh, lastHash: me.lastHash }));

// ---------- chain state ----------
async function refresh(me) {
  const { A, B, feed } = me;
  await Promise.all([A.scan.sync(), B.scan.sync(), feed.sync()]);
  const [pa, pb, fresh] = await Promise.all([publicBalance(A), publicBalance(B), me.fresh ? publicBalance(A, me.fresh.address) : Promise.resolve(null)]);
  const priv = (b) => b.scan.unspent().reduce((s, x) => s + BigInt(x.amount), 0n);
  const notes = [...A.scan.unspent().map((x) => ({ ...x, owner: A.name })), ...B.scan.unspent().map((x) => ({ ...x, owner: B.name }))].sort((x, y) => x.index - y.index);
  const payNote = B.scan.notes.find((x) => x.memo === `from ${A.name}`);
  // If the withdrawal happened elsewhere (another tab, a reload mid-step), its address comes from the chain.
  if (!me.fresh && payNote?.spent) {
    const w = feed.logs.find((l) => l.eventName === "Withdraw" && BigInt(l.args.nullifier) === BigInt(payNote.nullifier));
    if (w) { me.fresh = { address: w.args.recipient }; save(me); }
  }
  me.state = { pa, pb, pool: feed.sessionHolds(), privA: priv(A), privB: priv(B), notes, payNote, freshBal: fresh,
    depositedA: A.scan.notes.some((x) => x.kind === "Deposit"), depositedB: B.scan.notes.some((x) => x.kind === "Deposit"),
    approved: !!(A.scan.attestation && B.scan.attestation) };
  me.synced = true;
}

// ---------- the story ----------
const STEPS = [
  { id: "depA", title: "Bank A deposits", detail: "Public: Bank A moves its tokenized dollars into the shielded pool.", proof: true },
  { id: "depB", title: "Bank B deposits", detail: "Public: Bank B does the same.", proof: true },
  { id: "pay", title: "Bank A pays Bank B 700", detail: "Private: a zero-knowledge proof made in this browser. The chain records only hashes.", proof: true },
  { id: "withdraw", title: "Bank B withdraws", detail: "Public: Bank B takes the 700 out to a brand-new address.", proof: true },
  { id: "replay", title: "Replay is rejected", detail: "Someone sends the same withdrawal again. A spent note cannot be spent twice." },
  { id: "audit", title: "Regulator reads it", detail: "With viewing keys, the regulator opens the private payment. Nobody else can." },
];
function done(id) {
  const s = C.state; if (!s) return false;
  if (id === "depA") return s.depositedA;
  if (id === "depB") return s.depositedB;
  if (id === "pay") return !!s.payNote;
  if (id === "withdraw") return !!(s.payNote && s.payNote.spent);
  return !!C.flags[id];
}
const nextStep = () => STEPS.find((x) => !done(x.id));

// The withdrawal's exact arguments, from this tab or rebuilt from its transaction on-chain.
async function withdrawArgs(me) {
  if (me.withdrawArgs) return me.withdrawArgs;
  const note = me.state?.payNote;
  const w = note && me.feed.logs.find((l) => l.eventName === "Withdraw" && BigInt(l.args.nullifier) === BigInt(note.nullifier));
  if (!w) throw new Error("Run the withdrawal first");
  const tx = await me.pub.getTransaction({ hash: w.transactionHash });
  me.withdrawArgs = [...decodeFunctionData({ abi: ABI.ShieldedPool, data: tx.input }).args];
  save(me);
  return me.withdrawArgs;
}

async function runStep(id) {
  const me = C;
  if (me.job && !me.job.done) return;
  const s = me.state, { A, B } = me;
  const job = (me.job = { id, stages: [], done: false, error: null });
  const stage = (t, hash) => { job.stages.push(t); if (isHash(hash)) job.hash = hash; if (C === me) paintTop(); };
  me.hold = true; // keep the stage still until the animation shows the change
  if (C === me) paintTop();
  try {
    let r;
    if (id === "depA" || id === "depB") {
      const bank = id === "depA" ? A : B, amt = id === "depA" ? s.pa : s.pb;
      if (amt === 0n) throw new Error(`${bank.name} has no public tUSD to deposit`);
      r = await deposit(bank, amt, stage);
      await fly(me, id === "depA" ? "A" : "B", "pool", { kind: "coin", label: n(amt) });
    } else if (id === "pay") {
      r = await sendPrivate(A, me.dep.directory[B.name], 700n, stage);
      await fly(me, "A", "B", { kind: "envelope", label: me.stage.reveal ? "700" : "sealed" });
    } else if (id === "withdraw") {
      await B.scan.sync();
      const note = B.scan.notes.find((x) => x.memo === `from ${A.name}` && !x.spent);
      if (!note) throw new Error("Bank B has no unspent payment from Bank A to withdraw");
      r = await withdraw(B, note.commitment, stage);
      me.withdrawArgs = r.args; me.fresh = { address: r.recipient }; save(me);
      if (C === me && here()) me.stage.update({ fresh: { address: r.recipient, balance: 0 } });
      await fly(me, "pool", "fresh", { kind: "coin", label: n(note.amount) });
    } else if (id === "replay") {
      const args = await withdrawArgs(me);
      stage("Sending the same withdrawal again");
      r = await replay(B, args);
      if (r.status === "reverted" && C === me && here()) me.stage.shake("pool");
      me.flags.replay = true;
    } else if (id === "audit") {
      me.flags.audit = true;
      const payHash = s.payNote?.txHash || me.feed.logs.filter((l) => l.eventName === "Transfer").pop()?.transactionHash;
      if (payHash) me.lastHash = payHash;
      save(me);
      if (C === me && here()) { setReveal(true); if (payHash) await showInspect(payHash); }
      return;
    }
    me.lastHash = r.hash; save(me);
    stage(r.status === "reverted" ? `Rejected by the contract in block ${r.block}` : `Confirmed in block ${r.block}`);
    if (C === me) showInspect(r.hash);
  } catch (e) { job.error = e.shortMessage || e.message; console.error(e); }
  finally {
    job.done = true;
    try { await refresh(me); } catch {}
    me.hold = false;
    if (C === me) paintAll();
  }
}
async function fly(me, from, to, opts) { if (C === me && here() && me.stage) await me.stage.fly(from, to, opts); }

async function showInspect(hash) {
  const me = C;
  me.inspect = { hash, busy: true };
  paintInspect();
  try { me.inspect = { hash, result: await inspectTx(me.pub, me.dep, me.viewingKeys, hash) }; } catch (e) { me.inspect = { hash, error: e.shortMessage || e.message }; }
  if (C === me) paintInspect();
}
function setReveal(on) { C.stage.setReveal(on); const t = $("#reveal"); if (t) t.checked = on; paintStage(true); paintInspect(); }

// ---------- rendering ----------
function shell() {
  return `<div class="top">${lockup()}<div class="net"><span id="chips" class="net"></span><button class="chip-btn" id="qrbtn" title="Show the audience QR code full screen">AUDIENCE QR</button></div></div>
    <div class="console-head">
      <div><h1 class="ctitle">Private payments between banks</h1><p class="lead small">Two banks on Sepolia. Watch what moves, and what the public chain can see.</p></div>
      <label class="switch"><input type="checkbox" id="reveal"><span class="track"><i></i></span><span>What the regulator sees</span></label>
    </div>
    <div class="story" id="story"></div>
    <div id="stage"></div>
    <div class="grid console-bottom">
      <div class="card" id="inspectcard"><h2>The latest transaction</h2><div id="inspect"><p class="hint">After each step, this shows what Etherscan shows next to what the viewing keys open.</p></div></div>
      <div class="card audience"><h2>Audience view</h2><canvas id="wqr" width="180" height="180" aria-label="QR code for the audience view"></canvas>
        <p class="hint">Scan to watch the public chain live on your phone. No keys, nothing private.</p>
        <div class="row"><a class="small" href="#watch" target="_blank" rel="noopener">Open ↗</a><button class="small ghost" id="wcopy">Copy link</button></div></div>
    </div>
    <div id="verify"></div>
    <div class="overlay" id="qrover" hidden><div class="overlay-box"><h2>Watch the public chain</h2><canvas id="bigqr" aria-label="Audience QR code"></canvas>
      <p class="hint">Scan with your phone camera. It shows only what anyone can read on Sepolia.</p><button id="qrclose">Close</button></div></div>` + footer();
}
function paintTop() {
  if (!C || !here() || !$("#chips")) return;
  const threads = globalThis.crossOriginIsolated ? `${Number(navigator.hardwareConcurrency) || "several"} threads` : "1 thread";
  $("#chips").innerHTML = `<span class="chip ${engine.ready ? "ok" : engine.error ? "warn" : ""}">PROOF ENGINE · ${engine.ready ? "READY" : engine.error ? "ERROR" : "LOADING"} · ${threads}</span>
    <span class="chip">${C.chainId === 11155111 ? "SEPOLIA" : "CHAIN " + Number(C.chainId)}</span>`;
  const nx = nextStep(), j = C.job, busy = !!(j && !j.done);
  const ready = (step) => C.synced && !busy && C.state?.approved && (!step?.proof || engine.ready);
  const status = busy ? `<span class="spin"></span>${esc(j.stages[j.stages.length - 1] || "Starting")}${j.hash ? " · " + txLink(C.chainId, j.hash) : ""}`
    : j?.error ? `<span class="err">Failed: ${esc(j.error)}</span>`
    : C.syncError ? `<span class="err">Chain connection problem: ${esc(C.syncError)} · retrying. If it persists, set another RPC on the setup page (Advanced).</span>`
    : !C.synced ? "Connecting to Sepolia…"
    : !C.state?.approved ? `<span class="err">These banks are not approved on this deployment. Create a new session on the setup page.</span>`
    : nx?.proof && engine.error ? `<span class="err">The proof engine failed to load: ${esc(engine.error)}</span> <button class="small ghost" id="retryengine">Retry</button>`
    : nx?.proof && !engine.ready ? "Loading the proof engine…"
    : nx ? esc(nx.detail) : "The story is complete. Create a fresh session on the setup page to run it again.";
  $("#story").innerHTML = `<ol class="steps-bar">${STEPS.map((s, i) => `<li class="${done(s.id) ? "done" : nx && nx.id === s.id ? "next" : ""} ${busy && j.id === s.id ? "running" : ""}">
      <button data-step="${s.id}" ${!ready(s) || done(s.id) || (nx && nx.id !== s.id) ? "disabled" : ""}><span class="si">${done(s.id) ? "✓" : i + 1}</span>${esc(s.title)}</button></li>`).join("")}</ol>
    <div class="story-row"><button class="go" id="go" ${!nx || !ready(nx) ? "disabled" : ""}>${nx ? `Run step ${STEPS.indexOf(nx) + 1}: ${esc(nx.title)}` : "Done"}</button><div class="status">${status}</div></div>`;
  $("#go").onclick = () => nx && runStep(nx.id);
  document.querySelectorAll("[data-step]").forEach((b) => (b.onclick = () => runStep(b.dataset.step)));
  if ($("#retryengine")) $("#retryengine").onclick = loadEngine;
}
function paintStage(force) {
  if (!C?.state || !here() || !C.stage || (C.hold && !force)) return;
  const s = C.state;
  C.stage.update({
    A: { pub: s.pa, priv: s.privA, addr: C.A.address }, B: { pub: s.pb, priv: s.privB, addr: C.B.address },
    pool: { pub: s.pool, addr: C.dep.ShieldedPool }, notes: s.notes.map((x) => ({ amount: x.amount, owner: x.owner })),
    fresh: C.fresh ? { address: C.fresh.address, balance: s.freshBal ?? 0n } : null,
  });
  C.stage.cards(C.feed.cards(C.stage.reveal ? C.viewingKeys : []));
}
function paintInspect() {
  const box = $("#inspect"); if (!box || !C?.inspect || !here()) return;
  const i = C.inspect;
  box.innerHTML = i.busy ? `<p class="hint"><span class="spin"></span>Reading ${txLink(C.chainId, i.hash)} from the chain…</p>`
    : i.error ? `<div class="err">${esc(i.error)}</div>`
    : inspectHtml(i.result, { chainId: C.chainId, keysLabel: "the regulator's viewing keys", showOpened: C.stage.reveal });
}
let lastVerify = "";
function paintVerify() {
  const box = $("#verify"); if (!box || !C) return;
  const html = verifyHtml({ chainId: C.chainId, feed: C.feed, bankB: C.B.address, token: C.dep.MockERC20, pool: C.dep.ShieldedPool });
  if (html !== lastVerify || !box.innerHTML) { box.innerHTML = html; lastVerify = html; }
}
const paintAll = () => { paintTop(); paintStage(); paintInspect(); paintVerify(); };

export function showConsole(prof) {
  // A different session than the one in memory: start from a clean page.
  if (C && (C.dep.ShieldedPool !== prof.dep.ShieldedPool || C.prof.banks[0].keys.ethKey !== prof.banks[0].keys.ethKey)) return location.reload();
  if (!C) build(prof);
  if (!engine.ready && !engine.loading) loadEngine();
  document.title = "Console · PrivateEth";
  $("#app").innerHTML = shell();
  C.stage = createStage($("#stage"), { nameA: C.A.name, nameB: C.B.name, chainId: C.chainId });
  C.stage.el.querySelector(".pool-sub .lbl").textContent = "In the pool this session";
  if (C.flags.audit) C.stage.setReveal(true);
  $("#reveal").checked = C.stage.reveal;
  $("#reveal").onchange = (e) => setReveal(e.target.checked);
  // The audience link comes from this console's own session, without any private RPC URL.
  const wurl = watchLinkFor(watchFromDep(C.dep));
  const qr = (el, width) => QRCode.toCanvas(el, wurl, { errorCorrectionLevel: "L", margin: 2, width, color: { dark: "#16181A", light: "#FFFFFF" } }).catch(() => {});
  qr($("#wqr"), 180);
  $("#wcopy").onclick = (e) => copy(wurl, e.target);
  $("#qrbtn").onclick = () => { $("#qrover").hidden = false; qr($("#bigqr"), Math.min(520, Math.floor(Math.min(innerWidth, innerHeight) * 0.7))); };
  $("#qrclose").onclick = () => ($("#qrover").hidden = true);
  $("#qrover").onclick = (e) => { if (e.target.id === "qrover") $("#qrover").hidden = true; };
  if (C.lastHash) showInspect(C.lastHash);
  paintAll();
  if (!C.polling) {
    C.polling = true;
    const me = C;
    const tick = async () => {
      if (C !== me) return; // a newer session replaced this one
      try { await refresh(me); me.syncError = null; } catch (e) { me.syncError = e.shortMessage || e.message; }
      finally {
        try { if (C === me && here()) { paintTop(); paintStage(); paintVerify(); } } catch (e) { console.warn(e); }
        setTimeout(tick, 3000);
      }
    };
    tick();
  }
}
