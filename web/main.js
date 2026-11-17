// Browser wallet: everything runs in this tab. Keys arrive once through a private setup link
// (in the URL fragment, which is never sent to any server) and are kept in this browser.
import { decodeEventLog, hexToBytes, bytesToHex } from "viem";
import ABI from "../artifacts/abis.json" with { type: "json" };
import { makeBank, deposit, sendPrivate, withdraw, replay, publicBalance } from "../lib/actions.js";
import { openNote, unpackEnvelopes } from "../lib/core.js";
import { makeClients, explorerFor } from "../lib/net.js";

const REPO = "https://github.com/EntEthAlliance/privateeth";
const STORE = "privateeth.profiles.v1";
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const short = (h) => (h ? h.slice(0, 8) + "…" + h.slice(-6) : "");
const n = (v) => Number(v).toLocaleString("en-US");
const json = (v) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? { $big: x.toString() } : x));
const unjson = (s) => JSON.parse(s, (_, x) => (x && typeof x === "object" && "$big" in x ? BigInt(x.$big) : x));

// ---------- profiles (per browser) ----------
const memory = {};
function loadProfiles() { try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch { return memory; } }
function saveProfiles(p) { try { localStorage.setItem(STORE, JSON.stringify(p)); } catch { Object.assign(memory, p); } }
function decodeSetup(s) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "===".slice((b64.length + 3) % 4));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
}
function takeSetupFromHash() {
  const m = location.hash.match(/^#setup=([A-Za-z0-9_-]+)$/);
  if (!m) return;
  try {
    const prof = decodeSetup(m[1]);
    if (!prof.id || !prof.dep) throw new Error("incomplete link");
    const all = loadProfiles();
    all[prof.id] = prof;
    saveProfiles(all);
    try { localStorage.removeItem("privateeth.state." + prof.id); } catch {}
    history.replaceState(null, "", "#" + prof.id);
  } catch (e) {
    history.replaceState(null, "", "#");
    setupError = "That setup link could not be read: " + e.message;
  }
}
let setupError = null;

// ---------- shared pieces ----------
let ctx = null; // the role this tab shows
const explorer = () => ctx?.dep?.explorer ?? explorerFor(ctx?.dep?.chainId);
const txLink = (h) => (explorer() ? `<a href="${explorer()}/tx/${h}" target="_blank" rel="noopener">${short(h)} ↗</a>` : `<span class="mono">${short(h)}</span>`);
const addrLink = (a) => (explorer() ? `<a href="${explorer()}/address/${a}" target="_blank" rel="noopener">${short(a)} ↗</a>` : `<span class="mono">${short(a)}</span>`);
const loadCircuits = async () => Object.fromEntries(await Promise.all(["deposit", "transfer", "withdraw"].map(async (c) =>
  [c, await (await fetch(new URL(`./circuits/${c}.json`, location.href))).json()])));

function header() {
  const d = ctx?.dep;
  const threads = globalThis.crossOriginIsolated ? `${navigator.hardwareConcurrency || "several"} threads` : "1 thread";
  const engine = ctx?.role === "bank" ? `<span class="chip ${ctx.proverReady ? "ok" : ""}" title="Proofs are generated in this browser">PROOF ENGINE · ${ctx.proverReady ? "READY" : ctx.proverError ? "ERROR" : "LOADING"} · ${threads}</span>` : "";
  const net = d ? `<span class="chip">${d.chainId === 11155111 ? "SEPOLIA" : "CHAIN " + d.chainId}</span>` : "";
  const pool = d && explorer() ? `<a class="chip" href="${explorer()}/address/${d.ShieldedPool}" target="_blank" rel="noopener">POOL ON ETHERSCAN ↗</a>` : "";
  return `<div class="top">
    <a class="lockup" href="#"><div><b>EEA</b>ETHEREUM INTELLIGENCE</div><div class="stripe"><i></i><i></i><i></i></div></a>
    <div class="net">${engine}${net}${pool}</div>
  </div>`;
}

// ---------- inspect: what the explorer shows vs what a key opens ----------
let inspectResult = null, inspectError = null, inspecting = false;
async function inspect(hash) {
  const { pub, dep } = ctx;
  const [tx, rcpt] = await Promise.all([pub.getTransaction({ hash }), pub.getTransactionReceipt({ hash })]);
  const fromLabel = tx.from.toLowerCase() === (dep.relayer || "").toLowerCase() ? "relayer"
    : Object.entries(dep.directory || {}).find(([, x]) => x.address.toLowerCase() === tx.from.toLowerCase())?.[0] || null;
  const out = { hash, from: tx.from, fromLabel, status: rcpt.status, events: [] };
  for (const log of rcpt.logs) {
    if (log.address.toLowerCase() !== dep.ShieldedPool.toLowerCase()) continue;
    let ev; try { ev = decodeEventLog({ abi: ABI.ShieldedPool, data: log.data, topics: log.topics }); } catch { continue; }
    const a = ev.args, payload = a.encryptedNote || a.encryptedNotes;
    const fields = Object.entries(a).filter(([k]) => !/encrypted/i.test(k)).map(([k, v]) => [k, String(v)]);
    const envelopes = payload ? unpackEnvelopes(hexToBytes(payload)).map((env) => {
      let opened = null;
      for (const k of ctx.viewingKeys) { const note = openNote(env, k.viewingPriv); if (note) { opened = { by: k.name, amount: note.amount, memo: note.memo }; break; } }
      return { bytes: bytesToHex(env).slice(0, 26) + "…", size: env.length, opened };
    }) : [];
    out.events.push({ name: ev.eventName, fields, envelopes });
  }
  return out;
}
function inspectCard() {
  const r = inspectResult, reg = ctx.role === "regulator";
  let body = `<p class="hint">Paste a transaction hash from Etherscan. Left: what everyone can read. Right: what ${reg ? "the viewing keys" : "this bank's key"} can open.</p>`;
  if (inspectError) body += `<div class="err">${esc(inspectError)}</div>`;
  if (r) {
    const evs = r.events.length ? r.events : [{ name: "(no pool event)", fields: [], envelopes: [] }];
    const left = evs.map((e) => `<div class="kv"><span>from</span><span>${addrLink(r.from)}${r.fromLabel ? " · " + esc(r.fromLabel) : ""}</span><span>status</span><span>${esc(r.status)}</span><span>event</span><span>${esc(e.name)}</span>
      ${e.fields.map(([k, v]) => `<span>${esc(k)}</span><span>${esc(v.length > 30 ? short(v) : v)}</span>`).join("")}
      ${e.envelopes.map((x, i) => `<span>encrypted ${i + 1}</span><span class="sealed">${esc(x.bytes)} (${x.size} bytes)</span>`).join("")}</div>`).join("");
    const all = evs.flatMap((e) => e.envelopes);
    const right = all.length ? all.map((x, i) => x.opened
      ? `<div class="open">Note ${i + 1}: ${n(x.opened.amount)} tUSD${x.opened.memo ? " · " + esc(x.opened.memo) : ""}<div class="tag" style="color:var(--blue)">opened with ${esc(x.opened.by)}'s key</div></div>`
      : `<div class="closed">Note ${i + 1}: cannot be opened with ${reg ? "these keys" : "this key"}</div>`).join("")
      : `<div class="closed">No encrypted notes in this transaction.</div>`;
    body += `<div class="inspect"><div><div class="lbl" style="color:var(--orange)">What Etherscan shows</div>${left}</div><div style="display:grid;gap:10px;align-content:start"><div class="lbl" style="color:var(--blue)">What the key opens</div>${right}</div></div>`;
  }
  return `<div class="card"><h2>Open a transaction with ${reg ? "the viewing keys" : "my key"}</h2>
    <div class="row"><input class="hash" id="ihash" placeholder="0x… transaction hash" value="${esc(r?.hash || $("#ihash")?.value || "")}" aria-label="Transaction hash"><button id="ibtn" ${inspecting ? "disabled" : ""}>${inspecting ? "Opening…" : "Open"}</button></div>${body}</div>`;
}
async function doInspect() {
  const h = $("#ihash").value.trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(h)) { inspectError = "That is not a transaction hash (0x followed by 64 hex characters)."; inspectResult = null; return render(); }
  inspecting = true; inspectError = null; render();
  try { inspectResult = await inspect(h); } catch (e) { inspectError = e.shortMessage || e.message; inspectResult = null; }
  inspecting = false; render();
}
function bindInspect() { $("#ibtn").onclick = doInspect; $("#ihash").onkeydown = (e) => e.key === "Enter" && doInspect(); }

