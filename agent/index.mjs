// index.mjs — ProofArena: two agents, one feed, settled by proof.
//
// Every TICK_MS the shared signal detector scans all tracked markets. When
// steam fires, a DUEL is created: Agent A "Steamer" backs the move, Agent B
// "Fader" backs the opposite side. Each sizes its own stake from its own
// bankroll (see strategy.mjs for the full math). In PAPER mode duels are
// logged + persisted; in LIVE mode both positions are committed on-chain
// before kickoff and settled by the TxLINE Merkle proof afterwards.
// The agents run unattended under pm2 — no human input, ever.

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { loadEnv, fetchFixtures, createOddsBook, streamOdds, DEMARGINED_BOOK_ID } from "./feed.mjs";
import { evaluateMarket, buildDuel, PARAMS } from "./strategy.mjs";

const MODE = process.env.PA_MODE ?? "paper"; // "paper" | "live"
const TICK_MS = 60_000;
const DATA_DIR = new URL("../data", import.meta.url).pathname;
const STATE_PATH = `${DATA_DIR}/state.json`;

mkdirSync(DATA_DIR, { recursive: true });

const state = existsSync(STATE_PATH)
  ? JSON.parse(readFileSync(STATE_PATH, "utf8"))
  : {
      startedAt: Date.now(),
      agents: {
        steamer: { name: "Agent A — Steamer", philosophy: "momentum / closing-line value", bankroll: PARAMS.START_BANKROLL, wins: 0, losses: 0 },
        fader: { name: "Agent B — Fader", philosophy: "mean-reversion / overreaction", bankroll: PARAMS.START_BANKROLL, wins: 0, losses: 0 },
      },
      duels: [],
    };
const duelKeys = new Set(state.duels.map((d) => d.templateKey));

const save = () => writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
const log = (...a) => console.log(new Date().toISOString(), ...a);

const env = loadEnv();
const book = createOddsBook();
let fixtures = new Map();

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
        openPicks: duelKeys,
      });
      if (signal) await openDuel(signal, fixture);
    }
  }
  const a = state.agents.steamer, b = state.agents.fader;
  log(`tick: ${book.fixtures().length} fixtures, ${evaluated} markets | ` +
      `Steamer ${a.bankroll.toFixed(0)}u (${a.wins}W-${a.losses}L) vs Fader ${b.bankroll.toFixed(0)}u (${b.wins}W-${b.losses}L) | duels ${state.duels.length}`);
  save();
}

async function openDuel(signal, fixture) {
  const duel = buildDuel(signal, {
    steamerBankroll: state.agents.steamer.bankroll,
    faderBankroll: state.agents.fader.bankroll,
  }, fixture);
  if (duel.steamer.stake < 1 || duel.fader.stake < 1) return;

  duel.openedAt = Date.now();
  duel.mode = MODE;
  duel.status = "open";
  duel.commitTx = null;
  duel.settleTx = null;
  duel.predicateTrue = null; // set at settlement: did the steamed statement happen?

  if (MODE === "live") {
    const { commitDuel } = await import("./chain.mjs");
    duel.commitTx = await commitDuel(duel);
  }
  state.duels.push(duel);
  duelKeys.add(duel.templateKey);
  log(`⚔️  DUEL on "${duel.steamer.label}" | ` +
      `Steamer ${duel.steamer.stake}u @ ${(duel.steamer.oddsMilli / 1000).toFixed(2)} vs ` +
      `Fader ${duel.fader.stake}u @ ${(duel.fader.oddsMilli / 1000).toFixed(2)} ` +
      `(consensus ${(duel.signal.consensusFrom * 100).toFixed(1)}%→${(duel.signal.consensusTo * 100).toFixed(1)}%)` +
      (duel.commitTx ? ` tx ${duel.commitTx}` : ""));
  save();
}

// Settlement: grade both sides of finished duels. Paper mode uses the same
// TxLINE stat-validation proof data (fetched off-chain); live mode submits it
// to the proofarena program which CPIs validate_stat. Wired via settle.mjs
// once the scores/seq plumbing lands.
async function settleTick() {
  const due = state.duels.filter((d) => d.status === "open" && Date.now() > d.kickoff + 165 * 60_000);
  if (!due.length) return;
  try {
    const { settleDuels } = await import("./settle.mjs");
    await settleDuels(due, state, { mode: MODE, env, log });
    save();
  } catch (e) {
    log("settle pass failed:", e.message);
  }
}

log(`ProofArena starting — mode=${MODE} | ${state.agents.steamer.name} vs ${state.agents.fader.name} | ${state.duels.length} historical duels`);
await tick();
setInterval(tick, TICK_MS);
setInterval(settleTick, 5 * 60_000);
