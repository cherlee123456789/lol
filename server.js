// server.js
console.log("RUNNING SERVER.JS FILE:", import.meta.url);

import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

const RIOT_API_KEY = process.env.RIOT_API_KEY;

// Match-V5 routing for NA players
const MATCH_REGION = "americas";

// Friends (Riot ID)
const FRIENDS = [
  { label: "Nouology", gameName: "Nouology", tagLine: "11111" },
  { label: "Kindred", gameName: "Kindred", tagLine: "1v9" },
  { label: "콩순이", gameName: "콩순이", tagLine: "SLEEP" },
  { label: "Pzzangs Child", gameName: "Pzzangs Child", tagLine: "YASUO" },
  { label: "bussking69", gameName: "bussking69", tagLine: "rek" },
  { label: "Chill Guy", gameName: "Chill Guy", tagLine: "Yang" },
  { label: "electrophoresis", gameName: "electrophoresis", tagLine: "gel" },
  { label: "ZaZa Pack", gameName: "ZaZa Pack", tagLine: "NA1" },
  { label: "Deesalia", gameName: "Deesalia", tagLine: "NA1" },
  { label: "mega bner", gameName: "mega bner", tagLine: "111" },
  { label: "IW1llEatB00ty", gameName: "IW1llEatB00ty", tagLine: "CAre" },
];

console.log("SERVER RUNNING — KEY:", RIOT_API_KEY ? "Loaded" : "Missing");

/**
 * ✅ Rate-limit safe defaults
 * - Keep match count low (5)
 * - Cache aggressively
 * - Delay between friends
 */
const DEFAULT_COUNT = 5;                 // <- IMPORTANT: keep low
const MAX_COUNT = 8;                     // cap to avoid 429
const PER_PLAYER_DELAY_MS = 900;         // slow down between friends

// Cache TTLs
const SUMMARY_CACHE_TTL_MS = 5 * 60 * 1000;  // 5 min for per-player summary
const MATCH_DETAIL_TTL_MS = 30 * 60 * 1000;  // 30 min for match detail caching
const PUUID_TTL_MS = 24 * 60 * 60 * 1000;    // 24h cache for puuid

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Cache file
const CACHE_FILE = path.join(__dirname, "match_cache.json");

function readCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
  } catch {
    return { players: {}, matches: {} };
  }
}
function writeCache(cache) {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), "utf8");
}

// Riot fetch with 429 detection + retry-after exposure
async function riotFetch(url) {
  const res = await fetch(url, {
    headers: { "X-Riot-Token": RIOT_API_KEY, Accept: "application/json" },
  });

  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  if (res.status === 429) {
    const retryAfter = res.headers.get("retry-after");
    const msg = data?.status?.message || "rate limit exceeded";
    const err = new Error(`429 Too Many Requests ${msg}`);
    err.code = 429;
    err.retryAfter = retryAfter ? Number(retryAfter) : null;
    throw err;
  }

  if (!res.ok || data?.status) {
    const msg = data?.status?.message || JSON.stringify(data).slice(0, 200);
    throw new Error(`${res.status} ${res.statusText} ${msg}`.trim());
  }

  return data;
}

// Riot ID -> puuid (cached)
async function getPuuidCached(cache, gameName, tagLine) {
  const key = `${gameName}#${tagLine}`;
  const existing = cache.players[key]?.puuidEntry;

  if (existing && Date.now() - existing.updatedAt < PUUID_TTL_MS) {
    return existing.puuid;
  }

  const url = `https://${MATCH_REGION}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(
    gameName
  )}/${encodeURIComponent(tagLine)}`;

  const acct = await riotFetch(url);
  if (!acct?.puuid) throw new Error(`No puuid for ${key}`);

  cache.players[key] = cache.players[key] || {};
  cache.players[key].puuidEntry = { puuid: acct.puuid, updatedAt: Date.now() };

  return acct.puuid;
}

// puuid -> match ids (ranked only, low count)
async function getMatchIds(puuid, count) {
  // type=ranked reduces noise; count kept low
  const url = `https://${MATCH_REGION}.api.riotgames.com/lol/match/v5/matches/by-puuid/${encodeURIComponent(
    puuid
  )}/ids?start=0&count=${encodeURIComponent(count)}&type=ranked`;

  const ids = await riotFetch(url);
  if (!Array.isArray(ids)) throw new Error("Match ids response was not an array");
  return ids;
}

// matchId -> match detail (cached per matchId)
async function getMatchCached(cache, matchId) {
  const entry = cache.matches[matchId];
  if (entry && Date.now() - entry.updatedAt < MATCH_DETAIL_TTL_MS) {
    return entry.data;
  }

  const url = `https://${MATCH_REGION}.api.riotgames.com/lol/match/v5/matches/${encodeURIComponent(matchId)}`;
  const match = await riotFetch(url);

  cache.matches[matchId] = { data: match, updatedAt: Date.now() };
  return match;
}

