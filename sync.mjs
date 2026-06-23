// scripts/sync.mjs
// World Cup 2026 -> Firebase RTDB sync (results auto-fill + live snapshot)
// Node 20+ (built-in fetch). No dependencies.
//
// Env:
//   API_KEY  (required)  api-sports.io key  -> GitHub secret APIFOOTBALL_KEY
//   DB_URL   (optional)  RTDB base url; leave unset to use the baked-in default
//
// Writes via plain REST (your RTDB rules already allow the app's client writes):
//   PATCH /game/results     finished-match outcomes (H/D/A group, H/A knockout)
//   PUT   /live             today's slate for the Live tab
//   PUT   /sync_schedule     internal: cached kickoff times + deep-stat clock

const API_KEY = process.env.API_KEY;
const DB = (process.env.DB_URL ||
  "https://world-cup-prediction-gam-b0c95-default-rtdb.asia-southeast1.firebasedatabase.app"
).replace(/\/+$/, "");
const API = "https://v3.football.api-sports.io";
const LEAGUE = 1, SEASON = 2026;

const WINDOW_MIN    = 150;                 // a match is "on" from kickoff to +150 min
const PREROLL_MIN   = 5;                    // start polling a few min before kickoff
const DEEP_EVERY_MS = 20 * 60 * 1000;       // possession/shots/scorers refresh cadence
const QUOTA_FLOOR   = 20;                    // skip deep stats when daily remaining < this

if (!API_KEY) { console.error("Missing API_KEY env."); process.exit(1); }

/* ---------- group data (mirrors the app, to rebuild match ids) ---------- */
const GROUPS = {
  A:["Mexico","South Africa","South Korea","Czechia"],
  B:["Canada","Bosnia & Herzegovina","Qatar","Switzerland"],
  C:["Brazil","Morocco","Haiti","Scotland"],
  D:["USA","Paraguay","Türkiye","Australia"],
  E:["Germany","Curaçao","Ivory Coast","Ecuador"],
  F:["Netherlands","Japan","Sweden","Tunisia"],
  G:["Belgium","Egypt","Iran","New Zealand"],
  H:["Spain","Cape Verde","Saudi Arabia","Uruguay"],
  I:["France","Senegal","Iraq","Norway"],
  J:["Argentina","Algeria","Austria","Jordan"],
  K:["Portugal","DR Congo","Uzbekistan","Colombia"],
  L:["England","Croatia","Ghana","Panama"]
};
const MD = [[[0,1],[2,3]],[[0,3],[1,2]],[[0,2],[1,3]]];
const GROUP_MATCHES = [];
for (const g of Object.keys(GROUPS)) {
  MD.forEach(pairs => pairs.forEach(([a,b]) => {
    GROUP_MATCHES.push({ id:`${g}-${a}${b}`, a:GROUPS[g][a], b:GROUPS[g][b] });
  }));
}

/* ---------- name normalisation (API spelling -> app spelling) ---------- */
const norm = s => String(s).toLowerCase().normalize("NFD")
  .replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9]/g,"");
const SYN = {}; // normalized variant -> app canonical exact string
[
  ["USA", ["United States","USA","US","USMNT"]],
  ["Türkiye", ["Turkey","Türkiye","Turkiye"]],
  ["South Korea", ["Korea Republic","South Korea","Korea South"]],
  ["Ivory Coast", ["Côte d'Ivoire","Cote d'Ivoire","Ivory Coast"]],
  ["DR Congo", ["Congo DR","DR Congo","Democratic Republic of Congo","Congo Democratic Republic"]],
  ["Czechia", ["Czech Republic","Czechia"]],
  ["Bosnia & Herzegovina", ["Bosnia and Herzegovina","Bosnia & Herzegovina","Bosnia Herzegovina","Bosnia"]],
  ["Cape Verde", ["Cape Verde Islands","Cape Verde","Cabo Verde"]],
  ["Iran", ["IR Iran","Iran"]],
  ["Curaçao", ["Curacao","Curaçao"]]
].forEach(([appName, variants]) => variants.forEach(v => { SYN[norm(v)] = appName; }));
const toApp = name => SYN[norm(name)] || name;

