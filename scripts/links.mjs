// Prints the private setup links for Bank A, Bank B and the regulator from deployment.json
// and demo-keys/. The keys travel in the URL fragment (#…), which browsers never send to a server.
//   npm run links                    (site URL from SITE_URL, default: the GitHub Pages site)
import { readFileSync, writeFileSync } from "node:fs";
import { loadEnv } from "../lib/chain.js";

export function makeLinks({ site, dep, keys }) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const pubDep = { ...dep, rpcUrl: process.env.WEB_RPC_URL || dep.rpcUrl };
  const bank = (id, k) => ({ id, role: "bank", name: k.name, keys: { name: k.name, ethKey: k.ethKey, spendingKey: k.spendingKey, viewingPriv: k.viewingPriv }, relayerKey: keys.relayer.ethKey, dep: pubDep });
  const roles = {
    "bank-a": bank("bank-a", keys.a),
    "bank-b": bank("bank-b", keys.b),
    regulator: { id: "regulator", role: "regulator", name: "Regulator", viewingKeys: [keys.a, keys.b].map((k) => ({ name: k.name, viewingPriv: k.viewingPriv })), dep: pubDep },
  };
  const base = site.endsWith("/") ? site : site + "/";
  return Object.fromEntries(Object.entries(roles).map(([id, r]) => [id, `${base}#setup=${enc(r)}`]));
}

export function printLinks(site) {
  const dep = JSON.parse(readFileSync("deployment.json", "utf8"));
  const read = (f) => JSON.parse(readFileSync(`demo-keys/${f}`, "utf8"));
  const links = makeLinks({ site, dep, keys: { a: read("bank-a.json"), b: read("bank-b.json"), relayer: read("relayer.json") } });
  const text = Object.entries(links).map(([id, url]) => `${id.toUpperCase()}\n${url}\n`).join("\n");
  writeFileSync("demo-links.txt", text);
  console.log("\nPrivate links (also saved in demo-links.txt). They contain testnet keys: share only with presenters.\n");
  console.log(text);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  loadEnv();
  printLinks(process.env.SITE_URL || "https://hub.entethalliance.org/privateeth/");
}
