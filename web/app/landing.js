// Landing page: an animated preview of the story, then the ways in.
import { $, esc, lockup, footer } from "./util.js";
import { createStage } from "./stage.js";
import { loadProfiles, loadWatch, forgetAll } from "./profiles.js";

let loopToken = 0;
const wait = (ms, token) => new Promise((r) => setTimeout(() => r(token === loopToken), ms));

export function showLanding(error) {
  document.title = "PrivateEth · Private Payments Demo";
  const profiles = loadProfiles(), ids = Object.keys(profiles).filter((id) => id !== "console").sort();
  const hasConsole = !!profiles.console, watch = loadWatch();
  $("#app").innerHTML = `<div class="top">${lockup()}<div class="net"><a class="chip" href="#setup">SET UP A LIVE DEMO →</a></div></div>
    <div class="hero"><h1>Private payments on Ethereum</h1></div>
    <p class="lead">Two banks pay each other on a public chain. Nobody watching the chain sees who paid whom or how much. A regulator with viewing keys can still read every payment.</p>
    ${error ? `<div class="err">${esc(error)}</div>` : ""}
    <div class="preview"><div class="preview-tag"><span class="chip">ANIMATED PREVIEW · NOT LIVE</span><span class="hint" id="pcap"></span></div><div id="pstage"></div></div>
    <div class="ways">
      <a class="card way primary" href="#setup"><span class="n">RUN IT LIVE</span><h3>Set up with MetaMask</h3><p class="hint">One transaction of Sepolia test ETH. The page deploys the contracts and prepares two banks and a regulator. No install.</p></a>
      ${hasConsole ? `<a class="card way" href="#console"><span class="n">ON THIS DEVICE</span><h3>Open the console</h3><p class="hint">The whole story on one screen, with real transactions.</p></a>` : ""}
      ${watch ? `<a class="card way" href="#watch"><span class="n">PUBLIC</span><h3>What everyone can see</h3><p class="hint">The demo's pool as the public chain shows it, live.</p></a>` : ""}
      ${ids.length ? `<div class="card way"><span class="n">ROLES ON THIS DEVICE</span><div class="roles">${ids.map((id) => `<a class="chip ok" href="#${esc(id)}">${esc(profiles[id].name || id)} →</a>`).join("")}</div>
        <button class="ghost small" id="forget">Forget the keys on this device</button>
        <p class="hint">Setup links stay in the browser history; clear it after the demo, or use a private window.</p></div>` : ""}
    </div>` + footer();
  if ($("#forget")) $("#forget").onclick = () => { forgetAll({ keepAdmin: true }); location.hash = ""; showLanding(); };
  runPreview();
}

// A scripted loop of the story with made-up numbers, so anyone can see the idea at a glance.
async function runPreview() {
  const token = ++loopToken;
  const stage = createStage($("#pstage"), { nameA: "Bank A", nameB: "Bank B", chainId: 0 });
  stage.el.querySelector(".live").hidden = true; // the preview is not live data
  const cap = (t) => { const c = $("#pcap"); if (c) c.textContent = t; };
  const card = (kind, title, rows, reveal) => ({ kind, title, rows, reveal, key: Math.random().toString(36), block: 0 });
  while (token === loopToken && $("#pstage")) {
    stage.setReveal(false);
    let cards = [];
    stage.update({ A: { pub: 1000, priv: 0 }, B: { pub: 500, priv: 0 }, pool: { pub: 0 }, notes: [], fresh: null }); stage.cards(cards);
    cap("Two approved banks hold tokenized dollars in ordinary, public wallets.");
    if (!(await wait(2600, token))) return;
    cap("1 · Bank A deposits 1,000 into the shielded pool. Public, like any transfer.");
    await stage.fly("A", "pool", { kind: "coin", label: "1,000" });
    cards = [card("deposit", "Deposit into the pool", [["From", "Bank A", "pub"], ["Amount", "1,000 tUSD", "pub"], ["Lands as", "1 sealed note", "sealed"]]), ...cards];
    stage.update({ A: { pub: 0, priv: 1000 }, pool: { pub: 1000 }, notes: [{ amount: 1000, owner: "Bank A" }] }); stage.cards(cards);
    if (!(await wait(1400, token))) return;
    cap("2 · Bank B deposits 500.");
    await stage.fly("B", "pool", { kind: "coin", label: "500" });
    cards = [card("deposit", "Deposit into the pool", [["From", "Bank B", "pub"], ["Amount", "500 tUSD", "pub"], ["Lands as", "1 sealed note", "sealed"]]), ...cards];
    stage.update({ B: { pub: 0, priv: 500 }, pool: { pub: 1500 }, notes: [{ amount: 1000, owner: "Bank A" }, { amount: 500, owner: "Bank B" }] }); stage.cards(cards);
    if (!(await wait(1400, token))) return;
    cap("3 · Bank A pays Bank B 700, privately. The chain records hashes, with no sender, recipient or amount.");
    await stage.fly("A", "B", { kind: "envelope", label: "sealed" });
    cards = [card("transfer", "Private payment", [["Sender", "not on-chain", "absent"], ["Recipient", "not on-chain", "absent"], ["Amount", "not on-chain", "absent"], ["Data", "2 spent tags · 2 new hashes · 2 sealed notes", "sealed"]], "Bank A → Bank B · 700 tUSD (300 change)"), ...cards];
    stage.update({ A: { priv: 300 }, B: { priv: 1200 }, notes: [{ amount: 500, owner: "Bank B" }, { amount: 700, owner: "Bank B" }, { amount: 300, owner: "Bank A" }] }); stage.cards(cards);
    if (!(await wait(2600, token))) return;
    cap("4 · Bank B takes 700 out to a brand-new address. Public again.");
    stage.update({ fresh: { address: "0xF7e5…", balance: 0 } });
    await stage.fly("pool", "fresh", { kind: "coin", label: "700" });
    cards = [card("withdraw", "Withdrawal from the pool", [["To", "new address", "pub"], ["Amount", "700 tUSD", "pub"], ["Who funded it", "not on-chain", "absent"]]), ...cards];
    stage.update({ B: { priv: 500 }, pool: { pub: 800 }, notes: [{ amount: 500, owner: "Bank B" }, { amount: 300, owner: "Bank A" }], fresh: { address: "0xF7e5…", balance: 700 } }); stage.cards(cards);
    if (!(await wait(2400, token))) return;
    cap("5 · The regulator turns on its viewing keys: every sealed note opens, for the regulator only.");
    stage.setReveal(true);
    stage.update({ notes: [{ amount: 500, owner: "Bank B" }, { amount: 300, owner: "Bank A" }] }); stage.cards(cards);
    if (!(await wait(4200, token))) return;
  }
}
export const stopPreview = () => { loopToken++; };
