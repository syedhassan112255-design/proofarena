# ProofArena — Technical Documentation

## Core idea
ProofArena is an **autonomous agent-vs-agent trading experiment** on live TxLINE World Cup
data. Two agents with opposite market philosophies — **Steamer** (momentum) and **Fader**
(mean-reversion) — read the same demargined consensus feed. When a pre-kickoff steam signal
fires, they take opposite sides of it, and the duel is **committed to Solana before kickoff**.
After the match, settlement is a **CPI into TxLINE's on-chain `validate_stat`**, which
verifies a 3-stage Merkle proof of the real match statistic against TxLINE's published daily
root. The proof — not the operator — decides which agent won. There is no instruction to
amend or delete a duel: the scoreboard is unfakeable by construction.

## Business & technical highlights
- **Business:** algorithmic-trading track records are unverifiable — logs get edited, losing
  trades vanish, backtests masquerade as live results. ProofArena is a working template for
  **provable strategy performance**: commitments notarized by the chain's clock, outcomes
  graded by cryptographic proof. The same rails apply to any quant strategy on any
  TxLINE-covered sport — a B2B primitive for funds, tipsters, and trading desks that want
  audit-grade track records.
- **Technical:** fully autonomous loop (signal → duel → on-chain commit → proof settlement)
  with zero human input; a pre-kickoff commitment gate enforced by the chain's own clock;
  deterministic, fully documented strategy math (steam detection + fractional Kelly, see
  `agent/strategy.mjs`); settlement that survives restarts by discovering the final
  consolidated proof record directly from the API (binary search over the per-fixture seq
  space) instead of depending on stream uptime.

## How a duel lives and dies
1. **Signal.** The demargined consensus (bookmaker 10021) moves ≥3.0 points inside a
   45-minute window before kickoff with ≥70% trend purity.
2. **Duel.** Steamer backs the move (belief: drift continues), Fader backs the other side
   (belief: overshoot reverts). Each sizes with quarter-Kelly from its own 10,000-unit
   bankroll.
3. **Commit.** `commit_duel` writes the pinned predicate + both positions to a duel PDA.
   The program rejects commits at or after `kickoff_time` — hindsight is impossible.
4. **Settle.** After full time, the agent locates the fixture's **final consolidated proof
   record** (period 0) and calls `settle_duel`, which re-checks the predicate against what
   was pinned and CPIs into `validate_stat`. `predicate_true == true` ⇒ Steamer won.
5. **Ledger.** Bankrolls and W–L records update; the dashboard renders every duel with its
   duel-account, commit-tx and settle-tx Explorer links.

## On-chain program
- Program: `proofarena` (Anchor 0.31.1), devnet ID `6iDo9DXUcAdXhrdGWCVxuADDZHVdixHuutJPm1g5gD5L`.
- Instructions: `commit_duel` (pre-kickoff gate, pinned predicate, both agents' positions),
  `settle_duel` (permissionless, predicate re-check, manual CPI into TxLINE `validate_stat`,
  reads the borsh bool from CPI return data).
- No SPL dependencies — stakes are virtual units from the agents' public bankroll ledger,
  keeping the binary at 211 KB and the trust story focused on commitments, not custody.
- Proven end-to-end on devnet:
  commit [`5BMrGF2f…44Ni`](https://explorer.solana.com/tx/5BMrGF2ffxTCR7rydanwWBfARJpgaRaf6aNkUpm4S5Tbr8zb9ssr11fETVwAxBx7pre4ZdyAdv3pW3fb4n4T44Ni?cluster=devnet)
  → settle [`5yUSVU9L…vEXU`](https://explorer.solana.com/tx/5yUSVU9LRFLKtYKJYcoKqVjDWK7MzWEYX45Zuzoo9XT2EQzL12s1RJQoTcKmu6qP16FCpjSuiMatP3depDV1vEXU?cluster=devnet)
  (both programs visible in the logs).

## TxLINE endpoints used
| Endpoint | Purpose |
|----------|---------|
| `POST /auth/guest/start` | guest JWT |
| on-chain `subscribe(serviceLevelId, weeks)` + `POST /api/token/activate` | API token (free World Cup tier) |
| `GET /api/fixtures/snapshot?competitionId=72` | fixture list + kickoff times |
| `GET /api/odds/stream` (SSE) | **live consensus odds — the agents' primary sensory input** (incl. `TXLineStablePriceDemargined`, bookmaker 10021) |
| `GET /api/scores/stream` (SSE) | live scores + per-fixture record seq |
| `GET /api/scores/stat-validation?fixtureId&seq&statKey` | 3-stage Merkle proof for settlement |
| on-chain `validate_stat` (CPI) | trustless settlement — the verification layer |

## Repo layout
- `agent/` — feed ingestion, strategy math, autonomous loop, on-chain lifecycle
- `program/` — the Anchor program (see `program/README.md` for the account model)
- `site/` — the fight-card dashboard (live at https://proofarena-live.vercel.app)
- `docs/` — this file, `FEEDBACK.md` (TxLINE API field notes), `SUBMISSION.md`
