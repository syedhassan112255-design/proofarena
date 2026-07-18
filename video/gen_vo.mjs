// ProofArena demo voiceover (ElevenLabs, "Jon - Natural Authority"), segment
// per scene, concatenated with fixed gaps → out/vo.mp3 + out/boundaries.json.
import { writeFileSync } from "fs";
import { execSync } from "child_process";

const KEY = process.env.ELEVENLABS_KEY;
const VOICE = process.env.VOICE_JON || "sB7vwSCyX0tQmU24cW2C";
const MODEL = "eleven_multilingual_v2";
const GAP = 0.6;

const segments = [
  "Every trading bot claims an amazing track record — and none of it can be verified. Logs get edited, losing trades disappear, backtests pose as live results. This is ProofArena: two autonomous agents whose track records cannot be faked — not even by their creator.",
  "Both agents read the same live TxLINE feed — the demargined consensus odds. Agent A, the Steamer, treats sharp pre-match moves as smart money, and backs the move. Agent B, the Fader, treats them as overreactions, and takes the other side. Stakes are sized by the Kelly criterion from separate bankrolls, and the duel runs twenty-four seven with no human input.",
  "What makes it honest is the chain itself. Every duel is committed to Solana before kickoff — the program rejects late entries using the blockchain's own clock. And settlement is not a database entry: it is a cryptographic Merkle proof of the real match statistic, verified on-chain by TxLINE's validate stat instruction.",
  "Every bout comes with receipts. This duel's commitment transaction is on-chain, timestamped before the match. And here is the settlement: the program calls directly into TxLINE's validate stat — the proof verifies against the published daily root, and the winner is recorded forever. Anyone can audit it.",
  "Even the failures stay. These two duels are marked no contest — a mid-tournament feed change made their predicates unprovable. They can never be deleted, because the program has no delete instruction. An unfakeable record keeps your losses as permanently as your wins.",
  "Two machines. One feed. Only proof decides. ProofArena — built on TxLINE, live on Solana devnet, fully autonomous.",
];

async function tts(text, out) {
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE}?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      text, model_id: MODEL,
      voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.12, use_speaker_boost: true },
    }),
  });
  if (!r.ok) throw new Error(`TTS ${r.status}: ${(await r.text()).slice(0, 200)}`);
  writeFileSync(out, Buffer.from(await r.arrayBuffer()));
}

const dir = new URL("./out", import.meta.url).pathname;
const dur = (f) => parseFloat(execSync(`ffprobe -v error -show_entries format=duration -of default=nk=1:nw=1 "${f}"`).toString().trim());

let totalChars = 0;
const files = [];
for (let i = 0; i < segments.length; i++) {
  totalChars += segments[i].length;
  const f = `${dir}/seg_${i}.mp3`;
  await tts(segments[i], f);
  console.log(`seg ${i}: ${dur(f).toFixed(2)}s (${segments[i].length} chars)`);
  files.push(f);
}
console.log("total chars:", totalChars);

const sil = `${dir}/sil.mp3`;
execSync(`ffmpeg -y -f lavfi -i anullsrc=r=44100:cl=mono -t ${GAP} -q:a 9 "${sil}" 2>/dev/null`);
const boundaries = [0];
let t = 0;
const lines = [];
for (let i = 0; i < files.length; i++) {
  lines.push(`file '${files[i]}'`);
  t += dur(files[i]);
  if (i < files.length - 1) { lines.push(`file '${sil}'`); t += GAP; }
  boundaries.push(t);
}
writeFileSync(`${dir}/concat.txt`, lines.join("\n"));
execSync(`ffmpeg -y -f concat -safe 0 -i "${dir}/concat.txt" -c copy "${dir}/vo.mp3" 2>/dev/null`);
console.log("vo.mp3:", dur(`${dir}/vo.mp3`).toFixed(2), "s | boundaries:", boundaries.map((b) => b.toFixed(1)).join(", "));
writeFileSync(`${dir}/boundaries.json`, JSON.stringify(boundaries));
