// settle.mjs — duel settlement.
//
// Paper mode: grades finished duels against the proofball backend's resolved
// markets (same TxLINE proofs, already fetched by its keeper) when a matching
// fixture/predicate exists; otherwise leaves the duel open for the on-chain
// path. Live mode: submits the Merkle proof to the proofarena program's
// settle_duel (CPI validate_stat) — wired in once the program is deployed.

const PROOFBALL_API = "https://proofball.vercel.app/api/markets";

function predicateMatches(duel, market) {
  if (duel.fixtureId !== market.fixtureId) return false;
  const t = duel.template?.kind;
  if (t === "RESULT" && /^RESULT_P[12]$/.test(market.templateKey)) return true;
  if (t === "TOTAL_GOALS" && market.templateKey === "TOTAL_GOALS_O25" && duel.template.line === 2.5) return true;
  if (t === "TOTAL_CORNERS" && market.templateKey === "TOTAL_CORNERS_O95" && duel.template.line === 9.5) return true;
  return false;
}

export async function settleDuels(due, state, { mode, log }) {
  let resolved;
  try {
    const r = await fetch(PROOFBALL_API);
    if (!r.ok) throw new Error(String(r.status));
    const d = await r.json();
    resolved = (Array.isArray(d) ? d : d.markets ?? []).filter((m) => m.resolved);
  } catch (e) {
    log("settle: reference feed unavailable:", e.message);
    return;
  }

  for (const duel of due) {
    const ref = resolved.find((m) => predicateMatches(duel, m));
    if (!ref) continue; // no proof-backed reference yet — stays open

    // ref.outcome is the truth of the market predicate; translate to OUR
    // predicate orientation (steamer backs predicateTrue side of the signal)
    const steamedWon = refOutcomeForDuel(duel, ref);
    if (steamedWon === null) continue; // ambiguous reference (e.g. other team's
    // RESULT market can't distinguish a draw) — wait for a same-side reference
    duel.predicateTrue = steamedWon;
    duel.status = "settled";
    duel.settledAt = Date.now();
    duel.settledVia = `paper:proofball:${ref.marketKey ?? "?"}`;

    const s = state.agents.steamer, f = state.agents.fader;
    if (steamedWon) {
      s.bankroll += duel.steamer.stake * (duel.steamer.oddsMilli / 1000 - 1);
      f.bankroll -= duel.fader.stake;
      s.wins++; f.losses++;
    } else {
      s.bankroll -= duel.steamer.stake;
      f.bankroll += duel.fader.stake * (duel.fader.oddsMilli / 1000 - 1);
      f.wins++; s.losses++;
    }
    log(`⚖️  SETTLED "${duel.steamer.label}" — ${steamedWon ? "STEAMER" : "FADER"} wins ` +
        `(via proof-backed ref ${duel.settledVia}) | Steamer ${s.bankroll.toFixed(0)}u vs Fader ${f.bankroll.toFixed(0)}u`);
  }
}

function refOutcomeForDuel(duel, ref) {
  // For totals templates the reference market predicate is "over line" — the
  // steamed side may have been over OR under.
  if (duel.template.kind !== "RESULT") {
    const steamedOver = !/under/i.test(duel.signal?.steamedSide ?? "");
    return ref.outcome === steamedOver;
  }
  // RESULT: only a same-team reference is unambiguous ("other team wins" being
  // false could mean our team won OR a draw — a draw loses for the steamer).
  const steamedP1 = /part1|1/.test(duel.signal?.steamedSide ?? "");
  const refIsP1 = ref.templateKey === "RESULT_P1";
  if (refIsP1 !== steamedP1) return null;
  return ref.outcome === true;
}
