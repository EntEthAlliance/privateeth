// The animated stage: Bank A · shielded pool · Bank B, and the public chain underneath.
// Orange is public, green is sealed, blue is what a viewing key reveals.
import { esc, n, short, txLink, addrLink } from "./util.js";

export function stageHtml({ nameA = "Bank A", nameB = "Bank B" } = {}) {
  const bank = (id, name) => `
    <div class="node bank" id="node-${id}">
      <div class="node-head"><span class="node-name">${esc(name)}</span><span class="node-addr" data-v="${id}-addr"></span></div>
      <div class="bals">
        <div class="b pub"><span class="lbl">Public wallet</span><span class="v" data-v="${id}-pub">…</span></div>
        <div class="b priv"><span class="lbl">Private balance</span><span class="v" data-v="${id}-priv">…</span></div>
      </div>
      ${id === "B" ? `<div class="fresh" id="node-fresh" hidden><span class="lbl">New address</span><span data-v="fresh-addr"></span><span class="v" data-v="fresh-bal"></span></div>` : ""}
    </div>`;
  return `<div class="stage" data-reveal="0">
    <div class="stage-row">
      ${bank("A", nameA)}
      <div class="node pool" id="node-pool">
        <div class="node-head"><span class="node-name">Shielded pool</span><span class="node-addr" data-v="pool-addr"></span></div>
        <div class="pool-sub"><span class="lbl">Holds (public)</span><span class="v" data-v="pool-pub">…</span></div>
        <div class="cloud" data-v="notes"><span class="empty">No notes yet</span></div>
      </div>
      ${bank("B", nameB)}
    </div>
    <div class="chain">
      <div class="chain-head"><span class="lbl">Public chain · what everyone sees</span><span class="live"><i></i>live</span></div>
      <div class="chain-cards" data-v="cards"><div class="empty">Transactions will appear here as they land on-chain.</div></div>
    </div>
  </div>`;
}

export function cardHtml(c, chainId, reveal) {
  const kind = { deposit: "PUBLIC · DEPOSIT", transfer: "PRIVATE · PAYMENT", withdraw: "PUBLIC · WITHDRAWAL", rejected: "REJECTED" }[c.kind] || c.kind;
  return `<div class="ccard ${c.kind}" data-key="${esc(c.key)}">
    <div class="ck">${kind}</div>
    <div class="ct">${esc(c.title)}</div>
    <div class="crows">${c.rows.map(([k, v, cls]) => `<span>${esc(k)}</span><span class="cv ${cls || ""}">${esc(v)}</span>`).join("")}</div>
    ${reveal && c.reveal ? `<div class="creveal">Regulator: ${esc(c.reveal)}</div>` : ""}
    <div class="cx">${txLink(chainId, c.hash, "block " + c.block)}</div>
  </div>`;
}

export function createStage(root, opts = {}) {
  root.innerHTML = stageHtml(opts);
  const el = root.querySelector(".stage");
  const v = (k) => el.querySelector(`[data-v="${k}"]`);
  let reveal = false, lastCards = "", chainId = opts.chainId;
  const setText = (k, text, { flash = true } = {}) => {
    const node = v(k); if (!node) return;
    const t = String(text);
    if (node.textContent !== t) { const had = node.textContent !== "…" && node.textContent !== ""; node.textContent = t; if (flash && had) { node.classList.remove("flash"); void node.offsetWidth; node.classList.add("flash"); } }
  };
  const center = (node) => { const r = node.getBoundingClientRect(), s = el.getBoundingClientRect(); return [r.left - s.left + r.width / 2, r.top - s.top + r.height / 2]; };
  return {
    el,
    setChain(id) { chainId = id; },
    update(s) {
      for (const id of ["A", "B"]) if (s[id]) {
        if (s[id].pub !== undefined) setText(`${id}-pub`, n(s[id].pub));
        if (s[id].priv !== undefined) setText(`${id}-priv`, n(s[id].priv));
        if (s[id].addr) v(`${id}-addr`).innerHTML = addrLink(chainId, s[id].addr);
      }
      if (s.pool) { if (s.pool.pub !== undefined) setText("pool-pub", `${n(s.pool.pub)} tUSD`); if (s.pool.addr) v("pool-addr").innerHTML = addrLink(chainId, s.pool.addr); }
      if (s.notes) {
        const html = s.notes.length ? s.notes.map((x) => `<span class="nchip ${reveal ? "open" : ""}" title="A sealed note: only its owner and the regulator can read it">${reveal ? `${n(x.amount)} · ${esc(x.owner)}` : "sealed note"}</span>`).join("") : '<span class="empty">No notes yet</span>';
        if (v("notes").innerHTML !== html) v("notes").innerHTML = html;
      }
      if (s.fresh !== undefined) {
        const f = el.querySelector("#node-fresh");
        if (s.fresh) { f.hidden = false; v("fresh-addr").innerHTML = addrLink(chainId, s.fresh.address); setText("fresh-bal", `${n(s.fresh.balance)} tUSD`); } else f.hidden = true;
      }
    },
    cards(list) {
      const html = list.length ? list.slice(0, 8).map((c) => cardHtml(c, chainId, reveal)).join("") : '<div class="empty">Transactions will appear here as they land on-chain.</div>';
      if (html === lastCards) return;
      const before = new Set([...el.querySelectorAll(".ccard")].map((x) => x.dataset.key));
      v("cards").innerHTML = html; lastCards = html;
      for (const c of el.querySelectorAll(".ccard")) if (before.size && !before.has(c.dataset.key)) c.classList.add("arrive");
    },
    setReveal(on) { reveal = !!on; el.dataset.reveal = on ? "1" : "0"; lastCards = ""; },
    get reveal() { return reveal; },
    // Moves a coin (public) or a sealed envelope (private) between two nodes.
    fly(from, to, { kind = "coin", label = "" } = {}) {
      const a = el.querySelector(`#node-${from}`), b = el.querySelector(`#node-${to}`);
      if (!a || !b || matchMedia("(prefers-reduced-motion: reduce)").matches) return Promise.resolve();
      const [x0, y0] = center(a), [x1, y1] = center(b);
      const t = document.createElement("div");
      t.className = `token ${kind}`; t.textContent = label;
      el.appendChild(t);
      const lift = Math.min(140, Math.abs(x1 - x0) / 3 + 40);
      const anim = t.animate([
        { transform: `translate(${x0}px, ${y0}px) translate(-50%, -50%) scale(0.6)`, opacity: 0 },
        { transform: `translate(${x0}px, ${y0 - 20}px) translate(-50%, -50%) scale(1)`, opacity: 1, offset: 0.12 },
        { transform: `translate(${(x0 + x1) / 2}px, ${Math.min(y0, y1) - lift}px) translate(-50%, -50%) scale(1.15)`, opacity: 1, offset: 0.55 },
        { transform: `translate(${x1}px, ${y1 - 10}px) translate(-50%, -50%) scale(1)`, opacity: 1, offset: 0.9 },
        { transform: `translate(${x1}px, ${y1}px) translate(-50%, -50%) scale(0.6)`, opacity: 0 },
      ], { duration: 1900, easing: "cubic-bezier(.45,.05,.35,1)" });
      return anim.finished.then(() => { t.remove(); b.classList.remove("pulse"); void b.offsetWidth; b.classList.add("pulse"); });
    },
    shake(id) { const x = el.querySelector(`#node-${id}`); if (!x) return; x.classList.remove("shake"); void x.offsetWidth; x.classList.add("shake"); },
  };
}
