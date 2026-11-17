// Setup page: MetaMask funds one in-browser demo account, which then deploys the contracts,
// creates a demo session and hands out links and QR codes. One MetaMask confirmation in total.
import { parseEther } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import QRCode from "qrcode";
import { makeClients } from "../../lib/net.js";
import { deployContracts, createSession, newSessionKeys, sessionAccounts, fundingPlan, ethText, profilesFor, watchInfo, DEPLOY_STEPS, SESSION_STEPS, PUBLIC_RPC } from "../../lib/deploy.js";
import { store, $, $$, esc, addrLink, txLink, lockup, footer, copy } from "./util.js";
import { loadProfiles, saveProfiles, linkFor, watchLinkFor, validateProfile } from "./profiles.js";

const ADMIN = "privateeth.admin.v1";
export const DEFAULT_RPC = PUBLIC_RPC[11155111];
const SEPOLIA = 11155111;
const onSetup = () => location.hash === "#setup";
const ACK = "privateeth.ack.v1";
const acknowledged = () => store.get(ACK) === "1";

export function loadAdmin() {
  let a = null; try { a = JSON.parse(store.get(ADMIN)); } catch {}
  if (!a || !/^0x[0-9a-fA-F]{64}$/.test(a.adminKey || "")) {
    // Created once and saved at once, so any ETH sent to it can always be recovered here.
    a = { adminKey: generatePrivateKey(), rpcUrl: DEFAULT_RPC, deployment: null, session: null };
    store.set(ADMIN, JSON.stringify(a));
  }
  a.pastSessions ||= [];
  // Stored data is untrusted too (another page on this origin could have written it):
  // drop a deployment or RPC that does not have the expected shape. Keys are never dropped.
  const addr = (x) => typeof x === "string" && /^0x[0-9a-fA-F]{40}$/.test(x);
  const d = a.deployment;
  if (d && !(Number.isSafeInteger(d.startBlock) && Number.isSafeInteger(d.chainId) && ["ShieldedPool", "AttestationRegistry", "MockERC20"].every((k) => addr(d[k])))) a.deployment = null;
  try { const u = new URL(a.rpcUrl); if (!(u.protocol === "https:" || ["127.0.0.1", "localhost"].includes(u.hostname))) throw 0; } catch { a.rpcUrl = DEFAULT_RPC; }
  return a;
}
const saveAdmin = (a) => store.set(ADMIN, JSON.stringify(a));
// Is browser storage really keeping the key? (It may not in some private windows.)
function storageWorks(a) { try { return JSON.parse(localStorage.getItem(ADMIN))?.adminKey === a.adminKey; } catch { return false; } }

let S = null; // page state
let ART = null;
const loadArt = async () => (ART ||= await (await fetch(new URL("./contracts.json", location.href))).json());

function init() {
  const admin = loadAdmin();
  S = { admin, mm: { account: null, chainId: null }, demoBal: null, fees: null, busy: null, error: null, notice: null,
    progress: { deploy: [], session: [] }, fundHash: null, sweepHashes: [], advancedOpen: false, showKey: false, fundEdited: false, revealed: {} };
  connectClients();
  if (window.ethereum?.on && !window.ethereum.__privateethBound) {
    window.ethereum.__privateethBound = true;
    window.ethereum.on("accountsChanged", (acc) => { if (S) { S.mm.account = acc[0] || null; render(); } });
    window.ethereum.on("chainChanged", (id) => { if (S) { S.mm.chainId = Number(id); render(); } });
  }
  // Another tab may have changed the demo account's record.
  window.addEventListener("storage", (e) => { if (S && e.key === ADMIN && !S.busy) { S.admin = loadAdmin(); connectClients(); render(); } });
}
function connectClients() {
  const { pub, wallet } = makeClients(S.admin.rpcUrl, SEPOLIA, S.admin.adminKey);
  S.pub = pub; S.demo = wallet;
}
const demoAddr = () => S.demo.account.address;
const mmOk = () => S.mm.account && S.mm.chainId === SEPOLIA;

