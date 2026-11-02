// Builds the Court Report data payload from Sleeper + ESPN.
// Used by api/data.js (the page) and api/alerts.js (the cron job).

const SLEEPER = "https://api.sleeper.app/v1";
const SLEEPER2 = "https://api.sleeper.com";
const ESPN = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=";
const ESPN_TO_SLEEPER = { GS: "GSW", NY: "NYK", NO: "NOP", SA: "SAS", UTAH: "UTA", WSH: "WAS", PHO: "PHX" };
const TZ = "America/New_York";

// Module-level caches survive between requests while the serverless instance stays warm.
const cache = new Map();
async function getJSON(url, { ttl = 0, timeout = 20000 } = {}) {
  const hit = cache.get(url);
  if (ttl && hit && Date.now() - hit.at < ttl) return hit.data;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": "court-report" } });
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    const data = await r.json();
    if (ttl) cache.set(url, { at: Date.now(), data });
    return data;
  } finally {
    clearTimeout(t);
  }
}
async function safe(url, fallback, opts) {
  try { return await getJSON(url, opts); } catch (e) { console.warn("fetch failed", url, e.message); return fallback; }
}

const MIN = 60 * 1000, HOUR = 60 * MIN;

export function etDate(d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
function addDays(iso, n) {
  const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
}

export function fantasyPoints(s, sc) {
  if (!s) return 0;
  let fp = 0;
  for (const [k, v] of Object.entries(sc)) if (!k.startsWith("bonus_")) fp += (s[k] || 0) * v;
  const pts = s.pts || 0, reb = s.reb || 0, ast = s.ast || 0;
  if (pts >= 40) fp += sc.bonus_pt_40p || 0;
  if (pts >= 50) fp += sc.bonus_pt_50p || 0;
  if (reb >= 20) fp += sc.bonus_reb_20p || 0;
  if (ast >= 15) fp += sc.bonus_ast_15p || 0;
  return Math.round(fp * 10) / 10;
}
const r1 = x => (x == null || Number.isNaN(x) ? null : Math.round(x * 10) / 10);
const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);

