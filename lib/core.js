// Wallet core: keys, notes, note encryption, chain scanning and proof generation.
// Hashes and public-input layouts follow pocs/private-payment/shielded-pool exactly.
import { poseidon1, poseidon2, poseidon4 } from "poseidon-lite";
import { LeanIMT } from "@zk-kit/lean-imt";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { Noir } from "@noir-lang/noir_js";
import { Barretenberg, UltraHonkBackend } from "@aztec/bb.js";
import { keccak256, bytesToHex, hexToBytes, getAddress, parseAbiItem } from "viem";

export const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const ATT_DEPTH = 20;
const TREE_DEPTH = 32;

export const toHex32 = (x) => "0x" + BigInt(x).toString(16).padStart(64, "0");
const randomBytes = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));
export const randField = () => BigInt(bytesToHex(randomBytes(32))) % P;
export const payloadHash = (bytes) => BigInt(keccak256(bytes)) % P;

// ---------- keys ----------
export function newShieldedKeys() {
  const spendingKey = randField();
  const viewingPriv = secp256k1.utils.randomSecretKey();
  return {
    spendingKey: toHex32(spendingKey),
    viewingPriv: bytesToHex(viewingPriv),
  };
}
export function publicShielded(keys) {
  return {
    ownerPubkey: toHex32(poseidon1([BigInt(keys.spendingKey)])),
    viewingPub: bytesToHex(secp256k1.getPublicKey(hexToBytes(keys.viewingPriv), true)),
  };
}

// ---------- notes ----------
export const commitmentOf = (n) => poseidon4([BigInt(n.token), BigInt(n.amount), BigInt(n.owner), BigInt(n.salt)]);
export const nullifierOf = (commitment, spendingKey) => poseidon2([BigInt(commitment), BigInt(spendingKey)]);

// Envelope: 0x01 | ephemeral pubkey (33) | nonce (12) | ChaCha20-Poly1305 ciphertext of the note JSON.
const INFO = new TextEncoder().encode("privpay-demo-note-v1");
function envelopeKey(shared, ephPub, recipientPub) {
  return hkdf(sha256, shared, new Uint8Array([...ephPub, ...recipientPub]), INFO, 32);
}
export function sealNote(note, recipientViewingPub) {
  const rPub = hexToBytes(recipientViewingPub);
  const eph = secp256k1.utils.randomSecretKey();
  const ephPub = secp256k1.getPublicKey(eph, true);
  const shared = secp256k1.getSharedSecret(eph, rPub, true).slice(1);
  const nonce = randomBytes(12);
  const body = new TextEncoder().encode(JSON.stringify({
    token: toHex32(note.token), amount: String(note.amount), owner: toHex32(note.owner), salt: toHex32(note.salt), memo: note.memo || "",
  }));
  const ct = chacha20poly1305(envelopeKey(shared, ephPub, rPub), nonce).encrypt(body);
  return new Uint8Array([1, ...ephPub, ...nonce, ...ct]);
}
export function openNote(envelope, viewingPriv) {
  try {
    if (envelope[0] !== 1 || envelope.length < 1 + 33 + 12 + 16) return null;
    const ephPub = envelope.slice(1, 34), nonce = envelope.slice(34, 46), ct = envelope.slice(46);
    const priv = hexToBytes(viewingPriv);
    const myPub = secp256k1.getPublicKey(priv, true);
    const shared = secp256k1.getSharedSecret(priv, ephPub, true).slice(1);
    const body = chacha20poly1305(envelopeKey(shared, ephPub, myPub), nonce).decrypt(ct);
    return JSON.parse(new TextDecoder().decode(body));
  } catch { return null; }
}
// Several envelopes in one payload: [u16 length][envelope]...
export function packEnvelopes(list) {
  const parts = [];
  for (const e of list) parts.push(e.length >> 8, e.length & 255, ...e);
  return new Uint8Array(parts);
}
export function unpackEnvelopes(bytes) {
  const out = [];
  for (let i = 0; i + 2 <= bytes.length;) {
    const len = (bytes[i] << 8) | bytes[i + 1];
    out.push(bytes.slice(i + 2, i + 2 + len));
    i += 2 + len;
  }
  return out;
}

