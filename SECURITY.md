# Security

This is a **testnet demo**. It runs on Sepolia, uses test tokens with no value, and has not had a professional audit. This page explains what the site does with your wallet, what we checked, what we changed, and what we recommend.

## What the site asks MetaMask for

Only the setup page (`#setup`) talks to MetaMask, and it asks for exactly this:

| Request | Why |
|---|---|
| `eth_requestAccounts`, `eth_accounts`, `eth_chainId` | Connect, and read the network |
| `wallet_switchEthereumChain` / `wallet_addEthereumChain` | Switch to Sepolia (hard-coded) |
| **One `eth_sendTransaction`** | A plain ETH transfer, of the amount you type, to the demo account shown on the page. The request names Sepolia (`chainId: 0xaa36a7`), so MetaMask rejects it on any other network |
| `wallet_revokePermissions` | Disconnects the site from MetaMask after funding and after returning the ETH |

It **never** asks for signatures (`personal_sign`, `eth_sign`, typed data or Permit), token approvals, or anything on Ethereum mainnet. **If MetaMask shows any other request on this site, reject it.**

Nothing else on the site (landing, console, bank and regulator screens, audience view) uses MetaMask at all.

## Keys the site creates

- **The demo account.** Created in your browser on the setup page; MetaMask funds it once. It deploys the contracts and pays for the demo session.
- **Bank A, Bank B and the relayer.** Created per session and funded from the demo account.
- **Viewing keys.** They let the regulator screen read payments.

All of these are **testnet keys stored in the browser (localStorage)**, and in the role links and QR codes. Anyone with them can use the demo's test funds, nothing else. The "Send all remaining ETH back to MetaMask" button returns what is left in every one of these accounts. None of them is ever related to your MetaMask key.

## How we checked

We ran an independent review with five auditors, each covering one area:
- the MetaMask flow
- keys in the browser
- supply chain and hosting
- injection
- risk to visitors

Two more reviewers then tried to refute each finding. We also tested the whole flow in a browser with an injected wallet, on a fork of Sepolia: setup, the six demo steps, the audience view, a second session, and returning the ETH. A run on live Sepolia follows (see below).

**Conclusion:** we found no way for this site's code to move a visitor's real funds or read their MetaMask key. The remaining risks come from where the site is hosted (below).

## What we fixed

| Finding | Fix |
|---|---|
| **High.** A transaction hash returned by the RPC was put into an Etherscan link without escaping, so a malicious RPC could inject script | Links are built only from validated hashes and addresses. RPC logs that are not well-formed are dropped at the edge, and decrypted note fields are type-checked |
| The funding request carried no chain ID, so a network switch at the last moment could move it to another chain | The request is bound to Sepolia (`chainId` in the request). The page re-checks the network just before asking |
| The MetaMask connection stayed open after use | The site disconnects itself after funding and after returning ETH. There is also a Disconnect button |
| Setup and audience links could point the page at any RPC, including plain http | Links are limited to Sepolia, https RPCs (http only for a local node), and audience links always use the public endpoint |
| A private RPC URL (with its API key) went into role links and QR codes | Links always carry the public endpoint; a private URL stays on the setup device |
| The key backup suggested importing the demo key into MetaMask | That advice is removed. The key is shown only after a confirmation, labelled Sepolia-only |
| QR codes with keys were always visible on the setup page | They are hidden until you click Reveal; only the audience QR code (no keys) shows openly |
| Opening a link could silently replace roles from another demo | The page asks first |
| No Content-Security-Policy | The page runs only its own scripts. WebAssembly is allowed for the proofs; network access is limited to https and local test nodes |
| The page could run inside another site's frame | It refuses to run when framed |
| Stored data was trusted | The saved setup record is shape-checked when loaded |
| Deployment had three publish paths and a third-party action with a write token | One path (GitHub Pages' own deployment) from `main` only, with actions pinned to commit SHAs |

## What remains, and what we recommend

**1. Give the demo its own domain (most important).** The site lives at `hub.entethalliance.org/privateeth/`, a path on a domain shared with other EEA project pages, one of which loads Google Analytics. Browsers grant MetaMask connections and browser storage per domain, not per path. So:
- while you are connected, any page on that domain could ask MetaMask for a signature that appears to come from `hub.entethalliance.org`
- any page on that domain can read the demo's testnet keys

The auto-disconnect limits the first risk to the minutes you are connected. The fix is a dedicated subdomain (for example `privateeth.entethalliance.org`), with no analytics on it.

**2. Settings only an organisation admin can change:**
- Turn on **Enforce HTTPS** for the organisation's Pages domain.
- Protect `main` (required review, no force-push), since every push to `main` publishes the site.

**3. Smaller items, to do if the demo outlives this event:**
- Self-host the fonts, removing the last third-party request that is not chain data.
- Move from the nightly `@aztec/bb.js` to a stable release once one matches the verifier version.
- Check the downloaded proving parameters against a pinned hash.

### For presenters

- Use a **separate MetaMask account, ideally in a separate browser profile, holding only Sepolia test ETH**. Never use an account that holds real assets.
- Check the address bar: `https://hub.entethalliance.org/privateeth/`.
- MetaMask should show **one** request: an ETH transfer on Sepolia to the demo account. Reject anything else.
- Keep role links and their QR codes off projected screens; project the console or the audience view.
- After the demo: **Send all remaining ETH back to MetaMask**, check that MetaMask shows the site as disconnected, then clear the site's data in the browser (or close the private window).

### For the audience

The audience view and the QR code carry no keys and never ask for a wallet. Every card links to Etherscan, so you can check for yourself that the private payment shows no amount, sender or recipient.

## Reporting a problem

Open an issue on this repository. Please do not post keys from a real wallet.
