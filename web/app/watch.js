// Audience view: everything anyone can read on the chain about this demo. No keys.
import { makeClients } from "../../lib/net.js";
import { $, esc, n, addrLink, lockup, footer } from "./util.js";
import { ChainFeed } from "./feed.js";
import { cardHtml } from "./stage.js";
import { verifyHtml } from "./verify.js";

let W = null;

export function showWatch(w) {
  document.title = "Audience view · PrivateEth";
  if (!w) {
    $("#app").innerHTML = `<div class="top">${lockup()}</div><div class="hero"><h1>Audience view</h1></div>
      <p class="lead">Open this page with the audience link or QR code from the presenter's setup page.</p>` + footer();
    return;
  }
  if (!W || W.w.ShieldedPool !== w.ShieldedPool) {
    const { pub } = makeClients(w.rpcUrl, w.chainId);
    W = { w, pub, feed: new ChainFeed(pub, w), pool: null, error: null };
  }
  $("#app").innerHTML = `<div class="top">${lockup()}<div class="net"><span class="chip">${w.chainId === 11155111 ? "SEPOLIA" : "CHAIN " + Number(w.chainId)}</span><span class="chip ok live-chip"><i></i>LIVE</span></div></div>
    <div class="hero"><h1>What everyone can see</h1></div>
    <p class="lead">This is the demo's shielded pool, read straight from the public chain, as any analyst or competitor would. Watch what appears when the banks pay each other privately.</p>
    <div class="watch-sum card"><div><span class="lbl">Shielded pool</span><div>${addrLink(w.chainId, w.ShieldedPool)}</div></div>
      <div><span class="lbl">In the pool this session</span><div class="big" id="wpool">…</div></div>
      <div><span class="lbl">Legend</span><div class="legend"><span><i class="lp"></i>public</span><span><i class="lh"></i>sealed</span><span><i class="la"></i>not on-chain</span></div></div></div>
    <div id="werr"></div>
    <div id="wverify"></div>
    <div class="watch-cards" id="wcards"><div class="empty">Reading the chain…</div></div>` + footer();
  paint();
  if (!W.polling) {
    W.polling = true;
    const me = W;
    const tick = async () => {
      if (W !== me) return;
      try { await me.feed.sync(); me.pool = me.feed.sessionHolds(); me.error = null; } catch (e) { me.error = e.shortMessage || e.message; }
      if (location.hash === "#watch") paint();
      setTimeout(tick, 4000);
    };
    tick();
  }
}
let last = "";
function paint() {
  if (!W) return;
  if ($("#wpool") && W.pool !== null) $("#wpool").textContent = `${n(W.pool)} tUSD`;
  if ($("#werr")) $("#werr").innerHTML = W.error ? `<div class="err">Chain connection problem: ${esc(W.error)} · retrying</div>` : "";
  const v = verifyHtml({ pub: W.pub, chainId: W.w.chainId, feed: W.feed, relayer: W.w.relayer, names: W.w.names, token: W.w.MockERC20, payLabel: "the one the presenter just made", onReady: paint });
  if ($("#wverify") && $("#wverify").innerHTML !== v) $("#wverify").innerHTML = v;
  const cards = W.feed.cards();
  const html = cards.length ? cards.map((c) => cardHtml(c, W.w.chainId, false)).join("") : `<div class="empty">No transactions yet. They appear here within seconds of landing on-chain.</div>`;
  if (html !== last && $("#wcards")) {
    const before = new Set([...document.querySelectorAll("#wcards .ccard")].map((x) => x.dataset.key));
    $("#wcards").innerHTML = html; last = html;
    for (const c of document.querySelectorAll("#wcards .ccard")) if (before.size && !before.has(c.dataset.key)) c.classList.add("arrive");
  }
}
export const resetWatchPaint = () => { last = ""; };