// ---------- chain scan ----------
const EV = {
  deposit: parseAbiItem("event Deposit(bytes32 indexed commitment, address indexed token, uint256 amount, bytes encryptedNote)"),
  transfer: parseAbiItem("event Transfer(bytes32 indexed nullifier1, bytes32 indexed nullifier2, bytes32 commitment1, bytes32 commitment2, bytes encryptedNotes)"),
  withdraw: parseAbiItem("event Withdraw(bytes32 indexed nullifier, address indexed recipient, address indexed token, uint256 amount)"),
  attest: parseAbiItem("event AttestationAdded(bytes32 indexed leaf, bytes32 indexed subjectPubkeyHash, address indexed attester, uint64 issuedAt, uint64 expiresAt)"),
};

// Rebuilds everything a wallet needs from the chain alone: the commitment tree, the
// attestation tree, spent nullifiers, and this wallet's own notes (by trial decryption).
export class Scanner {
  constructor(client, dep, keys, chunk = 5000n) {
    Object.assign(this, { client, dep, keys, chunk });
    this.pub = publicShielded(keys);
    this.from = BigInt(dep.startBlock);
    this.logs = [];
    this.notes = [];
    this.attestation = null;
  }
  async sync() {
    const latest = await this.client.getBlockNumber();
    while (this.from <= latest) {
      const to = this.from + this.chunk - 1n > latest ? latest : this.from + this.chunk - 1n;
      const [pool, reg] = await Promise.all([
        this.client.getLogs({ address: this.dep.ShieldedPool, events: [EV.deposit, EV.transfer, EV.withdraw], fromBlock: this.from, toBlock: to }),
        this.client.getLogs({ address: this.dep.AttestationRegistry, event: EV.attest, fromBlock: this.from, toBlock: to }),
      ]);
      this.logs.push(...pool, ...reg);
      this.from = to + 1n;
    }
    this.logs.sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : Number(a.blockNumber - b.blockNumber)));
    return this.rebuild();
  }
  rebuild() {
    const tree = new LeanIMT((a, b) => poseidon2([a, b]));
    const attTree = new LeanIMT((a, b) => poseidon2([a, b]));
    const spent = new Set();
    const notes = [];
    let attestation = null;
    const seen = new Set();
    const tryOpen = (bytes, commitments, log) => {
      for (const env of bytes) {
        const n = openNote(env, this.keys.viewingPriv);
        if (!n || BigInt(n.owner) !== BigInt(this.pub.ownerPubkey)) continue;
        const c = commitmentOf(n);
        const hit = commitments.find((x) => x.value === c);
        if (!hit || seen.has(c)) continue;
        seen.add(c);
        notes.push({ ...n, commitment: toHex32(c), index: hit.index, nullifier: toHex32(nullifierOf(c, this.keys.spendingKey)),
          txHash: log.transactionHash, block: Number(log.blockNumber), kind: log.eventName });
      }
    };
    for (const log of this.logs) {
      const a = log.args;
      if (log.eventName === "AttestationAdded") {
        attTree.insert(BigInt(a.leaf));
        if (BigInt(a.subjectPubkeyHash) === BigInt(this.pub.ownerPubkey))
          attestation = { index: attTree.size - 1, attester: a.attester, issuedAt: a.issuedAt, expiresAt: a.expiresAt };
      } else if (log.eventName === "Deposit") {
        tree.insert(BigInt(a.commitment));
        tryOpen(unpackEnvelopes(hexToBytes(a.encryptedNote)), [{ value: BigInt(a.commitment), index: tree.size - 1 }], log);
      } else if (log.eventName === "Transfer") {
        spent.add(BigInt(a.nullifier1)); spent.add(BigInt(a.nullifier2));
        tree.insert(BigInt(a.commitment1)); tree.insert(BigInt(a.commitment2));
        tryOpen(unpackEnvelopes(hexToBytes(a.encryptedNotes)),
          [{ value: BigInt(a.commitment1), index: tree.size - 2 }, { value: BigInt(a.commitment2), index: tree.size - 1 }], log);
      } else if (log.eventName === "Withdraw") {
        spent.add(BigInt(a.nullifier));
      }
    }
    for (const n of notes) n.spent = spent.has(BigInt(n.nullifier));
    Object.assign(this, { tree, attTree, spent, notes, attestation });
    return this;
  }
  unspent() { return this.notes.filter((n) => !n.spent && BigInt(n.amount) > 0n); }
}

