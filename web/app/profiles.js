// Role profiles (bank, regulator, console) and the public watch description.
// Setup links are untrusted input: only the exact shape the setup produces is accepted.
import { store, isAddr, key32, b64urlDecode, b64urlEncode, siteBase } from "./util.js";
import { PUBLIC_RPC, publicRpcFor } from "../../lib/deploy.js";

const STORE = "privateeth.profiles.v1";
export const loadProfiles = () => { try { return JSON.parse(store.get(STORE)) || {}; } catch { return {}; } };
export const saveProfiles = (p) => store.set(STORE, JSON.stringify(p));

const need = (ok, what) => { if (!ok) throw new Error(`invalid ${what}`); };
const name = (x) => typeof x === "string" && /^[\w .-]{1,32}$/.test(x);
const isLocalHost = (h) => h === "127.0.0.1" || h === "localhost";
// https only; plain http only for a node on this computer (local testing).
function rpc(u) {
  let url; try { url = new URL(u); } catch { need(false, "RPC URL"); }
  need(url.protocol === "https:" || (url.protocol === "http:" && isLocalHost(url.hostname)), "RPC URL (https only)");
  return url.href;
}
// Sepolia, or a local test chain.
const okChain = (id) => id === 11155111 || id === 31337;
function cleanDep(d = {}) {
  need(Number.isSafeInteger(d.chainId) && okChain(d.chainId), "chain (Sepolia only)");
  need(Number.isSafeInteger(d.startBlock) && d.startBlock >= 0, "start block");
  for (const k of ["ShieldedPool", "AttestationRegistry", "MockERC20", "relayer"]) need(isAddr(d[k]), k);
  need(d.directory && typeof d.directory === "object", "directory");
  const directory = {};
  for (const [k, v] of Object.entries(d.directory)) {
    need(name(k) && isAddr(v.address) && key32(v.ownerPubkey) && /^0x0[23][0-9a-fA-F]{64}$/.test(v.viewingPub), "directory entry");
    directory[k] = { address: v.address, ownerPubkey: v.ownerPubkey, viewingPub: v.viewingPub };
  }
  need(d.sessionBlock === undefined || (Number.isSafeInteger(d.sessionBlock) && d.sessionBlock >= d.startBlock), "session block");
  return { chainId: d.chainId, rpcUrl: rpc(d.rpcUrl), startBlock: d.startBlock, sessionBlock: d.sessionBlock ?? d.startBlock, ShieldedPool: d.ShieldedPool,
    AttestationRegistry: d.AttestationRegistry, MockERC20: d.MockERC20, relayer: d.relayer, directory };
}
export function validateProfile(p) {
  need(p && typeof p === "object", "profile");
  need(typeof p.id === "string" && /^[a-z0-9-]{1,32}$/.test(p.id), "id");
  if (p.role === "console") {
    need(Array.isArray(p.banks) && p.banks.length === 2, "console banks");
    const banks = p.banks.map(validateProfile);
    need(banks.every((b) => b.role === "bank"), "console banks");
    const regulator = validateProfile(p.regulator);
    need(regulator.role === "regulator", "console regulator");
    return { id: p.id, role: "console", name: "Console", banks, regulator, dep: banks[0].dep };
  }
  need(p.role === "bank" || p.role === "regulator", "role");
  need(name(p.name), "name");
  const dep = cleanDep(p.dep);
  if (p.role === "bank") {
    need(p.keys && key32(p.keys.ethKey) && key32(p.keys.spendingKey) && key32(p.keys.viewingPriv) && key32(p.relayerKey), "bank keys");
    need(p.keys.name === p.name && p.name in dep.directory, "bank name");
    return { id: p.id, role: "bank", name: p.name, keys: { name: p.name, ethKey: p.keys.ethKey, spendingKey: p.keys.spendingKey, viewingPriv: p.keys.viewingPriv }, relayerKey: p.relayerKey, dep };
  }
  need(Array.isArray(p.viewingKeys) && p.viewingKeys.length > 0 && p.viewingKeys.every((k) => name(k.name) && key32(k.viewingPriv)), "viewing keys");
  return { id: p.id, role: "regulator", name: p.name, viewingKeys: p.viewingKeys.map((k) => ({ name: k.name, viewingPriv: k.viewingPriv })), dep };
}

