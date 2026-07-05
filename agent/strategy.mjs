// strategy.mjs — deterministic pick engine.
//
// ProofPicks runs ONE strategy, stated here in full so every pick is
// reproducible from the public odds trail:
//
//   STEAM-FOLLOWING WITH PROVABLE SETTLEMENT
//   ----------------------------------------
//   The TxLINE demargined consensus (bookmaker 10021) is the de-vigged fair
//   probability aggregated from sharp global books. When that consensus moves
//   decisively toward one outcome before kickoff, it is (by construction) the
//   footprint of informed money — retail noise is demargined and outlier-
//   filtered away upstream. The classic closing-line-value result says prices
//   drift toward the sharp side, so entering after a confirmed move retains
//   positive expected value versus the eventual close.
//
//   SIGNAL (all conditions must hold, evaluated on the consensus trail):
//     1. window: the last STEAM_WINDOW_MS of consensus updates, ≥ MIN_POINTS.
//     2. move:   pct[side] rose by ≥ STEAM_MIN_MOVE percentage points
//                across the window.
//     3. trend:  ≥ TREND_PURITY of consecutive deltas in the window agree
//                with the move's direction (filters V-shaped noise).
//     4. timing: now ∈ [kickoff − COMMIT_EARLIEST, kickoff − COMMIT_LATEST].
//     5. novelty: no prior pick on this fixture+template.
//
//   BELIEF MODEL: if consensus moved from p0 to p1 for our side, we assume
//   the drift is CONTINUATION_LAMBDA fractionally incomplete:
//       p̂ = p1 + CONTINUATION_LAMBDA · (p1 − p0)      (clamped to [0.01,0.99])
//
//   STAKE (fractional Kelly on the belief edge, taken at fair odds b = 1/p1):
//       f* = (b̄·p̂ − (1 − p̂)) / b̄        where b̄ = b − 1
//       stake = bankroll · KELLY_FRACTION · max(f*, 0), capped at MAX_STAKE_PCT
//
//   Every pick records: the trail slice that fired the signal, p0→p1, p̂, f*,
//   and the resulting stake — the whole decision is auditable.
//
// Only markets that can later be SETTLED BY MERKLE PROOF are eligible.
// TxLINE's validate_stat proves goals (stat keys 1/2), cards (3-6) and
// corners (7/8), so eligible templates are:
//   RESULT_P1 / RESULT_P2   — "team X wins" (goals_p1 vs goals_p2)
//   TOTAL_GOALS_{line}      — "total goals > line" (fractional lines only)
//   TOTAL_CORNERS_{line}    — "total corners > line" (fractional lines only)

export const PARAMS = Object.freeze({
  STEAM_WINDOW_MS: 45 * 60_000, // look-back window for the consensus move
  MIN_POINTS: 4,                // minimum consensus updates inside the window
  STEAM_MIN_MOVE: 3.0,          // percentage points the consensus must move
  TREND_PURITY: 0.7,            // share of deltas that must agree in direction
  COMMIT_EARLIEST_MS: 6 * 3600_000, // don't act more than 6h before kickoff
  COMMIT_LATEST_MS: 2 * 60_000,     // stop 2 minutes before kickoff
  CONTINUATION_LAMBDA: 0.5,     // assumed unfinished fraction of the drift
  KELLY_FRACTION: 0.25,         // quarter-Kelly
  MAX_STAKE_PCT: 0.05,          // hard cap: 5% of bankroll per pick
  START_BANKROLL: 10_000,       // virtual units
});

// ------------------------------------------------------- market eligibility

