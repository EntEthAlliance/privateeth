// "Is the payment really private?": the deposit and the private payment side by side, with
// what Etherscan shows for each, read from the real transaction receipts.
// Every value that reaches a link or the page is validated or escaped first.
import { decodeEventLog, parseAbiItem } from "viem";
import { esc, n, short, isHash, isAddr, explorerFor } from "./util.js";

const ERC20 = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const facts = new Map(); // tx hash -> what the receipt shows (or a pending promise)

// What a block explorer will show for one transaction: sender, ETH value, token transfers.
function load(pub, hash, token) {
  if (facts.has(hash)) return facts.get(hash);
  const p = Promise.all([pub.getTransaction({ hash }), pub.getTransactionReceipt({ hash })]).then(([tx, r]) => {
    const moves = r.logs.filter((l) => l.address.toLowerCase() === token.toLowerCase()).map((l) => {
      try { const e = decodeEventLog({ abi: [ERC20], data: l.data, topics: l.topics }); return e.args.value; } catch { return null; }
    }).filter((v) => v !== null);
    const f = { from: tx.from, value: tx.value, tokens: moves.reduce((s, v) => s + v, 0n), moves: moves.length };
    facts.set(hash, f);
    return f;
  }).catch(() => { facts.delete(hash); return null; });
  facts.set(hash, p);
  return p;
}

// opts: { pub, chainId, feed, relayer, names (address -> name), token, onReady }
export function verifyHtml({ pub, chainId, feed, relayer, names = {}, token, onReady, payLabel = "Bank A → Bank B, 700 tUSD" }) {
  const ex = explorerFor(chainId);
  const dep = feed.logs.find((l) => l.eventName === "Deposit" && isHash(l.transactionHash));
  const pay = feed.logs.find((l) => l.eventName === "Transfer" && isHash(l.transactionHash));
  if (!dep || !pay || !isAddr(token)) return "";
  const fd = facts.get(dep.transactionHash), fp = facts.get(pay.transactionHash);
  const ready = fd && !(fd instanceof Promise) && fp && !(fp instanceof Promise);
  if (!ready) {
    Promise.all([load(pub, dep.transactionHash, token), load(pub, pay.transactionHash, token)]).then(() => onReady && onReady());
    return `<div class="card verify"><h2>Is the payment really private?</h2><p class="hint"><span class="spin"></span>Reading both transactions from the chain…</p></div>`;
  }
  const who = (a) => { const k = (a || "").toLowerCase(); return relayer && k === relayer.toLowerCase() ? "the relayer" : names[k] || short(a); };
  const yes = (t) => `<span class="vyes">${esc(t)}</span>`, no = (t) => `<span class="vno">${esc(t)}</span>`;
  const btn = (h) => (ex ? `<a class="btn small-btn" href="${esc(ex + "/tx/" + h)}" target="_blank" rel="noopener">Open on Etherscan ↗</a>` : `<span class="mono">${esc(short(h))}</span>`);
  const rows = [
    ["“ERC-20 Tokens Transferred” section", fd.moves ? yes(`Yes: ${n(fd.tokens)} tUSD`) : no("No"), fp.moves ? yes(`Yes: ${n(fp.tokens)} tUSD`) : no("No, none")],
    ["Amount visible", fd.moves ? yes(`${n(fd.tokens)} tUSD`) : no("No"), fp.moves ? yes(`${n(fp.tokens)} tUSD`) : no("No")],
    ["Who sent it (“From”)", yes(who(fd.from)), fp.from.toLowerCase() === (relayer || "").toLowerCase() ? no("Only the relayer, not the bank") : yes(who(fp.from))],
    ["Who received it", yes("the shielded pool"), no("Not on-chain")],
  ];
  const bad = fp.moves > 0 || fp.from.toLowerCase() !== (relayer || "").toLowerCase();
  return `<div class="card verify"><h2>Is the payment really private?</h2>
    <p class="hint">The same two transactions as on Etherscan, read from the chain. Open both and compare: the deposit shows its amount, the private payment shows nothing that identifies the banks or the amount.</p>
    <div class="vtable" role="table">
      <div class="vh" role="row"><span></span><span class="vcol"><b>A deposit</b><small>public on purpose</small>${btn(dep.transactionHash)}</span><span class="vcol priv"><b>The private payment</b><small>${esc(payLabel)}</small>${btn(pay.transactionHash)}</span></div>
      ${rows.map(([k, a, b]) => `<div class="vr" role="row"><span class="vk2">${esc(k)}</span><span>${a}</span><span>${b}</span></div>`).join("")}
    </div>
    <p class="vverdict ${bad ? "warn" : ""}">${bad ? "Something here is visible that should not be: look at the payment on Etherscan." : "Checked: the payment moved no visible tokens, and the chain does not show who paid whom or how much."}</p></div>`;
}
