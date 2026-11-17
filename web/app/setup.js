// Setup page: MetaMask funds one in-browser demo account, which then deploys the contracts,
// creates a demo session and hands out links and QR codes. One MetaMask confirmation in total.
import { createWalletClient, custom, formatEther, parseEther } from "viem";
import { sepolia } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import QRCode from "qrcode";
import { makeClients } from "../../lib/net.js";
import { deployContracts, createSession, suggestFunding, profilesFor, watchInfo, DEPLOY_STEPS, SESSION_STEPS } from "../../lib/deploy.js";
import { store, $, $$, esc, short, addrLink, txLink, lockup, footer, copy } from "./util.js";
import { loadProfiles, saveProfiles, linkFor, watchLinkFor, validateProfile } from "./profiles.js";

const ADMIN = "privateeth.admin.v1";
export const DEFAULT_RPC = "https://ethereum-sepolia-rpc.publicnode.com";
const SEPOLIA = 11155111;

export function loadAdmin() {
  let a = null; try { a = JSON.parse(store.get(ADMIN)); } catch {}
  if (!a || !/^0x[0-9a-fA-F]{64}$/.test(a.adminKey || "")) {
    // Created once and saved at once, so any ETH sent to it can always be recovered here.
    a = { adminKey: generatePrivateKey(), rpcUrl: DEFAULT_RPC, deployment: null, session: null };
    store.set(ADMIN, JSON.stringify(a));
  }
  return a;
}
const saveAdmin = (a) => store.set(ADMIN, JSON.stringify(a));

let S = null; // page state
let ART = null;
const loadArt = async () => (ART ||= await (await fetch(new URL("./contracts.json", location.href))).json());

function init() {
  const admin = loadAdmin();
  S = { admin, mm: { account: null, chainId: null }, demoBal: null, fees: null, busy: null, error: null, progress: { deploy: [], session: [] }, fundHash: null, sweepHash: null };
  connectClients();
  if (window.ethereum?.on && !window.ethereum.__privateethBound) {
    window.ethereum.__privateethBound = true;
    window.ethereum.on("accountsChanged", (acc) => { if (S) { S.mm.account = acc[0] || null; render(); } });
    window.ethereum.on("chainChanged", (id) => { if (S) { S.mm.chainId = Number(id); render(); } });
  }
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
const plan = () => (S.fees ? suggestFunding(S.fees.maxFeePerGas, { deploy: !S.admin.deployment }) : null);

// ---------- MetaMask ----------
async function connect() {
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
      await window.ethereum.request({ method: "wallet_addEthereumChain", params: [{ chainId: "0xaa36a7", chainName: "Sepolia", nativeCurrency: { name: "Sepolia ETH", symbol: "ETH", decimals: 18 }, rpcUrls: [DEFAULT_RPC], blockExplorerUrls: ["https://sepolia.etherscan.io"] }] });
    } else S.error = "MetaMask did not switch network: " + (e.message || e);
  }
  S.mm.chainId = Number(await window.ethereum.request({ method: "eth_chainId" }));
  render();
}
async function fund() {
  const v = $("#fundamt").value.trim();
  let value; try { value = parseEther(v); } catch { S.error = "Enter an amount of ETH, like 0.05."; return render(); }
  S.busy = "fund"; S.error = null; render();
  try {
    const mm = createWalletClient({ chain: sepolia, transport: custom(window.ethereum) });
    S.fundHash = await mm.sendTransaction({ account: S.mm.account, to: demoAddr(), value });
    render();
    const r = await S.pub.waitForTransactionReceipt({ hash: S.fundHash, timeout: 600_000 });
    if (r.status !== "success") throw new Error("the transfer failed");
    await refreshBalances();
  } catch (e) { S.error = "Funding did not go through: " + (e.shortMessage || e.message); }
  S.busy = null; render();
}
async function sweep() {
  S.busy = "sweep"; S.error = null; render();
  try {
    await refreshBalances();
    const fee = S.fees.maxFeePerGas * 21000n * 2n;
    if (S.demoBal <= fee) throw new Error("nothing left to return");
    S.sweepHash = await S.demo.sendTransaction({ to: S.mm.account, value: S.demoBal - fee, gas: 21000n, maxFeePerGas: S.fees.maxFeePerGas, maxPriorityFeePerGas: S.fees.maxPriorityFeePerGas });
    render();
    await S.pub.waitForTransactionReceipt({ hash: S.sweepHash, timeout: 600_000 });
    await refreshBalances();
  } catch (e) { S.error = "Could not return the ETH: " + (e.shortMessage || e.message); }
  S.busy = null; render();
}

