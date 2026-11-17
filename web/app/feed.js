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
// Rejected transactions emit no events. To show them, the feed looks at the relayer's
// transactions to the pool in recent blocks (at most this many back on first load).
const FAILURE_LOOKBACK = 120n; // about 24 minutes of Sepolia blocks

export class ChainFeed {
  // w: { ShieldedPool, startBlock (this session's first block), relayer?, names: { lowercased address: name } }
  constructor(pub, w, chunk = 5000n) {
    Object.assign(this, { pub, w, chunk, from: BigInt(w.startBlock), logs: [], seen: new Set(), senders: new Map(), rejected: new Map(), blocksFrom: null });
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
    // Deposits do not name their sender in the event; the transaction does. Looked up in
    // parallel and without blocking: cards show "unknown" until the answer arrives.
    const missing = [...new Set(this.logs.map((l) => l.transactionHash))].filter((h) => !this.senders.has(h));
    for (const h of missing) this.senders.set(h, null);
    Promise.all(missing.map((h) => this.pub.getTransaction({ hash: h }).then((t) => this.senders.set(h, t.from), () => this.senders.delete(h)))).catch(() => {});
    // Runs in the background so it never delays balances and cards.
    if (this.w.relayer && !this._failing) this._failing = this._failures(latest).catch(() => {}).finally(() => (this._failing = null));
  }
  async _failures(latest) {
    const start = BigInt(this.w.startBlock);
    if (this.blocksFrom === null) this.blocksFrom = latest - FAILURE_LOOKBACK > start ? latest - FAILURE_LOOKBACK : start;
    const relayer = this.w.relayer.toLowerCase(), pool = this.w.ShieldedPool.toLowerCase();
    while (this.blocksFrom <= latest) {
      const batch = [];
      for (let b = this.blocksFrom; b <= latest && batch.length < 12; b++) batch.push(b);
      const blocks = await Promise.all(batch.map((b) => this.pub.getBlock({ blockNumber: b, includeTransactions: true })));
      for (const block of blocks) for (const tx of block.transactions) {
        if (tx.from?.toLowerCase() !== relayer || tx.to?.toLowerCase() !== pool || this.rejected.has(tx.hash)) continue;
        const r = await this.pub.getTransactionReceipt({ hash: tx.hash });
        if (r.status === "reverted") this.rejected.set(tx.hash, { kind: "rejected", key: tx.hash + ":x", hash: tx.hash, block: Number(block.number),
          title: "Rejected transaction", rows: [["Sent by", "Relayer", "pub"], ["Result", "rejected by the contract", "pub"], ["Reason", "the note was already spent", "pub"]] });
      }
      this.blocksFrom = batch[batch.length - 1] + 1n;
    }
  }
  label(addr) {
    if (!addr) return "…";
    const a = addr.toLowerCase();
    if (this.w.relayer && a === this.w.relayer.toLowerCase()) return "Relayer";
    return this.w.names?.[a] || short(addr);
  }
  // What this session put into the pool, minus what it took out, from public events only.
  sessionHolds() {
    let t = 0n;
    for (const l of this.logs) { if (l.eventName === "Deposit") t += BigInt(l.args.amount); if (l.eventName === "Withdraw") t -= BigInt(l.args.amount); }
    return t;
  }

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
    return [...cards, ...this.rejected.values()].sort((x, y) => y.block - x.block || (y.key > x.key ? 1 : -1));
  }
}
