// Single-role screens: one bank's wallet, or the regulator. For presenting on separate screens.
import { makeBank, deposit, sendPrivate, withdraw, replay, publicBalance } from "../../lib/actions.js";
import { makeClients } from "../../lib/net.js";
import { $, $$, esc, n, isHash, json, unjson, store, txLink, addrLink, lockup, footer } from "./util.js";
import { inspectTx, inspectHtml } from "./inspect.js";

export const loadCircuits = async () => Object.fromEntries(await Promise.all(["deposit", "transfer", "withdraw"].map(async (c) =>
  [c, await (await fetch(new URL(`./circuits/${c}.json`, location.href))).json()])));

const roles = new Map(); // one entry per role for the life of the tab
let current = null, lastHtml = "", lastToast = 0, prevPriv = null, prevPub = null, prevRole = null;
const paint = (me) => { if (current === me && location.hash === "#" + me.id) render(); };

function roleFor(prof) {
  if (roles.has(prof.id)) return roles.get(prof.id);
  const { pub } = makeClients(prof.dep.rpcUrl, prof.dep.chainId);
  const me = { id: prof.id, role: prof.role, name: prof.name, dep: prof.dep, pub, chainId: prof.dep.chainId, inspect: { result: null, error: null, busy: false, draft: "" } };
  if (prof.role === "regulator") { me.viewingKeys = prof.viewingKeys; roles.set(prof.id, me); return me; }
  me.bank = makeBank({ dep: prof.dep, keys: prof.keys, relayerKey: prof.relayerKey, loadCircuits });
  me.viewingKeys = [{ name: prof.name, viewingPriv: prof.keys.viewingPriv }];
  let saved = null; try { saved = unjson(store.get("privateeth.state." + prof.id) || "null"); } catch {}
  Object.assign(me, { activity: saved?.activity || [], fresh: saved?.fresh || [], lastWithdrawArgs: saved?.lastWithdrawArgs || null,
    publicBal: 0n, known: new Set(), firstSync: true, synced: false, job: null, proverReady: false, proverError: null });
  me.loadProver = () => me.bank.prover().then(() => { me.proverReady = true; me.proverError = null; paint(me); }, (e) => { me.proverError = e.message; paint(me); });
  me.loadProver();
  roles.set(prof.id, me);
  return me;
}

function header(me) {
  const threads = globalThis.crossOriginIsolated ? `${Number(navigator.hardwareConcurrency) || "several"} threads` : "1 thread";
  const engine = me.role === "bank" ? `<span class="chip ${me.proverReady ? "ok" : me.proverError ? "warn" : ""}" title="Proofs are generated in this browser">PROOF ENGINE · ${me.proverReady ? "READY" : me.proverError ? "ERROR" : "LOADING"} · ${threads}</span>` : "";
  const net = `<span class="chip">${me.chainId === 11155111 ? "SEPOLIA" : "CHAIN " + Number(me.chainId)}</span>`;
  return `<div class="top">${lockup()}<div class="net">${engine}${net}${me.chainId === 11155111 ? `<a class="chip" href="https://sepolia.etherscan.io/address/${me.dep.ShieldedPool}" target="_blank" rel="noopener">POOL ON ETHERSCAN ↗</a>` : ""}</div></div>`;
}

// ---------- inspect card ----------
function inspectCard(me) {
  const { result: r, error, busy } = me.inspect, reg = me.role === "regulator";
  let body = `<p class="hint">Paste a transaction hash from Etherscan. Left: what everyone can read. Right: what ${reg ? "the viewing keys" : "this bank's key"} can open.</p>`;
  if (error) body += `<div class="err">${esc(error)}</div>`;
  if (r) body += inspectHtml(r, { chainId: me.chainId, keysLabel: reg ? "the viewing keys" : "this bank's key" });
  return `<div class="card" id="inspectcard"><h2>Open a transaction with ${reg ? "the viewing keys" : "my key"}</h2>
    <div class="row"><input class="hash" id="ihash" placeholder="0x… transaction hash" value="${esc(r?.hash || me.inspect.draft || "")}" aria-label="Transaction hash"><button id="ibtn" ${busy ? "disabled" : ""}>${busy ? "Opening…" : "Open"}</button></div>${body}</div>`;
}
async function doInspect(me, hash) {
  const h = (hash ?? $("#ihash")?.value ?? "").trim();
  me.inspect.draft = h;
  if (!isHash(h)) { me.inspect = { result: null, error: "That is not a transaction hash (0x followed by 64 hex characters).", busy: false, draft: h }; return paint(me); }
  me.inspect.busy = true; me.inspect.error = null; paint(me); scrollToInspect();
  try { me.inspect.result = await inspectTx(me.pub, me.dep, me.viewingKeys, h); } catch (e) { me.inspect.error = e.shortMessage || e.message; me.inspect.result = null; }
  me.inspect.busy = false; paint(me); scrollToInspect();
}
const scrollToInspect = () => $("#inspectcard")?.scrollIntoView({ behavior: "smooth", block: "start" });

