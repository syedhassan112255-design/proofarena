// One-off: state surgery + instant demo duel.
//
// 1. Voids the two Norway–England duels whose on-chain predicates pinned the
//    legacy period code (4) that TxLINE's knockout-fixture records no longer
//    reach — unprovable by construction, recorded as NO CONTEST.
// 2. Grades the pre-on-chain France–Morocco paper duel from the real
//    consolidated proof record (2–0 → over 2.5 false → Fader wins).
// 3. Commits + immediately settles a DEMO duel on the archived France–Morocco
//    fixture, so the full commit → proof → settle loop is visible on-chain
//    end-to-end. (The program only time-gates commits, not settles.)
//
// Run ON the VPS with the agent STOPPED (single writer for state.json).

import { readFileSync, writeFileSync } from "fs";
import { commitDuel, settleDuelOnChain } from "../agent/chain.mjs";

const STATE = new URL("../data/state.json", import.meta.url).pathname;
const state = JSON.parse(readFileSync(STATE, "utf8"));

// ---- 1. void the unprovable Norway–England duels ----
for (const d of state.duels) {
  if (d.fixtureId === 18213979 && d.status === "open") {
    d.status = "void";
    d.voidReason =
      "Predicate pinned TxLINE period code 4 (full time), but 2026 knockout records consolidate to period 0 — no matching proof can exist. See docs/FEEDBACK.md.";
    console.log("voided:", d.steamer.label);
  }
}

// ---- 2. grade the France–Morocco paper duel from the real proof record ----
const fm = state.duels.find((d) => d.fixtureId === 18209181 && d.status === "open");
if (fm) {
  // consolidated record (seq 1115): France 2 — Morocco 0 → total 2 → over 2.5 FALSE
  const steamedWon = false;
  fm.predicateTrue = steamedWon;
  fm.status = "settled";
  fm.settledAt = Date.now();
  fm.settledVia = "paper:proof-record:seq1115";
  const s = state.agents.steamer, f = state.agents.fader;
  s.bankroll -= fm.steamer.stake;
  f.bankroll += fm.fader.stake * (fm.fader.oddsMilli / 1000 - 1);
  f.wins++; s.losses++;
  console.log("graded paper duel:", fm.steamer.label, "→ FADER wins");
}

// ---- 3. instant demo duel on the archived fixture ----
const demo = {
  templateKey: "18209181:DEMO_TOTAL_GOALS1.5",
  fixtureId: 18209181,
  template: { kind: "TOTAL_GOALS", line: 1.5 },
  kickoff: Date.now() + 60 * 86400_000, // future kickoff satisfies the commit gate
  signal: {
    steamedSide: "over",
    consensusFrom: 0.62,
    consensusTo: 0.66,
    window: { points: 0, movePts: 0 },
  },
  steamer: { label: "Over 1.5 total goals (France v Morocco · archived demo)", backsPredicate: true, oddsMilli: 1515, belief: 0.68, kellyRaw: 0.06, stake: 100 },
  fader: { label: "Under 1.5 total goals (France v Morocco · archived demo)", backsPredicate: false, oddsMilli: 2941, belief: 0.38, kellyRaw: 0.05, stake: 60 },
  openedAt: Date.now(),
  mode: "live",
  status: "open",
  isDemo: true,
  commitTx: null,
  settleTx: null,
  predicateTrue: null,
};

console.log("committing demo duel on-chain…");
demo.commitTx = await commitDuel(demo);
console.log("commit tx:", demo.commitTx, "duel:", demo.duelKey);

console.log("settling with the real consolidated proof…");
const { sig, predicateTrue } = await settleDuelOnChain(demo, 1115);
demo.predicateTrue = predicateTrue;
demo.status = "settled";
demo.settledAt = Date.now();
demo.settleTx = sig;
demo.settledVia = "onchain:seq1115";
console.log("settle tx:", sig, "→ predicateTrue:", predicateTrue, predicateTrue ? "(STEAMER wins)" : "(FADER wins)");

// demo stakes are excluded from the competitive bankrolls — it's a showcase round
state.duels.push(demo);
writeFileSync(STATE, JSON.stringify(state, null, 2));
console.log("state saved.");
