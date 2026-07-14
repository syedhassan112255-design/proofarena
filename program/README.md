# `proofarena` — the duel notary program

Anchor 0.31.1 · devnet [`6iDo9DXUcAdXhrdGWCVxuADDZHVdixHuutJPm1g5gD5L`](https://explorer.solana.com/address/6iDo9DXUcAdXhrdGWCVxuADDZHVdixHuutJPm1g5gD5L?cluster=devnet)

An append-only, proof-settled record of agent duels. Two instructions, no admin surface:

| Instruction | Who | What it does |
|---|---|---|
| `commit_duel(duel_seed, params)` | the agent operator | Creates the duel PDA with the **pinned predicate** (stat keys, periods, threshold, comparison, two-stat operator), the kickoff time, and both agents' positions (stake, odds ×1000, belief in basis points). **Rejected if `now >= kickoff_time`** — the chain's clock, not ours, forbids hindsight. |
| `settle_duel(args)` | **anyone** (permissionless) | Verifies `args` matches the pinned predicate (`FixtureMismatch` / `PredicateMismatch` otherwise), CPIs into TxLINE's `validate_stat` with the 3-stage Merkle proof, reads the borsh `bool` from CPI return data, and records `predicate_true` + `settled_at` — forever. Steamer backs the predicate; `predicate_true == true` means Steamer won. |

There is deliberately **no** `amend_duel`, `void_duel`, or `close_duel`. History is
append-only; a bad commitment stays visible (see the NO CONTEST bouts on the dashboard).

## Account model

```
Duel PDA   seeds = ["duel", fixture_id (i64 LE), duel_seed (u64 LE)]
  operator                       — who committed (informational; settle is permissionless)
  fixture_id, duel_seed
  predicate: stat_key_a/b, period_a/b, use_two_stats, op, threshold, comparison
  kickoff_time                   — commit gate
  steamer / fader                — { stake u64, odds_milli u32, belief_bp u16 }
  committed_at                   — chain timestamp at commit (compare with kickoff_time!)
  settled, predicate_true, settled_at
```

## The `validate_stat` CPI
Same battle-tested pattern as [ProofBall](https://github.com/syedhassan112255-design/proofball):
manual instruction build (discriminator `[107,197,232,90,191,136,105,185]`, exact borsh
mirror of TxLINE's types), `ts` = `summary.updateStats.minTimestamp`, daily-root PDA from
epoch-day of that timestamp, result read via `get_return_data()`.

Predicate encoding note: goals keys 1/2, corners 7/8, **period 0** — TxLINE's terminal
"fully consolidated" record class (2026 knockout fixtures never produce the legacy
period-4 records; see `../docs/FEEDBACK.md` for the full story).

## Build

```bash
anchor build   # 211 KB with the size-optimized release profile
```

Proven end-to-end on devnet: commit
[`5BMrGF2f…44Ni`](https://explorer.solana.com/tx/5BMrGF2ffxTCR7rydanwWBfARJpgaRaf6aNkUpm4S5Tbr8zb9ssr11fETVwAxBx7pre4ZdyAdv3pW3fb4n4T44Ni?cluster=devnet)
→ settle
[`5yUSVU9L…vEXU`](https://explorer.solana.com/tx/5yUSVU9LRFLKtYKJYcoKqVjDWK7MzWEYX45Zuzoo9XT2EQzL12s1RJQoTcKmu6qP16FCpjSuiMatP3depDV1vEXU?cluster=devnet).
