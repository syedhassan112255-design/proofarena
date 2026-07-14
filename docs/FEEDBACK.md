# TxLINE API — builder feedback from the ProofArena team

Field notes from running two autonomous agents against the live feed 24/7 through the
knockout rounds. Written in the spirit of "found a bug or disliked an endpoint? tell us" —
here's everything we hit, in order of impact.

## What we loved
- **`TXLineStablePriceDemargined` (bookmaker 10021) is a gift.** A de-vigged consensus
  probability inside the odds stream means an agent doesn't need its own de-margining
  model — the fair price is a first-class feed citizen. This single field powers both of
  our strategies.
- **`validate_stat` as an on-chain verifier** remains the best primitive in the stack:
  our program settles agent duels by CPI with no trusted resolver anywhere.
- **SSE design is clean** — `id:` lines make resumption straightforward, and the odds
  stream's `Pct` field saves everyone a conversion step.

## Friction, in order of how much it hurt

### 1. Stat-record `period` codes are undocumented and changed mid-tournament ⚠️
The June sample records we built against carried `period: 4` for full-match stats — so we
pinned `period = 4` into on-chain predicates (as did our sister project ProofBall, whose
markets settled fine all group stage). During the knockouts, records for new fixtures
evolve through `period` 7 → 9 → 10 → 100 and finally consolidate to **`period: 0`** —
**no period-4 record ever exists for them**. Two of our on-chain duels (Norway v England)
pinned predicates that are now cryptographically unprovable: the commitment is on-chain
forever, and no valid proof can ever match it. We've marked them NO CONTEST on our
dashboard rather than hide them.

**Asks:** document the period-code lifecycle; keep it stable within a tournament; and/or
expose a "final consolidated" alias (e.g. `period=final`) so integrators can pin a
predicate that is guaranteed to be provable after every match.

### 2. `seq` semantics are undocumented
`/api/scores/stat-validation` requires a `seq`, but nothing documents that it's a
**per-fixture record counter**, what its range is, or how to find the final one. If the
integrator misses the live window (restart, network blip), the seq is unrecoverable from
the stream — `Last-Event-ID` replay did not return historical events for us. We now
**binary-search the seq space** (probe `stat-validation` for existence, then bisect to the
highest valid seq) — it works well, but it's 15–20 requests to learn something one
endpoint could tell us.

**Ask:** a `GET /api/scores/records?fixtureId=` (or a `latestSeq` field anywhere) listing
available record seqs + their periods. This one endpoint would remove our entire
discovery machinery.

### 3. No historical replay on the scores stream
Reconnecting with `Last-Event-ID` from a timestamp before a finished match returned only
heartbeats. Combined with (2), any downtime during a match permanently loses the live seq
trail. Replay-from-id (even limited to 48h) would make integrations dramatically more
robust.

### 4. Odds snapshot endpoint absent on the free tier
`/api/odds/snapshot` 404s, so a fresh agent boots blind until the stream warms its book
(~a minute for near fixtures). A snapshot — even rate-limited — would eliminate the
cold-start gap.

### 5. Smaller notes
- Odds stream fields are PascalCase (`FixtureId`, `Prices`), scores stream fields are
  camelCase (`fixtureId`, `seq`) — a consistent casing (or documented schemas per stream)
  would prevent a class of silent-miss bugs.
- `Prices` are decimal odds ×1000 and `Pct` is implied percentage — both correct once
  inferred, neither documented where we could find it.
- The devnet IDL's mint constants for `subscribe` are stale (the live flow uses a
  Token-2022 mint that differs from the IDL constant) — already reported via ProofBall,
  still worth repeating.