async function refreshBalances() {
  try {
    const [bal, fees] = await Promise.all([S.pub.getBalance({ address: demoAddr() }), S.pub.estimateFeesPerGas()]);
    S.demoBal = bal; S.fees = fees; S.rpcError = null;
  } catch (e) { S.rpcError = e.shortMessage || e.message; }
}
// What the demo account still needs: the rest of the deployment (if any) plus one session.
function needs() {
  if (!S.fees) return null;
  const p = fundingPlan(S.fees.maxFeePerGas);
  const deploy = S.admin.deployment ? 0n : p.deployNeed;
  return { ...p, deploy, forDeploy: deploy + p.sessionNeed, forSession: p.sessionNeed };
}
const shortBy = (need) => (S.demoBal === null ? need : need > S.demoBal ? need - S.demoBal : 0n);
const suggested = () => { const nd = needs(); if (!nd) return "0.05"; const want = (nd.forDeploy * 3n) / 2n; const eth = Math.max(0.01, Math.ceil(Number(want) / 1e15) / 1000); return eth.toFixed(3); };

// Only one tab at a time may move the demo account's ETH.
async function exclusive(name, fn) {
  S.admin = loadAdmin(); connectClients();
  const go = async () => { S.busy = name; S.error = null; render(); try { await fn(); } finally { S.busy = null; await refreshBalances(); render(); } };
  if (!navigator.locks) return go();
  await navigator.locks.request("privateeth-setup", { ifAvailable: true }, async (lock) => {
    if (!lock) { S.error = "Another tab is already running setup. Finish there, or close it and reload this page."; return render(); }
    await go();
  });
}

// ---------- MetaMask ----------
async function connect() {
  if (!acknowledged()) return;
  try {
    const acc = await window.ethereum.request({ method: "eth_requestAccounts" });
    S.mm.account = acc[0] || null;
    S.mm.chainId = Number(await window.ethereum.request({ method: "eth_chainId" }));
  } catch (e) { S.error = "MetaMask did not connect: " + (e.message || e); }
  render();
}
async function switchChain() {
  try {
    await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0xaa36a7" }] });
  } catch (e) {
    if (e.code === 4902) {
      try { await window.ethereum.request({ method: "wallet_addEthereumChain", params: [{ chainId: "0xaa36a7", chainName: "Sepolia", nativeCurrency: { name: "Sepolia ETH", symbol: "ETH", decimals: 18 }, rpcUrls: [DEFAULT_RPC], blockExplorerUrls: ["https://sepolia.etherscan.io"] }] }); }
      catch (e2) { S.error = "MetaMask did not add Sepolia: " + (e2.message || e2); }
    } else S.error = "MetaMask did not switch network: " + (e.message || e);
  }
  try { S.mm.chainId = Number(await window.ethereum.request({ method: "eth_chainId" })); } catch {}
  render();
}
const fund = () => exclusive("fund", async () => {
  let value; try { value = parseEther($("#fundamt").value.trim()); } catch { S.error = "Enter an amount of ETH, like 0.05."; return; }
  if (value <= 0n) { S.error = "Enter an amount above zero."; return; }
  if (!acknowledged()) { S.error = "Read and accept the notice at the top of the page first."; return; }
  try {
    // Hard stop: never send unless MetaMask is on Sepolia right now (viem checks again before sending).
    const chainNow = Number(await window.ethereum.request({ method: "eth_chainId" }));
    if (chainNow !== SEPOLIA) throw new Error(`MetaMask is on chain ${chainNow}, not Sepolia (${SEPOLIA}). Nothing was sent.`);
    // The request itself names Sepolia (chainId), so MetaMask rejects it on any other network,
    // even if something switches MetaMask between the check above and the confirmation.
    S.fundHash = await window.ethereum.request({ method: "eth_sendTransaction",
      params: [{ from: S.mm.account, to: demoAddr(), value: "0x" + value.toString(16), chainId: "0xaa36a7" }] });
    render();
    const r = await S.pub.waitForTransactionReceipt({ hash: S.fundHash, timeout: 600_000 });
    if (r.status !== "success") throw new Error("the transfer failed");
    // Done with MetaMask: drop this site's connection so no page on this domain can use it.
    await disconnectMetaMask(true);
  } catch (e) {
    S.error = "Funding did not go through: " + (e.shortMessage || e.message) + (S.fundHash ? " Check the transfer in MetaMask's activity: it must be on Sepolia." : "");
  }
});
// Revokes this site's MetaMask permission (MetaMask supports wallet_revokePermissions).
async function disconnectMetaMask(quiet) {
  try { await window.ethereum.request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] }); } catch {}
  S.mm.account = null;
  if (!quiet) S.notice = "MetaMask is disconnected from this site.";
  else S.notice = "Funded. MetaMask is now disconnected from this site; connect again only to return the ETH at the end.";
}

