// feed.mjs — TxLINE ingestion layer.
//
// Maintains an in-memory odds book from the TxLINE SSE odds stream plus the
// fixtures snapshot. Prices arrive as decimal odds ×1000 (e.g. 2520 = 2.52);
// each message also carries implied percentages ("Pct"). Bookmaker 10021
// ("TXLineStablePriceDemargined") is TxLINE's de-vigged consensus — the
// fair-probability reference every strategy decision is measured against.
//
// The stream is resumable: SSE `id:` lines are stored and replayed via the
// Last-Event-ID header on reconnect, so an agent restart loses nothing.

import { readFileSync, existsSync } from "fs";

export function loadEnv(path = new URL("../.env.txline", import.meta.url).pathname) {
  const env = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) env[m[1]] = m[2];
  }
  for (const k of ["TXLINE_BASE", "TXLINE_JWT", "TXLINE_API_TOKEN"])
    if (!env[k]) throw new Error(`missing ${k} in .env.txline`);
  return env;
}

const HDRS = (env) => ({
  Authorization: `Bearer ${env.TXLINE_JWT}`,
  "X-Api-Token": env.TXLINE_API_TOKEN,
});

export const DEMARGINED_BOOK_ID = 10021; // TXLineStablePriceDemargined
export const WORLD_CUP_COMPETITION_ID = 72;

// ---------------------------------------------------------------- fixtures

export async function fetchFixtures(env, competitionId = WORLD_CUP_COMPETITION_ID) {
  const r = await fetch(`${env.TXLINE_BASE}/api/fixtures/snapshot?competitionId=${competitionId}`, {
    headers: HDRS(env),
  });
  if (!r.ok) throw new Error(`fixtures snapshot ${r.status}`);
  const rows = await r.json();
  const byId = new Map();
  for (const f of rows) {
    byId.set(f.FixtureId, {
      fixtureId: f.FixtureId,
      p1: f.Participant1,
      p2: f.Participant2,
      p1Id: f.Participant1Id,
      p2Id: f.Participant2Id,
      startTime: f.StartTime, // ms epoch
      competitionId: f.CompetitionId,
    });
  }
  return byId;
}

// ---------------------------------------------------------------- odds book
//
// book:  fixtureId -> marketId -> bookmakerId -> quote
// quote: { prices: [milliOdds], pct: [number], names: [string], ts, inRunning }
// history (demargined only): fixtureId -> marketId -> ring buffer of
// { ts, pct } — this is what the momentum signal reads.

const HISTORY_MAX = 720; // ≥ ~12h of one-per-minute updates per market

export function marketId(msg) {
  // A market is uniquely identified by its odds type + parameters + period.
  return [msg.SuperOddsType, msg.MarketParameters ?? "", msg.MarketPeriod ?? ""].join("|");
}

export function createOddsBook() {
  const book = new Map();
  const history = new Map();

  function apply(msg) {
    if (!msg.FixtureId || !Array.isArray(msg.Prices)) return null;
    const mid = marketId(msg);
    let markets = book.get(msg.FixtureId);
    if (!markets) book.set(msg.FixtureId, (markets = new Map()));
    let quotes = markets.get(mid);
    if (!quotes) markets.set(mid, (quotes = new Map()));
    const quote = {
      prices: msg.Prices,
      pct: (msg.Pct ?? []).map(Number),
      names: msg.PriceNames ?? [],
      ts: msg.Ts,
      inRunning: !!msg.InRunning,
    };
    quotes.set(msg.BookmakerId, quote);

    if (msg.BookmakerId === DEMARGINED_BOOK_ID) {
      let hFix = history.get(msg.FixtureId);
      if (!hFix) history.set(msg.FixtureId, (hFix = new Map()));
      let ring = hFix.get(mid);
      if (!ring) hFix.set(mid, (ring = []));
      ring.push({ ts: msg.Ts, pct: quote.pct });
      if (ring.length > HISTORY_MAX) ring.shift();
    }
    return { fixtureId: msg.FixtureId, marketId: mid, bookmakerId: msg.BookmakerId, quote };
  }

  return {
    apply,
    consensus: (fixtureId, mid) => book.get(fixtureId)?.get(mid)?.get(DEMARGINED_BOOK_ID) ?? null,
    quotes: (fixtureId, mid) => book.get(fixtureId)?.get(mid) ?? new Map(),
    markets: (fixtureId) => [...(book.get(fixtureId)?.keys() ?? [])],
    trail: (fixtureId, mid) => history.get(fixtureId)?.get(mid) ?? [],
    fixtures: () => [...book.keys()],
  };
}

// ---------------------------------------------------------------- SSE

// Long-lived SSE consumer with automatic reconnect + Last-Event-ID resume.
export async function streamSSE(env, path, onEvent, { signal, label = path } = {}) {
  let lastEventId = null;
  let backoff = 1000;
  while (!signal?.aborted) {
    try {
      const headers = HDRS(env);
      if (lastEventId) headers["Last-Event-ID"] = lastEventId;
      const r = await fetch(`${env.TXLINE_BASE}${path}`, { headers, signal });
      if (!r.ok) throw new Error(`${label} ${r.status}`);
      backoff = 1000;
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx).trimEnd();
          buf = buf.slice(idx + 1);
          if (line.startsWith("id:")) lastEventId = line.slice(3).trim();
          else if (line.startsWith("data:")) {
            const body = line.slice(5).trim();
            if (!body) continue;
            try { onEvent(JSON.parse(body)); } catch { /* non-JSON keepalive */ }
          }
        }
      }
      throw new Error(`${label} stream ended`);
    } catch (e) {
      if (signal?.aborted) return;
      console.error(`[feed] ${label}: ${e.message} — reconnecting in ${backoff}ms`);
      await new Promise((res) => setTimeout(res, backoff));
      backoff = Math.min(backoff * 2, 30_000);
    }
  }
}

export const streamOdds = (env, onMsg, opts) => streamSSE(env, "/api/odds/stream", onMsg, { ...opts, label: "odds" });
export const streamScores = (env, onMsg, opts) => streamSSE(env, "/api/scores/stream", onMsg, { ...opts, label: "scores" });
