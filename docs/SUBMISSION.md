# ProofArena — Superteam Earn Submission (ready to paste)

**Track:** TxLINE agentic track (autonomous agents on live TxLINE data)
**Deadline:** Jul 19, 2026 · 23:59 UTC

## Project name
ProofArena — Two Agents, One Feed, Only Proof Decides

## One-liner
Two autonomous agents with opposite philosophies (momentum vs mean-reversion) duel on live
TxLINE World Cup odds — every duel committed to Solana before kickoff, every winner decided
by a Merkle-proof CPI into `validate_stat`. No human input. No editable history.

## Links
| Field | Value |
|---|---|
| Live app | https://proofarena-live.vercel.app |
| Demo video | ← paste YouTube/Loom link |
| GitHub repo | https://github.com/syedhassan112255-design/proofarena |
| Program (devnet) | `6iDo9DXUcAdXhrdGWCVxuADDZHVdixHuutJPm1g5gD5L` |
| Settled duel account (persists) | `ADmWjf4sHYRuoPcYEcntyaFoQqCDNjxCCr6ysWTp6xgR` |
| Fresh commit + settle txs | on the ⚡ SHOWCASE bout at proofarena-live.vercel.app — re-proven on-chain every 36h (devnet prunes old tx history) |
| Tech docs | `docs/TECHNICAL.md` in repo |
| API feedback | `docs/FEEDBACK.md` in repo |

## Description (paste into the form)
ProofArena answers a question every algorithmic trader hand-waves: how do you PROVE a
strategy's track record? Our answer: make the blockchain the notary and the data feed the
referee.

Two autonomous agents run 24/7 against TxLINE's live World Cup feed. Both watch the same
demargined consensus (TXLineStablePriceDemargined). When it moves decisively before
kickoff, Agent A "Steamer" backs the move (closing-line-value logic) and Agent B "Fader"
takes the opposite side (overreaction/mean-reversion). Each sizes its stake with
fractional Kelly from its own bankroll — the full decision math is documented in the repo
and every parameter is deterministic.

The duel — both positions, stakes, beliefs, and the exact predicate — is committed to our
Solana program BEFORE kickoff; the program rejects late commitments using the chain's own
clock, so hindsight picks are structurally impossible. After the match, anyone can settle:
the program re-checks the predicate against what was committed and CPIs into TxLINE's
on-chain validate_stat with the real 3-stage Merkle proof. The proof decides the winner.
There is no instruction to amend or delete a duel — losses cannot be buried.

The fight-card dashboard shows the live bankroll race and every duel with its
duel-account, commit-tx, and settle-tx Explorer links — including two duels we
transparently marked NO CONTEST after a TxLINE period-code change made their pinned
predicates unprovable (full write-up in our API feedback; the agents' predicate encoding
now pins the consolidated record class and the settle path discovers the final proof
by binary-searching the seq space, so the loop is robust to feed restarts and schema
drift).

Autonomy: the agents run under pm2 with zero human input — signal detection, duel
construction, on-chain commitment, proof discovery, and settlement are all programmatic.

## TxLINE integration (endpoints used)
`POST /auth/guest/start` · on-chain `subscribe` + `POST /api/token/activate` ·
`GET /api/fixtures/snapshot` · `GET /api/odds/stream` (SSE — the agents' primary input) ·
`GET /api/scores/stream` (SSE) · `GET /api/scores/stat-validation` (Merkle proofs) ·
on-chain `validate_stat` (settlement CPI).

## API feedback (short version)
Full notes in `docs/FEEDBACK.md`. Highlights: the demargined consensus book is a gift —
it powers both strategies with zero de-vigging code on our side. Friction: stat-record
`period` codes are undocumented and changed mid-tournament (7/9/10/100→0 vs the legacy 4),
which permanently orphaned two of our on-chain commitments; `seq` semantics are
undocumented (it's a per-fixture record counter — we now binary-search it); the scores
stream has no historical replay; and no odds snapshot exists on the free tier, so agents
cold-start blind. One `records?fixtureId=` index endpoint would remove most of this.

## Judge walkthrough
1. Open https://proofarena-live.vercel.app — the bankroll race and fight card are live
   state from the agents (the header shows "agents live · live mode").
2. On the ⚡ SHOWCASE bout, click "commit tx" and "settle tx" — see `commit_duel`, then
   `settle_duel` CPI-ing into TxLINE `validate_stat` on Solana Explorer. (The agent
   re-proves this loop on a fresh duel every 36 hours, so these links never go stale
   even though devnet prunes transaction history.)
3. On any duel, compare the on-chain `committed_at` with the fixture kickoff — every
   commitment precedes it. The program has no amend/delete instruction: read
   `program/programs/proofarena/src/lib.rs` (~330 lines).
