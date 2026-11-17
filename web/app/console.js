// Console: the whole story on one screen, with real transactions on Sepolia.
// Both banks and the regulator's keys live in this tab; one proof engine serves both banks.
import QRCode from "qrcode";
import { makeBank, sharedProver, deposit, sendPrivate, withdraw, replay, publicBalance } from "../../lib/actions.js";
import ABI from "../../artifacts/abis.json" with { type: "json" };
import { makeClients } from "../../lib/net.js";
import { $, esc, n, isHash, json, unjson, store, txLink, lockup, footer, copy } from "./util.js";
import { createStage } from "./stage.js";
import { ChainFeed } from "./feed.js";
import { inspectTx, inspectHtml } from "./inspect.js";
import { loadCircuits } from "./roles.js";
import { watchLinkFor, loadWatch } from "./profiles.js";

let C = null; // console state, kept for the life of the tab

function build(prof) {
  const [pa, pb] = prof.banks, dep = pa.dep;
  const prover = sharedProver(loadCircuits);
  const A = makeBank({ dep, keys: pa.keys, relayerKey: pa.relayerKey, loadCircuits, prover });
  const B = makeBank({ dep: pb.dep, keys: pb.keys, relayerKey: pb.relayerKey, loadCircuits, prover });
  const { pub } = makeClients(dep.rpcUrl, dep.chainId);
  const names = Object.fromEntries(Object.entries(dep.directory).map(([nm, d]) => [d.address.toLowerCase(), nm]));
  const feed = new ChainFeed(pub, { ShieldedPool: dep.ShieldedPool, startBlock: dep.startBlock, relayer: dep.relayer, names });
  const key = "privateeth.console." + dep.ShieldedPool.toLowerCase() + "." + A.address.toLowerCase();
  let saved = {}; try { saved = unjson(store.get(key) || "{}"); } catch {}
  C = { prof, dep, A, B, pub, feed, key, chainId: dep.chainId, viewingKeys: prof.regulator.viewingKeys,
    flags: saved.flags || {}, withdrawArgs: saved.withdrawArgs || null, fresh: saved.fresh || null, rejected: saved.rejected || [], lastHash: saved.lastHash || null,
    state: null, job: null, proverReady: false, proverError: null, synced: false, animating: false, inspect: null };
  for (const r of C.rejected) feed.addRejected(r);
  prover().then(() => { C.proverReady = true; paintTop(); }, (e) => { C.proverError = e.message; paintTop(); });
}
const save = () => store.set(C.key, json({ flags: C.flags, withdrawArgs: C.withdrawArgs, fresh: C.fresh, rejected: C.rejected, lastHash: C.lastHash }));

// ---------- chain state ----------
async function refresh() {
  const { A, B, feed } = C;
  await Promise.all([A.scan.sync(), B.scan.sync(), feed.sync()]);
  const [pa, pb, pool, fresh] = await Promise.all([publicBalance(A), publicBalance(B), feed.poolBalance(ABI.MockERC20, C.dep.MockERC20),
    C.fresh ? publicBalance(A, C.fresh.address) : Promise.resolve(null)]);
  const priv = (b) => b.scan.unspent().reduce((s, x) => s + BigInt(x.amount), 0n);
  const notes = [...A.scan.unspent().map((x) => ({ ...x, owner: A.name })), ...B.scan.unspent().map((x) => ({ ...x, owner: B.name }))].sort((x, y) => x.index - y.index);
  const payNote = B.scan.notes.find((x) => x.memo === `from ${A.name}`);
  C.state = { pa, pb, pool, privA: priv(A), privB: priv(B), notes, payNote, freshBal: fresh, approved: !!(A.scan.attestation && B.scan.attestation) };
  C.synced = true;
}