// Returns ETH from every account this browser created (old and current sessions, then the
// demo account itself) to the connected MetaMask account.
const sweep = () => exclusive("sweep", async () => {
  if (S.admin.session && !confirm("This ends the current demo session: its banks and relayer give their gas back. Continue?")) return;
  const fees = await S.pub.estimateFeesPerGas();
  const keys = [...(S.admin.pastSessions || []), S.admin.session, S.admin.pendingSession].filter(Boolean).flatMap(sessionAccounts);
  S.sweepHashes = [];
  for (const acct of [...keys, { name: "Demo account", ethKey: S.admin.adminKey }]) {
    const { wallet } = makeClients(S.admin.rpcUrl, SEPOLIA, acct.ethKey);
    const from = wallet.account.address;
    const bal = await S.pub.getBalance({ address: from });
    if (bal === 0n) continue;
    // MetaMask accounts can carry code (EIP-7702 smart accounts), so estimate the gas.
    const gas = ((await S.pub.estimateGas({ account: from, to: S.mm.account, value: 1n })) * 12n) / 10n;
    const cost = gas * fees.maxFeePerGas;
    if (bal <= cost) continue;
    const hash = await wallet.sendTransaction({ to: S.mm.account, value: bal - cost, gas, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas });
    S.sweepHashes.push(hash); render();
    const r = await S.pub.waitForTransactionReceipt({ hash, timeout: 600_000 });
    if (r.status !== "success") throw new Error(`returning ETH from ${acct.name} failed`);
  }
  if (S.admin.session) { S.admin.pastSessions.push(S.admin.session); S.admin.session = null; saveAdmin(S.admin); }
  // Every account created here is now empty: forget the old session keys.
  S.admin.pastSessions = []; saveAdmin(S.admin);
  await disconnectMetaMask(true);
  S.notice = (S.sweepHashes.length ? "ETH returned to MetaMask." : "Nothing left to return.") + " MetaMask is now disconnected from this site.";
}).catch((e) => { S.error = "Could not return all the ETH: " + (e.shortMessage || e.message); S.busy = null; render(); });