// ---------- bank ----------
const saveBankState = (me) => store.set("privateeth.state." + me.id, json({ activity: me.activity, fresh: me.fresh, lastWithdrawArgs: me.lastWithdrawArgs }));
function addActivity(me, e) { me.activity.unshift({ ts: Date.now(), ...e }); me.activity.length = Math.min(me.activity.length, 30); saveBankState(me); }

async function refreshBank(me) {
  const b = me.bank;
  await b.scan.sync();
  me.publicBal = await publicBalance(b);
  for (const f of me.fresh) f.balance = String(await publicBalance(b, f.address));
  for (const note of b.scan.notes) {
    if (me.known.has(note.commitment)) continue;
    me.known.add(note.commitment);
    const incoming = note.memo && note.memo.startsWith("from ");
    if (incoming && !me.activity.some((a) => a.hash === note.txHash)) addActivity(me, { type: "receive", text: `Received ${note.amount} tUSD privately (${note.memo})`, hash: note.txHash, flash: !me.firstSync });
  }
  me.firstSync = false; me.synced = true;
}
function run(me, label, type, fn) {
  if (me.job && !me.job.done) return;
  const job = (me.job = { label, stages: [], done: false, error: null, hash: null });
  const stage = (s, hash) => { job.stages.push(s); if (isHash(hash)) job.hash = hash; paint(me); };
  (async () => {
    let r;
    try { r = await fn(stage); } catch (e) { job.error = e.shortMessage || e.message; console.error(e); }
    if (r) {
      job.hash = r.hash;
      stage(r.status === "reverted" ? `Rejected by the contract in block ${r.block}` : `Confirmed in block ${r.block}`);
      addActivity(me, { type, text: r.text, hash: r.hash });
      try { await refreshBank(me); } catch (e) { console.warn(e); }
    }
    job.done = true; paint(me);
  })();
  paint(me);
}
const alertJob = (me, msg) => { if (me.job && !me.job.done) return; me.job = { label: "Check the amount", stages: [], error: msg, done: true }; paint(me); };
function jobView(me) {
  const j = me.job, busy = j && !j.done;
  if (!j) return `<div class="empty">No action yet.</div>`;
  return `<div class="job ${j.error ? "err" : ""}"><div class="lbl">${esc(j.label)}</div>
    ${j.stages.map((s, i) => `<div class="stage-line">${busy && i === j.stages.length - 1 ? '<span class="spin"></span>' : ""}${esc(s)}</div>`).join("")}
    ${busy && !j.stages.length ? '<div class="stage-line"><span class="spin"></span>Starting</div>' : ""}
    ${j.hash ? `<div class="stage-line">Transaction ${txLink(me.chainId, j.hash)}</div>` : ""}${j.error ? `<div class="stage-line err">Failed: ${esc(j.error)}</div>` : ""}</div>`;
}
function bankView(me) {
  const b = me.bank, busy = !!(me.job && !me.job.done);
  const notes = b.scan.notes.filter((x) => BigInt(x.amount) > 0n), unspent = notes.filter((x) => !x.spent);
  const priv = unspent.reduce((s, x) => s + BigInt(x.amount), 0n);
  const others = Object.keys(me.dep.directory).filter((x) => x !== me.name);
  const ready = me.synced, canProve = ready && me.proverReady;
  const keep = (id, d) => { const el = document.getElementById(id); return el && el.value !== el.dataset.auto ? el.value : String(d); };
  const depDefault = me.publicBal > 0n ? String(me.publicBal) : "0";
  const why = !ready ? "Connecting to the chain…" : !me.proverReady ? (me.proverError ? "The proof engine failed to load." : "Waiting for the proof engine…") : "";
  me.view = { priv, publicBal: me.publicBal, ready };
  return header(me) + `
    <div class="hero"><h1>${esc(me.name)}</h1><span class="addr">${addrLink(me.chainId, b.address)}</span>
      <span class="pill ${b.scan.attestation ? "" : "off"}">${!ready ? "CONNECTING…" : b.scan.attestation ? "APPROVED FOR THE POOL" : "NOT APPROVED"}</span></div>
    ${me.syncError ? `<div class="err">Chain connection problem: ${esc(me.syncError)} · retrying</div>` : ""}
    ${me.proverError ? `<div class="err">Proof engine failed to load: ${esc(me.proverError)} <button class="small ghost" id="retryprover">Retry</button></div>` : ""}
    <div class="bal">
      <div class="tile"><span class="lbl">Public wallet · tUSD</span><span class="num" id="pubnum">${ready ? n(me.publicBal) : "…"}</span><span class="who">Anyone can see this on Etherscan</span></div>
      <div class="tile priv"><span class="lbl">Private balance · tUSD</span><span class="num" id="privnum">${ready ? n(priv) : "…"}</span><span class="who">Only ${esc(me.name)} can see this</span></div>
    </div>
    <div class="grid">
      <div class="col">
        <div class="card"><h2>Move into the pool</h2><p class="hint">${me.publicBal === 0n && ready ? "No public tUSD left to deposit." : `Public: Etherscan shows ${esc(me.name)} sending tUSD to the pool.`}</p>
          <div class="row"><input type="number" id="damt" min="1" aria-label="Deposit amount" data-auto="${depDefault}" value="${esc(keep("damt", depDefault))}"><button id="dbtn" ${busy || !canProve || me.publicBal === 0n ? "disabled" : ""}>Deposit</button></div></div>
        <div class="card"><h2>Pay privately</h2><p class="hint">Private: no sender, recipient or amount on-chain. A relayer pays the gas.</p>
          <div class="row"><select id="sto" aria-label="Recipient">${others.map((c) => `<option ${$("#sto")?.value === c ? "selected" : ""}>${esc(c)}</option>`).join("")}</select>
            <input type="number" id="samt" min="1" aria-label="Amount to send" data-auto="700" value="${esc(keep("samt", 700))}"><button id="sbtn" ${busy || !canProve || priv === 0n ? "disabled" : ""}>Send privately</button></div></div>
        <div class="card"><h2>Withdraw</h2><p class="hint">Public: one whole note leaves the pool to a brand-new address.</p>
          <div class="notes">${unspent.length ? unspent.map((x) => `<span class="note">${n(x.amount)}${x.memo && x.memo !== "deposit" ? " · " + esc(x.memo) : ""} <button class="small ghost" data-w="${esc(x.commitment)}" ${busy || !canProve ? "disabled" : ""}>Withdraw</button></span>`).join("") : '<span class="empty">No private notes yet.</span>'}</div>
          ${me.fresh.map((f) => `<div class="hint">New address ${addrLink(me.chainId, f.address)} holds <b>${n(f.balance)} tUSD</b></div>`).join("")}
          ${me.lastWithdrawArgs ? `<div class="row"><button class="ghost" id="rbtn" ${busy ? "disabled" : ""}>Replay last withdrawal (should fail)</button></div>` : ""}</div>
        ${why ? `<p class="hint">${esc(why)}</p>` : ""}
      </div>
      <div class="col">
        <div class="card"><h2>Progress</h2><div id="jobbox">${jobView(me)}</div></div>
        <div class="card"><h2>Activity</h2><div>${me.activity.length ? me.activity.map((a) => `<div class="item"><span class="tag ${esc(a.type)}">${esc(a.type)}</span><span>${esc(a.text)}</span><span>${isHash(a.hash) ? txLink(me.chainId, a.hash) + ` <button class="small ghost" data-i="${a.hash}">Open</button>` : ""}</span></div>`).join("") : '<div class="empty">Nothing yet.</div>'}</div></div>
        <div class="card"><h2>Private notes</h2><div class="notes">${notes.length ? notes.map((x) => `<span class="note ${x.spent ? "spent" : ""}">${n(x.amount)}${x.memo && x.memo !== "deposit" ? " · " + esc(x.memo) : ""}</span>`).join("") : '<span class="empty">None yet.</span>'}</div></div>
      </div>
    </div>` + inspectCard(me) + footer();
}
function bindBank(me) {
  const b = me.bank;
  $("#dbtn").onclick = () => {
    const v = $("#damt").value.trim();
    if (!/^\d+$/.test(v) || BigInt(v) === 0n) return alertJob(me, "Enter a whole number of tUSD to deposit.");
    if (BigInt(v) > me.publicBal) return alertJob(me, `The public wallet holds only ${me.publicBal} tUSD.`);
    run(me, `Move ${v} tUSD into the pool`, "deposit", async (s) => ({ ...(await deposit(b, BigInt(v), s)), text: `Deposited ${v} tUSD into the pool (public)` }));
  };
  $("#sbtn").onclick = () => {
    const to = $("#sto").value, v = $("#samt").value.trim();
    if (!/^\d+$/.test(v) || BigInt(v) === 0n) return alertJob(me, "Enter a whole number of tUSD to send.");
    run(me, `Pay ${to} ${v} tUSD privately`, "send", async (s) => ({ ...(await sendPrivate(b, me.dep.directory[to], BigInt(v), s)), text: `Paid ${to} ${v} tUSD privately` }));
  };
  $$("[data-w]").forEach((el) => (el.onclick = () => run(me, "Withdraw to a new address", "withdraw", async (s) => {
    const r = await withdraw(b, el.dataset.w, s);
    me.lastWithdrawArgs = r.args; me.fresh.push({ address: r.recipient, balance: "0" }); saveBankState(me);
    return { ...r, text: `Withdrew ${r.args[3]} tUSD to new address ${r.recipient.slice(0, 8)}…` };
  })));
  if ($("#rbtn")) $("#rbtn").onclick = () => run(me, "Replay the last withdrawal", "replay", async (s) => {
    s("Sending the same withdrawal again");
    const r = await replay(b, me.lastWithdrawArgs);
    return { ...r, text: r.status === "reverted" ? "Replay rejected by the contract (note already spent)" : "Replay unexpectedly succeeded" };
  });
  if ($("#retryprover")) $("#retryprover").onclick = () => { me.proverError = null; paint(me); me.loadProver(); };
  $$("[data-i]").forEach((el) => (el.onclick = () => doInspect(me, el.dataset.i)));
}
function afterBankRender(me) {
  if (prevRole === me.id && me.view?.ready) {
    if (prevPriv !== null && prevPriv !== String(me.view.priv)) $("#privnum")?.classList.add("flash");
    if (prevPub !== null && prevPub !== String(me.view.publicBal)) $("#pubnum")?.classList.add("flash");
  }
  if (me.view?.ready) { prevPriv = String(me.view.priv); prevPub = String(me.view.publicBal); prevRole = me.id; }
  const flash = me.activity.find((a) => a.flash && a.ts > lastToast);
  if (flash) {
    lastToast = flash.ts; flash.flash = false; saveBankState(me);
    $("#toast-text").textContent = flash.text; $("#toast").hidden = false;
    setTimeout(() => ($("#toast").hidden = true), 9000);
  }
}
// While an action field is being edited, update only the live parts so typing is never interrupted.
function liveBank(me) {
  const busy = !!(me.job && !me.job.done), canProve = me.synced && me.proverReady;
  $("#jobbox").innerHTML = jobView(me);
  if (me.synced) {
    const priv = me.bank.scan.unspent().reduce((s, x) => s + BigInt(x.amount), 0n);
    $("#pubnum").textContent = n(me.publicBal); $("#privnum").textContent = n(priv);
    me.view = { priv, publicBal: me.publicBal, ready: true };
  }
  $("#dbtn").disabled = busy || !canProve || me.publicBal === 0n;
  $("#sbtn").disabled = busy || !canProve;
  $$("#rbtn,[data-w]").forEach((el) => (el.disabled = busy || (el.id !== "rbtn" && !canProve)));
  afterBankRender(me);
}