// ---------- the story ----------
const STEPS = [
  { id: "depA", title: "Bank A deposits", detail: "Public: Bank A moves its tokenized dollars into the shielded pool." },
  { id: "depB", title: "Bank B deposits", detail: "Public: Bank B does the same." },
  { id: "pay", title: "Bank A pays Bank B 700", detail: "Private: a zero-knowledge proof made in this browser. The chain records only hashes." },
  { id: "withdraw", title: "Bank B withdraws", detail: "Public: Bank B takes the 700 out to a brand-new address." },
  { id: "replay", title: "Replay is rejected", detail: "Someone sends the same withdrawal again. A spent note cannot be spent twice." },
  { id: "audit", title: "Regulator reads it", detail: "With viewing keys, the regulator opens the private payment. Nobody else can." },
];
function done(id) {
  const s = C.state; if (!s) return false;
  if (id === "depA") return s.pa === 0n && (s.privA > 0n || !!s.payNote);
  if (id === "depB") return s.pb === 0n && (s.privB > 0n || !!s.payNote);
  if (id === "pay") return !!s.payNote;
  if (id === "withdraw") return !!(s.payNote && s.payNote.spent);
  return !!C.flags[id];
}
const nextStep = () => STEPS.find((x) => !done(x.id));
async function runStep(id) {
  if (C.job && !C.job.done) return;
  const s = C.state, { A, B } = C;
  const job = (C.job = { id, stages: [], done: false, error: null });
  const stage = (t, hash) => { job.stages.push(t); if (isHash(hash)) job.hash = hash; paintTop(); };
  paintTop();
  try {
    let r;
    if (id === "depA" || id === "depB") {
      const bank = id === "depA" ? A : B, amt = id === "depA" ? s.pa : s.pb;
      if (amt === 0n) throw new Error(`${bank.name} has no public tUSD left to deposit`);
      r = await deposit(bank, amt, stage);
      await animate(() => C.stage.fly(id === "depA" ? "A" : "B", "pool", { kind: "coin", label: n(amt) }));
    } else if (id === "pay") {
      r = await sendPrivate(A, C.dep.directory[B.name], 700n, stage);
      await animate(() => C.stage.fly("A", "B", { kind: "envelope", label: C.stage.reveal ? "700" : "sealed" }));
    } else if (id === "withdraw") {
      await B.scan.sync();
      const note = B.scan.notes.find((x) => x.memo === `from ${A.name}` && !x.spent);
      if (!note) throw new Error("Bank B has no unspent payment from Bank A to withdraw");
      r = await withdraw(B, note.commitment, stage);
      C.withdrawArgs = r.args; C.fresh = { address: r.recipient }; save();
      C.stage.update({ fresh: { address: r.recipient, balance: 0 } });
      await animate(() => C.stage.fly("pool", "fresh", { kind: "coin", label: n(note.amount) }));
    } else if (id === "replay") {
      if (!C.withdrawArgs) throw new Error("Run the withdrawal first");
      stage("Sending the same withdrawal again");
      r = await replay(B, C.withdrawArgs);
      if (r.status === "reverted") {
        C.stage.shake("pool");
        const card = { kind: "rejected", key: r.hash + ":x", hash: r.hash, block: r.block, title: "Replayed withdrawal", rows: [["Result", "rejected by the contract", "pub"], ["Reason", "note already spent", "pub"]] };
        C.rejected.push(card); C.feed.addRejected(card);
      }
      C.flags.replay = true;
    } else if (id === "audit") {
      C.flags.audit = true; setReveal(true);
      const pay = C.feed.logs.filter((l) => l.eventName === "Transfer").pop();
      if (pay) await showInspect(pay.transactionHash);
      job.done = true; save(); paintTop(); return;
    }
    C.lastHash = r.hash; save();
    stage(r.status === "reverted" ? `Rejected by the contract in block ${r.block}` : `Confirmed in block ${r.block}`);
    showInspect(r.hash);
  } catch (e) { job.error = e.shortMessage || e.message; console.error(e); }
  job.done = true;
  try { await refresh(); } catch {}
  paintAll();
}
async function animate(f) { C.animating = true; try { await f(); } finally { C.animating = false; } }

async function showInspect(hash) {
  C.inspect = { hash, busy: true };
  paintInspect();
  try { C.inspect = { hash, result: await inspectTx(C.pub, C.dep, C.viewingKeys, hash) }; } catch (e) { C.inspect = { hash, error: e.shortMessage || e.message }; }
  paintInspect();
}
function setReveal(on) { C.stage.setReveal(on); const t = $("#reveal"); if (t) t.checked = on; paintStage(); paintInspect(); }