/* ---------- tiny HTTP helpers ---------- */
let lastRemaining = Infinity;
async function apiGet(path) {
  const r = await fetch(`${API}${path}`, { headers: { "x-apisports-key": API_KEY } });
  const rem = r.headers.get("x-ratelimit-requests-remaining");
  if (rem != null) lastRemaining = Number(rem);
  const j = await r.json();
  const errs = j.errors;
  if (errs && (Array.isArray(errs) ? errs.length : Object.keys(errs).length))
    console.error("API error:", JSON.stringify(errs));
  return j.response || [];
}
async function dbGet(path) {
  const r = await fetch(`${DB}/${path}.json`);
  return r.ok ? r.json() : null;
}
async function dbPut(path, body) {
  await fetch(`${DB}/${path}.json`, { method:"PUT", body: JSON.stringify(body) });
}
async function dbPatch(path, body) {
  if (!Object.keys(body).length) return;
  await fetch(`${DB}/${path}.json`, { method:"PATCH", body: JSON.stringify(body) });
}

/* ---------- status sets ---------- */
const LIVE = new Set(["1H","2H","HT","ET","BT","P","LIVE","INT","SUSP"]);
const DONE = new Set(["FT","AET","PEN"]);

/* ---------- group result, oriented to the app's a/b ("1"=a wins) ---------- */
function groupResult(fx) {
  const home = toApp(fx.teams.home.name), away = toApp(fx.teams.away.name);
  const gm = GROUP_MATCHES.find(m =>
    (norm(m.a)===norm(home) && norm(m.b)===norm(away)) ||
    (norm(m.a)===norm(away) && norm(m.b)===norm(home)));
  if (!gm) return null;
  const gh = fx.goals.home, ga = fx.goals.away;
  let res = gh>ga ? "H" : gh<ga ? "A" : "D";
  if (norm(home) !== norm(gm.a) && res !== "D") res = res==="H" ? "A" : "H"; // home/away swapped vs app
  return { id: gm.id, res };
}

/* ---------- knockout result, matched to a user-added tie ---------- */
function koResult(fx, koList) {
  if (!koList.length) return null;
  const home = toApp(fx.teams.home.name), away = toApp(fx.teams.away.name);
  const tie = koList.find(t =>
    (norm(toApp(t.a))===norm(home) && norm(toApp(t.b))===norm(away)) ||
    (norm(toApp(t.a))===norm(away) && norm(toApp(t.b))===norm(home)));
  if (!tie) return null;
  const winnerApp = fx.teams.home.winner === true ? home
                  : fx.teams.away.winner === true ? away
                  : fx.goals.home>fx.goals.away ? home
                  : fx.goals.away>fx.goals.home ? away : null;
  if (!winnerApp) return null;
  return { id: tie.id, res: norm(winnerApp)===norm(toApp(tie.a)) ? "H" : "A" };
}

/* ---------- deep stats + scorers for one fixture (2 API calls) ---------- */
const pickStat = (arr, type) => { const s = (arr||[]).find(x => x.type === type); return s ? s.value : null; };
async function fixtureDetail(fx) {
  const fid = fx.fixture.id, homeId = fx.teams.home.id;
  const [stats, events] = await Promise.all([
    apiGet(`/fixtures/statistics?fixture=${fid}`),
    apiGet(`/fixtures/events?fixture=${fid}`)
  ]);
  let out = null;
  if (stats.length === 2) {
    const H = stats.find(s=>s.team.id===homeId) || stats[0];
    const A = stats.find(s=>s.team.id!==homeId) || stats[1];
    const pct = v => v==null ? null : parseInt(String(v),10);
    out = {
      possession:{ home:pct(pickStat(H.statistics,"Ball Possession")), away:pct(pickStat(A.statistics,"Ball Possession")) },
      shots:     { home:pickStat(H.statistics,"Total Shots"),   away:pickStat(A.statistics,"Total Shots") },
      sot:       { home:pickStat(H.statistics,"Shots on Goal"), away:pickStat(A.statistics,"Shots on Goal") },
      corners:   { home:pickStat(H.statistics,"Corner Kicks"),  away:pickStat(A.statistics,"Corner Kicks") },
      fouls:     { home:pickStat(H.statistics,"Fouls"),         away:pickStat(A.statistics,"Fouls") }
    };
  }
  const scorers = (events||[])
    .filter(e => e.type === "Goal" && e.detail !== "Missed Penalty")
    .map(e => ({
      side: e.team && e.team.id===homeId ? "home" : "away",
      player: e.player ? e.player.name : "",
      minute: e.time ? e.time.elapsed : null,
      tag: e.detail==="Penalty" ? "P" : e.detail==="Own Goal" ? "OG" : ""
    }));
  return { stats: out, scorers };
}

