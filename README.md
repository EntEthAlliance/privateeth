# PrivateEth: private payments between banks on Ethereum

**Live site:** https://entethalliance.github.io/privateeth/

Two banks pay each other on Sepolia. Anyone watching the chain sees money enter and leave a shielded pool, but not who paid whom or how much. A regulator holding viewing keys can still read every payment.

Everything runs in the browser: the zero-knowledge proofs are generated in the page, transactions go to a public Sepolia RPC, and there is no backend. Built on the shielded pool in [ethsystems/pocs](https://github.com/ethsystems/pocs) (`pocs/private-payment/shielded-pool`): its contracts, its Noir circuits and real proofs checked by on-chain verifiers.

> Research prototype on testnet. Not audited. The setup links carry testnet keys; never put real funds behind them.

## How a demo works

1. **Once:** run the setup script. It deploys the contracts to Sepolia, approves two banks, gives them test dollars (tUSD) and gas, and prints three private links: **Bank A**, **Bank B** and **Regulator**.
2. **On the day:** open each link on its own screen (or in its own window). The page stores that role's keys in the browser and turns into that bank's wallet.
3. Bank A deposits, then pays Bank B privately. Bank B's screen picks the payment up from the chain. Etherscan shows that the payment has no amount, sender or recipient. The regulator opens the same transaction with the viewing keys.

## Set up (the evening before)

You need Node.js 20 or newer and a Sepolia account with test ETH (gas on Sepolia is close to free; 0.3 ETH is plenty).

```bash
npm install
```

```bash
cp .env.example .env
```

Put your Sepolia RPC URL and the deployer's private key in `.env`, then:

```bash
npm run setup
```

This takes a few minutes and ends by printing the three links (also saved to `demo-links.txt`). To print them again later without redeploying:

```bash
npm run links
```

**Optional rehearsal without a browser** (uses up the banks' balances, so run `npm run setup` again afterwards):

```bash
npm run selftest
```

## On stage

| # | Screen | What happens |
|---|---|---|
| 1 | Bank A and Bank B | Public wallets show 1,000 and 500 tUSD. Wait for **PROOF ENGINE · READY** in the header. |
| 2 | Bank A: **Deposit** | Public: Etherscan shows Bank A sending 1,000 tUSD to the pool. |
| 3 | Bank B: **Deposit** | Same, 500 tUSD. |
| 4 | Bank A: **Send privately** 700 to Bank B | The proof is generated in the browser (a few seconds); a relayer account submits it. |
| 5 | Bank B | "Received 700 tUSD privately". Private balance goes up; the public wallet does not move. |
| 6 | Etherscan, the payment | See the checklist below. |
| 7 | Bank B: **Open** the payment | Left: what Etherscan shows. Right: Bank B's key opens its 700 note, not Bank A's change. |
| 8 | Regulator: same hash | Both notes open: 700 to Bank B, 300 change to Bank A. |
| 9 | Bank B: **Withdraw** the 700 note | Public again: a brand-new address receives 700. |
| 10 | Bank B: **Replay last withdrawal** | Rejected on-chain: a spent note cannot be spent twice. |

### Proving on Etherscan that the amount is not there

Compare the deposit (the control) with the private payment:

1. **"ERC-20 Tokens Transferred"**: the deposit shows 1,000 tUSD from Bank A to the pool. The payment has none, because no tokens move.
2. **Logs**: the payment's event holds two nullifiers, two commitments and encrypted bytes. There is no amount, sender or recipient field; that is the contract's design, not redaction. Etherscan shows the log raw (the contracts are not verified there); the wallet's **Open** panel shows it decoded.
3. **From** is the relayer, not Bank A.
4. **Bank B's address page**: no new transaction and an unchanged tUSD balance, while Bank B's screen shows +700.
5. **The pool's tUSD balance** does not change with the payment.

## Be upfront about these

- **Two banks is a tiny crowd.** The audience saw Bank A deposit 1,000, so "the 700 came from Bank A" is an easy guess. Privacy grows with the number of participants.
- **Funding links.** Setup funds the relayer and both banks from the same deployer, which Etherscan shows. For the cleanest version, fund the relayer from a faucet.
- **Keys in links.** The links carry the banks' testnet keys in the URL fragment (`#…`), which browsers never send to a server. The page stores them in that browser; the landing page has a button to forget them.
- **What is new here.** The repo's own test leaves the encrypted notes empty, so this demo adds a simple note encryption (secp256k1 ECDH + ChaCha20-Poly1305) instead of the repo's `sealring` envelope. The memo "from Bank A" sits inside the encrypted note.

## Run it without the website

The same wallet also runs as three local Node servers (useful offline or if the venue blocks the site):

```bash
npm run local-a
```

```bash
npm run local-b
```

```bash
npm run local-regulator
```

Then open http://localhost:3001, :3002 and :3003.

## Develop

```bash
npm run dev
```

```bash
npm run build
```

Pushing to `main` rebuilds the site and publishes it to the `gh-pages` branch (`.github/workflows/pages.yml`).

| Path | What it is |
|---|---|
| `web/` | The website: `main.js` (wallet UI and roles), `style.css`, `public/circuits/` (compiled Noir circuits) |
| `lib/core.js` | Keys, notes, note encryption, chain scanning, proof inputs |
| `lib/actions.js` | Deposit, private send, withdraw, replay (shared by browser and Node) |
| `scripts/setup.mjs`, `scripts/links.mjs` | Deploy, approve, fund; print the private links |
| `contracts/src/` | Contracts from ethsystems/pocs, with verifiers regenerated by the same bb.js version that proves (`5.0.0-nightly.20260324`); their key hashes match the repo's |
| `artifacts/` | Compiled contracts, so setup needs only Node |
| `local/` | The Node-server version of the wallet |

To rebuild the verifiers after changing circuits: `npm run rebuild-verifiers` (needs Foundry).

Multi-threaded proving needs cross-origin isolation, which GitHub Pages cannot set as headers; `web/public/coi-serviceworker.js` adds them (it reloads the page once on first visit).

## Credits and licences

This repository is MIT-licensed. It includes code from [ethsystems/pocs](https://github.com/ethsystems/pocs) (MIT OR Apache-2.0); the generated verifiers in `contracts/src/verifiers/` carry Barretenberg's Apache-2.0 header (see `contracts/LICENSE-APACHE`). [coi-serviceworker](https://github.com/gzuidhof/coi-serviceworker) is MIT.