// ---------- rendering ----------
function shell() {
  return `<div class="top">${lockup()}<div class="net" id="chips"></div></div>
    <div class="console-head">
      <div><h1 class="ctitle">Private payments between banks</h1><p class="lead small">Two banks on Sepolia. Watch what moves, and what the public chain can see.</p></div>
      <label class="switch"><input type="checkbox" id="reveal"><span class="track"><i></i></span><span>What the regulator sees</span></label>
    </div>
    <div class="story" id="story"></div>
    <div id="stage"></div>
    <div class="grid console-bottom">
      <div class="card" id="inspectcard"><h2>The latest transaction</h2><div id="inspect"><p class="hint">After each step, this shows what Etherscan shows next to what the viewing keys open.</p></div></div>
      <div class="card audience"><h2>Audience view</h2><canvas id="wqr" width="150" height="150" aria-label="QR code for the audience view"></canvas>
        <p class="hint">Scan to watch the public chain live on your phone. No keys, nothing private.</p>
        <div class="row"><a class="small" href="#watch" target="_blank" rel="noopener">Open ↗</a><button class="small ghost" id="wcopy">Copy link</button></div></div>
    </div>` + footer();
}
function paintTop() {
  if (!C || location.hash !== "#console") return;
  const threads = globalThis.crossOriginIsolated ? `${Number(navigator.hardwareConcurrency) || "several"} threads` : "1 thread";
  $("#chips").innerHTML = `<span class="chip ${C.proverReady ? "ok" : C.proverError ? "warn" : ""}">PROOF ENGINE · ${C.proverReady ? "READY" : C.proverError ? "ERROR" : "LOADING"} · ${threads}</span>
    <span class="chip">${C.chainId === 11155111 ? "SEPOLIA" : "CHAIN " + Number(C.chainId)}</span>`;
  const nx = nextStep(), j = C.job, busy = !!(j && !j.done);
  const can = C.synced && C.proverReady && !busy;
  const status = busy ? `<span class="spin"></span>${esc(j.stages[j.stages.length - 1] || "Starting")}${j.hash ? " · " + txLink(C.chainId, j.hash) : ""}`
    : j?.error ? `<span class="err">Failed: ${esc(j.error)}</span>`
    : !C.synced ? "Connecting to Sepolia…" : !C.proverReady ? (C.proverError ? `<span class="err">The proof engine failed to load: ${esc(C.proverError)}</span>` : "Loading the proof engine…")
    : !C.state?.approved ? `<span class="err">These banks are not approved on this deployment. Create a new session on the setup page.</span>`
    : nx ? esc(nx.detail) : "The story is complete. Create a fresh session on the setup page to run it again.";
  $("#story").innerHTML = `<ol class="steps-bar">${STEPS.map((s, i) => `<li class="${done(s.id) ? "done" : nx && nx.id === s.id ? "next" : ""} ${busy && j.id === s.id ? "running" : ""}">
      <button data-step="${s.id}" ${!can || (nx && nx.id !== s.id && !done(s.id)) || done(s.id) ? "disabled" : ""}><span class="si">${done(s.id) ? "✓" : i + 1}</span>${esc(s.title)}</button></li>`).join("")}</ol>
    <div class="story-row"><button class="go" id="go" ${!can || !nx || !C.state?.approved ? "disabled" : ""}>${nx ? `Run step ${STEPS.indexOf(nx) + 1}: ${esc(nx.title)}` : "Done"}</button><div class="status">${status}</div></div>`;
  $("#go").onclick = () => nx && runStep(nx.id);
  document.querySelectorAll("[data-step]").forEach((b) => (b.onclick = () => runStep(b.dataset.step)));
}
function paintStage() {
  if (!C?.state || C.animating) return;
  const s = C.state;
  C.stage.update({
    A: { pub: s.pa, priv: s.privA, addr: C.A.address }, B: { pub: s.pb, priv: s.privB, addr: C.B.address },
    pool: { pub: s.pool, addr: C.dep.ShieldedPool }, notes: s.notes.map((x) => ({ amount: x.amount, owner: x.owner })),
    fresh: C.fresh ? { address: C.fresh.address, balance: s.freshBal ?? 0n } : null,
  });
  C.stage.cards(C.feed.cards(C.stage.reveal ? C.viewingKeys : []));
}
function paintInspect() {
  const box = $("#inspect"); if (!box || !C.inspect) return;
  const i = C.inspect;
  box.innerHTML = i.busy ? `<p class="hint"><span class="spin"></span>Reading ${txLink(C.chainId, i.hash)} from the chain…</p>`
    : i.error ? `<div class="err">${esc(i.error)}</div>`
    : inspectHtml(i.result, { chainId: C.chainId, keysLabel: "the regulator's viewing keys", showOpened: C.stage.reveal });
}
const paintAll = () => { paintTop(); paintStage(); paintInspect(); };

export function showConsole(prof) {
  if (!C || C.dep.ShieldedPool !== prof.dep.ShieldedPool || C.prof.banks[0].keys.ethKey !== prof.banks[0].keys.ethKey) build(prof);
  document.title = "Console · PrivateEth";
  $("#app").innerHTML = shell();
  C.stage = createStage($("#stage"), { nameA: C.A.name, nameB: C.B.name, chainId: C.chainId });
  if (C.flags.audit) C.stage.setReveal(true);
  $("#reveal").checked = C.stage.reveal;
  $("#reveal").onchange = (e) => setReveal(e.target.checked);
  const w = loadWatch(), wurl = w ? watchLinkFor(w) : null;
  if (wurl) { QRCode.toCanvas($("#wqr"), wurl, { margin: 1, width: 150, color: { dark: "#16181A", light: "#F7F5F0" } }).catch(() => {}); $("#wcopy").onclick = (e) => copy(wurl, e.target); }
  else $(".audience").hidden = true;
  if (C.lastHash && !C.inspect) showInspect(C.lastHash);
  paintAll();
  if (!C.polling) {
    C.polling = true;
    const me = C;
    const tick = async () => {
      if (C !== me) return; // a newer session replaced this one
      try { await refresh(); me.syncError = null; } catch (e) { me.syncError = e.shortMessage || e.message; }
      if (C === me && location.hash === "#console") { paintTop(); paintStage(); }
      setTimeout(tick, 3000);
    };
    tick();
  }
}