function pathOf(tree, index, depth) {
  const p = tree.generateProof(index);
  const path = Array(depth).fill("0x0"), indices = Array(depth).fill(false);
  p.siblings.forEach((s, i) => { path[i] = toHex32(s); indices[i] = ((p.index >> i) & 1) === 1; });
  return { root: p.root, length: p.siblings.length, path, indices };
}

// ---------- prover ----------
export class Prover {
  // circuits: { deposit, transfer, withdraw } compiled Noir JSON (from nargo compile)
  static async create(circuits) {
    const p = new Prover();
    p.api = await Barretenberg.new();
    for (const name of ["deposit", "transfer", "withdraw"]) {
      const c = circuits[name];
      p[name] = { noir: new Noir(c), backend: new UltraHonkBackend(c.bytecode, p.api) };
    }
    return p;
  }
  async prove(name, inputs) {
    const { noir, backend } = this[name];
    const { witness } = await noir.execute(inputs);
    const { proof, publicInputs } = await backend.generateProof(witness, { verifierTarget: "evm" });
    return { proof: bytesToHex(proof), publicInputs };
  }
  async destroy() { await this.api.destroy(); }
}

// Build deposit: note to self, sealed to own viewing key so the wallet can recover it from chain.
export async function buildDeposit(prover, scan, { token, amount, funding }) {
  const att = scan.attestation;
  if (!att) throw new Error("This bank's key is not approved yet");
  const note = { token: BigInt(token), amount: BigInt(amount), owner: BigInt(scan.pub.ownerPubkey), salt: randField(), memo: "deposit" };
  const commitment = commitmentOf(note);
  const payload = packEnvelopes([sealNote(note, scan.pub.viewingPub)]);
  const ap = pathOf(scan.attTree, att.index, ATT_DEPTH);
  const { proof } = await prover.prove("deposit", {
    commitment: toHex32(commitment), token: toHex32(BigInt(token)), amount: toHex32(note.amount),
    funding_address: toHex32(BigInt(funding)), attestation_root: toHex32(ap.root), payload_hash: toHex32(payloadHash(payload)),
    spending_key: scan.keys.spendingKey, salt: toHex32(note.salt), attester: toHex32(BigInt(att.attester)),
    issued_at: String(att.issuedAt), expires_at: String(att.expiresAt),
    attestation_proof_length: String(ap.length), attestation_path: ap.path, attestation_indices: ap.indices,
  });
  return { proof, commitment: toHex32(commitment), payload: bytesToHex(payload) };
}

