// Small shared helpers for the website.
export const $ = (s, root = document) => root.querySelector(s);
export const $$ = (s, root = document) => [...root.querySelectorAll(s)];
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const short = (h) => (h ? String(h).slice(0, 8) + "…" + String(h).slice(-6) : "");
export const n = (v) => Number(v).toLocaleString("en-US");
export const isAddr = (a) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
export const isHash = (h) => typeof h === "string" && /^0x[0-9a-fA-F]{64}$/.test(h);
export const key32 = (k) => typeof k === "string" && /^0x[0-9a-fA-F]{64}$/.test(k);
export const json = (v) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? { $big: x.toString() } : x));
export const unjson = (s) => JSON.parse(s, (_, x) => (x && typeof x === "object" && "$big" in x ? BigInt(x.$big) : x));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// localStorage that degrades to memory (private windows, blocked storage).
const memory = new Map();
export const store = {
  get(k) { try { const v = localStorage.getItem(k); return v === null ? (memory.has(k) ? memory.get(k) : null) : v; } catch { return memory.get(k) ?? null; } },
  set(k, v) { memory.set(k, v); try { localStorage.setItem(k, v); } catch {} },
  del(k) { memory.delete(k); try { localStorage.removeItem(k); } catch {} },
  keys() { let ks = []; try { ks = Object.keys(localStorage); } catch {} return [...new Set([...ks, ...memory.keys()])]; },
};

export function b64urlEncode(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let bin = ""; for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function b64urlDecode(s) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "===".slice((b64.length + 3) % 4));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
}

export const siteBase = () => location.href.split("#")[0];
export const explorerFor = (chainId) => (chainId === 11155111 ? "https://sepolia.etherscan.io" : null);
export const txLink = (chainId, h, label) => (!isHash(h) ? "" : explorerFor(chainId) ? `<a href="${explorerFor(chainId)}/tx/${h}" target="_blank" rel="noopener">${esc(label || short(h))} ↗</a>` : `<span class="mono">${esc(label || short(h))}</span>`);
export const addrLink = (chainId, a, label) => (!isAddr(a) ? esc(a) : explorerFor(chainId) ? `<a href="${explorerFor(chainId)}/address/${a}" target="_blank" rel="noopener">${esc(label || short(a))} ↗</a>` : `<span class="mono">${esc(label || short(a))}</span>`);

export function lockup() {
  return `<a class="lockup" href="#"><div><b>EEA</b>ETHEREUM INTELLIGENCE</div><div class="stripe"><i></i><i></i><i></i></div></a>`;
}
export function footer() {
  return `<p class="hint foot">Research prototype on Sepolia testnet, built on the shielded pool from <a href="https://github.com/ethsystems/pocs" target="_blank" rel="noopener">ethsystems/pocs</a>. Not audited. Source: <a href="https://github.com/EntEthAlliance/privateeth" target="_blank" rel="noopener">EntEthAlliance/privateeth</a>.</p>`;
}
export async function copy(text, btn) {
  try { await navigator.clipboard.writeText(text); if (btn) { const t = btn.textContent; btn.textContent = "Copied"; setTimeout(() => (btn.textContent = t), 1500); } }
  catch { prompt("Copy this link", text); }
}