// Build summary from matches
function summarizeMatches(puuid, matches) {
  let wins = 0, games = 0;
  let kSum = 0, dSum = 0, aSum = 0;
  const champCount = new Map();
  let lastGameStart = null;

  for (const m of matches) {
    const info = m?.info;
    const participants = info?.participants;
    if (!info || !Array.isArray(participants)) continue;

    const p = participants.find((x) => x?.puuid === puuid);
    if (!p) continue;

    games += 1;
    if (p.win) wins += 1;

    kSum += Number(p.kills || 0);
    dSum += Number(p.deaths || 0);
    aSum += Number(p.assists || 0);

    const champ = p.championName || "Unknown";
    champCount.set(champ, (champCount.get(champ) || 0) + 1);

    const ts = info.gameStartTimestamp || null;
    if (ts && (!lastGameStart || ts > lastGameStart)) lastGameStart = ts;
  }

  let mostPlayed = "—", mostPlayedCount = 0;
  for (const [champ, c] of champCount.entries()) {
    if (c > mostPlayedCount) {
      mostPlayed = champ;
      mostPlayedCount = c;
    }
  }

  const winrate = games > 0 ? Math.round((wins / games) * 1000) / 10 : 0;
  const avgK = games > 0 ? Math.round((kSum / games) * 10) / 10 : 0;
  const avgD = games > 0 ? Math.round((dSum / games) * 10) / 10 : 0;
  const avgA = games > 0 ? Math.round((aSum / games) * 10) / 10 : 0;

  return { games, wins, winrate, avgK, avgD, avgA, mostPlayed, lastGameStart };
}

// Serve frontend
app.use(express.static(path.join(__dirname, "public")));

// Match-V5 leaderboard (rate-limit safe)
app.get("/api/match-leaderboard", async (req, res) => {
  if (!RIOT_API_KEY) return res.status(400).json({ error: "Missing RIOT_API_KEY" });

  const countRaw = Number(req.query.count ?? DEFAULT_COUNT);
  const count = Math.max(1, Math.min(MAX_COUNT, Number.isFinite(countRaw) ? countRaw : DEFAULT_COUNT));

  const cache = readCache();
  cache.players = cache.players || {};
  cache.matches = cache.matches || {};

  const results = [];
  let rateLimited = false;
  let retryAfter = null;

  for (const f of FRIENDS) {
    const riotId = `${f.gameName}#${f.tagLine}`;
    const pKey = riotId;
    cache.players[pKey] = cache.players[pKey] || {};

    // ✅ Use cached summary if fresh (this avoids tons of calls)
    const summaryEntry = cache.players[pKey].summaryEntry;
    if (summaryEntry && Date.now() - summaryEntry.updatedAt < SUMMARY_CACHE_TTL_MS && summaryEntry.count === count) {
      results.push({ player: f.label, riotId, ...summaryEntry.data, cached: true, error: null });
      continue;
    }

    try {
      const puuid = await getPuuidCached(cache, f.gameName, f.tagLine);
      const matchIds = await getMatchIds(puuid, count);

      // Fetch match details (but cached by matchId, so after first run it’s cheap)
      const matches = [];
      for (const id of matchIds) {
        const match = await getMatchCached(cache, id);
        matches.push(match);
      }

      const summary = summarizeMatches(puuid, matches);
      const data = {
        ...summary,
        count,
        lastGameStartISO: summary.lastGameStart ? new Date(summary.lastGameStart).toISOString() : null,
      };

      cache.players[pKey].summaryEntry = { data, updatedAt: Date.now(), count };

      results.push({ player: f.label, riotId, ...data, cached: false, error: null });
    } catch (e) {
      if (e?.code === 429) {
        rateLimited = true;
        retryAfter = e.retryAfter;

        // ✅ If rate-limited, serve the best cached summary we have
        const cached = cache.players[pKey].summaryEntry;
        if (cached) {
          results.push({ player: f.label, riotId, ...cached.data, cached: true, error: "RATE LIMITED (served cached)" });
        } else {
          results.push({
            player: f.label,
            riotId,
            games: 0, wins: 0, winrate: 0, avgK: 0, avgD: 0, avgA: 0,
            mostPlayed: "—", lastGameStartISO: null,
            cached: false,
            error: "429 Too Many Requests (no cache yet)",
          });
        }

        // Stop making more Riot calls this request
        break;
      }

      results.push({
        player: f.label,
        riotId,
        games: 0, wins: 0, winrate: 0, avgK: 0, avgD: 0, avgA: 0,
        mostPlayed: "—", lastGameStartISO: null,
        cached: false,
        error: String(e.message || e),
      });
    }

    await sleep(PER_PLAYER_DELAY_MS);
  }

  writeCache(cache);

  results.sort((a, b) => {
    const aErr = !!a.error && !String(a.error).includes("served cached");
    const bErr = !!b.error && !String(b.error).includes("served cached");
    if (aErr && !bErr) return 1;
    if (bErr && !aErr) return -1;
    if (b.winrate !== a.winrate) return b.winrate - a.winrate;
    return b.games - a.games;
  });

  res.json({
    updatedAt: Date.now(),
    count,
    rateLimited,
    retryAfterSeconds: retryAfter,
    results,
  });
});

app.listen(PORT, () => console.log(`✅ http://localhost:${PORT}`));
