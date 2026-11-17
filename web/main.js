// Browser wallet: everything runs in this tab. Keys arrive once through a private setup link
// (in the URL fragment, which is never sent to any server) and are kept in this browser.
import { decodeEventLog, hexToBytes, bytesToHex } from "viem";
import ABI from "../artifacts/abis.json" with { type: "json" };
import { makeBank, deposit, sendPrivate, withdraw, replay, publicBalance } from "../lib/actions.js";
import { openNote, unpackEnvelopes, commitmentOf } from "../lib/core.js";
import { makeClients, explorerFor } from "../lib/net.js";

const REPO = "https://github.com/EntEthAlliance/privateeth";
const STORE = "privateeth.profiles.v1";
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const short = (h) => (h ? String(h).slice(0, 8) + "…" + String(h).slice(-6) : "");
const n = (v) => Number(v).toLocaleString("en-US");
const json = (v) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? { $big: x.toString() } : x));
const unjson = (s) => JSON.parse(s, (_, x) => (x && typeof x === "object" && "$big" in x ? BigInt(x.$big) : x));
const isAddr = (a) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
const isHash = (h) => typeof h === "string" && /^0x[0-9a-fA-F]{64}$/.test(h);

// ---------- profiles (per browser) ----------
const memory = {};
function loadProfiles() { try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch { return memory; } }
function saveProfiles(p) { try { localStorage.setItem(STORE, JSON.stringify(p)); } catch { Object.assign(memory, p); } }
function decodeSetup(s) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "===".slice((b64.length + 3) % 4));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
}
// A setup link is untrusted input: accept only the exact shape the setup script produces.
function validateProfile(p) {
  const need = (ok, what) => { if (!ok) throw new Error(`invalid ${what}`); };
  const key32 = (k) => typeof k === "string" && /^0x[0-9a-fA-F]{64}$/.test(k);
  const name = (x) => typeof x === "string" && /^[\w .-]{1,32}$/.test(x);
  need(typeof p.id === "string" && /^[a-z0-9-]{1,32}$/.test(p.id), "id");
  need(p.role === "bank" || p.role === "regulator", "role");
  need(name(p.name), "name");
  const d = p.dep || {};
  need(Number.isSafeInteger(d.chainId) && d.chainId > 0, "chain id");
  need(Number.isSafeInteger(d.startBlock) && d.startBlock >= 0, "start block");
  for (const k of ["ShieldedPool", "AttestationRegistry", "MockERC20", "relayer"]) need(isAddr(d[k]), k);
  let url; try { url = new URL(d.rpcUrl); } catch { need(false, "RPC URL"); }
  need(url.protocol === "https:" || url.protocol === "http:", "RPC URL");
  need(d.directory && typeof d.directory === "object", "directory");
  for (const [k, v] of Object.entries(d.directory)) {
    need(name(k) && isAddr(v.address) && key32(v.ownerPubkey) && /^0x0[23][0-9a-fA-F]{64}$/.test(v.viewingPub), "directory entry");
  }
  if (p.role === "bank") {
    need(p.keys && key32(p.keys.ethKey) && key32(p.keys.spendingKey) && key32(p.keys.viewingPriv) && key32(p.relayerKey), "bank keys");
    need(p.keys.name === p.name && p.name in d.directory, "bank name");
  } else {
    need(Array.isArray(p.viewingKeys) && p.viewingKeys.length > 0 && p.viewingKeys.every((k) => name(k.name) && key32(k.viewingPriv)), "viewing keys");
  }
  // Keep only known fields, and never trust an explorer URL from a link.
  const dep = { chainId: d.chainId, rpcUrl: url.href, startBlock: d.startBlock, ShieldedPool: d.ShieldedPool, AttestationRegistry: d.AttestationRegistry,
    MockERC20: d.MockERC20, relayer: d.relayer, directory: d.directory };
  return p.role === "bank"
    ? { id: p.id, role: "bank", name: p.name, keys: { name: p.name, ethKey: p.keys.ethKey, spendingKey: p.keys.spendingKey, viewingPriv: p.keys.viewingPriv }, relayerKey: p.relayerKey, dep }
    : { id: p.id, role: "regulator", name: p.name, viewingKeys: p.viewingKeys.map((k) => ({ name: k.name, viewingPriv: k.viewingPriv })), dep };
}
let setupError = null;
function takeSetupFromHash() {
  const m = location.hash.match(/^#setup=([A-Za-z0-9_-]+)$/);
  if (!m) return;
  try {
    const prof = validateProfile(decodeSetup(m[1]));
    const all = loadProfiles();
    all[prof.id] = prof;
    saveProfiles(all);
    try { localStorage.removeItem("privateeth.state." + prof.id); } catch {}
    roles.delete(prof.id);
    history.replaceState(null, "", "#" + prof.id);
  } catch (e) {
    history.replaceState(null, "", "#");
    setupError = "That setup link could not be used: " + e.message + ".";
  }
}

// ---------- per-role state, kept for the life of the tab ----------
// One entry per role id: switching roles never restarts a prover or crosses a running job's state.
const roles = new Map();
let current = null; // the role this tab shows
const loadCircuits = async () => Object.fromEntries(await Promise.all(["deposit", "transfer", "withdraw"].map(async (c) =>
  [c, await (await fetch(new URL(`./circuits/${c}.json`, location.href))).json()])));

function roleFor(id, prof) {
  if (roles.has(id)) return roles.get(id);
  const { pub } = makeClients(prof.dep.rpcUrl, prof.dep.chainId);
  const me = { id, role: prof.role, name: prof.name, dep: prof.dep, pub, explorer: explorerFor(prof.dep.chainId), inspect: { result: null, error: null, busy: false } };
  if (prof.role === "regulator") { me.viewingKeys = prof.viewingKeys; roles.set(id, me); return me; }
  me.bank = makeBank({ dep: prof.dep, keys: prof.keys, relayerKey: prof.relayerKey, loadCircuits });
  me.viewingKeys = [{ name: prof.name, viewingPriv: prof.keys.viewingPriv }];
  let saved = null; try { saved = unjson(localStorage.getItem("privateeth.state." + id) || "null"); } catch {}
  Object.assign(me, { activity: saved?.activity || [], fresh: saved?.fresh || [], lastWithdrawArgs: saved?.lastWithdrawArgs || null,
    publicBal: 0n, known: new Set(), firstSync: true, synced: false, job: null, proverReady: false, proverError: null });
  const loadProver = () => me.bank.prover().then(() => { me.proverReady = true; me.proverError = null; paint(me); },
    (e) => { me.proverError = e.message; console.error(e); paint(me); });
  me.loadProver = loadProver;
  loadProver();
  roles.set(id, me);
  return me;
}
const paint = (me) => { if (current === me) render(); };

const explorerOf = (me) => me?.explorer;
const txLink = (me, h) => (!isHash(h) ? "" : explorerOf(me) ? `<a href="${explorerOf(me)}/tx/${h}" target="_blank" rel="noopener">${short(h)} ↗</a>` : `<span class="mono">${short(h)}</span>`);
const addrLink = (me, a) => (!isAddr(a) ? esc(a) : explorerOf(me) ? `<a href="${explorerOf(me)}/address/${a}" target="_blank" rel="noopener">${short(a)} ↗</a>` : `<span class="mono">${short(a)}</span>`);

function header(me) {
  const d = me?.dep;
  const threads = globalThis.crossOriginIsolated ? `${Number(navigator.hardwareConcurrency) || "several"} threads` : "1 thread";
  const state = me?.proverReady ? "READY" : me?.proverError ? "ERROR" : "LOADING";
  const engine = me?.role === "bank" ? `<span class="chip ${me.proverReady ? "ok" : me.proverError ? "warn" : ""}" title="Proofs are generated in this browser">PROOF ENGINE · ${state} · ${threads}</span>` : "";
  const net = d ? `<span class="chip">${d.chainId === 11155111 ? "SEPOLIA" : "CHAIN " + Number(d.chainId)}</span>` : "";
  const pool = d && me.explorer ? `<a class="chip" href="${me.explorer}/address/${d.ShieldedPool}" target="_blank" rel="noopener">POOL ON ETHERSCAN ↗</a>` : "";
  return `<div class="top">
    <a class="lockup" href="#"><div><b>EEA</b>ETHEREUM INTELLIGENCE</div><div class="stripe"><i></i><i></i><i></i></div></a>
    <div class="net">${engine}${net}${pool}</div>
  </div>`;
}

// ---------- inspect: what the explorer shows vs what a key opens ----------
async function inspect(me, hash) {
  const { pub, dep } = me;
  const [tx, rcpt] = await Promise.all([pub.getTransaction({ hash }), pub.getTransactionReceipt({ hash })]);
  const from = isAddr(tx.from) ? tx.from : "unknown";
  const fromLabel = from.toLowerCase() === dep.relayer.toLowerCase() ? "relayer"
    : Object.entries(dep.directory).find(([, x]) => x.address.toLowerCase() === from.toLowerCase())?.[0] || null;
  const out = { hash, from, fromLabel, status: rcpt.status, events: [] };
  for (const log of rcpt.logs) {
    if (log.address.toLowerCase() !== dep.ShieldedPool.toLowerCase()) continue;
    let ev; try { ev = decodeEventLog({ abi: ABI.ShieldedPool, data: log.data, topics: log.topics }); } catch { continue; }
    const a = ev.args, payload = a.encryptedNote || a.encryptedNotes;
    // A note only counts if it re-hashes to a commitment this event actually put on-chain.
    const onchain = [a.commitment, a.commitment1, a.commitment2].filter(Boolean).map((c) => BigInt(c));
    const fields = Object.entries(a).filter(([k]) => !/encrypted/i.test(k)).map(([k, v]) => [k, String(v)]);
    const envelopes = payload ? unpackEnvelopes(hexToBytes(payload)).map((env) => {
      let opened = null;
      for (const k of me.viewingKeys) {
        const note = openNote(env, k.viewingPriv);
        if (note) { opened = { by: k.name, amount: note.amount, memo: note.memo, matches: onchain.includes(commitmentOf(note)) }; break; }
      }
      return { bytes: bytesToHex(env).slice(0, 26) + "…", size: env.length, opened };
    }) : [];
    out.events.push({ name: ev.eventName, fields, envelopes });
  }
  return out;
}
function inspectCard(me) {
  const { result: r, error, busy } = me.inspect, reg = me.role === "regulator";
  let body = `<p class="hint">Paste a transaction hash from Etherscan. Left: what everyone can read. Right: what ${reg ? "the viewing keys" : "this bank's key"} can open.</p>`;
  if (error) body += `<div class="err">${esc(error)}</div>`;
  if (r) {
    const evs = r.events.length ? r.events : [{ name: "(no pool event)", fields: [], envelopes: [] }];
    const left = evs.map((e) => `<div class="kv"><span>from</span><span>${addrLink(me, r.from)}${r.fromLabel ? " · " + esc(r.fromLabel) : ""}</span><span>status</span><span>${esc(r.status)}</span><span>event</span><span>${esc(e.name)}</span>
      ${e.fields.map(([k, v]) => `<span>${esc(k)}</span><span>${esc(v.length > 30 ? short(v) : v)}</span>`).join("")}
      ${e.envelopes.map((x, i) => `<span>encrypted ${i + 1}</span><span class="sealed">${esc(x.bytes)} (${x.size} bytes)</span>`).join("")}</div>`).join("");
    const all = evs.flatMap((e) => e.envelopes);
    const right = all.length ? all.map((x, i) => !x.opened
      ? `<div class="closed">Note ${i + 1}: cannot be opened with ${reg ? "these keys" : "this key"}</div>`
      : x.opened.matches
        ? `<div class="open">Note ${i + 1}: ${n(x.opened.amount)} tUSD${x.opened.memo ? " · " + esc(x.opened.memo) : ""}<div class="tag" style="color:var(--blue)">opened with ${esc(x.opened.by)}'s key · matches the on-chain commitment</div></div>`
        : `<div class="err">Note ${i + 1} decrypts, but does not match the on-chain commitment: ignore it</div>`).join("")
      : `<div class="closed">No encrypted notes in this transaction.</div>`;
    body += `<div class="inspect"><div><div class="lbl" style="color:var(--orange)">What Etherscan shows</div>${left}</div><div style="display:grid;gap:10px;align-content:start"><div class="lbl" style="color:var(--blue)">What the key opens</div>${right}</div></div>`;
  }
  const value = r?.hash || me.inspect.draft || "";
  return `<div class="card" id="inspectcard"><h2>Open a transaction with ${reg ? "the viewing keys" : "my key"}</h2>
    <div class="row"><input class="hash" id="ihash" placeholder="0x… transaction hash" value="${esc(value)}" aria-label="Transaction hash"><button id="ibtn" ${busy ? "disabled" : ""}>${busy ? "Opening…" : "Open"}</button></div>${body}</div>`;
}
async function doInspect(me, hash) {
  const h = (hash ?? $("#ihash")?.value ?? "").trim();
  me.inspect.draft = h;
  if (!isHash(h)) { me.inspect = { result: null, error: "That is not a transaction hash (0x followed by 64 hex characters).", busy: false, draft: h }; paint(me); return; }
  me.inspect.busy = true; me.inspect.error = null; paint(me); scrollToInspect();
  try { me.inspect.result = await inspect(me, h); } catch (e) { me.inspect.error = e.shortMessage || e.message; me.inspect.result = null; }
  me.inspect.busy = false; paint(me); scrollToInspect();
}
const scrollToInspect = () => $("#inspectcard")?.scrollIntoView({ behavior: "smooth", block: "start" });

// ---------- bank role ----------
function saveBankState(me) { try { localStorage.setItem("privateeth.state." + me.id, json({ activity: me.activity, fresh: me.fresh, lastWithdrawArgs: me.lastWithdrawArgs })); } catch {} }
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
    const logged = me.activity.some((a) => a.hash === note.txHash);
    if (incoming && !logged) addActivity(me, { type: "receive", text: `Received ${note.amount} tUSD privately (${note.memo})`, hash: note.txHash, flash: !me.firstSync });
  }
  me.firstSync = false;
  me.synced = true;
}