// Map a TxLINE marketId ("SUPERODDSTYPE|params|period") to a provable
// predicate template, or null if we can't settle it with validate_stat.
export function mapMarket(mid, names) {
  const [type, params, period] = mid.split("|");
  if (period && period !== "" && !/full|match|ft/i.test(period)) return null; // full-time only

  if (type === "1X2_PARTICIPANT_RESULT") {
    return { kind: "RESULT", sides: names.map((n) => n.toLowerCase()) };
  }
  const line = /(?:^|[;,&])line=([\-0-9.]+)/.exec(params ?? "")?.[1];
  const fractional = line != null && Math.abs(Number(line) % 1) === 0.5 && Number(line) > 0;
  if (!fractional) return null; // integer lines can push — not binary, skip

  if (/TOTAL|OVERUNDER/i.test(type) && /GOAL/i.test(type) && !/participant=[12]/i.test(params ?? ""))
    return { kind: "TOTAL_GOALS", line: Number(line) };
  if (/TOTAL|OVERUNDER/i.test(type) && /CORNER/i.test(type))
    return { kind: "TOTAL_CORNERS", line: Number(line) };
  return null;
}

// ------------------------------------------------------------- the signal

export function evaluateMarket({ trail, names, mid, fixture, now, openPicks }) {
  const p = PARAMS;
  const template = mapMarket(mid, names);
  if (!template) return null;

  // timing gate
  const toKick = fixture.startTime - now;
  if (toKick < p.COMMIT_LATEST_MS || toKick > p.COMMIT_EARLIEST_MS) return null;

  // novelty gate
  const templateKey = `${fixture.fixtureId}:${template.kind}${template.line ?? ""}`;
  if (openPicks.has(templateKey)) return null;

  // window slice
  const since = now - p.STEAM_WINDOW_MS;
  const win = trail.filter((t) => t.ts >= since && !t.inRunning);
  if (win.length < p.MIN_POINTS) return null;

  const first = win[0].pct, last = win[win.length - 1].pct;
  if (!first?.length || first.length !== last?.length) return null;

  // find the outcome with the largest positive move
  let side = -1, move = 0;
  for (let i = 0; i < first.length; i++) {
    const d = last[i] - first[i];
    if (d > move) { move = d; side = i; }
  }
  if (side < 0 || move < p.STEAM_MIN_MOVE) return null;

  // RESULT template: never pick the draw — it has no clean stat predicate
  if (template.kind === "RESULT" && /draw|x/i.test(names[side] ?? "")) return null;

  // trend purity
  let agree = 0, total = 0;
  for (let i = 1; i < win.length; i++) {
    const d = win[i].pct[side] - win[i - 1].pct[side];
    if (d === 0) continue;
    total++;
    if (d > 0) agree++;
  }
  if (total === 0 || agree / total < p.TREND_PURITY) return null;

  // belief + Kelly
  const p1 = last[side] / 100;
  const p0 = first[side] / 100;
  const pHat = Math.min(0.99, Math.max(0.01, p1 + p.CONTINUATION_LAMBDA * (p1 - p0)));
  const b = 1 / p1;         // fair decimal odds at commit
  const bBar = b - 1;
  const fStar = (bBar * pHat - (1 - pHat)) / bBar;
  if (fStar <= 0) return null;

  return {
    templateKey,
    template,
    fixtureId: fixture.fixtureId,
    label: pickLabel(template, names[side], fixture),
    side,
    sideName: names[side],
    oddsMilli: Math.round(b * 1000),
    consensusFrom: p0,
    consensusTo: p1,
    belief: pHat,
    kellyRaw: fStar,
    stakeFraction: Math.min(p.KELLY_FRACTION * fStar, p.MAX_STAKE_PCT),
    window: { from: win[0].ts, to: win[win.length - 1].ts, points: win.length, movePts: move },
    kickoff: fixture.startTime,
  };
}

function pickLabel(template, sideName, fixture) {
  if (template.kind === "RESULT") {
    const team = /part1|1/.test(sideName ?? "") ? fixture.p1 : fixture.p2;
    return `${team} to win (${fixture.p1} v ${fixture.p2})`;
  }
  const what = template.kind === "TOTAL_GOALS" ? "goals" : "corners";
  const dir = /under|part2|2/i.test(sideName ?? "") ? "Under" : "Over";
  return `${dir} ${template.line} total ${what} (${fixture.p1} v ${fixture.p2})`;
}
