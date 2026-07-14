// chain.mjs — on-chain duel lifecycle against the proofarena program (devnet).
//
// commit: every duel is written on-chain BEFORE kickoff (program enforces it via
// the chain clock — hindsight picks are impossible by construction).
// settle: after full time, the TxLINE Merkle proof is submitted to settle_duel,
// which CPIs into validate_stat; the proof decides the winner.
//
// Predicate encodings: goals keys 1/2, corners 7/8, period 100 = TxLINE's
// final-consolidated record (see duelPredicate note). The DUEL predicate is
// always the STEAMED side's statement, so `predicate_true == steamer wins`
// holds on-chain.

import anchorPkg from "@coral-xyz/anchor";
import { Connection, PublicKey, Keypair, ComputeBudgetProgram } from "@solana/web3.js";
import { readFileSync } from "fs";
const anchor = anchorPkg;
const { BN } = anchorPkg;

const RPC = process.env.RPC || "https://api.devnet.solana.com";
export const TXORACLE_PROGRAM_ID = new PublicKey("6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J");

const here = (p) => new URL(p, import.meta.url).pathname;
const idl = JSON.parse(readFileSync(here("../idl/proofarena.json")));
const env = Object.fromEntries(
  readFileSync(here("../.env.txline"), "utf8").split("\n").filter(Boolean)
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)]; })
);

const conn = new Connection(RPC, "confirmed");
const operatorKp = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(process.env.OPERATOR_KEY || here("../operator-key.json"))))
);
const program = new anchor.Program(idl, new anchor.AnchorProvider(conn, new anchor.Wallet(operatorKp), { commitment: "confirmed" }));
export const PROGRAM_ID = program.programId.toBase58();

// ---------------------------------------------------------------- predicate

// Final-consolidated period + base stat keys. TxLINE records evolve through
// period codes as a match settles (7/9 in-play → 10/100 post-match → 0 once
// fully archived). Every finished fixture we sampled converges to period 0,
// so we pin 0: the terminal state that always eventually exists. Settlement
// simply waits for consolidation (usually 1–3 days after full time).
const P_FINAL = 0;
const KEYS = { GOALS: [1, 2], CORNERS: [7, 8] };

// The committed predicate is the steamed side's statement.
export function duelPredicate(duel) {
  const { kind, line } = duel.template;
  const steamed = duel.signal.steamedSide ?? "";
  if (kind === "RESULT") {
    const p1 = /part1|^1$/.test(steamed);
    const [a, b] = p1 ? KEYS.GOALS : [...KEYS.GOALS].reverse();
    // (steamed team goals − other team goals) > 0
    return { statKeyA: a, periodA: P_FINAL, useTwoStats: true, statKeyB: b, periodB: P_FINAL, op: 1, threshold: 0, comparison: 0 };
  }
  const [a, b] = kind === "TOTAL_GOALS" ? KEYS.GOALS : KEYS.CORNERS;
  const under = /under/i.test(steamed);
  return under
    // steamed UNDER L.5  ⇒  total < ceil(L)  (integers: < 3 ⇔ under 2.5)
    ? { statKeyA: a, periodA: P_FINAL, useTwoStats: true, statKeyB: b, periodB: P_FINAL, op: 0, threshold: Math.ceil(line), comparison: 1 }
    // steamed OVER L.5   ⇒  total > floor(L)
    : { statKeyA: a, periodA: P_FINAL, useTwoStats: true, statKeyB: b, periodB: P_FINAL, op: 0, threshold: Math.floor(line), comparison: 0 };
}

export function duelPda(fixtureId, seed) {
  const f = Buffer.alloc(8); f.writeBigInt64LE(BigInt(fixtureId));
  const s = Buffer.alloc(8); s.writeBigUInt64LE(BigInt(seed));
  return PublicKey.findProgramAddressSync([Buffer.from("duel"), f, s], program.programId)[0];
}

// ---------------------------------------------------------------- commit

export async function commitDuel(duel) {
  const seed = duel.seed ?? Date.now();
  duel.seed = seed;
  const pred = duelPredicate(duel);
  const pda = duelPda(duel.fixtureId, seed);

  const params = {
    fixtureId: new BN(duel.fixtureId),
    statKeyA: pred.statKeyA, periodA: pred.periodA,
    useTwoStats: pred.useTwoStats,
    statKeyB: pred.statKeyB, periodB: pred.periodB,
    op: pred.op, threshold: pred.threshold, comparison: pred.comparison,
    kickoffTime: new BN(Math.floor(duel.kickoff / 1000)),
    steamer: { stake: new BN(duel.steamer.stake), oddsMilli: duel.steamer.oddsMilli, beliefBp: Math.round(duel.steamer.belief * 10000) },
    fader: { stake: new BN(duel.fader.stake), oddsMilli: duel.fader.oddsMilli, beliefBp: Math.round(duel.fader.belief * 10000) },
  };

  const sig = await program.methods
    .commitDuel(new BN(seed), params)
    .accounts({ operator: operatorKp.publicKey, duel: pda })
    .rpc();
  duel.duelKey = pda.toBase58();
  return sig;
}