function run(me, label, type, fn) {
  if (me.job && !me.job.done) return;
  const job = (me.job = { label, stages: [], done: false, error: null, hash: null });
  const stage = (s, hash) => { job.stages.push(s); if (isHash(hash)) job.hash = hash; paint(me); };
  (async () => {
    let r;
    try {
      r = await fn(stage);
    } catch (e) {
      job.error = e.shortMessage || e.message;
      console.error(e);
    }
    if (r) {
      job.hash = r.hash;
      stage(r.status === "reverted" ? `Rejected by the contract in block ${r.block}` : `Confirmed in block ${r.block}`);
      addActivity(me, { type, text: r.text, hash: r.hash });
      // Refreshing is best effort: the transaction is confirmed whatever happens here.
      try { await refreshBank(me); } catch (e) { console.warn(e); }
    }
    job.done = true; paint(me);
  })();
  paint(me);
}

function jobView(me) {
  const j = me.job, busy = j && !j.done;
  if (!j) return `<div class="empty">No action yet.</div>`;
  return `<div class="job ${j.error ? "err" : ""}"><div class="lbl">${esc(j.label)}</div>
    ${j.stages.map((s, i) => `<div class="stage">${busy && i === j.stages.length - 1 ? '<span class="spin"></span>' : ""}${esc(s)}</div>`).join("")}
    ${busy && !j.stages.length ? '<div class="stage"><span class="spin"></span>Starting</div>' : ""}
    ${j.hash ? `<div class="stage">Transaction ${txLink(me, j.hash)}</div>` : ""}${j.error ? `<div class="stage err">Failed: ${esc(j.error)}</div>` : ""}</div>`;
}