// ---------- deploy & session ----------
const logInto = (list) => (e) => {
  const i = list.findIndex((x) => x.label === e.label);
  if (i < 0) list.push({ ...e }); else Object.assign(list[i], e);
  render();
};
const deploy = () => exclusive("deploy", async () => {
  await refreshBalances();
  const nd = needs();
  if (nd && shortBy(nd.forDeploy) > 0n) { S.error = `The demo account needs at least ${ethText(shortBy(nd.forDeploy))} ETH more for the deployment and a session.`; return; }
  S.progress.deploy = DEPLOY_STEPS.map((label) => ({ label, state: "waiting" })); render();
  try {
    const dep = await deployContracts({ pub: S.pub, wallet: S.demo, ART: await loadArt(), rpcUrl: S.admin.rpcUrl, log: logInto(S.progress.deploy),
      partial: S.admin.partialDeploy || null, save: (p) => { S.admin.partialDeploy = p; saveAdmin(S.admin); } });
    if (S.admin.session) S.admin.pastSessions.push(S.admin.session);
    S.admin.deployment = dep; S.admin.session = null; S.admin.partialDeploy = null; saveAdmin(S.admin);
  } catch (e) { S.error = "Deployment stopped: " + (e.shortMessage || e.message) + " Press the button again to continue where it stopped; finished steps are not paid for twice."; }
});
const newSession = () => exclusive("session", async () => {
  await refreshBalances();
  const nd = needs();
  if (!nd) { S.error = "Could not read the gas price. Check the connection and try again."; return; }
  if (shortBy(nd.forSession) > 0n) { S.error = `The demo account needs at least ${ethText(shortBy(nd.forSession))} ETH more for a session.`; return; }
  // Keys are saved before any ETH moves; an interrupted session resumes with the same keys.
  if (!S.admin.pendingSession) { S.admin.pendingSession = newSessionKeys(); saveAdmin(S.admin); }
  S.progress.session = SESSION_STEPS({ nameA: "Bank A", nameB: "Bank B", mintA: 1000, mintB: 500 }).map((label) => ({ label, state: "waiting" })); render();
  try {
    const s = await createSession({ pub: S.pub, wallet: S.demo, ART: await loadArt(), dep: S.admin.deployment, keys: S.admin.pendingSession, mintA: 1000n, mintB: 500n,
      fundBank: nd.fundBank, fundRelayer: nd.fundRelayer, rpcUrl: S.admin.rpcUrl, log: logInto(S.progress.session), save: () => saveAdmin(S.admin) });
    if (S.admin.session) S.admin.pastSessions.push(S.admin.session);
    S.admin.session = s; S.admin.pendingSession = null; saveAdmin(S.admin);
    installProfiles(S.admin);
  } catch (e) { S.error = "Creating the session stopped: " + (e.shortMessage || e.message) + " Press the button again to continue with the same banks."; }
});
// Puts this session's roles on this device, so the console and role pages open here directly.
export function installProfiles(admin = loadAdmin()) {
  if (!admin.deployment || !admin.session) return null;
  const ps = profilesFor(admin.deployment, admin.session);
  const consoleProfile = { id: "console", role: "console", banks: [ps["bank-a"], ps["bank-b"]], regulator: ps.regulator };
  const all = loadProfiles();
  for (const p of [...Object.values(ps), consoleProfile]) { all[p.id] = validateProfile(p); store.del("privateeth.state." + p.id); }
  saveProfiles(all);
  store.set("privateeth.watch.v1", JSON.stringify(watchInfo(admin.deployment, admin.session)));
  return { ...ps, console: consoleProfile };
}
function startOver() {
  if (!confirm("Forget the deployed contracts and start over? The demo account and its ETH are kept.")) return;
  S.admin = loadAdmin();
  if (S.admin.session) S.admin.pastSessions.push(S.admin.session);
  S.admin.deployment = null; S.admin.session = null; S.admin.partialDeploy = null; saveAdmin(S.admin); render();
}
function saveRpc() {
  let url; try { url = new URL($("#rpc").value.trim()); } catch { S.error = "That is not a URL."; return render(); }
  S.admin = loadAdmin();
  S.admin.rpcUrl = url.href;
  if (S.admin.session) { S.admin.session.rpcUrl = url.href; installProfiles(S.admin); } // the wallets on this device switch too
  saveAdmin(S.admin); connectClients();
  S.notice = "RPC saved. Wallets opened from new links use it; the audience link always uses the public endpoint.";
  refreshBalances().then(render);
}

