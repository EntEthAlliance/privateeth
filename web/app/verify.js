// "Check it yourself on Etherscan": a deposit (amount visible) next to the private payment
// (no amount, no sender, no recipient), with direct links, for this session's transactions.
// Every value that reaches a link is validated as a hash or an address first.
import { esc, n, short, isHash, isAddr, explorerFor } from "./util.js";

// feed: a ChainFeed for this session; bankB: Bank B's public address; token/pool addresses.
export function verifyHtml({ chainId, feed, bankB, token, pool }) {
  const ex = explorerFor(chainId);
  const dep = feed.logs.find((l) => l.eventName === "Deposit" && isHash(l.transactionHash));
  const pay = feed.logs.find((l) => l.eventName === "Transfer" && isHash(l.transactionHash));
  if (!dep && !pay) return "";
  const link = (path, label) => (ex ? `<a href="${esc(ex + "/" + path)}" target="_blank" rel="noopener">${esc(label)} ↗</a>` : `<span class="mono">${esc(label)}</span>`);
  const row = (k, title, linkHtml, what) => `<li><span class="vk">${k}</span><div><div class="vt">${title} · ${linkHtml}</div><div class="hint">${what}</div></div></li>`;
  const items = [];
  if (dep) items.push(row("1", "A deposit", link(`tx/${dep.transactionHash}`, short(dep.transactionHash)),
    `Public on purpose. Etherscan shows <b>“ERC-20 Tokens Transferred: ${esc(n(dep.args.amount))} tUSD”</b> from the bank to the pool.`));
  if (pay) {
    items.push(row("2", "The private payment", link(`tx/${pay.transactionHash}`, short(pay.transactionHash)),
      `Compare: <b>no “ERC-20 Tokens Transferred” section</b>, value 0 ETH, and “From” is the relayer, not Bank A. The Logs tab holds only hashes and encrypted bytes: no amount, sender or recipient.`));
    if (isAddr(bankB)) items.push(row("3", "Bank B's public address", link(`address/${bankB}`, short(bankB)),
      `No incoming payment appears here, although Bank B's private balance went up by 700.`));
  }
  if (isAddr(token) && isAddr(pool)) items.push(row(String(items.length + 1), "The pool's tUSD movements", link(`token/${token}?a=${pool}`, "token transfers"),
    `Only deposits and withdrawals move tUSD. The private payment is not in this list.`));
  return `<div class="card verify"><h2>Check it yourself on Etherscan</h2>
    ${ex ? "" : `<p class="hint">This chain has no public explorer; the links work on Sepolia.</p>`}
    <ol class="vlist">${items.join("")}</ol></div>`;
}