// ---------- bank role ----------
function bankState() { try { return unjson(localStorage.getItem("privateeth.state." + ctx.id) || "null"); } catch { return null; } }
function saveBankState() { try { localStorage.setItem("privateeth.state." + ctx.id, json({ activity: ctx.activity, fresh: ctx.fresh, lastWithdrawArgs: ctx.lastWithdrawArgs })); } catch {} }
function addActivity(e) { ctx.activity.unshift({ ts: Date.now(), ...e }); ctx.activity.length = Math.min(ctx.activity.length, 30); saveBankState(); }

async function refreshBank() {
  const b = ctx.bank;
  await b.scan.sync();
  ctx.publicBal = await publicBalance(b);
  for (const f of ctx.fresh) f.balance = String(await publicBalance(b, f.address));
  for (const note of b.scan.notes) {
    if (ctx.known.has(note.commitment)) continue;
    ctx.known.add(note.commitment);
    const incoming = note.memo && note.memo.startsWith("from ");
    const logged = ctx.activity.some((a) => a.hash === note.txHash);
    if (incoming && !logged) addActivity({ type: "receive", text: `Received ${note.amount} tUSD privately (${note.memo})`, hash: note.txHash, flash: !ctx.firstSync });
  }
  ctx.firstSync = false;
  ctx.synced = true;
}

