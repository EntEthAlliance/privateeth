// "What Etherscan shows" vs "what a key opens" for one transaction.
import { decodeEventLog, hexToBytes, bytesToHex } from "viem";
import ABI from "../../artifacts/abis.json" with { type: "json" };
import { openNote, unpackEnvelopes, commitmentOf } from "../../lib/core.js";
import { esc, n, short, isAddr, addrLink } from "./util.js";

// dep needs ShieldedPool, relayer, directory; viewingKeys: [{ name, viewingPriv }]
export async function inspectTx(pub, dep, viewingKeys, hash) {
  const [tx, rcpt] = await Promise.all([pub.getTransaction({ hash }), pub.getTransactionReceipt({ hash })]);
  const from = isAddr(tx.from) ? tx.from : "unknown";
  const fromLabel = dep.relayer && from.toLowerCase() === dep.relayer.toLowerCase() ? "relayer"
    : Object.entries(dep.directory || {}).find(([, x]) => x.address.toLowerCase() === from.toLowerCase())?.[0] || null;
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
      for (const k of viewingKeys) {
        const note = openNote(env, k.viewingPriv);
        if (note) { opened = { by: k.name, amount: note.amount, memo: note.memo, matches: onchain.includes(commitmentOf(note)) }; break; }
      }
      return { bytes: bytesToHex(env).slice(0, 26) + "…", size: env.length, opened };
    }) : [];
    out.events.push({ name: ev.eventName, fields, envelopes });
  }
  return out;
}

export function inspectHtml(r, { chainId, keysLabel = "the key", showOpened = true }) {
  const evs = r.events.length ? r.events : [{ name: "(no pool event)", fields: [], envelopes: [] }];
  const left = evs.map((e) => `<div class="kv"><span>from</span><span>${addrLink(chainId, r.from)}${r.fromLabel ? " · " + esc(r.fromLabel) : ""}</span><span>status</span><span>${esc(r.status)}</span><span>event</span><span>${esc(e.name)}</span>
    ${e.fields.map(([k, v]) => `<span>${esc(k)}</span><span>${esc(v.length > 30 ? short(v) : v)}</span>`).join("")}
    ${e.envelopes.map((x, i) => `<span>encrypted ${i + 1}</span><span class="sealed">${esc(x.bytes)} (${x.size} bytes)</span>`).join("")}</div>`).join("");
  const all = evs.flatMap((e) => e.envelopes);
  const right = !showOpened ? `<div class="closed">Turn on “What the regulator sees” to open the notes.</div>`
    : all.length ? all.map((x, i) => !x.opened
      ? `<div class="closed">Note ${i + 1}: cannot be opened with ${esc(keysLabel)}</div>`
      : x.opened.matches
        ? `<div class="open">Note ${i + 1}: ${n(x.opened.amount)} tUSD${x.opened.memo ? " · " + esc(x.opened.memo) : ""}<div class="tag" style="color:var(--blue)">opened with ${esc(x.opened.by)}'s key · matches the on-chain commitment</div></div>`
        : `<div class="err">Note ${i + 1} decrypts, but does not match the on-chain commitment: ignore it</div>`).join("")
    : `<div class="closed">No encrypted notes in this transaction.</div>`;
  return `<div class="inspect"><div><div class="lbl" style="color:var(--orange)">What Etherscan shows</div>${left}</div><div style="display:grid;gap:10px;align-content:start"><div class="lbl" style="color:var(--blue)">What ${esc(keysLabel)} opens</div>${right}</div></div>`;
}
