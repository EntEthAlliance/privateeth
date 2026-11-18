# PrivateEth

**Private payments between banks, on a public blockchain. A live demo you run from your browser.**

👉 **https://hub.entethalliance.org/privateeth/**

Two banks pay each other on Ethereum's Sepolia test network. Anyone watching the chain sees money go into a shared pool and come out again, but **not who paid whom, or how much**. A regulator holding viewing keys can still read every payment.

There is nothing to install and no server: the zero-knowledge proofs are made in the page, and the page sends the transactions to Sepolia itself. It is built on the shielded pool from [ethsystems/pocs](https://github.com/ethsystems/pocs), with its contracts, its circuits and real proofs checked on-chain.

> ⚠️ **Testnet only.** This is a research prototype with no professional audit. Use a MetaMask account that holds only Sepolia test ETH, never one with real funds. [SECURITY.md](SECURITY.md) explains what the site asks your wallet for.

---

## Run the demo in 10 minutes

**You need:** a browser with MetaMask, and about 0.05 Sepolia test ETH (free from any Sepolia faucet).

1. Open **https://hub.entethalliance.org/privateeth/#setup** and read the safety notice.
2. **Connect MetaMask.** The page switches it to Sepolia if needed.
3. **Fund the demo account.** You confirm **one** transaction in MetaMask: test ETH to a demo account the page creates in your browser. After that, MetaMask is disconnected and never asked again.
4. **Deploy the contracts.** About 5 minutes, only the first time. Later demos reuse them.
5. **Create a demo session.** About 2 minutes: Bank A gets 1,000 test dollars (tUSD), Bank B gets 500.
6. **Open the console** on the presenting screen. Show the **audience QR code** so people can follow along on their phones.

Afterwards, click **Send the demo account's ETH back to MetaMask** on the setup page.

## What the audience sees

Press **Run step** six times. Each step is a real Sepolia transaction.

| Step | What happens | What the public chain shows |
|---|---|---|
| 1. Bank A deposits | 1,000 tUSD goes into the pool | Bank A, 1,000 tUSD |
| 2. Bank B deposits | 500 tUSD goes into the pool | Bank B, 500 tUSD |
| 3. **Bank A pays Bank B 700** | A proof is made in the browser and sent | **No sender, no recipient, no amount** |
| 4. Bank B withdraws | 700 tUSD leaves the pool to a new address | That address and 700 tUSD, but not where it came from |
| 5. A replay is rejected | The same withdrawal is sent again | A failed transaction: money can't be spent twice |
| 6. The regulator reads it | Viewing keys open the sealed payment | "Bank A → Bank B, 700 tUSD", for the regulator only |

The **audience link** (from the QR code) shows the same chain from the outside, the way any analyst or competitor would see it. It holds no keys and never asks for a wallet.

## Check for yourself that it's private

After step 3, the console and the audience page show **"Is the payment really private?"**, filled in from the real transactions:

| | A deposit (public on purpose) | The private payment |
|---|---|---|
| "ERC-20 Tokens Transferred" on Etherscan | Yes: 1,000 tUSD | No, none |
| Amount visible | 1,000 tUSD | No |
| Who sent it ("From") | Bank A | Only the relayer, not the bank |
| Who received it | The shielded pool | Not on-chain |

Each column has an **Open on Etherscan** button, so anyone can confirm this on Etherscan itself. Example from a real run:
- [a deposit](https://sepolia.etherscan.io/tx/0x145c6c5f7cea635c24691d54325b58bc8a4197dd329429c39230fabd48d2e7e4): 1,000 tUSD moves, and you can see who sent it
- [the private payment](https://sepolia.etherscan.io/tx/0x26cab0157a39853da0e94dc48bfa8a319d8e72a27ab85058bd4ba3adb8dfd5a5): no tokens move, it is sent by the relayer, and its data is hashes and sealed bytes of a fixed size, whatever the amount

The amount isn't hidden or redacted: the contract simply has no field for it.

## How it works, in one picture

Think of the pool as a vault full of identical sealed envelopes.

- **Depositing** puts money in the vault and gets back a sealed envelope (a *note*) that only its owner can open. This step is public.
- **Paying** swaps envelopes inside the vault. The bank proves, with a zero-knowledge proof, that it owns enough and isn't spending anything twice, without showing which envelope is its own. The chain only records new sealed envelopes and "spent" tags.
- **Withdrawing** opens an envelope and takes money out to an address. This step is public too.
- **Viewing keys** let a regulator open the envelopes and read them, but not spend them.

## What it could be used for

The demo uses banks, but the pattern fits any case where companies need to settle on a shared ledger without showing their business to competitors:

- **Payments between banks** and tokenized-deposit networks
- **Paying suppliers**, without revealing prices or volumes to rivals
- **Payroll and treasury moves** that shouldn't be public
- **Moving funds inside a group of companies**

In every case, regulators and auditors keep full visibility through viewing keys, and only approved participants can use the pool (here, a compliance attester approves both banks).

## Be upfront about the limits

- **Two banks is a small crowd.** The audience saw Bank A deposit 1,000, so "the 700 came from Bank A" is an easy guess. Privacy grows with the number of users.
- **One demo account funds everything,** and Etherscan shows that link.
- **Testnet keys live in the presenter's browser.** That's fine for test funds, not for anything real.
- **One action at a time.** Both banks share one relayer.
- **Note encryption added here.** The original project leaves the sealed notes empty in its tests, so this demo adds a simple encryption (secp256k1 + ChaCha20-Poly1305) with a fixed size.

---

## For developers

You don't need any of this to run the demo. With Node.js 20 or newer:

```bash
npm install
```

```bash
npm run dev
```

Every push to `main` builds the site and publishes it to GitHub Pages (`.github/workflows/pages.yml`).

Command-line versions of the setup also exist, for rehearsing without a browser: `npm run setup` (reads `RPC_URL` and `DEPLOYER_KEY` from `.env`, see `.env.example`), `npm run selftest`, and `npm run local-a` / `local-b` / `local-regulator`.

| Path | What it is |
|---|---|
| `web/app/setup.js` | Setup page: MetaMask funding, deployment, sessions |
| `web/app/console.js` | The one-screen story |
| `web/app/watch.js`, `feed.js` | Audience view and the public chain feed |
| `web/app/verify.js` | "Is the payment really private?" |
| `web/app/roles.js` | Separate Bank A, Bank B and Regulator screens |
| `lib/core.js` | Keys, notes, note encryption, chain scanning |
| `lib/actions.js`, `lib/deploy.js` | Deposit, pay, withdraw, replay; deployment and sessions |
| `contracts/src/` | Contracts from ethsystems/pocs, with verifiers regenerated by the bb.js version that makes the proofs (`5.0.0-nightly.20260324`) |
| `web/public/circuits/` | Compiled Noir circuits |

Fast proving needs cross-origin isolation, which GitHub Pages can't set, so `web/public/coi-serviceworker.js` adds it. It reloads the page once on the first visit.

## Credits and licences

MIT licensed, by the [Enterprise Ethereum Alliance](https://entethalliance.org). It includes code from [ethsystems/pocs](https://github.com/ethsystems/pocs) (MIT OR Apache-2.0). The generated verifiers in `contracts/src/verifiers/` carry Barretenberg's Apache-2.0 header (see `contracts/LICENSE-APACHE`). [coi-serviceworker](https://github.com/gzuidhof/coi-serviceworker) and [qrcode](https://github.com/soldair/node-qrcode) are MIT.
