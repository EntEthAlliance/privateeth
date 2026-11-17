# PrivateEth: private payments between banks on Ethereum

**Live site:** https://hub.entethalliance.org/privateeth/

Two banks pay each other on Sepolia. Anyone watching the chain sees money enter and leave a shielded pool, but not who paid whom or how much. A regulator holding viewing keys can still read every payment.

Everything runs in the browser, with no install and no backend. Zero-knowledge proofs are generated in the page, transactions go to a public Sepolia RPC, and MetaMask is only used once, to fund the demo. Built on the shielded pool in [ethsystems/pocs](https://github.com/ethsystems/pocs) (`pocs/private-payment/shielded-pool`): its contracts, its Noir circuits and real proofs checked by on-chain verifiers.

> Research prototype on testnet. Not audited. Never put real funds behind it.

## Run a live demo (browser only)

You need MetaMask with some Sepolia test ETH (from any Sepolia faucet).

1. Open **https://hub.entethalliance.org/privateeth/#setup**.
2. **Connect MetaMask** and switch it to Sepolia if asked.
3. **Fund the demo account.** The page creates a demo account in your browser and suggests an amount based on today's gas price. One MetaMask confirmation. That account does all the remaining transactions, so no more pop-ups.
4. **Deploy the contracts** (about 15 transactions, 4 to 6 minutes, once). Every later session reuses them.
5. **Create the demo session** (about 2 minutes): two banks approved by the compliance attester, 1,000 and 500 test dollars (tUSD), gas for the banks and a relayer.
6. **Open the console** on the presenting screen, and put the **audience QR code** on screen so people can follow the public chain on their phones.

When you are done, **Send the demo account's ETH back to MetaMask** on the setup page.

### The console

The whole story on one screen, with real transactions on Sepolia. Press **Run step** six times:

| Step | What happens | What the public chain shows |
|---|---|---|
| 1. Bank A deposits | 1,000 tUSD moves into the pool (orange coin) | Bank A, 1,000 tUSD |
| 2. Bank B deposits | 500 tUSD moves into the pool | Bank B, 500 tUSD |
| 3. Bank A pays Bank B 700 | Proof made in the browser; a sealed envelope moves from A to B | Sent by the relayer. Sender, recipient and amount are **not on-chain** |
| 4. Bank B withdraws | 700 tUSD leaves the pool to a brand-new address | New address, 700 tUSD; who funded it is not on-chain |
| 5. Replay is rejected | The same withdrawal is sent again and fails | A rejected transaction |
| 6. Regulator reads it | "What the regulator sees" turns on: the sealed notes open | The same data, now read with viewing keys |

The **latest transaction** panel shows what Etherscan shows next to what the viewing keys open, for the transaction just made. Every card links to Etherscan.

### Other screens

The setup page also gives a link and QR code for each role:
- **Bank A**, **Bank B** and **Regulator** open the same story as separate wallets, for a demo on two or three screens.
- **Audience** is the public view, with no keys. Share it freely.

Role links carry that session's testnet keys in the URL fragment (`#…`), which browsers never send to a server. Share them only with the people presenting.

## Proving on Etherscan that the amount is not there

Compare a deposit (the control) with the private payment:

1. **"ERC-20 Tokens Transferred"**: the deposit shows the tUSD moving from the bank to the pool. The payment has none, because no tokens move.
2. **Logs**: the payment's event holds two nullifiers, two commitments and encrypted bytes, all 446 bytes long whatever the amount. There is no amount, sender or recipient field; that is the contract's design, not redaction.
3. **From** is the relayer, not Bank A.
4. **Bank B's address page**: nothing new, while the console shows Bank B's private balance going up.
5. **The pool's tUSD balance** does not change with the payment.

## Be upfront about these

- **Two banks is a tiny crowd.** The audience saw Bank A deposit 1,000, so "the 700 came from Bank A" is an easy guess. Privacy grows with the number of participants.
- **One demo account funds everything.** The banks and the relayer are funded from it, which Etherscan shows.
- **Keys live in this browser.** The demo account and role keys are stored in the browser of the person who set them up. The site shares its origin (`hub.entethalliance.org`) with other EEA project pages. That is fine for disposable testnet keys, not for anything more.
- **One action at a time.** Both banks share one relayer account.
- **What is new here.** The repository's own test leaves the encrypted notes empty, so this demo adds a simple note encryption (secp256k1 ECDH + ChaCha20-Poly1305), padded to a fixed size, instead of the repository's `sealring` envelope.

## For developers

Not needed to run the demo. With Node.js 20 or newer:

```bash
npm install
```

```bash
npm run dev
```

The same setup also exists as a command (`npm run setup`, reads `RPC_URL`, `DEPLOYER_KEY` and `SITE_URL` from `.env`), with a scripted rehearsal (`npm run selftest`) and the wallet as local servers (`npm run local-a`, `local-b`, `local-regulator`).

Pushing to `main` builds the site and publishes it to GitHub Pages (`.github/workflows/pages.yml`).

| Path | What it is |
|---|---|
| `web/main.js` | Router: landing, `#setup`, `#console`, `#watch`, role screens |
| `web/app/setup.js` | MetaMask funding, deployment and sessions in the browser |
| `web/app/console.js`, `stage.js`, `feed.js` | The one-screen story, the animated stage, the public chain feed |
| `web/app/watch.js` | Audience view |
| `web/app/roles.js` | Single-role bank and regulator screens |
| `lib/core.js` | Keys, notes, note encryption, chain scanning, proof inputs |
| `lib/actions.js` | Deposit, private send, withdraw, replay |
| `lib/deploy.js` | Deployment and demo sessions (browser and Node) |
| `web/public/circuits/`, `web/public/contracts.json` | Compiled Noir circuits and contracts |
| `contracts/src/` | Contracts from ethsystems/pocs, with verifiers regenerated by the same bb.js version that proves (`5.0.0-nightly.20260324`); their key hashes match the repository's |

Multi-threaded proving needs cross-origin isolation, which GitHub Pages cannot set as headers; `web/public/coi-serviceworker.js` adds them (it reloads the page once on the first visit).

## Credits and licences

This repository is MIT-licensed. It includes code from [ethsystems/pocs](https://github.com/ethsystems/pocs) (MIT OR Apache-2.0); the generated verifiers in `contracts/src/verifiers/` carry Barretenberg's Apache-2.0 header (see `contracts/LICENSE-APACHE`). [coi-serviceworker](https://github.com/gzuidhof/coi-serviceworker) and [qrcode](https://github.com/soldair/node-qrcode) are MIT.
