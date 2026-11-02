// Court Report — front end. Loads /api/data and renders every tab.
// League format: Sleeper NBA Lock-In. Each starter counts ONE game per week:
// the game you lock (before his next game starts, while he's in your lineup),
// otherwise his last game of the week. Locked players can't move slots.

let D = null, P = {}, TEAMS = {}, MEMO = {};
// Per-load cache for expensive calculations (cleared whenever new data arrives)
function memo(k, f) { return k in MEMO ? MEMO[k] : (MEMO[k] = f()); }
function baseLineup(rid) { return memo("bl" + rid, () => typicalLineup(active(TEAMS[rid]))); }
const st = { day: null, wPos: "ALL", wSort: "score", partner: null, give: new Set(), get: new Set(), kScope: "mine" };

const OUT = new Set(["Out", "IR", "Suspended", "Sus", "NA", "DNR", "COV"]);
// Chance a player suits up for his NEXT game given his status
const PLAY_PROB = { GTD: 0.7, Questionable: 0.6, "Day-To-Day": 0.75, DTD: 0.75, Doubtful: 0.2, Probable: 0.92 };
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const f1 = x => (x == null || isNaN(x) ? "—" : (Math.round(x * 10) / 10).toFixed(1));
const f0 = x => (x == null || isNaN(x) ? "—" : Math.round(x).toString());
const sum = a => a.reduce((s, x) => s + (x || 0), 0);
const pct = x => Math.round(x * 100) + "%";

// ---------- storage (manual lock marks live in your browser only) ----------
function lockKey() { return `cr-locks-${D.season}-${D.week}`; }
function manualLocks() { try { return JSON.parse(localStorage.getItem(lockKey()) || "{}"); } catch { return {}; } }
function setManualLock(id, d) { try { const m = manualLocks(); if (d) m[id] = d; else delete m[id]; localStorage.setItem(lockKey(), JSON.stringify(m)); } catch {} }

// ---------- math ----------
function normCdf(z) { const t = 1 / (1 + 0.2316419 * Math.abs(z)); const d = 0.3989423 * Math.exp(-z * z / 2); const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return z > 0 ? 1 - p : p; }
const phi = z => Math.exp(-z * z / 2) / Math.sqrt(2 * Math.PI);
// E[max(X, c)] for X ~ Normal(m, s)
function eMax(m, s, c) { if (!(s > 0)) return Math.max(m, c); const d = (m - c) / s; return m * normCdf(d) + c * normCdf(-d) + s * phi(d); }

function elig(slot, pos) { if (slot === "UTIL") return true; if (slot === "G") return pos.includes("PG") || pos.includes("SG"); if (slot === "F") return pos.includes("SF") || pos.includes("PF"); return pos.includes(slot); }
function active(team) { const out = new Set([...(team.reserve || []), ...(team.taxi || [])]); return team.players.filter(id => !out.has(id) && P[id]); }
function nick(team, id) { return team?.nicks ? team.nicks[id] : null; }
function dayLabel(d) { const x = new Date(d + "T12:00:00"); return x.toLocaleDateString(undefined, { weekday: "short" }) + " " + (x.getMonth() + 1) + "/" + x.getDate(); }
function gameFor(team, d) { return D.games.find(g => g.d === d && (g.home === team || g.away === team)); }
function tipTime(g) { if (!g) return ""; if (g.state === "in") return g.detail; if (g.state === "post") return "Final"; return new Date(g.tip).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); }
function tipLong(iso) { const d = new Date(iso); return d.toLocaleDateString(undefined, { weekday: "short" }) + " " + d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); }

// Expected fantasy points for one game: Sleeper's projection for that game blended with our season value
function gameMean(p, d) { const g = p.wk[d]; if (!g) return 0; let m = g.proj != null ? 0.5 * g.proj + 0.5 * (p.val || 0) : (p.val || 0); if (g.b2b) m *= 0.96; return m; }
function gameSd(p, d) { return Math.max(3, p.sd || 0.33 * gameMean(p, d)); }
// Games this week that haven't tipped yet, in order, with the chance he plays each
function futureGames(p) {
  const ds = D.weekDates.filter(d => p.wk[d] && p.wk[d].state === "pre");
  return ds.map((d, i) => ({ d, m: gameMean(p, d), s: gameSd(p, d), p: OUT.has(p.inj) ? (i === 0 ? 0 : 0.35) : i === 0 ? (PLAY_PROB[p.inj] ?? 0.97) : 0.95 }));
}
// Value of passing: optimal stopping over the remaining games. The last game counts no matter what.
function continuation(fut) {
  if (!fut.length) return null;
  const last = fut[fut.length - 1]; let V = last.p * last.m;
  for (let i = fut.length - 2; i >= 0; i--) { const f = fut[i]; V = f.p * eMax(f.m, f.s, V) + (1 - f.p) * V; }
  return V;
}
function chanceBeat(fut, s) { return 1 - fut.reduce((acc, f) => acc * (1 - f.p * (1 - normCdf((s - f.m) / f.s))), 1); }

// ---------- lock state ----------
// players_points in Lock-In = the game that currently counts: the locked one, or the latest one.
// If it matches an earlier game instead of the latest, that player is locked.
function lockState(rid, id) {
  const p = P[id]; const cur = D.current.find(c => c.rid === rid); if (!p || !cur) return { locked: false };
  const played = D.weekDates.filter(d => p.wk[d] && p.wk[d].state === "post" && p.wk[d].fp != null);
  const counted = cur.pp[id];
  if (rid === D.me) { const m = manualLocks()[id]; if (m && p.wk[m]) return { locked: true, d: m, score: p.wk[m].fp ?? counted, manual: true }; }
  if (played.length >= 2 && counted != null) {
    const latest = played[played.length - 1];
    if (Math.abs((p.wk[latest].fp ?? -999) - counted) > 0.05) {
      const hit = played.slice(0, -1).reverse().find(d => Math.abs(p.wk[d].fp - counted) <= 0.05);
      if (hit) return { locked: true, d: hit, score: counted };
    }
  }
  // Week over for him and it counts automatically
  return { locked: false };
}

// The lock-or-pass call for one player
function lockCall(rid, id, wp) {
  const p = P[id]; const ls = lockState(rid, id);
  if (ls.locked) return { kind: "locked", ls };
  const done = D.weekDates.filter(d => p.wk[d] && p.wk[d].state === "post" && p.wk[d].fp != null);
  const live = D.weekDates.find(d => p.wk[d] && p.wk[d].state === "in");
  if (live) return { kind: "live", d: live };
  const fut = futureGames(p);
  if (!done.length) return { kind: "waiting", fut };
  const d = done[done.length - 1]; const s = p.wk[d].fp;
  if (!fut.length) return { kind: "final", d, s };
  // Matchup context: protect a lead by locking a bit sooner, chase upside when behind
  const lean = wp == null ? 1 : wp > 0.7 ? 0.95 : wp < 0.35 ? 1.06 : 1;
  const W = continuation(fut); const bar = W * lean; const beat = chanceBeat(fut, s);
  const diff = (s - bar) / Math.max(bar, 1);
  const verdict = diff >= 0.04 ? "lock" : diff <= -0.04 ? "pass" : "toss";
  return { kind: "decide", d, s, fut, W, bar, beat, verdict, lean, deadline: fut[0] && gameFor(p.t, fut[0].d)?.tip };
}

// What a player is expected to end up counting for this week, under the lock/pass rule above
function expectedCount(rid, id) {
  const p = P[id]; const ls = lockState(rid, id); if (ls.locked) return ls.score;
  const fut = futureGames(p); const W = continuation(fut);
  const live = D.weekDates.find(d => p.wk[d] && p.wk[d].state === "in");
  if (live) return Math.max(gameMean(p, live), W ?? 0);
  const done = D.weekDates.filter(d => p.wk[d] && p.wk[d].state === "post" && p.wk[d].fp != null);
  const s = done.length ? p.wk[done[done.length - 1]].fp : null;
  if (W == null) return s ?? 0;
  return s != null ? Math.max(s, W) : W;
}