export function validateWatch(w) {
  need(w && typeof w === "object", "watch link");
  need(Number.isSafeInteger(w.chainId) && okChain(w.chainId), "chain (Sepolia only)");
  need(Number.isSafeInteger(w.startBlock) && w.startBlock >= 0, "start block");
  need(isAddr(w.ShieldedPool) && isAddr(w.MockERC20), "addresses");
  need(w.relayer === undefined || isAddr(w.relayer), "relayer");
  const names = {};
  for (const [a, nm] of Object.entries(w.names || {})) { need(isAddr(a) && name(nm), "names"); names[a.toLowerCase()] = nm; }
  // Audience links use the chain's public endpoint. A link may name an RPC only for a node on
  // this computer (testing), so a shared link can never point viewers at someone else's RPC.
  // (The chain's own public endpoint is accepted too: validated data is stored with it filled in.)
  if (w.rpcUrl !== undefined && w.rpcUrl !== PUBLIC_RPC[w.chainId]) { let h = ""; try { h = new URL(w.rpcUrl).hostname; } catch {} need(isLocalHost(h), "RPC URL in an audience link"); }
  const rpcUrl = w.rpcUrl !== undefined ? rpc(w.rpcUrl) : PUBLIC_RPC[w.chainId];
  need(!!rpcUrl, "chain (no public RPC known for it)");
  return { chainId: w.chainId, rpcUrl, startBlock: w.startBlock, ShieldedPool: w.ShieldedPool, MockERC20: w.MockERC20, relayer: w.relayer, names };
}
// Audience link for a console/bank profile's own session, built from its deployment.
export function watchFromDep(dep) {
  const w = { chainId: dep.chainId, startBlock: dep.sessionBlock ?? dep.startBlock, ShieldedPool: dep.ShieldedPool, MockERC20: dep.MockERC20, relayer: dep.relayer,
    names: Object.fromEntries(Object.entries(dep.directory).map(([nm, d]) => [d.address, nm])) };
  const rpc = publicRpcFor(dep.chainId, dep.rpcUrl);
  if (rpc !== PUBLIC_RPC[dep.chainId]) w.rpcUrl = rpc;
  return w;
}

// Takes #setup=… or #watch=… from the address bar, stores what it carries, and replaces the
// fragment so keys do not stay on screen. Returns an error message for a bad link.
export function takeLinkFromHash() {
  const m = location.hash.match(/^#(setup|watch)=([A-Za-z0-9_-]+)$/);
  if (!m) return null;
  try {
    if (m[1] === "watch") {
      const w = validateWatch(b64urlDecode(m[2]));
      store.set("privateeth.watch.v1", JSON.stringify(w));
      history.replaceState(null, "", "#watch");
      return null;
    }
    const prof = validateProfile(b64urlDecode(m[2]));
    const all = loadProfiles();
    // Opening a link must not silently replace roles from another demo on this device.
    const ids = prof.role === "console" ? ["console", ...prof.banks.map((b) => b.id), prof.regulator.id] : [prof.id];
    const clash = ids.some((id) => all[id] && (all[id].dep?.ShieldedPool !== prof.dep.ShieldedPool || JSON.stringify(all[id].keys || all[id].viewingKeys || all[id].banks) !== JSON.stringify(prof.keys || prof.viewingKeys || prof.banks)));
    if (clash && !confirm(`This link replaces the "${prof.name}" role already on this device (from another demo session). Replace it?`)) {
      history.replaceState(null, "", "#");
      return null;
    }
    const put = (p) => { all[p.id] = p; store.del("privateeth.state." + p.id); };
    if (prof.role === "console") { prof.banks.forEach(put); put(prof.regulator); }
    put(prof);
    saveProfiles(all);
    store.set("privateeth.watch.v1", JSON.stringify(watchFromDep(prof.dep)));
    history.replaceState(null, "", "#" + prof.id);
    return null;
  } catch (e) {
    history.replaceState(null, "", "#");
    return "That link could not be used: " + e.message + ".";
  }
}

export const linkFor = (profile) => `${siteBase()}#setup=${b64urlEncode(profile)}`;
export const watchLinkFor = (w) => `${siteBase()}#watch=${b64urlEncode(w)}`;
export const loadWatch = () => { try { return validateWatch(JSON.parse(store.get("privateeth.watch.v1"))); } catch { return null; } };
// Removes role keys and state. The setup page's demo account is kept by default: it may hold ETH.
export function forgetAll({ keepAdmin = true } = {}) {
  for (const k of store.keys()) if (k.startsWith("privateeth.") && !(keepAdmin && k === "privateeth.admin.v1")) store.del(k);
}