function bankView(me) {
  const b = me.bank, j = me.job, busy = !!(j && !j.done);
  const notes = b.scan.notes.filter((x) => BigInt(x.amount) > 0n);
  const unspent = notes.filter((x) => !x.spent);
  const priv = unspent.reduce((s, x) => s + BigInt(x.amount), 0n);
  const others = Object.keys(me.dep.directory).filter((x) => x !== me.name);
  const ready = me.synced, canProve = ready && me.proverReady;
  // Inputs follow their suggested value until the presenter types something else.
  const keep = (id, d) => { const el = document.getElementById(id); return el && el.value !== el.dataset.auto ? el.value : String(d); };
  const depDefault = me.publicBal > 0n ? String(me.publicBal) : "0";
  const why = !ready ? "Connecting to the chain…" : !me.proverReady ? (me.proverError ? "The proof engine failed to load." : "Waiting for the proof engine…") : "";
  me.view = { priv, publicBal: me.publicBal, ready };
  return header(me) + `
    <div class="hero"><h1>${esc(me.name)}</h1><span class="addr">${addrLink(me, b.address)}</span>
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
          ${me.fresh.map((f) => `<div class="hint">New address ${addrLink(me, f.address)} holds <b>${n(f.balance)} tUSD</b></div>`).join("")}
          ${me.lastWithdrawArgs ? `<div class="row"><button class="ghost" id="rbtn" ${busy ? "disabled" : ""}>Replay last withdrawal (should fail)</button></div>` : ""}</div>
        ${why ? `<p class="hint">${esc(why)}</p>` : ""}
      </div>
      <div class="col">
        <div class="card"><h2>Progress</h2><div id="jobbox">${jobView(me)}</div></div>
        <div class="card"><h2>Activity</h2><div>${me.activity.length ? me.activity.map((a) => `<div class="item"><span class="tag ${esc(a.type)}">${esc(a.type)}</span><span>${esc(a.text)}</span><span>${isHash(a.hash) ? txLink(me, a.hash) + ` <button class="small ghost" data-i="${a.hash}">Open</button>` : ""}</span></div>`).join("") : '<div class="empty">Nothing yet.</div>'}</div></div>
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
  document.querySelectorAll("[data-w]").forEach((el) => (el.onclick = () => run(me, "Withdraw to a new address", "withdraw", async (s) => {
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
  document.querySelectorAll("[data-i]").forEach((el) => (el.onclick = () => doInspect(me, el.dataset.i)));
}
function alertJob(me, msg) { if (me.job && !me.job.done) return; me.job = { label: "Check the amount", stages: [], error: msg, done: true }; paint(me); }

let lastToast = 0, prevPriv = null, prevPub = null, prevRole = null;
function afterBankRender(me) {
  if (prevRole === me.id && me.view.ready) {
    if (prevPriv !== null && prevPriv !== String(me.view.priv)) $("#privnum")?.classList.add("flash");
    if (prevPub !== null && prevPub !== String(me.view.publicBal)) $("#pubnum")?.classList.add("flash");
  }
  if (me.view.ready) { prevPriv = String(me.view.priv); prevPub = String(me.view.publicBal); prevRole = me.id; }
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
  document.querySelectorAll("#rbtn,[data-w]").forEach((el) => (el.disabled = busy || (el.id !== "rbtn" && !canProve)));
  afterBankRender(me);
}

// ---------- regulator role ----------
function regulatorView(me) {
  return header(me) + `<div class="hero"><h1>Regulator</h1><span class="addr">Holds viewing keys for ${me.viewingKeys.map((k) => esc(k.name)).join(" and ")} · cannot move funds</span></div>` + inspectCard(me) + footer();
}

// ---------- landing ----------
function footer() {
  return `<p class="hint">Research prototype on Sepolia testnet, built on the shielded pool from <a href="https://github.com/ethsystems/pocs" target="_blank" rel="noopener">ethsystems/pocs</a>. Not audited. Source: <a href="${REPO}" target="_blank" rel="noopener">EntEthAlliance/privateeth</a>.</p>`;
}
function landingView() {
  const all = loadProfiles();
  const ids = Object.keys(all).sort();
  return header(null) + `
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
        <div class="row"><button class="ghost small" id="forget">Forget the keys on this device</button></div>
        <p class="hint">This clears the stored keys. The setup links themselves stay in the browser history; clear it too after the demo, or use a private window per role.</p>` : `<p class="hint">This page turns into a bank wallet or a regulator view when you open it with a private setup link. Create the links with the setup script in the repository:</p>
        <pre class="cmd">npm install
npm run setup</pre><p class="hint">It deploys the contracts to Sepolia and prints one link each for Bank A, Bank B and the regulator. The links carry testnet keys, so share them only with the people presenting.</p>`}
    </div>` + footer();
}