// Hungarian algorithm (min-cost assignment) on a square matrix
function hungarian(c) {
  const n = c.length, u = Array(n + 1).fill(0), v = Array(n + 1).fill(0), p = Array(n + 1).fill(0), way = Array(n + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i; let j0 = 0; const minv = Array(n + 1).fill(Infinity), used = Array(n + 1).fill(false);
    do {
      used[j0] = true; const i0 = p[j0]; let d = Infinity, j1 = 0;
      for (let j = 1; j <= n; j++) if (!used[j]) { const cur = c[i0 - 1][j - 1] - u[i0] - v[j]; if (cur < minv[j]) { minv[j] = cur; way[j] = j0; } if (minv[j] < d) { d = minv[j]; j1 = j; } }
      for (let j = 0; j <= n; j++) { if (used[j]) { u[p[j]] += d; v[j] -= d; } else minv[j] -= d; } j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
  }
  const res = Array(n).fill(-1); for (let j = 1; j <= n; j++) if (p[j]) res[p[j] - 1] = j - 1; return res;
}
function optimize(ids, scoreOf, slots = D.league.slots) {
  const pool = ids.map(id => ({ id, s: scoreOf(id) })).filter(x => x.s != null && x.s > 0);
  const n = Math.max(slots.length, pool.length); if (!n) return { lineup: slots.map(s => ({ slot: s, id: null, s: 0 })), total: 0 };
  const BIG = 1e6, c = [];
  for (let i = 0; i < n; i++) { const row = []; for (let j = 0; j < n; j++) { if (i >= slots.length || j >= pool.length) row.push(0); else row.push(elig(slots[i], P[pool[j].id].pos) ? -pool[j].s : BIG); } c.push(row); }
  const a = hungarian(c);
  const lineup = slots.map((s, i) => { const j = a[i]; if (j < pool.length && c[i][j] < BIG) return { slot: s, id: pool[j].id, s: pool[j].s }; return { slot: s, id: null, s: 0 }; });
  return { lineup, total: sum(lineup.map(x => x.s)) };
}

// ---------- matchup projection (shared by several tabs) ----------
function teamProjection(rid) {
  const team = TEAMS[rid]; const cur = D.current.find(c => c.rid === rid) || { starters: [], pp: {} };
  const ids = active(team); const slots = D.league.slots;
  const lockedSlots = [], openSlots = [], used = new Set();
  slots.forEach((s, i) => { const id = cur.starters[i]; const ls = id && lockState(rid, id); if (ls && ls.locked) { lockedSlots.push({ slot: s, id, score: ls.score }); used.add(id); } else openSlots.push(s); });
  const o = optimize(ids.filter(id => !used.has(id)), id => expectedCount(rid, id), openSlots);
  const lockedPts = sum(lockedSlots.map(x => x.score));
  const total = lockedPts + o.total;
  const varr = sum(o.lineup.map(x => (x.id ? Math.pow(0.25 * x.s, 2) : 0)));
  return { total, varr, lockedSlots, open: o.lineup, lockedPts };
}
function myMatchup() {
  const mine = D.current.find(c => c.rid === D.me); if (!mine) return null;
  const opp = D.current.find(c => c.mid === mine.mid && c.rid !== D.me); if (!opp) return null;
  const a = teamProjection(D.me), b = teamProjection(opp.rid);
  const sd = Math.sqrt(a.varr + b.varr) || 1;
  return { mine, opp, a, b, wp: normCdf((a.total - b.total) / sd) };
}

// ---------- shared bits ----------
function statusTags(p, d) {
  let h = ""; if (!p) return h;
  if (OUT.has(p.inj)) h += `<span class="tag t-out">${esc(p.inj === "IR" ? "IR" : "OUT")}</span>`;
  else if (p.inj) h += `<span class="tag t-q">${esc(p.inj === "Questionable" ? "Q" : p.inj === "Doubtful" ? "D" : p.inj)}</span>`;
  if (d && p.wk[d] && p.wk[d].b2b) h += `<span class="tag t-b2b">B2B</span>`;
  return h;
}
function plCell(id, team, d, extra = "") {
  const p = P[id]; if (!p) return `<div class="pl"><span class="a muted">Empty</span></div>`;
  const g = d && p.wk[d]; const n = nick(team, id);
  const opp = g ? `${g.home ? "vs" : "@"} ${esc(g.opp)} · ${esc(tipTime(gameFor(p.t, d)))}` : d ? "No game" : "";
  return `<div class="pl"><span class="a">${esc(p.n)}${statusTags(p, d)}${extra}</span><span class="b">${esc(p.t || "FA")} · ${esc(p.pos.join("/"))}${opp ? " · " + opp : ""}${n ? ` · <span class="nick">“${esc(n)}”</span>` : ""}</span></div>`;
}
function weekStrip(p) {
  return D.weekDates.filter(d => p.wk[d]).map(d => { const g = p.wk[d]; const v = g.state === "post" ? f1(g.fp) : g.state === "in" ? "live" : "–"; return `${dayLabel(d).split(" ")[0]} ${v}`; }).join("  ");
}

// ---------- Lock-In tab ----------
function viewLock() {
  const me = TEAMS[D.me]; const cur = D.current.find(c => c.rid === D.me) || { starters: [] };
  const mu = myMatchup(); const wp = mu ? mu.wp : null;
  const ids = active(me);
  const calls = ids.map(id => ({ id, c: lockCall(D.me, id, wp), starting: cur.starters.includes(id) }));
  const decide = calls.filter(x => x.c.kind === "decide").sort((a, b) => (a.c.deadline || "").localeCompare(b.c.deadline || ""));
  const locked = calls.filter(x => x.c.kind === "locked");
  const live = calls.filter(x => x.c.kind === "live");
  const waiting = calls.filter(x => x.c.kind === "waiting" || x.c.kind === "final");

  const card = x => {
    const p = P[x.id]; const c = x.c; const v = c.verdict;
    const label = v === "lock" ? "Lock" : v === "pass" ? "Pass" : "Toss-up";
    const why = v === "lock"
      ? `${f1(c.s)} beats the ${f1(c.W)} you'd expect to end up with by waiting${c.lean !== 1 ? (c.lean < 1 ? ", and you're ahead, so banking points is worth more" : "") : ""}.`
      : v === "pass"
        ? `His ${c.fut.length} game${c.fut.length > 1 ? "s" : ""} left should be worth about ${f1(c.W)}${c.lean > 1 ? ", and you're behind, so chasing a bigger game makes sense" : ""}.`
        : `${f1(c.s)} is right around what waiting is worth (${f1(c.W)}). Lock if you'd rather have the sure thing.`;
    return `<article class="lock v-${v}">
      <div class="top">${plCell(x.id, me, null)}<span class="call ${v}-c">${label}</span></div>
      <div class="cmp"><div><span class="k">${dayLabel(c.d).split(" ")[0]} score</span><span class="v score">${f1(c.s)}</span></div><div><span class="k">Waiting worth</span><span class="v">${f1(c.W)}</span></div><div><span class="k">Later beats it</span><span class="v">${pct(c.beat)}</span></div></div>
      <div class="why">${why}</div>
      <div class="foot"><span>${c.deadline ? "Decide before " + esc(tipLong(c.deadline)) : ""}${!x.starting ? " · He has to be in your lineup to lock" : ""}</span><button class="btn" type="button" data-mark="${x.id}" data-d="${c.d}">I locked him</button></div>
    </article>`;
  };
  const row = (x, right) => `<tr><td>${plCell(x.id, me, null)}</td><td class="n">${right}</td></tr>`;
  return `
  <section class="panel"><div class="hd"><h2>Lock or Pass</h2><span class="r">Week ${D.week}${mu ? ` · ${pct(wp)} to win` : ""}</span></div>
    <p class="muted small" style="margin:0">Each card compares the game he just played with what his remaining games are likely to give you, using his projection and how much his scoring swings game to game. If you're well ahead it leans toward locking; if you're behind it leans toward waiting for a big game.</p></section>
  ${decide.length ? `<div class="locks">${decide.map(card).join("")}</div>` : `<div class="panel empty">No lock decisions right now. Cards show up here after each game ends.</div>`}
  <div class="grid2">
    <section class="panel"><div class="hd"><h3>Locked</h3><span class="r">${locked.length} of ${D.league.slots.length} slots</span></div>
      ${locked.length ? `<div class="tbl"><table><tbody>${locked.map(x => row(x, `<span class="tag t-lock">${esc(dayLabel(x.c.ls.d).split(" ")[0])}</span> <span class="score">${f1(x.c.ls.score)}</span>${x.c.ls.manual ? ` <button class="btn" style="padding:2px 8px;font-size:11px" type="button" data-unmark="${x.id}">Undo</button>` : ""}`)).join("")}</tbody></table></div>` : `<div class="empty">Nobody locked yet this week.</div>`}</section>
    <section class="panel"><div class="hd"><h3>Playing now</h3></div>
      ${live.length ? `<div class="tbl"><table><tbody>${live.map(x => row(x, `<span class="tag t-live">LIVE</span> ${f1(P[x.id].wk[x.c.d].fp)}`)).join("")}</tbody></table></div>` : `<div class="empty">None of your players are on the floor.</div>`}</section>
  </div>
  <section class="panel"><div class="hd"><h3>Everyone else</h3><span class="r">Week so far</span></div>
    <div class="tbl"><table><tbody>${waiting.map(x => row(x, `<span class="muted small">${esc(weekStrip(P[x.id]) || "No games")}</span>`)).join("")}</tbody></table></div>
    <p class="muted small" style="margin:10px 0 0">Sleeper's public data doesn't flag locks directly. Court Report spots a lock when a player's counted score matches an earlier game instead of his latest one. If you lock someone on his latest game, tap “I locked him” so the app knows.</p></section>`;
}

// ---------- Lineup tab ----------
// In Lock-In, starting a player only matters on days you might want to lock his game.
// Value of starting him today = how much having today's game as a lock option adds over just waiting.
const CLOSE = 1.0; // edges within a point of each other are a coin flip
function startValue(id, d) {
  const p = P[id]; const g = p.wk[d]; if (!g || g.state !== "pre") return null;
  const fut = futureGames(p); const idx = fut.findIndex(f => f.d === d); if (idx < 0) return null;
  const today = fut[idx], after = fut.slice(idx + 1); const W = continuation(after);
  if (W == null) return today.p * today.m; // last game of the week: it has to be in a slot to count
  return today.p * eMax(today.m, today.s, W) + (1 - today.p) * W - W + 0.01 * today.m;
}
// Plain-language reasons behind a player's edge tonight
function startReasons(id, d) {
  const p = P[id]; const g = p.wk[d];
  if (!g) return ["No game"]; if (g.state !== "pre") return ["Already played"]; if (OUT.has(p.inj)) return ["Out"];
  const fut = futureGames(p); const idx = fut.findIndex(f => f.d === d); if (idx < 0) return [];
  const today = fut[idx], after = fut.slice(idx + 1); const W = continuation(after); const r = [];
  if (!after.length) r.push("Last game this week, so he has to start for it to count");
  if (PLAY_PROB[p.inj] != null) r.push(`${p.inj === "GTD" ? "Game-time decision" : p.inj}, about ${pct(today.p)} to play`);
  if (after.length) {
    if (W > today.m * 1.12) r.push(`Better games ahead: ${after.length} more worth ~${f1(W)}`);
    else if (after.length === 1) r.push("Only 1 game left after tonight");
  }
  const swing = today.s / Math.max(today.m, 1);
  if (swing > 0.38) r.push("Big game-to-game swings, so a spike tonight is worth catching");
  else if (swing < 0.25 && after.length) r.push("Steady scorer, so tonight rarely beats waiting");
  if (g.b2b) r.push("Second night of a back-to-back");
  if (!r.length) r.push("Tonight looks about as good as his later games");
  return r;
}
function withReason(cell, reasons) { return reasons.length ? cell.replace(/<\/div>$/, `<span class="b why-line">${esc(reasons.join(" · "))}</span></div>`) : cell; }
function viewLineup() {
  const me = TEAMS[D.me]; const cur = D.current.find(c => c.rid === D.me) || { starters: [] }; const ids = active(me);
  const days = D.weekDates.filter(d => d >= D.today); if (!st.day || !days.includes(st.day)) st.day = days[0] || D.weekDates[D.weekDates.length - 1];
  const d = st.day, isToday = d === D.today;
  const slots = D.league.slots; const lockedIdx = new Set(); const lockedIds = new Set();
  slots.forEach((s, i) => { const id = cur.starters[i]; if (id && lockState(D.me, id).locked) { lockedIdx.add(i); lockedIds.add(id); } });
  const openSlots = slots.filter((_, i) => !lockedIdx.has(i));
  const edge = id => startValue(id, d);
  const o = optimize(ids.filter(id => !lockedIds.has(id)), edge, openSlots);
  const rec = new Set(o.lineup.map(x => x.id).filter(Boolean)); const now = new Set(cur.starters);
  const benchIds = ids.filter(id => !rec.has(id) && !lockedIds.has(id));
  let oi = 0;
  const rows = slots.map((s, i) => {
    if (lockedIdx.has(i)) { const id = cur.starters[i]; const ls = lockState(D.me, id); return `<tr class="dim"><td class="slot">${esc(s)}</td><td>${plCell(id, me, null, `<span class="tag t-lock">LOCKED ${f1(ls.score)}</span>`)}</td><td class="n">—</td><td class="n">—</td><td class="n hide-s">—</td></tr>`; }
    const x = o.lineup[oi++]; const p = P[x.id]; const isNew = isToday && x.id && !now.has(x.id);
    const fut = p ? futureGames(p) : [];
    const tags = isNew ? `<span class="tag t-in">IN</span>` : "";
    const reasons = p ? startReasons(x.id, d) : [];
    return `<tr class="${isNew ? "swapin" : ""}"><td class="slot">${esc(s)}</td><td>${p ? withReason(plCell(x.id, me, d, tags), reasons) : plCell(null)}</td><td class="n score">${p ? f1(gameMean(p, d)) : "—"}</td><td class="n">${p ? f1(x.s) : "—"}</td><td class="n hide-s">${p ? fut.length : "—"}</td></tr>`;
  }).join("");
  const brow = benchIds.map(id => ({ id, e: edge(id) })).sort((a, b) => (b.e ?? -1) - (a.e ?? -1)).map(({ id, e }) => {
    const p = P[id]; const was = isToday && now.has(id); const reasons = startReasons(id, d);
    return `<tr class="${e == null ? "dim" : ""}"><td class="slot">${was ? "OUT" : "BN"}</td><td>${withReason(plCell(id, me, d), reasons)}</td><td class="n">${p.wk[d] ? f1(gameMean(p, d)) : "—"}</td><td class="n">${e == null ? "—" : f1(e)}</td></tr>`;
  }).join("");
  // Today's swaps: pair each player coming in with a current starter going out
  let moves = "";
  if (isToday) {
    const ins = [...rec].filter(id => !now.has(id)).sort((a, b) => edge(b) - edge(a));
    const outs = cur.starters.filter((id, i) => id && !lockedIdx.has(i) && !rec.has(id)).sort((a, b) => (edge(a) ?? -1) - (edge(b) ?? -1));
    const pairs = ins.map((id, i) => ({ id, out: outs[i], gap: edge(id) - (outs[i] ? edge(outs[i]) ?? 0 : 0) }));
    const real = pairs.filter(x => x.gap >= CLOSE), flips = pairs.filter(x => x.gap < CLOSE);
    const curEdge = sum(cur.starters.filter((id, i) => id && !lockedIdx.has(i)).map(id => edge(id) ?? 0)), gainAll = o.total - curEdge;
    const mv = (x, opt) => `<div class="move ${opt ? "opt" : ""}"><span>${opt ? "Either:" : "<b>Start</b>"} ${esc(P[x.id].n)}</span><span class="arrow">${opt ? "or" : "over"}</span><span class="muted">${x.out ? esc(P[x.out].n) : "an empty slot"}</span><span class="gain ${opt ? "flat" : ""}">+${f1(x.gap)}</span></div>`;
    const summary = `<div class="note ${gainAll >= 2 ? "" : "info"}">${gainAll < 0.5 ? "Your current lineup is already the best one for today." : `Making every change below gains about <b>${f1(gainAll)}</b> point${Math.abs(gainAll - 1) < 0.05 ? "" : "s"} of expected value this week${gainAll < 2 ? ", so tonight's lineup is low stakes" : ""}.`}</div>`;
    if (!pairs.length) moves = summary;
    else moves = summary + real.map(x => mv(x, false)).join("") +
      (flips.length ? `<details${real.length ? "" : " open"}><summary>${flips.length} close call${flips.length > 1 ? "s" : ""}, under a point either way</summary><div class="moves" style="margin-top:8px">${flips.map(x => mv(x, true)).join("")}</div></details>` : "");
  }
  const chips = days.map(x => `<button class="chip ${x === d ? "on" : ""}" data-day="${x}" type="button">${x === D.today ? "Today" : dayLabel(x)}<span class="cnt">${ids.filter(id => P[id].wk[x] && !OUT.has(P[id].inj)).length}</span></button>`).join("");
  return `
  <section class="panel"><div class="hd"><h2>Daily Lineup</h2><span class="r">${openSlots.length} open slots · ${lockedIdx.size} locked</span></div><div class="chips">${chips}</div></section>
  <div class="note info">In Lock-In, a game only counts if the player is in your lineup that day and you lock it, or if it's his last game of the week. So each day, start the players whose game tonight you'd be most likely to lock. Edge is how many points you gain by having tonight as a lock option; anything within a point is a coin flip.</div>
  ${isToday ? `<section class="panel"><div class="hd"><h3>Moves to make today</h3></div><div class="moves">${moves}</div></section>` : ""}
  <section class="panel"><div class="hd"><h3>Recommended lineup · ${dayLabel(d)}</h3><span class="r">Exp = expected points tonight · Edge = gain from starting him</span></div>
    <div class="tbl"><table><thead><tr><th>Slot</th><th>Player</th><th class="n">Exp</th><th class="n">Edge</th><th class="n hide-s">Gms left</th></tr></thead><tbody>${rows}</tbody></table></div></section>
  <section class="panel"><div class="hd"><h3>Bench</h3></div><div class="tbl"><table><thead><tr><th></th><th>Player</th><th class="n">Exp</th><th class="n">Edge</th></tr></thead><tbody>${brow || `<tr><td class="empty">Nobody on the bench.</td></tr>`}</tbody></table></div></section>`;
}

// ---------- Matchup tab ----------
function viewMatchup() {
  const mu = myMatchup(); if (!mu) return `<div class="panel empty">No matchup this week.</div>`;
  const A = TEAMS[D.me], B = TEAMS[mu.opp.rid];
  const side = (rid, proj, team) => {
    const locked = proj.lockedSlots.map(x => `<tr><td class="slot">${esc(x.slot)}</td><td>${plCell(x.id, team, null)}</td><td class="n"><span class="tag t-lock">LOCKED</span> <span class="score">${f1(x.score)}</span></td></tr>`).join("");
    const open = proj.open.map(x => `<tr><td class="slot">${esc(x.slot)}</td><td>${plCell(x.id, team, null)}</td><td class="n">${x.id ? "~" + f1(x.s) : "—"}</td></tr>`).join("");
    return locked + open;
  };
  const gl = rid => sum(active(TEAMS[rid]).map(id => futureGames(P[id]).length));
  return `
  <div class="board">
    <div class="side"><span class="tn">${esc(A.name)}</span><span class="big score">${f1(mu.a.total)}</span><span class="muted small">Projected · <b class="num">${f1(mu.a.lockedPts)}</b> locked</span></div>
    <div class="vs">VS</div>
    <div class="side r"><span class="tn">${esc(B.name)}</span><span class="big">${f1(mu.b.total)}</span><span class="muted small">Projected · <b class="num">${f1(mu.b.lockedPts)}</b> locked</span></div>
  </div>
  <section class="panel"><div class="hd"><h3>Win chance</h3><span class="r num">${pct(mu.wp)} you · ${pct(1 - mu.wp)} them</span></div><div class="wp"><i style="width:${mu.wp * 100}%"></i></div>
    <div class="summary" style="margin-top:12px"><div><span class="k">Sleeper score now</span><span class="v">${f1(mu.mine.pts)} – ${f1(mu.opp.pts)}</span></div><div><span class="k">Your games left</span><span class="v">${gl(D.me)}</span></div><div><span class="k">Their games left</span><span class="v">${gl(mu.opp.rid)}</span></div><div><span class="k">Projected margin</span><span class="v ${mu.a.total >= mu.b.total ? "good" : ""}">${mu.a.total >= mu.b.total ? "+" : ""}${f1(mu.a.total - mu.b.total)}</span></div></div>
    <p class="muted small" style="margin:10px 0 0">Locked slots count their locked score. Open slots use what each player should end up counting if you follow the Lock or Pass calls. More games left means more chances at a big game to lock.</p></section>
  <div class="grid2">
    <section class="panel"><div class="hd"><h3>${esc(A.name)}</h3></div><div class="tbl"><table><tbody>${side(D.me, mu.a, A)}</tbody></table></div></section>
    <section class="panel"><div class="hd"><h3>${esc(B.name)}</h3><span class="r">${esc(B.user)}</span></div><div class="tbl"><table><tbody>${side(mu.opp.rid, mu.b, B)}</tbody></table></div></section>
  </div>`;
}

// ---------- season values used by waivers, trades, dynasty ----------
// In Lock-In a player's weekly worth is closer to his best of ~3.5 games than his average
function lockValue(id) { const p = P[id]; return (p.val || 0) + 0.85 * (p.sd || 0.33 * (p.val || 0)); }
function weekEV(id) { const p = P[id]; return continuation(futureGames(p)) ?? 0; }

function waiverScore(id) { const p = P[id]; const base = 0.5 * lockValue(id) + 0.3 * weekEV(id) + 0.2 * (p.l14 ?? p.val ?? 0); return OUT.has(p.inj) ? base * 0.4 : base; }
// Concrete add/drop moves, judged for this season and for the long run
function waiverMoves() {
  return memo("waivers", () => {
    const me = TEAMS[D.me]; const act = active(me); const before = baseLineup(D.me);
    const drops = act.filter(id => !lockState(D.me, id).locked);
    const fas = D.fa.filter(id => P[id] && !OUT.has(P[id].inj));
    const cands = [];
    for (const f of fas) for (const d of drops) {
      const sGain = lockValue(f) - lockValue(d), dGain = dv(f) - dv(d);
      const now = sGain >= 2 && dGain >= -10, fut = dGain >= 10 && sGain >= -4;
      if (!now && !fut) continue;
      cands.push({ f, d, sGain, dGain, now, fut });
    }
    for (const c of cands) c.lineup = typicalLineup(act.filter(x => x !== c.d).concat(c.f)) - before;
    const pickBest = (list, key, n = 3) => { const out = [], uf = new Set(), ud = new Set(); for (const c of list.sort((a, b) => key(b) - key(a))) { if (uf.has(c.f) || ud.has(c.d)) continue; out.push(c); uf.add(c.f); ud.add(c.d); if (out.length >= n) break; } return out; };
    const nowList = pickBest(cands.filter(c => c.now && c.lineup >= 1), c => c.lineup + 0.05 * Math.max(0, c.dGain));
    const futList = pickBest(cands.filter(c => c.fut), c => c.dGain + 0.5 * Math.max(0, c.sGain));
    // Taxi: a rookie on waivers who's a better stash than one of yours
    const taxiOk = id => P[id].exp === 0 || D.league.taxiVets;
    const taxiMoves = [];
    for (const t of (me.taxi || []).filter(id => P[id])) {
      const best = fas.filter(f => taxiOk(f) && dv(f) - dv(t) >= 8 && !taxiMoves.find(x => x.f === f)).sort((a, b) => dv(b) - dv(a))[0];
      if (best) taxiMoves.push({ f: best, d: t, dGain: dv(best) - dv(t) });
    }
    return { nowList, futList, taxiMoves: taxiMoves.slice(0, 2) };
  });
}
function moveCard(c, kind) {
  const f = P[c.f], d = P[c.d]; const both = c.fut && c.lineup != null && c.lineup >= 1;
  const lines = [];
  if (c.lineup != null) lines.push(`This season: ${c.lineup >= 0.5 ? `your best lineup gets <b>${f1(c.lineup)}</b> better each week` : c.sGain >= 0 ? `better depth (${f1(lockValue(c.f))} vs ${f1(lockValue(c.d))} lock value), though he wouldn't crack your best lineup yet` : `a small step back now (${f1(lockValue(c.f))} vs ${f1(lockValue(c.d))} lock value)`}`);
  lines.push(`Dynasty: ${dv(c.f)} vs ${dv(c.d)} (<span class="${c.dGain >= 0 ? "up" : "down"}">${c.dGain >= 0 ? "+" : ""}${c.dGain}</span>)${f.age != null && d.age != null ? ` · age ${f.age} vs ${d.age}` : ""}`);
  const gl = futureGames(f).length; if (kind !== "taxi") lines.push(`${gl} game${gl === 1 ? "" : "s"} left this week${f.inj ? ` · listed ${esc(f.inj)}` : ""}`);
  return `<article class="lock ${both ? "v-lock" : ""}">
    <div class="top"><div class="pl"><span class="a">Pick up ${esc(f.n)}${statusTags(f)}</span><span class="b">${esc(f.t)} · ${esc(f.pos.join("/"))}</span></div>${both ? `<span class="tag t-lock">BOTH</span>` : ""}</div>
    <div class="pl"><span class="a muted">${kind === "taxi" ? "Cut from taxi" : "Drop"} ${esc(d.n)}</span><span class="b">${esc(d.t || "")} · ${esc(d.pos.join("/"))}</span></div>
    <div class="why">${lines.join("<br>")}</div></article>`;
}
function viewWaivers() {
  const me = TEAMS[D.me]; const mine = active(me);
  const mv = waiverMoves();
  const shown = new Set(); const key = c => c.f + ">" + c.d;
  const nowCards = mv.nowList.map(c => { shown.add(key(c)); return moveCard(c, "now"); }).join("");
  const futCards = mv.futList.filter(c => !shown.has(key(c))).map(c => moveCard(c, "fut")).join("");
  const taxiCards = mv.taxiMoves.map(c => moveCard(c, "taxi")).join("");
  const drop = mine.map(id => ({ id, v: lockValue(id) })).sort((a, b) => a.v - b.v)[0];
  const bestFA = D.fa.filter(id => P[id] && !OUT.has(P[id].inj)).sort((a, b) => lockValue(b) - lockValue(a))[0];
  const none = !nowCards && !futCards && !taxiCards;
  const recs = none
    ? `<div class="note info">No pickups worth making right now. Your weakest player${drop ? `, ${esc(P[drop.id].n)} (${f1(drop.v)} lock value, ${dv(drop.id)} dynasty)` : ""}, is about as good as anyone available${bestFA ? `; the best free agent is ${esc(P[bestFA].n)} at ${f1(lockValue(bestFA))}` : ""}.</div>`
    : `${nowCards ? `<h3 style="margin:4px 0 8px">Win now</h3><div class="locks">${nowCards}</div>` : `<div class="note info">No pickup would improve your lineup this season by a point or more.</div>`}
       ${futCards ? `<h3 style="margin:16px 0 8px">Build for the future</h3><div class="locks">${futCards}</div>` : ""}
       ${taxiCards ? `<h3 style="margin:16px 0 8px">Taxi squad upgrades</h3><div class="locks">${taxiCards}</div>` : ""}`;

  const pos = st.wPos; let list = D.fa.filter(id => P[id] && (pos === "ALL" || P[id].pos.includes(pos)));
  const sortKey = { score: waiverScore, dyn: dv, lv: lockValue, val: id => P[id].val || 0, wk: weekEV, trend: id => (P[id].l14 ?? P[id].val ?? 0) - (P[id].pre || P[id].val || 0) }[st.wSort] || waiverScore;
  list = list.map(id => ({ id, k: sortKey(id) })).sort((a, b) => b.k - a.k).slice(0, 40);
  const th = (k, l, cls = "") => `<th class="n sort ${st.wSort === k ? "act" : ""} ${cls}" data-sort="${k}">${l}</th>`;
  const rows = list.map((x, i) => { const p = P[x.id]; const tr = (p.l14 ?? p.val ?? 0) - (p.pre || p.val || 0);
    return `<tr><td class="n muted">${i + 1}</td><td>${plCell(x.id, null, null)}</td><td class="n score">${f1(waiverScore(x.id))}</td><td class="n">${f1(lockValue(x.id))}</td><td class="n">${f1(weekEV(x.id))}</td><td class="n hide-s">${futureGames(p).length}</td><td class="n hide-s ${tr > 1 ? "up" : tr < -1 ? "down" : ""}">${tr > 0 ? "▲" : tr < 0 ? "▼" : ""}${f1(Math.abs(tr))}</td><td class="n">${dv(x.id)}</td><td class="n hide-s">${p.age ?? "—"}</td></tr>`; }).join("");
  const chips = ["ALL", "PG", "SG", "SF", "PF", "C"].map(x => `<button class="chip ${x === pos ? "on" : ""}" data-pos="${x}" type="button">${x === "ALL" ? "All" : x}</button>`).join("");
  return `
  <section class="panel"><div class="hd"><h2>Waiver Moves</h2><span class="r">FAAB $${D.league.faab ?? "—"} · ${D.fa.length} free agents checked</span></div>
    <p class="muted small" style="margin:0 0 12px">Every free agent is checked against every player on your active roster. Win-now moves have to make your best lineup at least a point better per week without giving up much dynasty value. Future moves have to add at least 10 dynasty value without hurting this season much. BOTH means it does both.</p>
    ${recs}</section>
  <details class="panel"><summary><b>All free agents</b></summary>
    <div class="chips" style="margin:10px 0">${chips}</div>
    <div class="tbl"><table><thead><tr><th class="n">#</th><th>Player</th>${th("score", "Score")}${th("lv", "Lock val")}${th("wk", "This wk")}<th class="n hide-s">Gms</th>${th("trend", "Trend", "hide-s")}${th("dyn", "Dyn")}<th class="n hide-s">Age</th></tr></thead><tbody>${rows || `<tr><td colspan="9" class="empty">No free agents at this position.</td></tr>`}</tbody></table></div>
    <p class="muted small" style="margin:10px 0 0">Lock val = worth in a typical Lock-In week (average plus credit for big games). This wk = what he'd likely count for this week. Dyn = dynasty value, 0–100.</p></details>`;
}

// ---------- dynasty values (league is dynasty: settings.type 2) ----------
// Age curve for long-term value: young players gain, players past 28 fade fast
function ageMult(a) { if (a == null) return 1; const t = { 19: 1.32, 20: 1.3, 21: 1.26, 22: 1.2, 23: 1.14, 24: 1.08, 25: 1.03, 26: 1, 27: 0.98, 28: 0.93, 29: 0.86, 30: 0.78, 31: 0.7, 32: 0.62 }; return a <= 19 ? 1.32 : t[a] ?? 0.52; }
let DV = null;
// 0–100 rank among every rostered player: 55% age-adjusted Lock-In value, 45% dynasty draft position
function dynastyValues() {
  if (DV) return DV; const ids = Object.keys(P).filter(id => P[id].own);
  const raw = ids.map(id => ({ id, r: lockValue(id) * ageMult(P[id].age) * (OUT.has(P[id].inj) ? 0.92 : 1), a: P[id].adp ?? 400 }));
  const byR = [...raw].sort((a, b) => a.r - b.r), byA = [...raw].sort((a, b) => b.a - a.a); const pr = {}, pa = {};
  byR.forEach((x, i) => (pr[x.id] = i / (raw.length - 1))); byA.forEach((x, i) => (pa[x.id] = i / (raw.length - 1)));
  DV = {}; raw.forEach(x => (DV[x.id] = Math.round(100 * (0.55 * pr[x.id] + 0.45 * pa[x.id])))); return DV;
}
function dv(id) { const k = dynastyValues(); if (k[id] != null) return k[id]; return Math.round(Math.min(95, lockValue(id) * ageMult(P[id].age) * 2.1)); }

// Rookie picks on the same 0–100 scale. Next year's 1st depends on how bad the original team looks now.
function teamStrengthRank(rid) { const s = Object.fromEntries(D.teams.map(t => [t.rid, typicalLineup(active(t))])); return 1 + D.teams.filter(t => s[t.rid] > s[rid]).length; }
function pickValue(pk) {
  const yrs = pk.season - Number(D.season); const n = D.teams.length;
  const slot = yrs === 1 ? (teamStrengthRank(pk.orig) - 1) / (n - 1) : 0.5; // 0 = best team (late pick), 1 = worst (early pick)
  const base = pk.round === 1 ? 40 + 30 * slot : pk.round === 2 ? 15 + 10 * slot : 5 + 5 * slot;
  return Math.round(base * Math.pow(0.9, yrs - 1));
}
function pickLabel(pk) { const t = TEAMS[pk.orig]; return `${pk.season} ${["", "1st", "2nd", "3rd"][pk.round] || pk.round + "th"}${pk.orig !== pk.owner ? ` (from ${t ? t.name : "?"})` : ""}`; }
const pickKey = pk => `pk:${pk.season}:${pk.round}:${pk.orig}`;
function picksOf(rid) { return (D.picks || []).filter(pk => pk.owner === rid); }
// Trade value: stars are worth far more than two mid players with the same total, so trades use a convex scale
function tv(v) { return 100 * Math.pow(Math.max(0, v) / 100, 2.5); }
function assetValue(key) { if (key.startsWith("pk:")) { const pk = D.picks.find(x => pickKey(x) === key); return pk ? pickValue(pk) : 0; } return dv(key); }

// ---------- trades ----------
// Rest of season: one counted game per week, so weeks left × lock value
function rosValue(id) { const p = P[id]; return lockValue(id) * ((p.rem || 0) / 3.5) * (OUT.has(p.inj) ? 0.5 : 1); }
// Best 9 lock values. Only the top 13 players (plus the top 2 centers) can matter, which keeps trade searches fast.
function typicalLineup(ids) {
  const ok = ids.filter(id => !OUT.has(P[id].inj)).sort((a, b) => lockValue(b) - lockValue(a));
  const keep = new Set(ok.slice(0, 13)); ok.filter(id => P[id].pos.includes("C")).slice(0, 2).forEach(id => keep.add(id));
  return optimize([...keep], lockValue).total;
}
const GROUPS = { G: ["PG", "SG"], F: ["SF", "PF"], C: ["C"] };
function groupStrength(rid) { const ids = active(TEAMS[rid]).filter(id => !OUT.has(P[id].inj)); const out = {}; for (const [g, ps] of Object.entries(GROUPS)) { out[g] = sum(ids.filter(id => P[id].pos.some(x => ps.includes(x))).map(lockValue).sort((a, b) => b - a).slice(0, g === "C" ? 2 : 4)); } return out; }
// How each team is positioned decides how it weighs this season against the future
function teamMode(rid) {
  return memo("modes", () => {
    const s = Object.fromEntries(D.teams.map(t => [t.rid, baseLineup(t.rid)]));
    const stand = [...D.teams].sort((a, b) => b.w - a.w || b.pf - a.pf).map(t => t.rid);
    // Early in the season the standings say little, so roster strength carries most of the weight
    const ws = Math.min(0.4, 0.05 * D.history.length);
    const score = Object.fromEntries(D.teams.map(t => [t.rid, (1 - ws) * (1 + D.teams.filter(x => s[x.rid] > s[t.rid]).length) + ws * (stand.indexOf(t.rid) + 1)]));
    const order = D.teams.map(t => t.rid).sort((a, b) => score[a] - score[b]); const n = order.length; const res = {};
    order.forEach((rid, i) => { const mode = i < Math.round(n / 3) ? "contender" : i >= n - Math.round(n / 3) ? "rebuilding" : "middle"; res[rid] = { mode, w: mode === "contender" ? 0.6 : mode === "rebuilding" ? 0.25 : 0.4 }; });
    return res;
  })[rid];
}
const modeName = m => (m === "contender" ? "like a contender" : m === "rebuilding" ? "like a rebuilding team" : "like a middle-of-the-pack team");
// Your own approach is your call, not a guess: saved in this browser
const APPROACH = { now: { w: 0.65, label: "Win now" }, bal: { w: 0.45, label: "Balanced" }, future: { w: 0.25, label: "Build for the future" } };
function myApproach() { try { const v = localStorage.getItem("cr-approach"); return APPROACH[v] ? v : "bal"; } catch { return "bal"; } }
function setApproach(v) { try { localStorage.setItem("cr-approach", v); } catch {} delete MEMO.ideas; }
const plOnly = a => a.filter(k => !String(k).startsWith("pk:"));
// One team's view of a trade: lineup change, rest-of-season change, dynasty change (including who they'd have to cut)
function evalSide(rid, give, get) {
  const t = TEAMS[rid]; const giveSet = new Set(give);
  const after = typicalLineup(active(t).filter(id => !giveSet.has(id)).concat(plOnly(get).filter(id => !OUT.has(P[id].inj) || true)));
  const dL = after - baseLineup(rid);
  // Rest of season = the lineup change for every week left (extra bench depth that never starts adds nothing)
  const dRos = dL * weeksLeft();
  let dDyn = sum(get.map(k => tv(assetValue(k)))) - sum(give.map(k => tv(assetValue(k))));
  const extra = plOnly(get).length - plOnly(give).length; let cut = [];
  if (extra > 0) {
    cut = t.players.filter(id => P[id] && !giveSet.has(id) && !(t.taxi || []).includes(id) && !(t.reserve || []).includes(id)).sort((a, b) => dv(a) - dv(b)).slice(0, extra);
    dDyn -= sum(cut.map(id => tv(dv(id))));
  }
  const m = rid === D.me ? { mode: myApproach(), w: APPROACH[myApproach()].w } : teamMode(rid);
  const nowS = Math.tanh(dL / 5), dynS = Math.tanh(dDyn / 25);
  return { dL, dRos, dDyn, nowS, dynS, score: m.w * nowS + (1 - m.w) * dynS, mode: m.mode, w: m.w, cut };
}
// Rough odds the other manager says yes: people want to feel they won, so an even trade lands around 35%
function acceptChance(their) { return 1 / (1 + Math.exp(-(8 * their.score - 0.6))); }
function weeksLeft() { return memo("weeksLeft", () => { const r = Object.values(P).filter(p => p.own && p.rem).map(p => p.rem); return r.length ? sum(r) / r.length / 3.5 : 0; }); }
function chanceLabel(p) { return p >= 0.6 ? ["Likely", "up"] : p >= 0.35 ? ["Possible", ""] : p >= 0.15 ? ["Long shot", "down"] : ["Very unlikely", "down"]; }
function myVerdict(s) { return s > 0.35 ? ["Strong win", "up"] : s > 0.1 ? ["Good for you", "up"] : s > -0.1 ? ["About even", ""] : s > -0.35 ? ["Bad for you", "down"] : ["Bad deal", "down"]; }
function assetName(k) { if (String(k).startsWith("pk:")) { const pk = D.picks.find(x => pickKey(x) === k); return pk ? pickLabel(pk) + " pick" : "a pick"; } return P[k]?.n || "?"; }

// Trades to propose: 1-for-1, 2-for-1 (consolidate) and 1-for-2 (add depth), plus a pick sweetener when it tips a deal
function tradeIdeas() {
  return memo("ideas", () => {
    const me = TEAMS[D.me]; const ideas = [];
    const myPool = me.players.filter(id => P[id] && !(me.reserve || []).includes(id));
    const myPicks = picksOf(D.me).sort((a, b) => pickValue(a) - pickValue(b)).filter(pk => pk.round >= 2).slice(0, 3);
    const consider = (rid, give, get, sweeten) => {
      const mine = evalSide(D.me, give, get); if (mine.score < 0.12) return;
      const theirs = evalSide(rid, get, give); const p = acceptChance(theirs);
      if (p >= 0.45) { ideas.push({ rid, give, get, mine, theirs, p, ev: mine.score * p }); return; }
      if (!sweeten || p < 0.2) return;
      for (const pk of myPicks) {
        const g2 = give.concat(pickKey(pk)); const m2 = evalSide(D.me, g2, get); if (m2.score < 0.1) break;
        const t2 = evalSide(rid, get, g2); const p2 = acceptChance(t2);
        if (p2 >= 0.45) { ideas.push({ rid, give: g2, get, mine: m2, theirs: t2, p: p2, ev: m2.score * p2 }); return; }
      }
    };
    for (const t of D.teams) {
      if (t.rid === D.me) continue;
      const pool = t.players.filter(id => P[id] && !(t.reserve || []).includes(id));
      for (const g of myPool) for (const r of pool) if (Math.abs(dv(g) - dv(r)) <= 25) consider(t.rid, [g], [r], true);
      const theirTop = [...pool].sort((a, b) => dv(b) - dv(a)).slice(0, 6), myMid = [...myPool].sort((a, b) => dv(b) - dv(a)).slice(0, 14);
      for (let i = 0; i < myMid.length; i++) for (let j = i + 1; j < myMid.length; j++) for (const r of theirTop) {
        const a = myMid[i], b = myMid[j], tot = dv(a) + dv(b);
        if (dv(r) < Math.max(dv(a), dv(b)) || tot < dv(r) - 10 || tot > dv(r) + 45) continue;
        consider(t.rid, [a, b], [r], false);
      }
      const theirMid = [...pool].sort((a, b) => dv(b) - dv(a)).slice(0, 10), myTop = [...myPool].sort((a, b) => dv(b) - dv(a)).slice(0, 8);
      for (const g of myTop) for (let i = 0; i < theirMid.length; i++) for (let j = i + 1; j < theirMid.length; j++) {
        const a = theirMid[i], b = theirMid[j], tot = dv(a) + dv(b);
        if (dv(g) < Math.max(dv(a), dv(b)) || tot < dv(g) - 10 || tot > dv(g) + 45) continue;
        consider(t.rid, [g], [a, b], false);
      }
    }
    ideas.sort((a, b) => b.ev - a.ev);
    const out = [], usedGet = new Set(), usedGive = {}, perTeam = {};
    for (const x of ideas) {
      if (x.get.some(id => usedGet.has(id))) continue;
      if ((perTeam[x.rid] || 0) >= 2) continue;
      if (plOnly(x.give).some(id => (usedGive[id] || 0) >= 2)) continue;
      out.push(x); x.get.forEach(id => usedGet.add(id)); plOnly(x.give).forEach(id => (usedGive[id] = (usedGive[id] || 0) + 1)); perTeam[x.rid] = (perTeam[x.rid] || 0) + 1;
      if (out.length >= 6) break;
    }
    return out;
  });
}
function sideText(e, who) {
  const bits = [];
  if (Math.abs(e.dL) >= 0.5) bits.push(`${who === "you" ? "your" : "their"} weekly lineup ${e.dL > 0 ? "+" : ""}${f1(e.dL)}`);
  bits.push(`trade value ${e.dDyn >= 0 ? "+" : ""}${f0(e.dDyn)}`);
  if (e.cut.length) bits.push(`${who === "you" ? "you'd" : "they'd"} have to cut ${e.cut.map(id => P[id].n).join(", ")}`);
  return bits.join(" · ");
}
function whyTheyAccept(x) {
  const t = TEAMS[x.rid], th = x.theirs, r = [`${esc(t.name)} looks ${modeName(th.mode)}`];
  if (th.mode === "contender" && th.dL > 0.5) r.push("and gets stronger right now");
  else if (th.mode === "rebuilding" && th.dDyn > 0) r.push("and gets younger or adds future value");
  else if (th.dL > 0.5 && th.dDyn > 0) r.push("and comes out ahead both now and long term");
  else if (th.dL > 0.5) r.push(`and their lineup improves by ${f1(th.dL)} a week`);
  else if (th.dDyn > 0) r.push(`and gains ${f0(th.dDyn)} dynasty value`);
  return r.join(" ") + ".";
}
function viewTrade() {
  const others = D.teams.filter(t => t.rid !== D.me); if (!st.partner) st.partner = others[0].rid;
  const me = TEAMS[D.me], them = TEAMS[st.partner]; const ap = myApproach();
  const apChips = Object.entries(APPROACH).map(([k, v]) => `<button class="chip ${k === ap ? "on" : ""}" data-approach="${k}" type="button">${v.label}</button>`).join("");
  // ---- suggestions (the search takes a moment, so paint the page first) ----
  const ready = "ideas" in MEMO;
  if (!ready) setTimeout(() => { tradeIdeas(); if (currentView() === "trade") render(); }, 30);
  const ideas = ready ? tradeIdeas() : [];
  const ideaCards = ideas.map((x, i) => { const t = TEAMS[x.rid]; const [cl, cc] = chanceLabel(x.p); const [vl] = myVerdict(x.mine.score);
    return `<article class="lock v-lock">
      <div class="top"><div class="pl"><span class="a">Get ${x.get.map(k => esc(assetName(k))).join(" + ")}</span><span class="b">from ${esc(t.name)} · ${esc(t.user)}</span></div><span class="tag ${cc === "up" ? "t-lock" : cc === "down" ? "t-out" : "t-q"}">${cl} ${pct(x.p)}</span></div>
      <div class="pl"><span class="a muted">Give ${x.give.map(k => esc(assetName(k))).join(" + ")}</span></div>
      <div class="why"><b>For you (${vl.toLowerCase()}):</b> ${esc(sideText(x.mine, "you"))}<br><b>Why they'd say yes:</b> ${whyTheyAccept(x)} (${esc(sideText(x.theirs, "them"))})</div>
      <div class="foot"><span></span><button class="btn" type="button" data-idea="${i}">Open in analyzer</button></div></article>`; }).join("");

  // ---- analyzer ----
  const pick = (team, set, key) => {
    const ids = [...new Set(team.players)].filter(id => P[id]).sort((a, b) => dv(b) - dv(a));
    const players = ids.map(id => `<label class="pick"><input type="checkbox" data-${key}="${id}" ${set.has(id) ? "checked" : ""}>${plCell(id, team, null, (team.taxi || []).includes(id) ? `<span class="tag t-b2b">TAXI</span>` : (team.reserve || []).includes(id) ? `<span class="tag t-b2b">IR</span>` : "")}<span class="num small" title="Lock value · dynasty value">${f1(lockValue(id))} · <b>${dv(id)}</b></span></label>`).join("");
    const pks = picksOf(team.rid).map(pk => `<label class="pick"><input type="checkbox" data-${key}="${pickKey(pk)}" ${set.has(pickKey(pk)) ? "checked" : ""}><div class="pl"><span class="a">${esc(pickLabel(pk))}</span><span class="b">Rookie draft pick</span></div><span class="num small"><b>${pickValue(pk)}</b></span></label>`).join("");
    return players + (pks ? `<details style="margin-top:8px"${[...set].some(k => k.startsWith("pk:")) ? " open" : ""}><summary>Draft picks (${picksOf(team.rid).length})</summary>${pks}</details>` : "");
  };
  const give = [...st.give], get = [...st.get];
  let result = `<div class="empty">Got an offer? Check the players and picks on each side to see how it grades for you and how likely they are to accept.</div>`;
  if (give.length || get.length) {
    const mine = evalSide(D.me, give, get), theirs = evalSide(them.rid, get, give);
    const [vl, vc] = myVerdict(mine.score); const p = acceptChance(theirs); const [cl, cc] = chanceLabel(p);
    const lean = mine.nowS > 0.1 && mine.dynS < -0.1 ? "Helps you this season, costs you long term." : mine.nowS < -0.1 && mine.dynS > 0.1 ? "Costs you this season, builds for the future." : "";
    const row = (k, a, b, d, fmt = f1) => `<tr><td>${k}</td><td class="n">${a}</td><td class="n">${b}</td><td class="n ${d > 0 ? "up" : d < 0 ? "down" : ""}">${d > 0 ? "+" : ""}${fmt(d)}</td></tr>`;
    const lv = a => sum(plOnly(a).map(lockValue)), dyn = a => sum(a.map(k => tv(assetValue(k))));
    result = `<div class="cmp" style="grid-template-columns:1fr 1fr;margin-bottom:10px">
        <div><span class="k">For you</span><span class="verdict ${vc}">${vl}</span></div>
        <div><span class="k">Will ${esc(them.name)} accept?</span><span class="verdict ${cc}">${cl} · ${pct(p)}</span></div></div>
      ${lean ? `<div class="note info" style="margin-bottom:10px">${lean}</div>` : ""}
      <div class="tbl"><table><thead><tr><th></th><th class="n">You give</th><th class="n">You get</th><th class="n">Net</th></tr></thead><tbody>
      ${row("Trade value (players + picks)", f0(dyn(give)), f0(dyn(get)), dyn(get) - dyn(give), f0)}
      ${row("Lock value per week", f1(lv(give)), f1(lv(get)), lv(get) - lv(give))}
      </tbody></table></div>
      <div class="summary" style="margin-top:12px"><div><span class="k">Rest of season for you</span><span class="v ${mine.dRos >= 0 ? "good" : ""}">${mine.dRos >= 0 ? "+" : ""}${f0(mine.dRos)}</span><span class="small muted">points over ~${f0(weeksLeft())} weeks</span></div><div><span class="k">Your weekly lineup</span><span class="v">${f1(baseLineup(D.me))} → ${f1(baseLineup(D.me) + mine.dL)}</span><span class="small ${mine.dL >= 0 ? "up" : "down"}">${mine.dL >= 0 ? "+" : ""}${f1(mine.dL)}</span></div><div><span class="k">Their weekly lineup</span><span class="v">${f1(baseLineup(them.rid))} → ${f1(baseLineup(them.rid) + theirs.dL)}</span><span class="small ${theirs.dL >= 0 ? "up" : "down"}">${theirs.dL >= 0 ? "+" : ""}${f1(theirs.dL)}</span></div></div>
      <p class="muted small" style="margin:10px 0 0"><b>Their side:</b> ${esc(them.name)} looks ${modeName(theirs.mode)}, so they weigh this season ${pct(theirs.w)} and the future ${pct(1 - theirs.w)}. For them: ${esc(sideText(theirs, "them"))}.${mine.cut.length ? ` You'd need to cut ${esc(mine.cut.map(id => P[id].n).join(", "))} to make room.` : ""}</p>`;
  }
  const opts = others.map(t => `<option value="${t.rid}" ${t.rid === st.partner ? "selected" : ""}>${esc(t.name)} (${esc(t.user)})</option>`).join("");
  return `
  <section class="panel"><div class="hd"><h2>Trades to Propose</h2><span class="r">Your approach: this season ${pct(APPROACH[ap].w)}, future ${pct(1 - APPROACH[ap].w)}</span></div>
    <div class="chips" style="margin-bottom:12px">${apChips}</div>
    <p class="muted small" style="margin:0 0 12px">Each idea has to make your team better and give the other manager a real reason to accept, based on whether they look like a contender (wants points now) or a rebuilding team (wants youth and picks). The odds are estimates, since real managers have their own favorite players.</p>
    ${!ready ? `<div class="empty">Looking for trades across the league…</div>` : ideaCards ? `<div class="locks">${ideaCards}</div>` : `<div class="note info">No trades right now that help you and that the other manager would likely accept. Check back after waivers or injuries shake up rosters.</div>`}</section>
  <section class="panel" id="analyzer"><div class="hd"><h2>Trade Analyzer</h2><span class="r">Numbers: lock value · <b>dynasty value</b></span></div><p class="muted small" style="margin:0 0 10px">Trade value turns dynasty value into what a player is worth in a deal. It grows faster than dynasty value at the top, so one star is worth more than two decent players who add up to the same number.</p><label class="small muted" for="partner">Trade partner</label><br><select class="sel" id="partner">${opts}</select></section>
  <div class="tradecols">
    <section class="panel"><div class="hd"><h3>You give</h3><span class="r">${esc(me.name)}</span></div>${pick(me, st.give, "give")}</section>
    <section class="panel"><div class="hd"><h3>You get</h3><span class="r">${esc(them.name)}</span></div>${pick(them, st.get, "get")}</section>
  </div>
  <section class="panel"><div class="hd"><h3>Result</h3>${give.length || get.length ? `<button class="btn" id="clearTrade" type="button" style="margin-left:auto">Clear</button>` : ""}</div>${result}</section>`;
}

// ---------- dynasty tab ----------
function teamDynasty(rid) { const t = TEAMS[rid]; const top = t.players.filter(id => P[id]).map(dv).sort((a, b) => b - a).slice(0, 12); return sum(top) + sum(picksOf(rid).map(pickValue)); }
function viewDynasty() {
  dynastyValues(); const scope = st.kScope;
  let ids = scope === "mine" ? TEAMS[D.me].players.filter(id => P[id]) : Object.keys(DV);
  ids = ids.sort((a, b) => dv(b) - dv(a)); if (scope !== "mine") ids = ids.slice(0, 75);
  const rows = ids.map((id, i) => { const p = P[id]; const team = TEAMS[p.own]; const t = TEAMS[p.own];
    const where = t && (t.taxi || []).includes(id) ? `<span class="tag t-b2b">TAXI</span>` : t && (t.reserve || []).includes(id) ? `<span class="tag t-b2b">IR</span>` : "";
    return `<tr${p.own === D.me && scope !== "mine" ? ' class="swapin"' : ""}><td class="n muted">${i + 1}</td><td>${plCell(id, team, null, where)}</td>${scope !== "mine" ? `<td class="muted small hide-s">${esc(team?.name || "")}</td>` : ""}<td><div class="bar-lg"><span class="meter"><i style="width:${dv(id)}%"></i></span><span class="num">${dv(id)}</span></div></td><td class="n">${p.age ?? "—"}</td><td class="n hide-s">${p.exp ?? "—"}</td><td class="n">${f1(lockValue(id))}</td><td class="n hide-s">${p.adp ? f0(p.adp) : "—"}</td></tr>`; }).join("");
  const tdyn = D.teams.map(t => ({ t, v: teamDynasty(t.rid), age: (() => { const a = t.players.filter(id => P[id]).sort((x, y) => dv(y) - dv(x)).slice(0, 10).map(id => P[id].age).filter(Boolean); return a.length ? sum(a) / a.length : null; })() })).sort((a, b) => b.v - a.v);
  const maxT = Math.max(1, ...tdyn.map(x => x.v));
  const trows = tdyn.map((x, i) => `<tr${x.t.rid === D.me ? ' class="swapin"' : ""}><td class="n muted">${i + 1}</td><td><div class="pl"><span class="a">${esc(x.t.name)}</span><span class="b">${esc(x.t.user)}</span></div></td><td><div class="bar-lg"><span class="meter"><i style="width:${x.v / maxT * 100}%"></i></span><span class="num">${f0(x.v)}</span></div></td><td class="n">${x.age ? f1(x.age) : "—"}</td></tr>`).join("");
  const myPicks = picksOf(D.me).map(pk => `<tr><td>${esc(pickLabel(pk))}</td><td class="n">${pickValue(pk)}</td></tr>`).join("");
  return `
  <section class="panel"><div class="hd"><h2>Dynasty Rankings</h2></div>
    <div class="chips"><button class="chip ${scope === "mine" ? "on" : ""}" data-k="mine" type="button">My team</button><button class="chip ${scope === "all" ? "on" : ""}" data-k="all" type="button">Whole league</button></div></section>
  <section class="panel"><div class="tbl"><table><thead><tr><th class="n">#</th><th>Player</th>${scope !== "mine" ? `<th class="hide-s">Team</th>` : ""}<th>Dynasty value</th><th class="n">Age</th><th class="n hide-s">Yrs</th><th class="n">Lock val</th><th class="n hide-s">Dyn ADP</th></tr></thead><tbody>${rows}</tbody></table></div>
  <p class="muted small" style="margin:10px 0 0">Dynasty value ranks every rostered player 0–100: 55% Lock-In value adjusted for age (young players get a big boost, players past 28 fade fast), 45% dynasty draft position.</p></section>
  <div class="grid2">
    <section class="panel"><div class="hd"><h3>Long-term team strength</h3><span class="r">Top 12 players + picks</span></div><div class="tbl"><table><thead><tr><th class="n">#</th><th>Team</th><th>Value</th><th class="n">Core age</th></tr></thead><tbody>${trows}</tbody></table></div><p class="muted small" style="margin:10px 0 0">Core age = average age of each team's 10 most valuable players.</p></section>
    <section class="panel"><div class="hd"><h3>Your draft picks</h3><span class="r">Next 3 rookie drafts</span></div>${myPicks ? `<div class="tbl"><table><tbody>${myPicks}</tbody></table></div>` : `<div class="empty">You've traded all your picks.</div>`}<p class="muted small" style="margin:10px 0 0">Pick values are estimates on the same 0–100 scale. A 1st next year is worth more the weaker the original team looks right now.</p></section>
  </div>`;
}

// ---------- my team (full roster) ----------
function viewTeam() {
  const me = TEAMS[D.me]; const cur = D.current.find(c => c.rid === D.me) || { starters: [], pp: {} };
  const ir = new Set(me.reserve || []), taxi = new Set(me.taxi || []);
  const activeIds = active(me); const startersNow = cur.starters.filter(id => id && P[id]);
  const bench = activeIds.filter(id => !cur.starters.includes(id)).sort((a, b) => lockValue(b) - lockValue(a));
  const head = `<thead><tr><th></th><th>Player</th><th class="n">Lock val</th><th class="n">Dyn</th><th class="n">Age</th><th class="n hide-s">This week</th><th class="n">Counts</th></tr></thead>`;
  const row = (slot, id, extra = "", note = "") => { const p = P[id]; const ls = lockState(D.me, id);
    const tags = (ls.locked ? `<span class="tag t-lock">LOCKED</span>` : "") + extra;
    return `<tr><td class="slot">${esc(slot)}</td><td>${withReason(plCell(id, me, null, tags), note ? [note] : [])}</td><td class="n score">${f1(lockValue(id))}</td><td class="n">${dv(id)}</td><td class="n">${p.age ?? "—"}</td><td class="n hide-s muted small">${esc(weekStrip(p) || "No games")}</td><td class="n">${cur.pp[id] != null ? f1(cur.pp[id]) : "—"}</td></tr>`; };
  const startRows = D.league.slots.map((s, i) => { const id = cur.starters[i]; return id && P[id] ? row(s, id) : `<tr><td class="slot">${esc(s)}</td><td colspan="6" class="muted">Empty</td></tr>`; }).join("");
  const weakestBench = Math.min(...bench.map(lockValue), Infinity);
  const openIR = (D.league.reserveSlots || 0) - ir.size;
  const benchRows = bench.map(id => row("BN", id, "", OUT.has(P[id].inj) && openIR > 0 ? "Out: you could move him to IR to open a roster spot" : "")).join("");
  const irRows = [...ir].filter(id => P[id]).map(id => { const p = P[id]; const healthy = !OUT.has(p.inj) && p.inj !== "Doubtful";
    return row("IR", id, healthy ? `<span class="tag t-q">ACTIVATE</span>` : "", healthy ? "No longer injured: Sleeper won't let you make moves until he's off IR" : (p.injNote || p.injPart || "")); }).join("");
  const taxiRows = [...taxi].filter(id => P[id]).map(id => { const better = !OUT.has(P[id].inj) && lockValue(id) > weakestBench + 3;
    return row("TX", id, better ? `<span class="tag t-in">PROMOTE?</span>` : "", better ? `Beats your weakest bench player (${f1(weakestBench)}), but promoting him is permanent` : `${P[id].exp === 0 ? "Rookie" : "Year " + (P[id].exp + 1)} · stashing is free`); }).join("");
  const total = me.players.length;
  return `
  <section class="panel"><div class="hd"><h2>My Team</h2><span class="r">${esc(me.name)} · ${me.w}-${me.l}</span></div>
    <div class="summary"><div><span class="k">Starters</span><span class="v">${startersNow.length}/${D.league.slots.length}</span></div><div><span class="k">Bench</span><span class="v">${bench.length}</span></div><div><span class="k">IR</span><span class="v">${ir.size}/${D.league.reserveSlots}</span></div><div><span class="k">Taxi</span><span class="v">${taxi.size}/${D.league.taxiSlots}</span></div><div><span class="k">Week ${D.week} score</span><span class="v acc">${f1(cur.pts)}</span></div></div></section>
  <section class="panel"><div class="hd"><h3>Starting lineup</h3><span class="r">As set in Sleeper right now</span></div><div class="tbl"><table>${head}<tbody>${startRows}</tbody></table></div></section>
  <section class="panel"><div class="hd"><h3>Bench</h3><span class="r">${bench.length} players</span></div><div class="tbl"><table>${head}<tbody>${benchRows || `<tr><td colspan="7" class="empty">Nobody on the bench.</td></tr>`}</tbody></table></div></section>
  <div class="grid2">
    <section class="panel"><div class="hd"><h3>Injured reserve</h3><span class="r">${ir.size} of ${D.league.reserveSlots} slots</span></div><div class="tbl"><table><tbody>${irRows || `<tr><td class="empty">IR is empty.</td></tr>`}</tbody></table></div></section>
    <section class="panel"><div class="hd"><h3>Taxi squad</h3><span class="r">${taxi.size} of ${D.league.taxiSlots} · rookies only</span></div><div class="tbl"><table><tbody>${taxiRows || `<tr><td class="empty">Taxi squad is empty.</td></tr>`}</tbody></table></div></section>
  </div>
  <p class="muted small">Counts = the score that currently counts for him this week in Sleeper (his locked game, or his latest one). ${total} players rostered in all.</p>`;
}

// ---------- season plan ----------
// Weekly strength for the season sim: best 9 lock values. IR players are assumed back after two weeks.
function strengthWithIR(rid) { return memo("sir" + rid, () => { const t = TEAMS[rid]; return typicalLineup(t.players.filter(id => P[id] && !(t.taxi || []).includes(id))); }); }
function randn() { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
// Monte Carlo of the rest of the regular season and the playoffs
function seasonSim(N = 3000) {
  return memo("sim", () => {
    const ids = D.teams.map(t => t.rid); const n = ids.length; const nP = D.league.playoffTeams || 6;
    const now = Object.fromEntries(ids.map(r => [r, baseLineup(r)])), full = Object.fromEntries(ids.map(r => [r, Math.max(baseLineup(r), strengthWithIR(r))]));
    const cur = Object.fromEntries(ids.map(r => [r, teamProjection(r)]));
    const mu = (r, w) => (w <= D.week + 1 ? now[r] : full[r]);
    const out = Object.fromEntries(ids.map(r => [r, { wins: 0, playoff: 0, title: 0, bye: 0, finish: Array(n).fill(0) }]));
    // Week-to-week noise (12%) plus season-level uncertainty per team (7%): injuries, trades, and this model being wrong
    let M = {};
    const play = (a, b) => { const sa = full[a] * M[a] * (1 + 0.12 * randn()), sb = full[b] * M[b] * (1 + 0.12 * randn()); return sa >= sb ? a : b; };
    for (let k = 0; k < N; k++) {
      M = Object.fromEntries(ids.map(r => [r, 1 + 0.07 * randn()]));
      const W = {}, PF = {}; for (const t of D.teams) { W[t.rid] = t.w + 0.5 * (t.tie || 0); PF[t.rid] = t.pf; }
      for (const f of D.fixtures) for (const [a, b] of f.pairs) {
        let sa, sb;
        if (f.w === D.week) { sa = cur[a].total + Math.sqrt(cur[a].varr) * randn(); sb = cur[b].total + Math.sqrt(cur[b].varr) * randn(); }
        else { sa = mu(a, f.w) * M[a] * (1 + 0.12 * randn()); sb = mu(b, f.w) * M[b] * (1 + 0.12 * randn()); }
        PF[a] += sa; PF[b] += sb; if (sa >= sb) W[a]++; else W[b]++;
      }
      const order = [...ids].sort((a, b) => W[b] - W[a] || PF[b] - PF[a]);
      order.forEach((r, i) => { out[r].finish[i]++; out[r].wins += W[r]; if (i < nP) out[r].playoff++; if (i < 2) out[r].bye++; });
      // 6-team bracket: 3v6 and 4v5, then the top two seeds play the winners
      const s = order.slice(0, nP); let champ;
      if (nP === 6) { const q1 = play(s[2], s[5]), q2 = play(s[3], s[4]); champ = play(play(s[0], q2), play(s[1], q1)); }
      else { let field = s; while (field.length > 1) { const next = []; for (let i = 0; i < field.length / 2; i++) next.push(play(field[i], field[field.length - 1 - i])); field = next; } champ = field[0]; }
      out[champ].title++;
    }
    for (const r of ids) { const o = out[r]; o.wins /= N; o.playoff /= N; o.title /= N; o.bye /= N; o.finish = o.finish.map(x => x / N); }
    return out;
  });
}
// Player development for the window view: young players grow, older ones fade
function growth(age) { if (age == null) return 1; if (age <= 21) return 1.12; if (age <= 23) return 1.08; if (age <= 25) return 1.03; if (age <= 28) return 1; if (age <= 30) return 0.95; if (age <= 32) return 0.9; return 0.85; }
function futureStrength(rid, years) {
  return memo(`fut${rid}-${years}`, () => {
    const t = TEAMS[rid]; const ids = t.players.filter(id => P[id]);
    const val = id => { let v = lockValue(id), a = P[id].age; for (let y = 0; y < years; y++) { v *= growth(a); if (a != null) a++; } return v; };
    return optimize(ids, val).total;
  });
}
function rankOf(rid, f) { const v = f(rid); return 1 + D.teams.filter(t => f(t.rid) > v).length; }
function ordinal(n) { const s = ["th", "st", "nd", "rd"], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }
function weekDate(w) { const d = new Date(D.weekDates[0] + "T12:00:00"); d.setDate(d.getDate() + 7 * (w - D.week)); return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }); }

function viewPlan() {
  const ready = "sim" in MEMO;
  if (!ready) { setTimeout(() => { seasonSim(); if (currentView() === "plan") render(); }, 30); return `<section class="panel"><div class="hd"><h2>Season Plan</h2></div><div class="empty">Simulating the rest of the season 3,000 times…</div></section>`; }
  const sim = seasonSim(); const me = TEAMS[D.me]; const my = sim[D.me]; const n = D.teams.length; const nP = D.league.playoffTeams || 6;
  const nowRank = rankOf(D.me, baseLineup), dynRank = rankOf(D.me, teamDynasty), y1 = rankOf(D.me, r => futureStrength(r, 1)), y2 = rankOf(D.me, r => futureStrength(r, 2));
  const coreAge = (() => { const a = me.players.filter(id => P[id]).sort((x, y) => dv(y) - dv(x)).slice(0, 10).map(id => P[id].age).filter(Boolean); return a.length ? sum(a) / a.length : null; })();
  // Draft slot if the order is reverse standings (worst record picks 1st)
  const pickDist = [...my.finish].reverse();
  const expPick = sum(pickDist.map((p, i) => p * (i + 1)));
  const slotValue = slot => { const frac = (n - slot) / (n - 1); return 40 + 30 * frac; }; // same scale as pick values
  const bottom3 = sum(pickDist.slice(0, 3)), top3pick = sum(pickDist.slice(0, 3));
  const tankGain = slotValue(2) - slotValue(Math.round(expPick));

  // The call
  let plan, tone, why;
  const deadline = D.league.tradeDeadline;
  if (my.title >= 0.15 || my.playoff >= 0.65) { plan = "Contend"; tone = "up"; why = `You make the playoffs in ${pct(my.playoff)} of simulations and win it all in ${pct(my.title)}. Spend future value (aging vets on rebuilding teams are cheap, and your later picks) to raise this season's ceiling.`; }
  else if (my.playoff >= 0.35) {
    if (dynRank <= 4 || y1 <= 3) { plan = "Push, but protect the core"; tone = ""; why = `You're a coin flip for the playoffs (${pct(my.playoff)}) and your long-term outlook is strong (${ordinal(dynRank)} in dynasty value). Make small upgrades for this season, but don't trade young players or 1sts for veterans.`; }
    else { plan = "Decide by the deadline"; tone = ""; why = `You're on the bubble (${pct(my.playoff)} playoff odds). Give it until about week ${Math.max(D.week + 3, (deadline || 18) - 6)}: if you're out of the top ${nP} by then, sell veterans before the week ${deadline} deadline.`; }
  } else if (dynRank <= 4 || y1 <= 3) { plan = "Retool for next year"; tone = "down"; why = `Only ${pct(my.playoff)} playoff odds this season, but your roster projects ${ordinal(y1)} next year. Sell veterans who won't be good by then for picks and young players, and keep the young core.`; }
  else { plan = "Rebuild: aim for a top pick"; tone = "down"; why = `Only ${pct(my.playoff)} playoff odds, and your long-term value ranks ${ordinal(dynRank)}. ${expPick <= 3.5 ? `You're already on track for a top-3 rookie pick (${pct(top3pick)} of simulations), so lean into it.` : `A top-3 rookie pick is worth about ${f0(tankGain)} more dynasty value than where you're projected to pick (${ordinal(Math.round(expPick))}).`} Sell veterans to contenders for 1sts and young players, and keep your young core.`; }

  // Who to sell, buy and build around
  const contenders = D.teams.filter(t => t.rid !== D.me && sim[t.rid].playoff >= 0.5).map(t => t.rid);
  const rebuilders = D.teams.filter(t => t.rid !== D.me && sim[t.rid].playoff < 0.3).map(t => t.rid);
  const groupOf = id => (P[id].pos.includes("C") ? "C" : P[id].pos.some(x => x === "PG" || x === "SG") ? "G" : "F");
  const weakFor = (rid, g) => { const s = groupStrength(rid); const r = 1 + D.teams.filter(t => groupStrength(t.rid)[g] > s[g]).length; return r >= 7; };
  const sells = me.players.filter(id => P[id] && (P[id].age || 0) >= 29 && !OUT.has(P[id].inj)).sort((a, b) => lockValue(b) - lockValue(a)).slice(0, 4)
    .map(id => ({ id, buyers: contenders.filter(r => weakFor(r, groupOf(id))).slice(0, 3) }));
  const core = me.players.filter(id => P[id] && (P[id].age || 99) <= 24 && dv(id) >= 55).sort((a, b) => dv(b) - dv(a));
  const buys = (() => { const out = []; const base = baseLineup(D.me);
    for (const r of rebuilders) for (const id of active(TEAMS[r])) { if ((P[id].age || 0) < 28 || OUT.has(P[id].inj)) continue; const gain = typicalLineup(active(me).concat(id)) - base; if (gain >= 2) out.push({ id, r, gain }); }
    return out.sort((a, b) => b.gain - a.gain).slice(0, 5); })();

  // Schedule
  const next = D.fixtures.filter(f => f.w > D.week).slice(0, 4).map(f => { const pr = f.pairs.find(p => p.includes(D.me)); const opp = pr ? pr.find(x => x !== D.me) : null; return { w: f.w, opp }; });
  const sos = (() => { const opps = D.fixtures.filter(f => f.w >= D.week).map(f => { const pr = f.pairs.find(p => p.includes(D.me)); return pr ? pr.find(x => x !== D.me) : null; }).filter(Boolean);
    const avgOpp = sum(opps.map(r => strengthWithIR(r))) / Math.max(1, opps.length); const all = D.teams.map(t => { const o = D.fixtures.filter(f => f.w >= D.week).map(f => { const pr = f.pairs.find(p => p.includes(t.rid)); return pr ? pr.find(x => x !== t.rid) : null; }).filter(Boolean); return sum(o.map(r => strengthWithIR(r))) / Math.max(1, o.length); });
    return 1 + all.filter(x => x > avgOpp).length; })();

  // Checklist
  const checks = [];
  const lockable = active(me).filter(id => lockCall(D.me, id, null).kind === "decide").length;
  if (lockable) checks.push(`Make ${lockable} lock decision${lockable > 1 ? "s" : ""} on the <a href="#lock">Lock-In</a> tab.`);
  const wm = waiverMoves(); const firstMove = (plan === "Contend" || plan.startsWith("Push") ? wm.nowList[0] || wm.futList[0] : wm.futList[0] || wm.taxiMoves[0]);
  if (firstMove) checks.push(`Waivers: pick up ${esc(P[firstMove.f].n)}, drop ${esc(P[firstMove.d].n)} (<a href="#waivers">details</a>).`);
  const irHealthy = (me.reserve || []).filter(id => P[id] && !OUT.has(P[id].inj) && P[id].inj !== "Doubtful");
  if (irHealthy.length) checks.push(`Move ${irHealthy.map(id => esc(P[id].n)).join(", ")} off IR. Sleeper blocks moves until you do.`);
  if (sells.length && !plan.startsWith("Contend") && !plan.startsWith("Push")) checks.push(`Shop ${esc(P[sells[0].id].n)} to ${sells[0].buyers.length ? sells[0].buyers.map(r => esc(TEAMS[r].name)).join(" or ") : "a contender"}.`);
  if (buys.length && (plan === "Contend" || plan.startsWith("Push"))) checks.push(`Ask ${esc(TEAMS[buys[0].r].name)} about ${esc(P[buys[0].id].n)}: a rebuilding team with a veteran who'd add ${f1(buys[0].gain)} to your lineup each week.`);
  checks.push(`Check <a href="#trade">Trades</a> with your approach set to ${plan === "Contend" ? "Win now" : plan.startsWith("Re") ? "Build for the future" : "Balanced"}.`);

  const oddsRows = [...D.teams].sort((a, b) => sim[b.rid].playoff - sim[a.rid].playoff || sim[b.rid].title - sim[a.rid].title).map(t => { const o = sim[t.rid];
    return `<tr${t.rid === D.me ? ' class="swapin"' : ""}><td><div class="pl"><span class="a">${esc(t.name)}</span><span class="b">${esc(t.user)} · ${t.w}-${t.l}</span></div></td><td class="n">${f1(o.wins)}</td><td class="n">${pct(o.playoff)}</td><td class="n hide-s">${pct(o.bye)}</td><td class="n score">${pct(o.title)}</td></tr>`; }).join("");
  const pickBars = pickDist.map((p, i) => `<div class="daybar" style="grid-template-columns:44px 1fr 44px"><span class="muted">#${i + 1}</span><div class="half"><span class="fill" style="width:${Math.min(100, p * 250)}%"></span></div><span class="num small">${pct(p)}</span></div>`).join("");
  const winRows = [["Now", nowRank], ["Next season", y1], ["In two seasons", y2]].map(([k, r]) => `<div><span class="k">${k}</span><span class="v ${r <= 3 ? "good" : ""}">${ordinal(r)}</span></div>`).join("");
  const list = (arr, fn, empty) => arr.length ? `<div class="tbl"><table><tbody>${arr.map(fn).join("")}</tbody></table></div>` : `<div class="empty">${empty}</div>`;

  return `
  <section class="panel"><div class="hd"><h2>Season Plan</h2><span class="r">${esc(me.name)} · ${me.w}-${me.l} · week ${D.week} of ${(D.league.playoffStart || 22) - 1}</span></div>
    <div class="verdict ${tone}" style="font-size:30px">${plan}</div>
    <p style="margin:8px 0 0;max-width:70ch">${why}</p></section>
  <div class="summary">
    <div><span class="k">Projected wins</span><span class="v">${f1(my.wins)}</span></div>
    <div><span class="k">Playoff odds</span><span class="v ${my.playoff >= 0.5 ? "good" : ""}">${pct(my.playoff)}</span></div>
    <div><span class="k">Title odds</span><span class="v acc">${pct(my.title)}</span></div>
    <div><span class="k">Dynasty rank</span><span class="v">${ordinal(dynRank)}</span></div>
    <div><span class="k">Core age</span><span class="v">${coreAge ? f1(coreAge) : "—"}</span></div>
  </div>
  <section class="panel"><div class="hd"><h3>This week</h3></div><ul style="margin:0;padding-left:20px;display:grid;gap:6px">${checks.map(c => `<li>${c}</li>`).join("")}</ul></section>
  <div class="grid2">
    <section class="panel"><div class="hd"><h3>Your window</h3><span class="r">Roster strength rank, players aging as they do</span></div>
      <div class="summary">${winRows}</div>
      <p class="muted small" style="margin:10px 0 0">Projects your current roster forward: players 23 and under improve, players past 29 decline. ${y2 <= nowRank - 2 ? "Your roster gets better with time, so patience pays." : y2 >= nowRank + 2 ? "Your roster gets worse with time, so this season matters more than later ones." : Math.min(nowRank, y1, y2) >= 9 ? "Your roster stays near the bottom even as your young players grow, so you need to add talent, not just wait." : Math.max(nowRank, y1, y2) <= 4 ? "Your roster stays near the top for the next two years." : "Your roster holds roughly steady over the next two years."}</p></section>
    <section class="panel"><div class="hd"><h3>Should you tank?</h3><span class="r">Assumes reverse standings set the rookie draft</span></div>
      <div class="daybars">${pickBars}</div>
      <p class="muted small" style="margin:10px 0 0">Your average projected pick is ${ordinal(Math.round(expPick))}; you land a top-3 pick in ${pct(top3pick)} of simulations. ${expPick <= 3.5 ? "You're already in range for a top pick." : `Moving up to the 2nd pick is worth about ${f0(Math.max(0, tankGain))} dynasty value.`} ${plan.startsWith("Rebuild") ? "That's worth chasing: selling veterans lowers your record and adds picks at the same time." : my.playoff >= 0.5 ? "With your playoff odds, chasing a high pick isn't worth it." : "It's a real option if your playoff odds keep slipping."} If your league uses a lottery or another order, tell me and I'll change this.</p></section>
  </div>
  <div class="grid2">
    <section class="panel"><div class="hd"><h3>${plan === "Contend" || plan.startsWith("Push") ? "Veterans you could sell later" : "Sell before the deadline"}</h3><span class="r">Week ${deadline} (~${weekDate(deadline)})</span></div>
      ${list(sells, x => `<tr><td>${plCell(x.id, me, null)}</td><td class="muted small">${x.buyers.length ? "Fits " + x.buyers.map(r => esc(TEAMS[r].name)).join(", ") : "Any contender"}</td><td class="n">${dv(x.id)}</td></tr>`, "No veterans worth selling.")}
      <p class="muted small" style="margin:10px 0 0">Players 29 and older lose dynasty value every year. Buyers listed are teams likely to make the playoffs that are thin at his position.</p></section>
    <section class="panel"><div class="hd"><h3>${plan === "Contend" || plan.startsWith("Push") ? "Veterans to target" : "Build around"}</h3></div>
      ${plan === "Contend" || plan.startsWith("Push")
        ? list(buys, x => `<tr><td>${plCell(x.id, TEAMS[x.r], null)}</td><td class="muted small">${esc(TEAMS[x.r].name)}</td><td class="n up">+${f1(x.gain)}/wk</td></tr>`, "No cheap veterans who'd improve your lineup.")
        : list(core, id => `<tr><td>${plCell(id, me, null)}</td><td class="n">${P[id].age}</td><td class="n">${dv(id)}</td></tr>`, "No young core players yet: target players 24 and under in trades.")}
    </section>
  </div>
  <div class="grid2">
    <section class="panel"><div class="hd"><h3>League odds</h3><span class="r">${f0(3000).replace(/\B(?=(\d{3})+(?!\d))/g, ",")} simulated seasons</span></div>
      <div class="tbl"><table><thead><tr><th>Team</th><th class="n">Wins</th><th class="n">Playoffs</th><th class="n hide-s">Bye</th><th class="n">Title</th></tr></thead><tbody>${oddsRows}</tbody></table></div>
      <p class="muted small" style="margin:10px 0 0">Each team's weekly strength is its best 9 lock values; IR players are assumed back after two weeks. Every simulation also shuffles team strength a little, since injuries and trades will change rosters. Top ${nP} make the playoffs, top 2 get byes.</p></section>
    <section class="panel"><div class="hd"><h3>Schedule</h3><span class="r">Remaining strength of schedule: ${ordinal(sos)} hardest</span></div>
      ${list(next, x => `<tr><td class="muted">Wk ${x.w}</td><td>${x.opp ? esc(TEAMS[x.opp].name) : "Bye"}</td><td class="n small muted">${x.opp ? `${ordinal(rankOf(x.opp, strengthWithIR))} strongest` : ""}</td></tr>`, "No games left.")}
      <p class="muted small" style="margin:10px 0 0">Trade deadline: week ${deadline} (~${weekDate(deadline)}). Playoffs start week ${D.league.playoffStart} (~${weekDate(D.league.playoffStart)}). Dates are estimates if Sleeper merges weeks around the All-Star break.</p></section>
  </div>`;
}

// ---------- league ----------
function viewLeague() {
  const allPlay = {}; D.teams.forEach(t => (allPlay[t.rid] = { w: 0, l: 0 }));
  D.history.forEach(w => w.s.forEach(([rid, , pts]) => w.s.forEach(([r2, , p2]) => { if (r2 === rid) return; if (pts > p2) allPlay[rid].w++; else if (pts < p2) allPlay[rid].l++; })));
  const maxPf = Math.max(1, ...D.teams.map(t => t.pf)); const depths = Object.fromEntries(D.teams.map(t => [t.rid, typicalLineup(active(t))])); const maxDepth = Math.max(1, ...Object.values(depths));
  const power = D.teams.map(t => { const ap = allPlay[t.rid]; const p = ap.w + ap.l ? ap.w / (ap.w + ap.l) : 0.5; return { t, score: 0.45 * p + 0.25 * (t.pf / maxPf) + 0.3 * depths[t.rid] / maxDepth }; }).sort((a, b) => b.score - a.score);
  const stand = [...D.teams].sort((a, b) => b.w - a.w || b.pf - a.pf);
  const dynOrder = [...D.teams].sort((a, b) => teamDynasty(b.rid) - teamDynasty(a.rid)); const dynRank = Object.fromEntries(dynOrder.map((t, i) => [t.rid, i + 1]));
  const divName = k => D.league.divs["division_" + k] || "";
  const srows = stand.map((t, i) => `<tr${t.rid === D.me ? ' class="swapin"' : ""}><td class="n muted">${i + 1}</td><td><div class="pl"><span class="a">${esc(t.name)}</span><span class="b">${esc(t.user)}${t.div ? " · " + esc(divName(t.div)) : ""}</span></div></td><td class="n">${t.w}-${t.l}${t.tie ? "-" + t.tie : ""}</td><td class="n">${f1(t.pf)}</td><td class="n hide-s">${f1(t.pa)}</td><td class="n muted hide-s">${esc(t.streak || "")}</td></tr>`).join("");
  const prows = power.map((x, i) => `<tr${x.t.rid === D.me ? ' class="swapin"' : ""}><td class="n muted">${i + 1}</td><td><div class="pl"><span class="a">${esc(x.t.name)}</span><span class="b">${esc(x.t.user)}</span></div></td><td class="n">${allPlay[x.t.rid].w}-${allPlay[x.t.rid].l}</td><td class="n">${f1(depths[x.t.rid])}</td><td class="n hide-s">${dynRank[x.t.rid]}</td></tr>`).join("");
  const rosters = D.teams.map(t => `<details class="panel"><summary><b>${esc(t.name)}</b> · ${esc(t.user)} · ${t.w}-${t.l}</summary><div class="tbl" style="margin-top:8px"><table><tbody>${t.players.filter(id => P[id]).sort((a, b) => lockValue(b) - lockValue(a)).map(id => `<tr><td>${plCell(id, t, null, (t.taxi || []).includes(id) ? `<span class="tag t-b2b">TAXI</span>` : (t.reserve || []).includes(id) ? `<span class="tag t-b2b">IR</span>` : "")}</td><td class="n">${f1(lockValue(id))}</td><td class="n">${dv(id)}</td></tr>`).join("")}</tbody></table></div></details>`).join("");
  return `
  <div class="grid2">
    <section class="panel"><div class="hd"><h2>Standings</h2><span class="r">${esc(D.league.name)} · Week ${D.week}</span></div><div class="tbl"><table><thead><tr><th class="n">#</th><th>Team</th><th class="n">W-L</th><th class="n">PF</th><th class="n hide-s">PA</th><th class="n hide-s">Strk</th></tr></thead><tbody>${srows}</tbody></table></div></section>
    <section class="panel"><div class="hd"><h2>Power Rankings</h2></div><div class="tbl"><table><thead><tr><th class="n">#</th><th>Team</th><th class="n">All-play</th><th class="n">Wk value</th><th class="n hide-s">Dyn rank</th></tr></thead><tbody>${prows}</tbody></table></div><p class="muted small" style="margin:10px 0 0">All-play is your record if you'd played every team every finished week. Rank mixes all-play (45%), points for (25%) and roster strength (30%). Dyn rank = long-term strength from the Dynasty tab.</p></section>
  </div>
  <section style="display:grid;gap:8px"><h3>Rosters</h3>${rosters}</section>`;
}

// ---------- shell ----------
const VIEWS = { plan: viewPlan, lock: viewLock, lineup: viewLineup, team: viewTeam, matchup: viewMatchup, waivers: viewWaivers, trade: viewTrade, dynasty: viewDynasty, league: viewLeague };
function currentView() { const h = (location.hash || "").slice(1); return VIEWS[h] ? h : "lock"; }
function render() {
  if (!D) return; const v = currentView();
  document.querySelectorAll("#tabs a").forEach(a => a.classList.toggle("on", a.dataset.v === v));
  try { document.getElementById("view").innerHTML = VIEWS[v](); }
  catch (e) { console.error(e); document.getElementById("view").innerHTML = `<div class="panel empty">This tab hit an error: ${esc(e.message)}</div>`; }
}
window.addEventListener("hashchange", render);
document.addEventListener("click", e => {
  const t = e.target.closest("[data-day],[data-pos],[data-sort],[data-k],[data-mark],[data-unmark],[data-idea],[data-approach],#clearTrade,#refresh"); if (!t) return;
  if (t.dataset.approach) { setApproach(t.dataset.approach); render(); return; }
  if (t.dataset.idea != null) { const x = tradeIdeas()[+t.dataset.idea]; st.partner = x.rid; st.give = new Set(x.give); st.get = new Set(x.get); render(); document.getElementById("analyzer")?.scrollIntoView({ behavior: "smooth" }); return; }
  if (t.id === "refresh") { load(true); return; }
  if (t.dataset.day) st.day = t.dataset.day;
  else if (t.dataset.pos) st.wPos = t.dataset.pos;
  else if (t.dataset.sort) st.wSort = t.dataset.sort;
  else if (t.dataset.k) st.kScope = t.dataset.k;
  else if (t.dataset.mark) setManualLock(t.dataset.mark, t.dataset.d);
  else if (t.dataset.unmark) setManualLock(t.dataset.unmark, null);
  else if (t.id === "clearTrade") { st.give.clear(); st.get.clear(); }
  render();
});
document.addEventListener("change", e => {
  const t = e.target;
  if (t.id === "partner") { st.partner = +t.value; st.get.clear(); }
  else if (t.dataset.give) t.checked ? st.give.add(t.dataset.give) : st.give.delete(t.dataset.give);
  else if (t.dataset.get) t.checked ? st.get.add(t.dataset.get) : st.get.delete(t.dataset.get);
  else return;
  render();
});

function ago(iso) { const m = Math.round((Date.now() - new Date(iso)) / 60000); if (m < 1) return "just now"; if (m < 60) return m + " min ago"; return Math.round(m / 60) + " hr ago"; }
function header() {
  const me = TEAMS[D.me];
  document.getElementById("teamName").textContent = me ? me.name : D.league.name;
  document.getElementById("teamSub").textContent = me ? `${me.w}-${me.l} · ${D.league.name} · Week ${D.week}` : "";
  document.getElementById("fresh").textContent = "Updated " + ago(D.gen);
}
let timer = null;
async function load(manual = false) {
  const btn = document.getElementById("refresh"); if (manual) { btn.disabled = true; btn.textContent = "Loading…"; }
  try {
    const r = await fetch("/api/data" + (manual ? "?t=" + Date.now() : ""), { cache: manual ? "no-store" : "default" });
    const body = await r.json(); if (!r.ok) throw new Error(body.error || "status " + r.status);
    D = body; P = D.players; TEAMS = Object.fromEntries(D.teams.map(t => [t.rid, t])); DV = null; MEMO = {};
    header(); render();
  } catch (e) {
    if (!D) document.getElementById("view").innerHTML = `<div class="panel empty">Couldn't load your league: ${esc(e.message)}. Tap Refresh to try again.</div>`;
  } finally { if (manual) { btn.disabled = false; btn.textContent = "Refresh"; } }
  // Poll every minute while games are on, every 5 minutes otherwise
  clearTimeout(timer); const liveNow = D && D.games.some(g => g.state === "in");
  timer = setTimeout(() => load(), liveNow ? 60000 : 300000);
}
setInterval(() => { if (D) document.getElementById("fresh").textContent = "Updated " + ago(D.gen); }, 30000);
load();