// ---------- deploy & session ----------
const logInto = (list) => (e) => {
  const i = list.findIndex((x) => x.label === e.label);
  if (i < 0) list.push({ ...e }); else Object.assign(list[i], e);
  render();
};
async function deploy() {
  S.busy = "deploy"; S.error = null; S.progress.deploy = DEPLOY_STEPS.map((label) => ({ label, state: "waiting" })); render();
  try {
    const dep = await deployContracts({ pub: S.pub, wallet: S.demo, ART: await loadArt(), rpcUrl: S.admin.rpcUrl, log: logInto(S.progress.deploy),
      partial: S.admin.partialDeploy || null, save: (p) => { S.admin.partialDeploy = p; saveAdmin(S.admin); } });
    S.admin.deployment = dep; S.admin.session = null; S.admin.partialDeploy = null; saveAdmin(S.admin);
  } catch (e) { S.error = "Deployment stopped: " + (e.shortMessage || e.message) + " Press Deploy again to continue where it stopped; finished steps are not paid for twice."; }
  S.busy = null; await refreshBalances(); render();
}
async function newSession() {
  const p = plan();
  S.busy = "session"; S.error = null;
  S.progress.session = SESSION_STEPS({ nameA: "Bank A", nameB: "Bank B", mintA: 1000, mintB: 500 }).map((label) => ({ label, state: "waiting" })); render();
  try {
    const s = await createSession({ pub: S.pub, wallet: S.demo, ART: await loadArt(), dep: S.admin.deployment, mintA: 1000n, mintB: 500n,
      fundBank: p.fundBank, fundRelayer: p.fundRelayer, log: logInto(S.progress.session) });
    S.admin.session = s; saveAdmin(S.admin);
    installProfiles();
  } catch (e) { S.error = "Creating the session stopped: " + (e.shortMessage || e.message); }
  S.busy = null; await refreshBalances(); render();
}
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
  S.admin.deployment = null; S.admin.session = null; S.admin.partialDeploy = null; saveAdmin(S.admin); render();
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
    { id: "console", title: "Console", text: "The whole story on one screen. Use it on the presenting laptop.", url: linkFor({ id: "console", role: "console", banks: [ps["bank-a"], ps["bank-b"]], regulator: ps.regulator }), secret: true },
    { id: "bank-a", title: "Bank A", text: "Bank A's wallet, for a second screen.", url: linkFor(ps["bank-a"]), secret: true },
    { id: "bank-b", title: "Bank B", text: "Bank B's wallet, for a second screen.", url: linkFor(ps["bank-b"]), secret: true },
    { id: "regulator", title: "Regulator", text: "Opens payments with the viewing keys.", url: linkFor(ps.regulator), secret: true },
    { id: "watch", title: "Audience", text: "What everyone can see on the chain. Safe to share: no keys.", url: watchLinkFor(watchInfo(a.deployment, a.session)), secret: false },
  ];
  return `<div class="card"><h2>Present</h2>
    <div class="row"><a class="btn" href="#console">Open the console on this screen</a><a class="btn ghost" href="#watch" target="_blank" rel="noopener">Open the audience view</a></div>
    <p class="hint">Or open a role on another device with its QR code or link. Links marked “contains keys” carry this session's testnet keys: share them only with presenters.</p>
    <div class="qrgrid">${items.map((x) => `<div class="qr ${x.secret ? "secret" : "public"}">
      <canvas data-qr="${esc(x.url)}" width="160" height="160" aria-label="QR code for ${esc(x.title)}"></canvas>
      <div><h3>${esc(x.title)}</h3><p class="hint">${esc(x.text)}</p><span class="tag ${x.secret ? "warn" : "ok"}">${x.secret ? "contains keys" : "public"}</span>
      <div class="row"><button class="small ghost" data-copy="${esc(x.url)}">Copy link</button><a class="small" href="${esc(x.url)}" target="_blank" rel="noopener">Open ↗</a></div></div>
    </div>`).join("")}</div></div>`;
}
function render() {
  if (!S) return;
  const a = S.admin, p = plan(), dep = a.deployment;
  const hasMM = !!window.ethereum;
  const enough = (need) => S.demoBal !== null && p && S.demoBal >= need;
  const funded = enough(p ? p.total / 2n : 1n);
  const busy = !!S.busy;
  const stepClass = (done, active) => (done ? "step done" : active ? "step active" : "step");
  const html = `<div class="top">${lockup()}<div class="net"><span class="chip">SETUP · SEPOLIA</span></div></div>
    <div class="hero"><h1>Set up a live demo</h1></div>
    <p class="lead">Everything happens in this browser. MetaMask sends test ETH once to a demo account kept in this browser; that account deploys the contracts and prepares two banks and a regulator.</p>
    ${S.error ? `<div class="err">${esc(S.error)}</div>` : ""}${S.rpcError ? `<div class="err">Sepolia connection problem: ${esc(S.rpcError)}</div>` : ""}
    <div class="${stepClass(mmOk(), true)}"><span class="sn">1</span><div class="sb"><h2>Connect MetaMask</h2>
      ${!hasMM ? `<p class="hint">MetaMask is not installed in this browser. Install it from <a href="https://metamask.io" target="_blank" rel="noopener">metamask.io</a>, add some Sepolia test ETH from a faucet, then reload this page.</p>`
        : !S.mm.account ? `<button id="connect">Connect MetaMask</button>`
        : `<p>Connected: ${addrLink(SEPOLIA, S.mm.account)}${S.mm.chainId === SEPOLIA ? " · Sepolia" : ""}</p>${S.mm.chainId !== SEPOLIA ? `<button id="switch">Switch MetaMask to Sepolia</button>` : ""}`}
    </div></div>
    <div class="${stepClass(funded, mmOk())}"><span class="sn">2</span><div class="sb"><h2>Fund the demo account</h2>
      <p>Demo account ${addrLink(SEPOLIA, demoAddr())} · balance <b>${S.demoBal === null ? "…" : Number(formatEther(S.demoBal)).toFixed(4)} ETH</b></p>
      <p class="hint">${p ? `Suggested at today's Sepolia gas price: <b>${Number(p.pretty).toPrecision(2)} ETH</b> (${dep ? "a new session" : "deploying the contracts and a session"}, with a wide margin). Whatever is left can be sent back to MetaMask.` : "Checking the gas price…"}</p>
      <div class="row"><input id="fundamt" type="text" inputmode="decimal" aria-label="ETH to send" value="${esc($("#fundamt")?.value || (p ? Math.max(0.01, Number(p.pretty) * 1.2).toFixed(3) : "0.05"))}"> <span>ETH</span>
        <button id="fund" ${!mmOk() || busy ? "disabled" : ""}>${S.busy === "fund" ? "Waiting for MetaMask…" : "Send from MetaMask"}</button>
        ${S.fundHash ? txLink(SEPOLIA, S.fundHash, "funding transaction") : ""}</div>
    </div></div>
    <div class="${stepClass(!!dep, funded)}"><span class="sn">3</span><div class="sb"><h2>Deploy the contracts</h2>
      ${dep ? `<p>Deployed: shielded pool ${addrLink(SEPOLIA, dep.ShieldedPool)} · token ${addrLink(SEPOLIA, dep.MockERC20)} · block ${dep.startBlock}</p>
          <p class="hint">Deploy once; every new demo session reuses these contracts. <button class="small ghost" id="startover" ${busy ? "disabled" : ""}>Start over with new contracts</button></p>`
        : `<p class="hint">13 contracts, including the three zero-knowledge proof verifiers from the EthSystems shielded pool. About 15 transactions; allow 4 to 6 minutes.</p>
          <button id="deploy" ${!funded || busy ? "disabled" : ""}>${S.busy === "deploy" ? "Deploying…" : a.partialDeploy ? "Continue the deployment" : "Deploy the contracts"}</button>`}
      ${progressHtml(S.progress.deploy)}
    </div></div>
    <div class="${stepClass(!!a.session, !!dep)}"><span class="sn">4</span><div class="sb"><h2>Create the demo session</h2>
      <p class="hint">Two new banks, approved by the compliance attester, with 1,000 and 500 test dollars (tUSD) and a little ETH for gas, plus a relayer account for private transactions. About 2 minutes.</p>
      ${a.session ? `<p>Session ready: Bank A ${addrLink(SEPOLIA, a.session.directory["Bank A"].address)} · Bank B ${addrLink(SEPOLIA, a.session.directory["Bank B"].address)}</p>` : ""}
      <button id="session" ${!dep || busy || !enough(p ? p.total / 4n : 1n) ? "disabled" : ""} class="${a.session ? "ghost" : ""}">${S.busy === "session" ? "Creating…" : a.session ? "Create a fresh session" : "Create the demo session"}</button>
      ${progressHtml(S.progress.session)}
    </div></div>
    ${linksHtml()}
    <div class="card"><h2>When you are done</h2>
      <div class="row"><button class="ghost" id="sweep" ${!mmOk() || busy || !S.demoBal ? "disabled" : ""}>${S.busy === "sweep" ? "Returning…" : "Send the demo account's ETH back to MetaMask"}</button>${S.sweepHash ? txLink(SEPOLIA, S.sweepHash, "return transaction") : ""}</div>
      <details><summary class="hint">Advanced: Sepolia RPC</summary><div class="row"><input id="rpc" class="hash" value="${esc(a.rpcUrl)}" aria-label="Sepolia RPC URL"><button class="small ghost" id="saverpc" ${busy ? "disabled" : ""}>Save</button></div>
        <p class="hint">The public endpoint works; a private one (Infura, Alchemy) is steadier. The wallets of this session use the same URL.</p></details>
    </div>` + footer();
  const app = $("#app");
  const focus = document.activeElement?.id;
  app.innerHTML = html;
  if (focus && document.getElementById(focus)) document.getElementById(focus).focus({ preventScroll: true });
  const on = (id, f) => { const el = document.getElementById(id); if (el) el.onclick = f; };
  on("connect", connect); on("switch", switchChain); on("fund", fund); on("deploy", deploy); on("session", newSession); on("sweep", sweep); on("startover", startOver);
  on("saverpc", () => { try { new URL($("#rpc").value); a.rpcUrl = $("#rpc").value.trim(); saveAdmin(a); connectClients(); refreshBalances().then(render); } catch { S.error = "That is not a URL."; render(); } });
  $$("[data-copy]").forEach((b) => (b.onclick = () => copy(b.dataset.copy, b)));
  for (const c of $$("canvas[data-qr]")) QRCode.toCanvas(c, c.dataset.qr, { errorCorrectionLevel: "L", margin: 1, width: 160, color: { dark: "#16181A", light: "#F7F5F0" } })
    .catch(() => { const p = document.createElement("p"); p.className = "hint qrnone"; p.textContent = "Too much data for a QR code: use Copy link, or open the console on this screen."; c.replaceWith(p); });
}

let timer = null;
export async function showSetup() {
  if (!S) init();
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
  timer = setInterval(async () => { if (location.hash !== "#setup") return clearInterval(timer); if (!S.busy) { await refreshBalances(); if (!document.activeElement?.matches?.("input")) render(); } }, 8000);
}