// ---------- rendering ----------
const stateIcon = { waiting: "○", sending: "◔", pending: "◑", done: "●" };
function progressHtml(list) {
  if (!list.length) return "";
  return `<ol class="plist">${list.map((x) => `<li class="${x.state}"><span class="pi">${stateIcon[x.state] || "○"}</span><span>${esc(x.label)}</span><span class="pl">${x.state === "pending" ? '<span class="spin"></span>' : ""}${x.hash ? txLink(SEPOLIA, x.hash) : ""}</span></li>`).join("")}</ol>`;
}
function linksHtml() {
  const a = S.admin;
  if (!a.deployment || !a.session) return "";
  const ps = profilesFor(a.deployment, a.session);
  const items = [
    { id: "watch", title: "Audience", text: "What everyone can see on the chain. Safe to share: no keys.", url: watchLinkFor(watchInfo(a.deployment, a.session)), secret: false },
    { id: "bank-a", title: "Bank A", text: "Bank A's wallet, for a second screen.", url: linkFor(ps["bank-a"]), secret: true },
    { id: "bank-b", title: "Bank B", text: "Bank B's wallet, for a second screen.", url: linkFor(ps["bank-b"]), secret: true },
    { id: "regulator", title: "Regulator", text: "Opens payments with the viewing keys.", url: linkFor(ps.regulator), secret: true },
    { id: "console", title: "Console", text: "The whole story on one screen, for another laptop.", url: linkFor({ id: "console", role: "console", banks: [ps["bank-a"], ps["bank-b"]], regulator: ps.regulator }), secret: true },
  ];
  return `<div class="card"><h2>Present</h2>
    <div class="row"><a class="btn" href="#console">Open the console on this screen</a><a class="btn ghost" href="#watch" target="_blank" rel="noopener">Open the audience view</a></div>
    <p class="hint">Or open a role on another device with its QR code or link. Links marked “contains keys” carry this session's testnet keys: share them only with presenters.</p>
    <div class="qrgrid">${items.map((x) => `<div class="qr ${x.secret ? "secret" : "public"}">
      ${!x.secret || S.revealed[x.id] ? `<canvas data-qr="${esc(x.url)}" width="160" height="160" aria-label="QR code for ${esc(x.title)}"></canvas>`
        : `<div class="qrhidden"><button class="small ghost" data-reveal="${esc(x.id)}">Reveal</button><span class="hint">Contains keys. Keep it off shared or projected screens.</span></div>`}
      <div><h3>${esc(x.title)}</h3><p class="hint">${esc(x.text)}</p><span class="tag ${x.secret ? "warn" : "ok"}">${x.secret ? "contains keys" : "public"}</span>
      <div class="row"><button class="small ghost" data-copy="${esc(x.url)}">Copy link</button><a class="small" href="${esc(x.url)}" target="_blank" rel="noopener">Open ↗</a></div></div>
    </div>`).join("")}</div></div>`;
}
function render() {
  if (!S || !onSetup()) return; // never draw over another page
  const a = S.admin, nd = needs(), dep = a.deployment;
  const hasMM = !!window.ethereum, busy = !!S.busy;
  const canDeploy = nd && shortBy(nd.forDeploy) === 0n, canSession = nd && shortBy(nd.forSession) === 0n;
  const stepClass = (done, active) => (done ? "step done" : active ? "step active" : "step");
  const fundEl = $("#fundamt");
  const fundValue = fundEl && S.fundEdited ? fundEl.value : suggested();
  const missing = nd ? shortBy(dep ? nd.forSession : nd.forDeploy) : null;
  const html = `<div class="top">${lockup()}<div class="net"><span class="chip">SETUP · SEPOLIA</span></div></div>
    <div class="hero"><h1>Set up a live demo</h1></div>
    <p class="lead">Everything happens in this browser. MetaMask sends test ETH once to a demo account kept in this browser; that account deploys the contracts and prepares two banks and a regulator.</p>
    ${!storageWorks(a) ? `<div class="err">This browser is not keeping data for this site (a private window, or blocked storage). Anything sent to the demo account would be lost when the page closes. Use a normal window.</div>` : ""}
    ${S.error ? `<div class="err">${esc(S.error)}</div>` : ""}${S.notice ? `<div class="ok-note">${esc(S.notice)}</div>` : ""}${S.rpcError ? `<div class="err">Sepolia connection problem: ${esc(S.rpcError)}</div>` : ""}
    <div class="notice ${acknowledged() ? "accepted" : ""}"><h2>Before you connect a wallet</h2>
      <ul>
        <li><b>Sepolia testnet only.</b> The ETH and tUSD used here have no value. This is a research prototype and has not been audited.</li>
        <li><b>Use a separate MetaMask account that holds only Sepolia test ETH</b>, ideally in a separate browser profile. Never use an account that holds real assets.</li>
        <li><b>This page asks MetaMask for one thing only:</b> a plain ETH transfer on Sepolia, of the amount you type, to the demo account shown in step 2. It never asks for signatures, token approvals or anything on Ethereum mainnet. <b>If MetaMask shows anything else, reject it.</b></li>
        <li><b>Check the address bar:</b> <span class="mono">https://hub.entethalliance.org/privateeth/</span>. A copy of this page elsewhere is not ours.</li>
        <li><b>Keys made here stay in this browser</b> and in the role links and QR codes. Anyone with them can use this demo's test funds, nothing else. Share role links only with presenters, and clear this site's data after the demo.</li>
      </ul>
      <label class="ack"><input type="checkbox" id="ack" ${acknowledged() ? "checked" : ""}> I understand: testnet only, a separate account with no real funds.</label>
    </div>
    <div class="${stepClass(mmOk(), acknowledged())}"><span class="sn">1</span><div class="sb"><h2>Connect MetaMask</h2>
      ${!hasMM ? `<p class="hint">MetaMask is not installed in this browser. Install it from <a href="https://metamask.io" target="_blank" rel="noopener">metamask.io</a>, add some Sepolia test ETH from a faucet, then reload this page.</p>`
        : !acknowledged() ? `<p class="hint">Accept the notice above to continue.</p><button id="connect" disabled>Connect MetaMask</button>`
        : !S.mm.account ? `<button id="connect">Connect MetaMask</button>`
        : `<p>Connected: ${addrLink(SEPOLIA, S.mm.account)}${S.mm.chainId === SEPOLIA ? " · Sepolia" : ""} <button class="small ghost" id="disconnect">Disconnect</button></p>${S.mm.chainId !== SEPOLIA ? `<button id="switch">Switch MetaMask to Sepolia</button>` : ""}`}
    </div></div>
    <div class="${stepClass(missing === 0n, mmOk())}"><span class="sn">2</span><div class="sb"><h2>Fund the demo account</h2>
      <p>Demo account ${addrLink(SEPOLIA, demoAddr())} · balance <b>${S.demoBal === null ? "…" : ethText(S.demoBal)} ETH</b></p>
      <p class="hint">${!nd ? "Checking the gas price…" : missing === 0n ? `Enough for ${dep ? "a session" : "the deployment and a session"} at today's gas price.`
        : `Needs at least <b>${ethText(missing)} ETH</b> more for ${dep ? "a session" : "the deployment and a session"} at today's gas price. The suggested amount adds a margin; whatever is left can be sent back to MetaMask.`}</p>
      <div class="row"><input id="fundamt" type="text" inputmode="decimal" aria-label="ETH to send" value="${esc(fundValue)}"> <span>ETH</span>
        <button id="fund" ${!mmOk() || busy || !storageWorks(a) ? "disabled" : ""}>${S.busy === "fund" ? "Waiting for MetaMask…" : "Send from MetaMask"}</button>
        ${S.fundHash ? txLink(SEPOLIA, S.fundHash, "funding transaction") : ""}</div>
    </div></div>
    <div class="${stepClass(!!dep, canDeploy)}"><span class="sn">3</span><div class="sb"><h2>Deploy the contracts</h2>
      ${dep ? `<p>Deployed: shielded pool ${addrLink(SEPOLIA, dep.ShieldedPool)} · token ${addrLink(SEPOLIA, dep.MockERC20)} · block ${esc(dep.startBlock)}</p>
          <p class="hint">Deploy once; every new demo session reuses these contracts. <button class="small ghost" id="startover" ${busy ? "disabled" : ""}>Start over with new contracts</button></p>`
        : `<p class="hint">13 contracts, including the three zero-knowledge proof verifiers from the EthSystems shielded pool. About 15 transactions; allow 4 to 6 minutes. Keep this tab open.</p>
          <button id="deploy" ${!canDeploy || busy ? "disabled" : ""}>${S.busy === "deploy" ? "Deploying…" : a.partialDeploy ? "Continue the deployment" : "Deploy the contracts"}</button>`}
      ${progressHtml(S.progress.deploy)}
    </div></div>
    <div class="${stepClass(!!a.session, !!dep && canSession)}"><span class="sn">4</span><div class="sb"><h2>Create the demo session</h2>
      <p class="hint">Two new banks, approved by the compliance attester, with 1,000 and 500 test dollars (tUSD) and a little ETH for gas, plus a relayer account for private transactions. About 2 minutes.</p>
      ${a.session ? `<p>Session ready: Bank A ${addrLink(SEPOLIA, a.session.directory["Bank A"].address)} · Bank B ${addrLink(SEPOLIA, a.session.directory["Bank B"].address)}</p>` : ""}
      <button id="session" ${!dep || busy || !canSession ? "disabled" : ""} class="${a.session ? "ghost" : ""}">${S.busy === "session" ? "Creating…" : a.pendingSession ? "Continue creating the session" : a.session ? "Create a fresh session" : "Create the demo session"}</button>
      ${progressHtml(S.progress.session)}
    </div></div>
    ${linksHtml()}
    <div class="card"><h2>When you are done</h2>
      <div class="row"><button class="ghost" id="sweep" ${!mmOk() || busy ? "disabled" : ""}>${S.busy === "sweep" ? "Returning…" : "Send all remaining ETH back to MetaMask"}</button>${S.sweepHashes.map((h) => txLink(SEPOLIA, h, "return")).join(" ")}</div>
      <p class="hint">Collects what is left in the banks, the relayer and the demo account. This ends the current session.</p>
      <details id="adv" ${S.advancedOpen ? "open" : ""}><summary class="hint">Advanced</summary>
        <div class="row"><input id="rpc" class="hash" value="${esc(a.rpcUrl)}" aria-label="Sepolia RPC URL"><button class="small ghost" id="saverpc" ${busy ? "disabled" : ""}>Save RPC</button></div>
        <p class="hint">The public endpoint works; a private one (Infura, Alchemy) is steadier. It is used by this page only: role links and the audience link always carry the public endpoint, so a private URL with an API key is never shared.</p>
        <div class="row"><button class="small ghost" id="showkey">${S.showKey ? "Hide" : "Show"} the demo account key (backup)</button></div>
        ${S.showKey ? `<p class="mono keybox">${esc(a.adminKey)}</p><p class="hint">Sepolia demo key. Keep it only as a backup in case this browser's data is lost. Never import it into a wallet you use for real assets, and never send real funds to this address. The safe way to get the ETH back is the button above.</p>` : ""}
      </details>
    </div>` + footer();
  const focus = document.activeElement?.id;
  $("#app").innerHTML = html;
  if (focus && document.getElementById(focus)) document.getElementById(focus).focus({ preventScroll: true });
  const on = (id, f) => { const el = document.getElementById(id); if (el) el.onclick = f; };
  on("connect", connect); on("switch", switchChain); on("fund", fund); on("deploy", deploy); on("session", newSession); on("sweep", sweep); on("startover", startOver); on("saverpc", saveRpc);
  on("showkey", () => { if (!S.showKey && !confirm("Show the demo account's private key? Make sure no one else can see this screen.")) return; S.showKey = !S.showKey; render(); });
  on("disconnect", () => disconnectMetaMask(false).then(render));
  $$("[data-reveal]").forEach((b) => (b.onclick = () => { if (confirm("Show this QR code? It contains testnet keys: keep it off shared screens.")) { S.revealed[b.dataset.reveal] = true; render(); } }));
  $("#ack").onchange = (e) => { if (e.target.checked) store.set(ACK, "1"); else store.del(ACK); render(); };
  $("#fundamt").oninput = () => { S.fundEdited = true; };
  $("#adv").ontoggle = (e) => { S.advancedOpen = e.target.open; };
  $$("[data-copy]").forEach((b) => (b.onclick = () => copy(b.dataset.copy, b)));
  for (const c of $$("canvas[data-qr]")) QRCode.toCanvas(c, c.dataset.qr, { errorCorrectionLevel: "L", margin: 1, width: 160, color: { dark: "#16181A", light: "#F7F5F0" } })
    .catch(() => { const p = document.createElement("p"); p.className = "hint qrnone"; p.textContent = "Too much data for a QR code: use Copy link, or open the console on this screen."; c.replaceWith(p); });
}

let timer = null;
export async function showSetup() {
  if (!S) init();
  document.title = "Setup · PrivateEth";
  render();
  if (window.ethereum) {
    try {
      const acc = await window.ethereum.request({ method: "eth_accounts" });
      S.mm.account = acc[0] || null;
      S.mm.chainId = Number(await window.ethereum.request({ method: "eth_chainId" }));
    } catch {}
  }
  await refreshBalances(); render();
  clearInterval(timer);
  timer = setInterval(async () => { if (!onSetup()) return clearInterval(timer); if (!S.busy) { await refreshBalances(); if (!document.activeElement?.matches?.("input")) render(); } }, 8000);
}