// ---------- rendering, routing & polling ----------
let lastHtml = "";
function render() {
  const me = current;
  // Never rebuild the page while an action field is being edited.
  if (me?.role === "bank" && $("#app").dataset.role === me.id && document.activeElement?.matches?.("#damt,#samt,#sto")) return liveBank(me);
  const html = !me ? landingView() : me.role === "regulator" ? regulatorView(me) : bankView(me);
  if (html !== lastHtml) {
    // Keep focus and cursor (e.g. in the hash box) across the rebuild.
    const a = document.activeElement, id = a?.id, sel = a && "selectionStart" in a ? [a.selectionStart, a.selectionEnd] : null;
    $("#app").innerHTML = html;
    $("#app").dataset.role = me?.id || "";
    lastHtml = html;
    const el = id && document.getElementById(id);
    if (el) { el.focus({ preventScroll: true }); if (sel && sel[0] != null) try { el.setSelectionRange(sel[0], sel[1]); } catch {} }
    if (!me) { if ($("#forget")) $("#forget").onclick = forget; }
    else {
      $("#ibtn").onclick = () => doInspect(me);
      $("#ihash").onkeydown = (e) => { if (e.key === "Enter") doInspect(me); };
      $("#ihash").oninput = (e) => { me.inspect.draft = e.target.value; };
      if (me.role === "bank") bindBank(me);
    }
  }
  if (me?.role === "bank") afterBankRender(me);
}
function forget() {
  try { for (const k of Object.keys(localStorage)) if (k.startsWith("privateeth.")) localStorage.removeItem(k); } catch {}
  for (const k of Object.keys(memory)) delete memory[k];
  roles.clear();
  location.hash = "";
  route();
}
let pollTimer = null;
function route() {
  takeSetupFromHash();
  const id = location.hash.slice(1);
  const prof = loadProfiles()[id];
  let profOk = null;
  if (prof) { try { profOk = validateProfile(prof); } catch { profOk = null; } }
  current = profOk ? roleFor(id, profOk) : null;
  document.title = current ? `${current.name} · PrivateEth` : "PrivateEth · Private Payments Demo";
  lastHtml = "";
  render();
  if (current?.role === "bank") poll(current);
}
// One poll loop per bank role; the next tick starts only after the previous one finished.
function poll(me) {
  if (me.polling) return;
  me.polling = true;
  const tick = async () => {
    try { await refreshBank(me); me.syncError = null; } catch (e) { me.syncError = e.shortMessage || e.message; }
    paint(me);
    setTimeout(tick, 3000);
  };
  tick();
}
window.addEventListener("hashchange", route);
route();