function run(label, type, fn) {
  if (ctx.job && !ctx.job.done) return;
  const job = (ctx.job = { label, stages: [], done: false, error: null, hash: null });
  const stage = (s, hash) => { job.stages.push(s); if (hash) job.hash = hash; render(); };
  (async () => {
    try {
      const r = await fn(stage);
      job.hash = r.hash;
      stage(r.status === "reverted" ? `Rejected by the contract in block ${r.block}` : `Confirmed in block ${r.block}`);
      addActivity({ type, text: r.text, hash: r.hash });
      await refreshBank();
    } catch (e) {
      job.error = e.shortMessage || e.message;
      console.error(e);
    } finally { job.done = true; render(); }
  })();
  render();
}

function jobView() {
  const j = ctx.job, busy = j && !j.done;
  if (!j) return `<div class="empty">No action yet.</div>`;
  return `<div class="job ${j.error ? "err" : ""}"><div class="lbl">${esc(j.label)}</div>
    ${j.stages.map((s, i) => `<div class="stage">${busy && i === j.stages.length - 1 ? '<span class="spin"></span>' : ""}${esc(s)}</div>`).join("")}
    ${busy && !j.stages.length ? '<div class="stage"><span class="spin"></span>Starting</div>' : ""}
    ${j.hash ? `<div class="stage">Transaction ${txLink(j.hash)}</div>` : ""}${j.error ? `<div class="stage err">Failed: ${esc(j.error)}</div>` : ""}</div>`;
}

