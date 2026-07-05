// index.mjs — ProofPicks autonomous agent loop.
//
// Every TICK_MS: refresh fixtures, evaluate every tracked market against the
// strategy, and act on any signal. In PAPER mode picks are only logged +
// persisted to state.json; in LIVE mode they are additionally committed
// on-chain (commit_pick) and later settled against TxLINE Merkle proofs
// (settle_pick). The agent runs unattended under pm2 — no human input.

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { loadEnv, fetchFixtures, createOddsBook, streamOdds, marketId, DEMARGINED_BOOK_ID } from "./feed.mjs";
import { evaluateMarket, PARAMS } from "./strategy.mjs";

const MODE = process.env.PP_MODE ?? "paper"; // "paper" | "live"
const TICK_MS = 60_000;
const DATA_DIR = new URL("../data", import.meta.url).pathname;
const STATE_PATH = `${DATA_DIR}/state.json`;

mkdirSync(DATA_DIR, { recursive: true });

const state = existsSync(STATE_PATH)
  ? JSON.parse(readFileSync(STATE_PATH, "utf8"))
  : { bankroll: PARAMS.START_BANKROLL, picks: [], startedAt: Date.now() };
const openPicks = new Set(state.picks.filter((p) => p.status === "open").map((p) => p.templateKey));
const allPickKeys = new Set(state.picks.map((p) => p.templateKey));

const save = () => writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
const log = (...a) => console.log(new Date().toISOString(), ...a);

const env = loadEnv();
const book = createOddsBook();
let fixtures = new Map();

// live odds -> book (with inRunning carried onto the trail for the gate)
streamOdds(env, (msg) => {
  const r = book.apply(msg);
  if (r && msg.BookmakerId === DEMARGINED_BOOK_ID) {
    const t = book.trail(r.fixtureId, r.marketId);
    if (t.length) t[t.length - 1].inRunning = !!msg.InRunning;
  }
});

async function tick() {
  try {
    fixtures = await fetchFixtures(env);
  } catch (e) {
    log("fixtures refresh failed:", e.message);
  }
  const now = Date.now();
  let evaluated = 0;

  for (const fixtureId of book.fixtures()) {
    const fixture = fixtures.get(fixtureId);
    if (!fixture) continue;
    for (const mid of book.markets(fixtureId)) {
      const consensus = book.consensus(fixtureId, mid);
      if (!consensus) continue;
      evaluated++;
      const signal = evaluateMarket({
        trail: book.trail(fixtureId, mid),
        names: consensus.names,
        mid,
        fixture,
        now,
        openPicks: new Set([...openPicks, ...allPickKeys]),
      });
      if (signal) await placePick(signal);
    }
  }
  log(`tick: ${book.fixtures().length} fixtures, ${evaluated} markets evaluated, bankroll ${state.bankroll.toFixed(0)}u, picks ${state.picks.length}`);
  save();
}

async function placePick(signal) {
  const stake = Math.round(state.bankroll * signal.stakeFraction);
  if (stake < 1) return;
  const pick = {
    ...signal,
    stake,
    committedAt: Date.now(),
    mode: MODE,
    status: "open",
    commitTx: null,
    settleTx: null,
    outcome: null,
  };
  if (MODE === "live") {
    // on-chain commitment happens here (chain.mjs) — wired in once the
    // proofpicks program is deployed.
    const { commitPick } = await import("./chain.mjs");
    pick.commitTx = await commitPick(pick);
  }
  state.picks.push(pick);
  openPicks.add(pick.templateKey);
  allPickKeys.add(pick.templateKey);
  log(`📌 PICK ${pick.label} @ ${(pick.oddsMilli / 1000).toFixed(2)} — stake ${stake}u ` +
      `(consensus ${(pick.consensusFrom * 100).toFixed(1)}%→${(pick.consensusTo * 100).toFixed(1)}%, ` +
      `belief ${(pick.belief * 100).toFixed(1)}%, kelly ${pick.kellyRaw.toFixed(3)})${pick.commitTx ? " tx " + pick.commitTx : ""}`);
  save();
}

log(`ProofPicks agent starting — mode=${MODE}, bankroll=${state.bankroll}u, ${state.picks.length} historical picks`);
await tick();
setInterval(tick, TICK_MS);
