// ProofArena demo — records the live arena + real Explorer transactions,
// paced to the Jon VO (out/vo.mp3 + out/boundaries.json).
import { chromium } from "playwright";
import { readdirSync, renameSync, readFileSync, statSync } from "fs";

const W = 1280, H = 720;
const here = new URL(".", import.meta.url).pathname;
const SITE = "https://proofarena-live.vercel.app";
const COMMIT_TX = "https://explorer.solana.com/tx/5BMrGF2ffxTCR7rydanwWBfARJpgaRaf6aNkUpm4S5Tbr8zb9ssr11fETVwAxBx7pre4ZdyAdv3pW3fb4n4T44Ni?cluster=devnet";
const SETTLE_TX = "https://explorer.solana.com/tx/5yUSVU9LRFLKtYKJYcoKqVjDWK7MzWEYX45Zuzoo9XT2EQzL12s1RJQoTcKmu6qP16FCpjSuiMatP3depDV1vEXU?cluster=devnet";
const B = JSON.parse(readFileSync(`${here}out/boundaries.json`));

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: W, height: H }, deviceScaleFactor: 2,
  recordVideo: { dir: `${here}out`, size: { width: W, height: H } },
});
const page = await context.newPage();
const wait = (ms) => page.waitForTimeout(ms);
const T0 = Date.now();
const at = async (sec) => { const rem = sec - (Date.now() - T0) / 1000; if (rem > 0) await wait(rem * 1000); };

async function caption(html) {
  await page.evaluate((t) => {
    let c = document.getElementById("__cap");
    if (!c) { c = document.createElement("div"); c.id = "__cap";
      c.style.cssText = "position:fixed;left:50%;transform:translateX(-50%);bottom:30px;z-index:2147483647;max-width:1000px;padding:13px 26px;border-radius:4px;background:rgba(4,8,6,.92);border:1px solid rgba(61,255,140,.4);color:#f2f4f1;font:600 20px/1.4 'Space Grotesk',system-ui,sans-serif;text-align:center;box-shadow:0 16px 50px -18px rgba(61,255,140,.25);opacity:0;transition:opacity .4s ease";
      document.body.appendChild(c); }
    c.innerHTML = t; requestAnimationFrame(() => (c.style.opacity = "1"));
  }, html);
}
const clearCap = () => page.evaluate(() => { const c = document.getElementById("__cap"); if (c) c.style.opacity = "0"; }).catch(() => {});
async function scrollTo(toY, ms) {
  await page.evaluate(({ toY, ms }) => new Promise((res) => {
    const s = window.scrollY, d = toY - s, t0 = performance.now();
    (function step(n){ const k=Math.min(1,(n-t0)/ms); const e=k<.5?2*k*k:1-Math.pow(-2*k+2,2)/2; window.scrollTo(0,s+d*e); k<1?requestAnimationFrame(step):res(); })(performance.now());
  }), { toY, ms });
}
const yOf = (sel, off = 60) => page.evaluate(({ sel, off }) => {
  const el = document.querySelector(sel);
  return el ? el.getBoundingClientRect().top + window.scrollY - off : 0;
}, { sel, off });

// ── SCENE 1 — hero hook 0 → B[1] ──
await page.goto(SITE, { waitUntil: "load" });
await wait(2500);
const G = "#3dff8c";
await at(B[1] - 3);
await caption(`Two autonomous agents. One TxLINE feed. <b style="color:${G}">An unfakeable track record.</b>`);
await at(B[1]);

// ── SCENE 2 — bankroll race B[1] → B[2] ──
await clearCap();
await scrollTo(await yOf(".tape"), 1400);
await wait(300);
await caption(`<b style="color:${G}">Steamer</b> backs the move · <b style="color:#ffa02e">Fader</b> fades it — Kelly-sized, 24/7, no humans`);
await at(B[1] + (B[2] - B[1]) * 0.62);
await scrollTo(await yOf(".racebar", 300), 1200);
await at(B[2]);

// ── SCENE 3 — house rules B[2] → B[3] ──
await clearCap();
await scrollTo(await yOf(".rules"), 1500);
await wait(300);
await caption(`Committed <b style="color:${G}">before kickoff</b> — settled by <b style="color:${G}">Merkle proof</b>, not by us`);
await at(B[2] + (B[3] - B[2]) * 0.55);
await scrollTo(await yOf(".lawrow", 140), 1200);
await at(B[3]);

// ── SCENE 4 — receipts: bouts + real Explorer txs B[3] → B[4] ──
await clearCap();
await scrollTo(await yOf(".card .wrap"), 1300);
await caption(`The showcase bout — <b style="color:${G}">STEAMER WINS · proof verified</b>`);
await at(B[3] + (B[4] - B[3]) * 0.3);
await clearCap();
await page.goto(COMMIT_TX, { waitUntil: "domcontentloaded" });
await wait(1200);
await caption(`<span style="font-family:monospace">commit_duel</span> — on-chain, <b style="color:${G}">timestamped before the match</b>`);
await at(B[3] + (B[4] - B[3]) * 0.62);
await page.goto(SETTLE_TX, { waitUntil: "domcontentloaded" });
await wait(1200);
await caption(`<span style="font-family:monospace">settle_duel → CPI validate_stat</span> — <b style="color:${G}">the proof decides</b>`);
await page.evaluate(() => window.scrollBy(0, 500)).catch(() => {});
await at(B[4]);

// ── SCENE 5 — NO CONTEST honesty B[4] → B[5] ──
await page.goto(SITE, { waitUntil: "load" });
await wait(1800);
await page.evaluate(() => { const c = document.querySelector(".card .wrap"); if (c) window.scrollTo(0, c.getBoundingClientRect().top + window.scrollY + 260); });
await caption(`Even failures are permanent — <b style="color:#ffa02e">NO CONTEST</b> bouts can never be deleted`);
await at(B[4] + (B[5] - B[4]) * 0.6);
await scrollTo(await yOf(".card .wrap", -420), 1400);
await at(B[5]);

// ── SCENE 6 — finale B[5] → end ──
await clearCap();
await scrollTo(await yOf(".finale"), 1400);
await wait(400);
await caption(`<b style="color:${G}">proofarena-live.vercel.app</b> · program <span style="font-family:monospace">6iDo9DXU…gD5L</span> · devnet`);
await at(B[6] + 2.2);

await context.close();
await browser.close();

// newest-by-mtime rename (alphabetical picked stale files before — lesson learned)
const vids = readdirSync(`${here}out`).filter((f) => f.endsWith(".webm"))
  .map((f) => ({ f, m: statSync(`${here}out/${f}`).mtimeMs })).sort((a, b) => b.m - a.m);
renameSync(`${here}out/${vids[0].f}`, `${here}out/capture.webm`);
console.log("capture.webm saved");