let prevPriv = null, prevPub = null, lastToast = 0;
function renderBank() {
  const b = ctx.bank, j = ctx.job, busy = !!(j && !j.done);
  const notes = b.scan.notes.filter((x) => BigInt(x.amount) > 0n);
  const unspent = notes.filter((x) => !x.spent);
  const priv = unspent.reduce((s, x) => s + BigInt(x.amount), 0n);
  // Inputs follow their suggested value until the presenter types something else.
  const keep = (id, d) => { const el = document.getElementById(id); return el && el.value !== el.dataset.auto ? el.value : String(d); };
  const others = Object.keys(ctx.dep.directory).filter((x) => x !== ctx.name);
  const depDefault = ctx.publicBal > 0n ? String(ctx.publicBal) : "100";
  const ready = ctx.synced;
  $("#app").innerHTML = header() + `
    <div class="hero"><h1>${esc(ctx.name)}</h1><span class="addr">${addrLink(b.address)}</span>
      <span class="pill ${b.scan.attestation ? "" : "off"}">${!ready ? "CONNECTING…" : b.scan.attestation ? "APPROVED FOR THE POOL" : "NOT APPROVED"}</span></div>
    ${ctx.syncError ? `<div class="err">Chain connection problem: ${esc(ctx.syncError)} · retrying</div>` : ""}
    <div class="bal">
      <div class="tile"><span class="lbl">Public wallet · tUSD</span><span class="num" id="pubnum">${ready ? n(ctx.publicBal) : "…"}</span><span class="who">Anyone can see this on Etherscan</span></div>
      <div class="tile priv"><span class="lbl">Private balance · tUSD</span><span class="num" id="privnum">${ready ? n(priv) : "…"}</span><span class="who">Only ${esc(ctx.name)} can see this</span></div>
    </div>
    <div class="grid">
      <div class="col">
        <div class="card"><h2>Move into the pool</h2><p class="hint">Public: Etherscan shows ${esc(ctx.name)} sending tUSD to the pool.</p>
          <div class="row"><input type="number" id="damt" min="1" aria-label="Deposit amount" data-auto="${depDefault}" value="${keep("damt", depDefault)}"><button id="dbtn" ${busy || !ready ? "disabled" : ""}>Deposit</button></div></div>
        <div class="card"><h2>Pay privately</h2><p class="hint">Private: no sender, recipient or amount on-chain. A relayer pays the gas.</p>
          <div class="row"><select id="sto" aria-label="Recipient">${others.map((c) => `<option ${$("#sto")?.value === c ? "selected" : ""}>${esc(c)}</option>`).join("")}</select>
            <input type="number" id="samt" min="1" aria-label="Amount to send" data-auto="700" value="${keep("samt", 700)}"><button id="sbtn" ${busy || !ready ? "disabled" : ""}>Send privately</button></div></div>
        <div class="card"><h2>Withdraw</h2><p class="hint">Public: one whole note leaves the pool to a brand-new address.</p>
          <div class="notes">${unspent.length ? unspent.map((x) => `<span class="note">${n(x.amount)}${x.memo && x.memo !== "deposit" ? " · " + esc(x.memo) : ""} <button class="small ghost" data-w="${x.commitment}" ${busy ? "disabled" : ""}>Withdraw</button></span>`).join("") : '<span class="empty">No private notes yet.</span>'}</div>
          ${ctx.fresh.map((f) => `<div class="hint">New address ${addrLink(f.address)} holds <b>${n(f.balance)} tUSD</b></div>`).join("")}
          ${ctx.lastWithdrawArgs ? `<div class="row"><button class="ghost" id="rbtn" ${busy ? "disabled" : ""}>Replay last withdrawal (should fail)</button></div>` : ""}</div>
      </div>
      <div class="col">
        <div class="card"><h2>Progress</h2><div id="jobbox">${jobView()}</div></div>
        <div class="card"><h2>Activity</h2><div>${ctx.activity.length ? ctx.activity.map((a) => `<div class="item"><span class="tag ${a.type}">${a.type}</span><span>${esc(a.text)}</span><span>${a.hash ? txLink(a.hash) + ` <button class="small ghost" data-i="${a.hash}">Open</button>` : ""}</span></div>`).join("") : '<div class="empty">Nothing yet.</div>'}</div></div>
        <div class="card"><h2>Private notes</h2><div class="notes">${notes.length ? notes.map((x) => `<span class="note ${x.spent ? "spent" : ""}">${n(x.amount)}${x.memo && x.memo !== "deposit" ? " · " + esc(x.memo) : ""}</span>`).join("") : '<span class="empty">None yet.</span>'}</div></div>
      </div>
    </div>` + inspectCard() + footer();
  if (prevPriv !== null && ready && prevPriv !== String(priv)) $("#privnum").classList.add("flash");
  if (prevPub !== null && ready && prevPub !== String(ctx.publicBal)) $("#pubnum").classList.add("flash");
  if (ready) { prevPriv = String(priv); prevPub = String(ctx.publicBal); }
  $("#dbtn").onclick = () => { const v = $("#damt").value; if (+v > 0) run(`Move ${v} tUSD into the pool`, "deposit", async (s) => ({ ...(await deposit(b, BigInt(v), s)), text: `Deposited ${v} tUSD into the pool (public)` })); };
  $("#sbtn").onclick = () => { const to = $("#sto").value, v = $("#samt").value; if (+v > 0) run(`Pay ${to} ${v} tUSD privately`, "send", async (s) => ({ ...(await sendPrivate(b, ctx.dep.directory[to], BigInt(v), s)), text: `Paid ${to} ${v} tUSD privately` })); };
  document.querySelectorAll("[data-w]").forEach((el) => (el.onclick = () => run("Withdraw to a new address", "withdraw", async (s) => {
    const r = await withdraw(b, el.dataset.w, s);
    ctx.lastWithdrawArgs = r.args; ctx.fresh.push({ address: r.recipient, balance: "0" }); saveBankState();
    return { ...r, text: `Withdrew ${r.args[3]} tUSD to new address ${r.recipient.slice(0, 8)}…` };
  })));
  if ($("#rbtn")) $("#rbtn").onclick = () => run("Replay the last withdrawal", "replay", async (s) => {
    s("Sending the same withdrawal again");
    const r = await replay(b, ctx.lastWithdrawArgs);
    return { ...r, text: r.status === "reverted" ? "Replay rejected by the contract (note already spent)" : "Replay unexpectedly succeeded" };
  });
  document.querySelectorAll("[data-i]").forEach((el) => (el.onclick = () => { $("#ihash").value = el.dataset.i; doInspect(); }));
  bindInspect();
  const flash = ctx.activity.find((a) => a.flash && a.ts > lastToast);
  if (flash) {
    lastToast = flash.ts; flash.flash = false; saveBankState();
    $("#toast-text").textContent = flash.text; $("#toast").hidden = false;
    setTimeout(() => ($("#toast").hidden = true), 9000);
  }
}
// While someone types, update only the live parts so the field keeps its cursor.
function liveBank() {
  const busy = !!(ctx.job && !ctx.job.done);
  $("#jobbox").innerHTML = jobView();
  document.querySelectorAll("#dbtn,#sbtn,#rbtn,[data-w]").forEach((el) => (el.disabled = busy || !ctx.synced));
}