export async function buildData({ leagueId, ownerId }) {
  const now = new Date();
  const today = etDate(now);

  const state = await getJSON(`${SLEEPER}/state/nba`, { ttl: 10 * MIN });
  const season = state.league_season || state.season;
  const week = Number(state.leg || state.week || 1);

  const [league, users, rosters, players_all, preseasonArr, weekProj, schedule, tradedPicks] = await Promise.all([
    getJSON(`${SLEEPER}/league/${leagueId}`, { ttl: 10 * MIN }),
    getJSON(`${SLEEPER}/league/${leagueId}/users`, { ttl: 10 * MIN }),
    getJSON(`${SLEEPER}/league/${leagueId}/rosters`),
    getJSON(`${SLEEPER}/players/nba`, { ttl: 6 * HOUR, timeout: 60000 }),
    safe(`${SLEEPER2}/projections/nba/${season}?season_type=regular`, [], { ttl: 6 * HOUR }),
    safe(`${SLEEPER2}/projections/nba/${season}/${week}?season_type=regular`, [], { ttl: 30 * MIN }),
    safe(`${SLEEPER2}/schedule/nba/regular/${season}`, [], { ttl: 30 * MIN }),
    safe(`${SLEEPER}/league/${leagueId}/traded_picks`, [], { ttl: 10 * MIN }),
  ]);
  const sc = league.scoring_settings;
  const slots = league.roster_positions.filter(p => p !== "BN");

  // Matchups for every week so far (past weeks rarely change, so cache them)
  const weeks = Array.from({ length: week }, (_, i) => i + 1);
  const matchupsByWeek = Object.fromEntries(await Promise.all(weeks.map(async w =>
    [w, await safe(`${SLEEPER}/league/${leagueId}/matchups/${w}`, [], { ttl: w < week ? 6 * HOUR : 0 })])));

  // Per-game logs for the season; the current week's stats stay fresh for live lock decisions
  const statWeeks = await Promise.all(weeks.map(w =>
    safe(`${SLEEPER2}/stats/nba/${season}/${w}?season_type=regular`, [], { ttl: w < week ? 3 * HOUR : 0 })));
  const logs = {};
  statWeeks.forEach((rows, i) => {
    for (const row of rows) {
      const s = row.stats || {};
      if ((s.min || 0) <= 0) continue;
      (logs[row.player_id] ||= []).push({ d: row.date, w: i + 1, opp: row.opponent, fp: fantasyPoints(s, sc), min: Math.round((s.min || 0) * 10) / 10 });
    }
  });

  // Schedule for this week, back-to-backs, games left in the season
  const weekGames = schedule.filter(g => g.week === week);
  const weekDates = [...new Set(weekGames.map(g => g.date))].sort();
  const remaining = {}, teamWeek = {}, teamDates = {};
  for (const g of schedule) {
    for (const side of ["home", "away"]) (teamDates[g[side].team] ||= new Set()).add(g.date);
    if (g.status === "complete" || g.date < today) continue;
    for (const side of ["home", "away"]) remaining[g[side].team] = (remaining[g[side].team] || 0) + 1;
  }
  for (const g of weekGames) {
    const h = g.home.team, a = g.away.team;
    (teamWeek[h] ||= []).push({ d: g.date, opp: a, home: true });
    (teamWeek[a] ||= []).push({ d: g.date, opp: h, home: false });
  }

  // ESPN: tip times and live game state for every date this week
  const games = [];
  const boards = await Promise.all(weekDates.map(d =>
    safe(ESPN + d.replaceAll("-", ""), { events: [] }, { ttl: d < today ? 6 * HOUR : 0 })));
  boards.forEach((sb, i) => {
    for (const e of sb.events || []) {
      const comp = e.competitions[0];
      const t = {};
      for (const c of comp.competitors) {
        const ab = ESPN_TO_SLEEPER[c.team.abbreviation] || c.team.abbreviation;
        t[c.homeAway] = { t: ab, s: c.score };
      }
      const st = e.status.type;
      games.push({ d: weekDates[i], tip: e.date, home: t.home.t, away: t.away.t, hs: t.home.s, as: t.away.s, state: st.state, detail: st.shortDetail || st.description });
    }
  });
  const gameOf = (team, d) => games.find(g => g.d === d && (g.home === team || g.away === team));

  const daily = {};
  for (const row of weekProj) (daily[row.player_id] ||= {})[row.date] = fantasyPoints(row.stats, sc);
  const preseason = Object.fromEntries(preseasonArr.map(r => [r.player_id, r]));

  // Which players to send: everyone rostered plus the best free agents
  const rostered = {};
  for (const r of rosters) for (const p of r.players || []) rostered[p] = r.roster_id;
  const include = new Set(Object.keys(rostered));
  const pool = [];
  for (const [pid, p] of Object.entries(players_all)) {
    if (rostered[pid] || !p.team || !["ACT", "TWO-WAY"].includes(p.status)) continue;
    const pre = fantasyPoints(preseason[pid]?.stats, sc);
    const g = logs[pid] || [];
    const avg = g.length ? mean(g.map(x => x.fp)) : 0;
    if (Math.max(pre, avg) >= 8 || g.length >= 2) pool.push([Math.max(pre, avg), pid]);
  }
  pool.sort((a, b) => b[0] - a[0]);
  const faIds = pool.slice(0, 180).map(x => x[1]);
  faIds.forEach(id => include.add(id));

  const cutoff14 = addDays(today, -14);
  const players = {};
  for (const pid of include) {
    const p = players_all[pid];
    if (!p) continue;
    const preRow = preseason[pid]?.stats || {};
    const pre = fantasyPoints(preRow, sc);
    const g = (logs[pid] || []).sort((a, b) => a.d.localeCompare(b.d));
    const gp = g.length;
    const fps = g.map(x => x.fp);
    const avg = mean(fps);
    const recent = g.filter(x => x.d >= cutoff14);
    const l14 = mean(recent.map(x => x.fp));
    // Blend: preseason outlook shrunk toward the season average, then tilted toward the last 14 days
    const prior = pre > 0 ? pre : (avg || 0);
    const base = gp ? (5 * prior + gp * avg) / (5 + gp) : prior;
    const rw = 0.4 * Math.min(recent.length, 5) / 5;
    const val = recent.length ? base * (1 - rw) + l14 * rw : base;
    // Game-to-game spread drives lock decisions; shrink toward 33% of value when the sample is small
    const sdObs = gp >= 2 ? Math.sqrt(fps.reduce((s, x) => s + (x - avg) ** 2, 0) / (gp - 1)) : null;
    const sdPrior = Math.max(3, 0.33 * val);
    const sd = sdObs == null ? sdPrior : (sdObs * gp + sdPrior * 4) / (gp + 4);

    const team = p.team;
    const wk = {};
    for (const x of teamWeek[team] || []) {
      const gm = gameOf(team, x.d);
      const played = g.find(l => l.d === x.d && l.w === week);
      wk[x.d] = {
        opp: x.opp, home: x.home, proj: daily[pid]?.[x.d] ?? null,
        b2b: (teamDates[team] || new Set()).has(addDays(x.d, -1)),
        tip: gm?.tip || null, state: gm?.state || "pre",
        fp: played ? played.fp : null, min: played ? played.min : null,
      };
    }
    players[pid] = {
      n: p.full_name || `${p.first_name || ""} ${p.last_name || ""}`.trim(), t: team, pos: p.fantasy_positions || [],
      age: p.age, exp: p.years_exp ?? null, inj: p.injury_status, injPart: p.injury_body_part, injNote: p.injury_notes,
      pre: r1(pre), gp, avg: r1(avg), l14: r1(l14), l14n: recent.length, min: r1(mean(g.map(x => x.min))),
      val: r1(val), sd: r1(sd), adp: preRow.adp_dynasty ?? null, rem: remaining[team] || 0, wk,
      log: g.slice(-8).map(x => [x.d, x.opp, x.fp, x.min]), own: rostered[pid] || null,
    };
  }

  const umap = Object.fromEntries(users.map(u => [u.user_id, u]));
  const teams = rosters.map(r => {
    const u = umap[r.owner_id] || {};
    const meta = r.metadata || {};
    const s = r.settings || {};
    return {
      rid: r.roster_id, owner: r.owner_id, user: u.display_name || "Open team",
      name: u.metadata?.team_name || u.display_name || `Team ${r.roster_id}`,
      w: s.wins || 0, l: s.losses || 0, tie: s.ties || 0,
      pf: r1((s.fpts || 0) + (s.fpts_decimal || 0) / 100), pa: r1((s.fpts_against || 0) + (s.fpts_against_decimal || 0) / 100),
      ppts: r1((s.ppts || 0) + (s.ppts_decimal || 0) / 100), div: s.division, streak: meta.streak,
      players: r.players || [], reserve: r.reserve || [], taxi: r.taxi || [], keepers: r.keepers || [],
      nicks: Object.fromEntries(Object.entries(meta).filter(([k]) => k.startsWith("p_nick_")).map(([k, v]) => [k.slice(7), v])),
    };
  });

  const history = weeks.filter(w => w < week).map(w => ({ w, s: matchupsByWeek[w].map(m => [m.roster_id, m.matchup_id, r1(m.points || 0)]) }));
  const current = (matchupsByWeek[week] || []).map(m => ({
    rid: m.roster_id, mid: m.matchup_id, pts: r1(m.points || 0), starters: m.starters || [],
    // In Lock-In, players_points is the one game that currently counts for each player: their locked game, or their latest game
    pp: Object.fromEntries(Object.entries(m.players_points || {}).map(([k, v]) => [k, r1(v || 0)])),
  }));
  const me = teams.find(t => t.owner === ownerId);

  return {
    gen: now.toISOString(), today, week, season, weekDates,
    league: {
      id: leagueId, name: league.name, slots, scoring: sc, keepers: league.settings?.max_keepers,
      faab: league.settings?.waiver_budget, teamsN: league.total_rosters,
      // type 2 = dynasty
      type: league.settings?.type, reserveSlots: league.settings?.reserve_slots ?? 0, taxiSlots: league.settings?.taxi_slots ?? 0,
      taxiYears: league.settings?.taxi_years ?? 0, taxiVets: !!league.settings?.taxi_allow_vets, rounds: league.settings?.draft_rounds ?? 3,
      divs: Object.fromEntries(Object.entries(league.metadata || {}).filter(([k]) => k.startsWith("division_") && !k.endsWith("avatar"))),
    },
    me: me ? me.rid : null, teams, players,
    // Future rookie picks: each team owns its own unless a trade moved it
    picks: futurePicks(Number(season), league.settings?.draft_rounds ?? 3, rosters.map(r => r.roster_id), tradedPicks), fa: faIds.filter(id => players[id]), history, current, games,
  };
}

// Sleeper lets dynasty leagues trade picks three drafts out
function futurePicks(season, rounds, rosterIds, traded) {
  const out = [];
  for (let y = season + 1; y <= season + 3; y++)
    for (let rd = 1; rd <= rounds; rd++)
      for (const rid of rosterIds) {
        const t = traded.find(x => Number(x.season) === y && x.round === rd && x.roster_id === rid);
        out.push({ season: y, round: rd, orig: rid, owner: t ? t.owner_id : rid });
      }
  return out;
}