// ---------------------------------------------------------------- settle

const node = (n) => ({ hash: n.hash, isRightSibling: n.isRightSibling });
const cmpEnum = (c) => [{ greaterThan: {} }, { lessThan: {} }, { equalTo: {} }][c];
const opEnum = (o) => [{ add: {} }, { subtract: {} }][o];

async function fetchProof(fixtureId, seq, statKey) {
  const r = await fetch(`${env.TXLINE_BASE}/api/scores/stat-validation?fixtureId=${fixtureId}&seq=${seq}&statKey=${statKey}`, {
    headers: { Authorization: `Bearer ${env.TXLINE_JWT}`, "X-Api-Token": env.TXLINE_API_TOKEN },
  });
  if (!r.ok) throw new Error(`stat-validation ${statKey}@${seq}: ${r.status}`);
  return r.json();
}

function dailyScoresPda(minTimestamp) {
  const epochDay = Math.floor(Number(minTimestamp) / 1000 / 86400);
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(epochDay);
  return PublicKey.findProgramAddressSync([Buffer.from("daily_scores_roots"), buf], TXORACLE_PROGRAM_ID)[0];
}

// Discover the final CONSOLIDATED proof seq for a fixture: the highest seq,
// provided its record has reached the terminal period (0). Returns null while
// the fixture is still consolidating — the settle loop just retries later.
export async function discoverFinalSeq(fixtureId) {
  const get = async (seq) => {
    try { return await fetchProof(fixtureId, seq, 1); } catch { return null; }
  };
  let hit = null;
  for (const s of [64, 256, 1024, 4096, 16384]) if (await get(s)) hit = s; // any record?
  if (hit === null) return null;
  // binary search the highest valid seq in [hit, hit*4+64]
  let lo = hit, top = hit * 4 + 64;
  while (lo < top) {
    const mid = Math.floor((lo + top + 1) / 2);
    if (await get(mid)) lo = mid; else top = mid - 1;
  }
  const finalRec = await get(lo);
  if (!finalRec || finalRec.statToProve.period !== 0) return null; // not consolidated yet
  return lo;
}

// Settle an on-chain duel with the real Merkle proof. Returns { sig, predicateTrue }.
// If seq is null, the final record is discovered automatically.
export async function settleDuelOnChain(duel, seq) {
  if (seq == null) {
    seq = await discoverFinalSeq(duel.fixtureId);
    if (seq == null) throw new Error(`no proof records for fixture ${duel.fixtureId}`);
  }
  const pred = duelPredicate(duel);
  const pda = new PublicKey(duel.duelKey);

  const proofA = await fetchProof(duel.fixtureId, seq, pred.statKeyA);
  const proofB = await fetchProof(duel.fixtureId, seq, pred.statKeyB);
  const minTs = proofA.summary.updateStats.minTimestamp;

  const args = {
    ts: new BN(minTs),
    fixtureSummary: {
      fixtureId: new BN(proofA.summary.fixtureId),
      updateStats: {
        updateCount: proofA.summary.updateStats.updateCount,
        minTimestamp: new BN(proofA.summary.updateStats.minTimestamp),
        maxTimestamp: new BN(proofA.summary.updateStats.maxTimestamp),
      },
      eventsSubTreeRoot: proofA.summary.eventStatsSubTreeRoot,
    },
    fixtureProof: proofA.subTreeProof.map(node),
    mainTreeProof: proofA.mainTreeProof.map(node),
    predicate: { threshold: pred.threshold, comparison: cmpEnum(pred.comparison) },
    statA: {
      statToProve: { key: proofA.statToProve.key, value: proofA.statToProve.value, period: proofA.statToProve.period },
      eventStatRoot: proofA.eventStatRoot,
      statProof: proofA.statProof.map(node),
    },
    statB: {
      statToProve: { key: proofB.statToProve.key, value: proofB.statToProve.value, period: proofB.statToProve.period },
      eventStatRoot: proofB.eventStatRoot,
      statProof: proofB.statProof.map(node),
    },
    op: opEnum(pred.op),
  };

  const cu = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 });
  const sig = await program.methods
    .settleDuel(args)
    .accounts({
      settler: operatorKp.publicKey,
      duel: pda,
      dailyScoresMerkleRoots: dailyScoresPda(minTs),
      txoracleProgram: TXORACLE_PROGRAM_ID,
    })
    .preInstructions([cu])
    .rpc();

  const after = await program.account.duel.fetch(pda);
  return { sig, predicateTrue: after.predicateTrue };
}