// ---------- regulator role ----------
function renderRegulator() {
  $("#app").innerHTML = header() + `<div class="hero"><h1>Regulator</h1><span class="addr">Holds viewing keys for ${ctx.viewingKeys.map((k) => esc(k.name)).join(" and ")} · cannot move funds</span></div>` + inspectCard() + footer();
  bindInspect();
}

// ---------- landing ----------
function footer() {
  return `<p class="hint">Research prototype on Sepolia testnet, built on the shielded pool from <a href="https://github.com/ethsystems/pocs" target="_blank" rel="noopener">ethsystems/pocs</a>. Not audited. Source: <a href="${REPO}" target="_blank" rel="noopener">EntEthAlliance/privateeth</a>.</p>`;
}
function renderLanding() {
  const all = loadProfiles();
  const ids = Object.keys(all).sort();
  $("#app").innerHTML = header() + `
    <div class="hero"><h1>Private payments on Ethereum</h1></div>
    <p class="lead">Two banks pay each other on a public chain. Nobody watching the chain sees who paid whom or how much. A regulator with viewing keys can still read every payment.</p>
    ${setupError ? `<div class="err">${esc(setupError)}</div>` : ""}
    <div class="steps">
      <div class="card"><span class="n">01 · ENTER</span><h3>Deposits are public</h3><p class="hint">A bank moves tokenized dollars into the shielded pool. Etherscan shows it, like any transfer.</p></div>
      <div class="card"><span class="n">02 · PAY</span><h3>Payments are private</h3><p class="hint">A zero-knowledge proof, made in your browser, moves value inside the pool. The chain records only hashes.</p></div>
      <div class="card"><span class="n">03 · AUDIT</span><h3>Regulators can read</h3><p class="hint">Each payment carries an encrypted note. Viewing keys open it; nobody else can.</p></div>
    </div>
    <div class="card"><h2>${ids.length ? "Roles on this device" : "Open a role"}</h2>
      ${ids.length ? `<div class="roles">${ids.map((id) => `<a class="chip ok" href="#${esc(id)}">${esc(all[id].name || id)} →</a>`).join("")}</div>
        <p class="hint">Open each role in its own window or on its own screen.</p>
        <div class="row"><button class="ghost small" id="forget">Forget the keys on this device</button></div>` : `<p class="hint">This page turns into a bank wallet or a regulator view when you open it with a private setup link. Create the links with the setup script in the repository:</p>
        <pre class="cmd">npm install
npm run setup</pre><p class="hint">It deploys the contracts to Sepolia and prints one link each for Bank A, Bank B and the regulator. The links carry testnet keys, so share them only with the people presenting.</p>`}
    </div>` + footer();
  if ($("#forget")) $("#forget").onclick = () => { try { for (const k of Object.keys(localStorage)) if (k.startsWith("privateeth.")) localStorage.removeItem(k); } catch {} location.hash = ""; route(); };
}