/* ---------- main ---------- */
(async () => {
  const now = Date.now();
  const todayUTC = new Date().toISOString().slice(0,10);

  const sched = await dbGet("sync_schedule");
  const needSeed = !sched || sched.date !== todayUTC;

  // 1) from cache, skip the run entirely if nothing is on (costs 0 API calls)
  if (!needSeed) {
    const onNow = (sched.kickoffs||[]).some(k => {
      const ko = Date.parse(k);
      return now >= ko - PREROLL_MIN*60000 && now <= ko + WINDOW_MIN*60000;
    });
    if (!onNow) { console.log("No match in window; idle (0 API calls)."); return; }
  }

  // 2) one cheap call: today's fixtures (scores, status, results)
  const fixtures = await apiGet(`/fixtures?league=${LEAGUE}&season=${SEASON}&date=${todayUTC}`);
  console.log(`Fetched ${fixtures.length} fixtures for ${todayUTC}. Quota remaining ~${lastRemaining}.`);
  const kickoffs = fixtures.map(f => f.fixture.date);
  const deepAt = (!needSeed && sched.deepAt) ? sched.deepAt : 0;

  // 3) write finished results (group + knockout)
  const koRaw = await dbGet("game/ko");
  const koList = (Array.isArray(koRaw) ? koRaw : koRaw ? Object.values(koRaw) : []).filter(Boolean);
  const resultPatch = {};
  for (const fx of fixtures) {
    if (!DONE.has(fx.fixture.status.short)) continue;
    const round = (fx.league && fx.league.round) || "";
    const r = /^group/i.test(round) ? groupResult(fx) : koResult(fx, koList);
    if (r) resultPatch[r.id] = r.res;
    else console.warn(`Unmatched finished fixture: ${fx.teams.home.name} v ${fx.teams.away.name} (${round})`);
  }
  await dbPatch("game/results", resultPatch);
  if (Object.keys(resultPatch).length) console.log("Wrote results:", resultPatch);

  // 4) live snapshot for today's slate (deep stats throttled + quota-gated)
  const liveFx = fixtures.filter(f => LIVE.has(f.fixture.status.short));
  const doDeep = liveFx.length>0 && (now-deepAt>=DEEP_EVERY_MS) && lastRemaining>QUOTA_FLOOR;
  const detail = {};
  if (doDeep) for (const fx of liveFx) detail[fx.fixture.id] = await fixtureDetail(fx);

  const prev = {};
  const prevLive = await dbGet("live");
  if (prevLive && Array.isArray(prevLive.matches)) prevLive.matches.forEach(m => { prev[m.id]=m; });

  const matches = fixtures.map(fx => {
    const st = fx.fixture.status.short, d = detail[fx.fixture.id], p = prev[fx.fixture.id] || {};
    return {
      id: fx.fixture.id, status: st, live: LIVE.has(st), done: DONE.has(st),
      minute: fx.fixture.status.elapsed ?? null,
      round: (fx.league && fx.league.round) || "", kickoff: fx.fixture.date,
      home: { name: toApp(fx.teams.home.name), goals: fx.goals.home },
      away: { name: toApp(fx.teams.away.name), goals: fx.goals.away },
      scorers: d ? d.scorers : (p.scorers || []),
      stats:   d ? d.stats   : (p.stats   || null)
    };
  });

  await dbPut("live", { updated: now, date: todayUTC, matches });
  await dbPut("sync_schedule", { date: todayUTC, kickoffs, deepAt: doDeep ? now : deepAt });
  console.log(`Live: ${matches.length} matches, ${liveFx.length} live${doDeep?" (deep stats refreshed)":""}.`);
})().catch(e => { console.error(e); process.exit(1); });