const regulatorView = (me) => header(me) + `<div class="hero"><h1>Regulator</h1><span class="addr">Holds viewing keys for ${me.viewingKeys.map((k) => esc(k.name)).join(" and ")} · cannot move funds</span></div>` + inspectCard(me) + footer();

function render() {
  const me = current;
  if (!me) return;
  if (me.role === "bank" && $("#app").dataset.role === me.id && document.activeElement?.matches?.("#damt,#samt,#sto")) return liveBank(me);
  const html = me.role === "regulator" ? regulatorView(me) : bankView(me);
  if (html !== lastHtml) {
    const a = document.activeElement, id = a?.id, sel = a && "selectionStart" in a ? [a.selectionStart, a.selectionEnd] : null;
    $("#app").innerHTML = html; $("#app").dataset.role = me.id; lastHtml = html;
    const el = id && document.getElementById(id);
    if (el) { el.focus({ preventScroll: true }); if (sel && sel[0] != null) try { el.setSelectionRange(sel[0], sel[1]); } catch {} }
    $("#ibtn").onclick = () => doInspect(me);
    $("#ihash").onkeydown = (e) => { if (e.key === "Enter") doInspect(me); };
    $("#ihash").oninput = (e) => { me.inspect.draft = e.target.value; };
    if (me.role === "bank") bindBank(me);
  }
  if (me.role === "bank") afterBankRender(me);
}

export function showRole(prof) {
  current = roleFor(prof);
  document.title = `${current.name} · PrivateEth`;
  lastHtml = ""; render();
  if (current.role === "bank" && !current.polling) {
    const me = current; me.polling = true;
    const tick = async () => {
      try { await refreshBank(me); me.syncError = null; } catch (e) { me.syncError = e.shortMessage || e.message; }
      paint(me); setTimeout(tick, 3000);
    };
    tick();
  }
}
export const leaveRole = () => { current = null; };
export const forgetRoles = () => roles.clear();
