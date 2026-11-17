// Public chain feed: the pool's events as anyone can read them, turned into cards.
// Needs no keys. Optional viewing keys add the regulator's reading of each payment.
import { parseAbiItem, hexToBytes } from "viem";
import { openNote, unpackEnvelopes, commitmentOf } from "../../lib/core.js";
import { n, short } from "./util.js";

const EV = [
  parseAbiItem("event Deposit(bytes32 indexed commitment, address indexed token, uint256 amount, bytes encryptedNote)"),
  parseAbiItem("event Transfer(bytes32 indexed nullifier1, bytes32 indexed nullifier2, bytes32 commitment1, bytes32 commitment2, bytes encryptedNotes)"),
  parseAbiItem("event Withdraw(bytes32 indexed nullifier, address indexed recipient, address indexed token, uint256 amount)"),
];

export class ChainFeed {
  // w: { ShieldedPool, startBlock, relayer?, names: { lowercased address: name } }
  constructor(pub, w, chunk = 5000n) {
    Object.assign(this, { pub, w, chunk, from: BigInt(w.startBlock), logs: [], seen: new Set(), senders: new Map(), extra: [] });
  }
  sync() { return (this._q = (this._q || Promise.resolve()).catch(() => {}).then(() => this._sync())); }
  async _sync() {
    const latest = await this.pub.getBlockNumber();
    while (this.from <= latest) {
      const to = this.from + this.chunk - 1n > latest ? latest : this.from + this.chunk - 1n;
      const logs = await this.pub.getLogs({ address: this.w.ShieldedPool, events: EV, fromBlock: this.from, toBlock: to });
      for (const l of logs) {
        const id = `${l.transactionHash}:${l.logIndex}`;
        if (!this.seen.has(id)) { this.seen.add(id); this.logs.push(l); }
      }
      this.from = to + 1n;
    }
    this.logs.sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : Number(a.blockNumber - b.blockNumber)));
    // Deposits do not name their sender in the event; the transaction does.
    for (const l of this.logs) if (!this.senders.has(l.transactionHash)) {
      try { this.senders.set(l.transactionHash, (await this.pub.getTransaction({ hash: l.transactionHash })).from); } catch {}
    }
  }
  // Rejected transactions emit no events; callers add them here.
  addRejected(c) { this.extra.push(c); }
  label(addr) {
    if (!addr) return "unknown";
    const a = addr.toLowerCase();
    if (this.w.relayer && a === this.w.relayer.toLowerCase()) return "Relayer";
    return this.w.names?.[a] || short(addr);
  }
  poolBalance(tokenAbi, token) { return this.pub.readContract({ address: token, abi: tokenAbi, functionName: "balanceOf", args: [this.w.ShieldedPool] }); }

  // Cards, newest first. viewingKeys (optional) adds what the regulator can read.
  cards(viewingKeys = []) {
    const open = (payload, onchain) => {
      const out = [];
      for (const env of unpackEnvelopes(hexToBytes(payload))) for (const k of viewingKeys) {
        const note = openNote(env, k.viewingPriv);
        if (note && onchain.includes(commitmentOf(note))) { out.push({ ...note, by: k.name }); break; }
      }
      return out;
    };
    const cards = this.logs.map((l) => {
      const a = l.args, from = this.senders.get(l.transactionHash), base = { hash: l.transactionHash, block: Number(l.blockNumber), key: `${l.transactionHash}:${l.logIndex}` };
      if (l.eventName === "Deposit") {
        const notes = viewingKeys.length ? open(a.encryptedNote, [BigInt(a.commitment)]) : [];
        return { ...base, kind: "deposit", title: "Deposit into the pool", rows: [["From", this.label(from), "pub"], ["Amount", `${n(a.amount)} tUSD`, "pub"], ["Lands as", "1 sealed note", "sealed"]],
          reveal: notes[0] ? `${notes[0].by}'s note · ${n(notes[0].amount)} tUSD` : null };
      }
      if (l.eventName === "Transfer") {
        const notes = viewingKeys.length ? open(a.encryptedNotes, [BigInt(a.commitment1), BigInt(a.commitment2)]) : [];
        const pay = notes.find((x) => x.memo && x.memo.startsWith("from ")), change = notes.find((x) => x.memo === "change");
        return { ...base, kind: "transfer", title: "Private payment", rows: [["Sent by", this.label(from), "pub"], ["Sender", "not on-chain", "absent"], ["Recipient", "not on-chain", "absent"], ["Amount", "not on-chain", "absent"], ["Data", "2 spent tags · 2 new hashes · 2 sealed notes", "sealed"]],
          reveal: pay ? `${pay.memo.slice(5)} → ${pay.by} · ${n(pay.amount)} tUSD${change ? ` (${n(change.amount)} change)` : ""}` : null };
      }
      return { ...base, kind: "withdraw", title: "Withdrawal from the pool", rows: [["To", this.label(a.recipient), "pub"], ["Amount", `${n(a.amount)} tUSD`, "pub"], ["Who funded it", "not on-chain", "absent"]], reveal: null };
    });
    return [...cards, ...this.extra].sort((x, y) => y.block - x.block || (y.key > x.key ? 1 : -1));
  }
}