// ---------- routing & polling ----------
let timer = null;
function render() {
  if (!ctx) return renderLanding();
  if (ctx.role === "regulator") return renderRegulator();
  const typing = document.activeElement?.matches?.("input,select") && $("#jobbox");
  return typing ? liveBank() : renderBank();
}
function route() {
  takeSetupFromHash();
  clearInterval(timer);
  inspectResult = null; inspectError = null;
  const id = location.hash.slice(1);
  const prof = loadProfiles()[id];
  if (!prof) { ctx = null; document.title = "PrivateEth · Private Payments Demo"; return render(); }
  const { pub } = makeClients(prof.dep.rpcUrl, prof.dep.chainId);
  ctx = { id, role: prof.role, name: prof.name, dep: prof.dep, pub };
  document.title = `${prof.name} · PrivateEth`;
  if (prof.role === "regulator") { ctx.viewingKeys = prof.viewingKeys; return render(); }
  ctx.bank = makeBank({ dep: prof.dep, keys: prof.keys, relayerKey: prof.relayerKey, loadCircuits });
  ctx.viewingKeys = [{ name: prof.name, viewingPriv: prof.keys.viewingPriv }];
  const saved = bankState() || {};
  Object.assign(ctx, { activity: saved.activity || [], fresh: saved.fresh || [], lastWithdrawArgs: saved.lastWithdrawArgs || null,
    publicBal: 0n, known: new Set(), firstSync: true, synced: false, job: null });
  const me = ctx;
  ctx.bank.prover().then(() => { me.proverReady = true; if (ctx === me) render(); }, (e) => { me.proverError = e.message; console.error(e); if (ctx === me) render(); });
  const tick = async () => {
    try { await refreshBank(); me.syncError = null; } catch (e) { me.syncError = e.shortMessage || e.message; }
    if (ctx === me) render();
  };
  render(); tick();
  timer = setInterval(tick, 3000);
}
window.addEventListener("hashchange", route);
route();