// Build a 2-in-2-out private transfer: output 0 to the recipient, output 1 as change to self.
export async function buildTransfer(prover, scan, { token, amount, to, memo }) {
  amount = BigInt(amount);
  const pool = scan.unspent().filter((n) => BigInt(n.token) === BigInt(token)).sort((a, b) => Number(BigInt(b.amount) - BigInt(a.amount)));
  let ins = pool.filter((n) => BigInt(n.amount) >= amount).slice(-1);
  if (!ins.length) {
    for (let i = 0; i < pool.length && !ins.length; i++)
      for (let j = i + 1; j < pool.length; j++)
        if (BigInt(pool[i].amount) + BigInt(pool[j].amount) >= amount) { ins = [pool[i], pool[j]]; break; }
  }
  if (!ins.length) throw new Error("Not enough private balance");
  const sk = scan.keys.spendingKey, me = BigInt(scan.pub.ownerPubkey);
  const pad = { token: BigInt(token), amount: 0n, owner: me, salt: randField() };
  const in0 = ins[0], in1 = ins[1] || pad;
  const total = BigInt(in0.amount) + BigInt(in1.amount);
  const out0 = { token: BigInt(token), amount, owner: BigInt(to.ownerPubkey), salt: randField(), memo: memo || "" };
  const out1 = { token: BigInt(token), amount: total - amount, owner: me, salt: randField(), memo: "change" };
  const c1in = commitmentOf(in1);
  const p0 = pathOf(scan.tree, in0.index, TREE_DEPTH);
  const p1 = ins[1] ? pathOf(scan.tree, in1.index, TREE_DEPTH) : { length: 0, path: Array(TREE_DEPTH).fill("0x0"), indices: Array(TREE_DEPTH).fill(false) };
  const payload = packEnvelopes([sealNote(out0, to.viewingPub), sealNote(out1, scan.pub.viewingPub)]);
  const nullifiers = [toHex32(BigInt(in0.nullifier)), toHex32(nullifierOf(c1in, sk))];
  const commitments = [toHex32(commitmentOf(out0)), toHex32(commitmentOf(out1))];
  const root = toHex32(p0.root);
  const { proof } = await prover.prove("transfer", {
    nullifier_0: nullifiers[0], nullifier_1: nullifiers[1], commitment_out_0: commitments[0], commitment_out_1: commitments[1],
    commitment_root: root, payload_hash: toHex32(payloadHash(payload)), spending_key: sk,
    token_in_0: toHex32(BigInt(in0.token)), amount_in_0: String(in0.amount), salt_in_0: toHex32(BigInt(in0.salt)),
    token_in_1: toHex32(BigInt(in1.token)), amount_in_1: String(in1.amount), salt_in_1: toHex32(BigInt(in1.salt)),
    token_out_0: toHex32(out0.token), amount_out_0: String(out0.amount), owner_out_0: toHex32(out0.owner), salt_out_0: toHex32(out0.salt),
    token_out_1: toHex32(out1.token), amount_out_1: String(out1.amount), owner_out_1: toHex32(out1.owner), salt_out_1: toHex32(out1.salt),
    proof_length_0: String(p0.length), path_0: p0.path, indices_0: p0.indices,
    proof_length_1: String(p1.length), path_1: p1.path, indices_1: p1.indices,
  });
  return { proof, nullifiers, commitments, root, payload: bytesToHex(payload), spent: ins.map((n) => n.amount) };
}

// Withdraw one whole note to a public address.
export async function buildWithdraw(prover, scan, { commitment, recipient }) {
  const n = scan.unspent().find((x) => x.commitment === commitment);
  if (!n) throw new Error("Note not found or already spent");
  const p = pathOf(scan.tree, n.index, TREE_DEPTH);
  const { proof } = await prover.prove("withdraw", {
    nullifier: n.nullifier, token: toHex32(BigInt(n.token)), amount: toHex32(BigInt(n.amount)), recipient: toHex32(BigInt(recipient)),
    commitment_root: toHex32(p.root), spending_key: scan.keys.spendingKey, salt: toHex32(BigInt(n.salt)),
    proof_length: String(p.length), path: p.path, indices: p.indices,
  });
  return { proof, nullifier: n.nullifier, token: getAddress(toHex32(BigInt(n.token)).replace(/^0x0{24}/, "0x")), amount: BigInt(n.amount), root: toHex32(p.root) };
}
