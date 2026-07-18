# `agent/` — the autonomous loop

| File | Role |
|------|------|
| `feed.mjs` | TxLINE ingestion: resumable SSE odds + scores streams, the consensus trail per market (bookmaker 10021 = the demargined fair price both strategies key on) |
| `strategy.mjs` | **Read this first.** The shared steam signal and both agents' full decision math — detection thresholds, belief models, fractional-Kelly staking — documented line by line so every duel is reproducible from the public odds trail |
| `index.mjs` | The 60-second loop: evaluate markets → open duels → commit on-chain → settle by proof. Also re-proves the showcase loop every 36 h (devnet prunes tx history) and serves the dashboard's state API on `:8802` |
| `chain.mjs` | On-chain lifecycle: `commit_duel`, consolidated-proof discovery (binary search over the per-fixture seq space), `settle_duel` with real Merkle proofs |
| `settle.mjs` | Paper-mode grading for the pre-on-chain era, against proof-backed reference markets |

Run modes: `node index.mjs` (paper) · `PA_MODE=live node index.mjs` (on-chain, needs
`../operator-key.json` + `../.env.txline` — see `.env.txline.example` at the repo root).
