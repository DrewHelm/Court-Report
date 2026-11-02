// Court Report — front end. Loads /api/data and renders every tab.
// League format: Sleeper NBA Lock-In. Each starter counts ONE game per week:
// the game you lock (before his next game starts, while he's in your lineup),
// otherwise his last game of the week. Locked players can't move slots.

let D = null, P = {}, TEAMS = {};
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
function viewWaivers() {
  const me = TEAMS[D.me]; const mine = active(me);
  const drop = mine.map(id => ({ id, v: lockValue(id) })).sort((a, b) => a.v - b.v)[0];
  const pos = st.wPos; let list = D.fa.filter(id => P[id] && (pos === "ALL" || P[id].pos.includes(pos)));
  const key = { score: waiverScore, dyn: dv, lv: lockValue, val: id => P[id].val || 0, wk: weekEV, l14: id => P[id].l14 ?? -1, trend: id => (P[id].l14 ?? P[id].val ?? 0) - (P[id].pre || P[id].val || 0) }[st.wSort] || waiverScore;
  list = list.map(id => ({ id, k: key(id) })).sort((a, b) => b.k - a.k).slice(0, 40);
  const th = (k, l, cls = "") => `<th class="n sort ${st.wSort === k ? "act" : ""} ${cls}" data-sort="${k}">${l}</th>`;
  const rows = list.map((x, i) => { const p = P[x.id]; const tr = (p.l14 ?? p.val ?? 0) - (p.pre || p.val || 0); const up = lockValue(x.id) - (drop ? drop.v : 0);
    return `<tr><td class="n muted">${i + 1}</td><td>${plCell(x.id, null, null)}</td><td class="n score">${f1(waiverScore(x.id))}</td><td class="n">${f1(lockValue(x.id))}</td><td class="n hide-s">${f1(p.val)}</td><td class="n">${f1(weekEV(x.id))}</td><td class="n">${futureGames(p).length}</td><td class="n hide-s ${tr > 1 ? "up" : tr < -1 ? "down" : ""}">${tr > 0 ? "▲" : tr < 0 ? "▼" : ""}${f1(Math.abs(tr))}</td><td class="n">${dv(x.id)}</td><td class="n ${up > 0 ? "up" : "down"}">${up > 0 ? "+" : ""}${f1(up)}</td></tr>`; }).join("");
  const chips = ["ALL", "PG", "SG", "SF", "PF", "C"].map(x => `<button class="chip ${x === pos ? "on" : ""}" data-pos="${x}" type="button">${x === "ALL" ? "All" : x}</button>`).join("");
  return `
  <section class="panel"><div class="hd"><h2>Waiver Wire</h2><span class="r">${D.fa.length} free agents · FAAB $${D.league.faab ?? "—"}</span></div><div class="chips">${chips}</div></section>
  ${drop ? `<div class="note info">Your weakest active player is <b>${esc(P[drop.id].n)}</b> (lock value ${f1(drop.v)}). The last column shows how much each free agent beats him by.</div>` : ""}
  <section class="panel"><div class="tbl"><table><thead><tr><th class="n">#</th><th>Player</th>${th("score", "Score")}${th("lv", "Lock val")}${th("val", "Avg val", "hide-s")}${th("wk", "This wk")}<th class="n">Gms</th>${th("trend", "Trend", "hide-s")}${th("dyn", "Dyn")}<th class="n">vs drop</th></tr></thead><tbody>${rows || `<tr><td colspan="10" class="empty">No free agents at this position.</td></tr>`}</tbody></table></div>
  <p class="muted small" style="margin:10px 0 0">Lock val = what he's worth in a typical Lock-In week: his average plus credit for big games, since you only count his best one. This wk = what he'd likely count for this week if you added him now. Score mixes lock value (50%), this week (30%) and last 14 days (20%). Dyn = dynasty value (0–100, same scale as rostered players); sort by it to find long-term stashes.</p></section>`;
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
function assetValue(key) { if (key.startsWith("pk:")) { const pk = D.picks.find(x => pickKey(x) === key); return pk ? pickValue(pk) : 0; } return dv(key); }

// ---------- trades ----------
// Rest of season: one counted game per week, so weeks left × lock value
function rosValue(id) { const p = P[id]; return lockValue(id) * ((p.rem || 0) / 3.5) * (OUT.has(p.inj) ? 0.5 : 1); }
function typicalLineup(ids) { return optimize(ids, id => (OUT.has(P[id].inj) ? null : lockValue(id))).total; }
const GROUPS = { G: ["PG", "SG"], F: ["SF", "PF"], C: ["C"] };
function groupStrength(rid) { const ids = active(TEAMS[rid]).filter(id => !OUT.has(P[id].inj)); const out = {}; for (const [g, ps] of Object.entries(GROUPS)) { out[g] = sum(ids.filter(id => P[id].pos.some(x => ps.includes(x))).map(lockValue).sort((a, b) => b - a).slice(0, g === "C" ? 2 : 4)); } return out; }
function viewTrade() {
  const others = D.teams.filter(t => t.rid !== D.me); if (!st.partner) st.partner = others[0].rid;
  const me = TEAMS[D.me], them = TEAMS[st.partner];
  const pick = (team, set, key) => {
    const ids = [...new Set(team.players)].filter(id => P[id]).sort((a, b) => dv(b) - dv(a));
    const players = ids.map(id => `<label class="pick"><input type="checkbox" data-${key}="${id}" ${set.has(id) ? "checked" : ""}>${plCell(id, team, null, (team.taxi || []).includes(id) ? `<span class="tag t-b2b">TAXI</span>` : (team.reserve || []).includes(id) ? `<span class="tag t-b2b">IR</span>` : "")}<span class="num small" title="Lock value · dynasty value">${f1(lockValue(id))} · <b>${dv(id)}</b></span></label>`).join("");
    const pks = picksOf(team.rid).map(pk => `<label class="pick"><input type="checkbox" data-${key}="${pickKey(pk)}" ${set.has(pickKey(pk)) ? "checked" : ""}><div class="pl"><span class="a">${esc(pickLabel(pk))}</span><span class="b">Rookie draft pick</span></div><span class="num small"><b>${pickValue(pk)}</b></span></label>`).join("");
    return players + (pks ? `<details style="margin-top:8px"><summary>Draft picks (${picksOf(team.rid).length})</summary>${pks}</details>` : "");
  };
  const give = [...st.give], get = [...st.get];
  const plOnly = a => a.filter(k => !k.startsWith("pk:"));
  let result = `<div class="empty">Pick players or draft picks on both sides to compare.</div>`;
  if (give.length || get.length) {
    const ros = a => sum(plOnly(a).map(rosValue)), dyn = a => sum(a.map(assetValue)), lv = a => sum(plOnly(a).map(lockValue));
    const myIds = active(me), thIds = active(them);
    const myAfter = myIds.filter(id => !st.give.has(id)).concat(plOnly(get)), thAfter = thIds.filter(id => !st.get.has(id)).concat(plOnly(give));
    const myB = typicalLineup(myIds), myA = typicalLineup(myAfter), thB = typicalLineup(thIds), thA = typicalLineup(thAfter);
    const dRos = ros(get) - ros(give), dDyn = dyn(get) - dyn(give), dL = myA - myB;
    // Dynasty league: long-term value carries the most weight
    // Squash each side so one huge number can't drown out the other
    const nowScore = Math.tanh((dL / 6 + dRos / 150) / 2), dynScore = Math.tanh(dDyn / 40);
    const score = 0.4 * nowScore + 0.6 * dynScore;
    const verdict = score > 0.5 ? ["Strong win", "up"] : score > 0.12 ? ["Lean accept", "up"] : score > -0.12 ? ["Even swap", ""] : score > -0.5 ? ["Lean decline", "down"] : ["Hard pass", "down"];
    const lean = nowScore > 0.1 && dynScore < -0.1 ? "Helps you now, costs you long term." : nowScore < -0.1 && dynScore > 0.1 ? "Costs you this season, builds for the future." : "";
    const row = (k, a, b, d) => `<tr><td>${k}</td><td class="n">${a}</td><td class="n">${b}</td><td class="n ${d > 0 ? "up" : d < 0 ? "down" : ""}">${d > 0 ? "+" : ""}${f1(d)}</td></tr>`;
    result = `<div class="bar-lg" style="justify-content:space-between;flex-wrap:wrap;margin-bottom:6px"><span class="verdict ${verdict[1]}">${verdict[0]}</span><span class="muted small">for ${esc(me.name)}</span></div>
      ${lean ? `<div class="note info" style="margin-bottom:10px">${lean}</div>` : ""}
      <div class="tbl"><table><thead><tr><th></th><th class="n">You give</th><th class="n">You get</th><th class="n">Net</th></tr></thead><tbody>
      ${row("Dynasty value (players + picks)", f0(dyn(give)), f0(dyn(get)), dDyn)}
      ${row("Lock value per week", f1(lv(give)), f1(lv(get)), lv(get) - lv(give))}
      ${row("Rest of this season", f0(ros(give)), f0(ros(get)), dRos)}
      </tbody></table></div>
      <div class="summary" style="margin-top:12px"><div><span class="k">Your weekly total</span><span class="v">${f1(myB)} → ${f1(myA)}</span><span class="small ${dL >= 0 ? "up" : "down"}">${dL >= 0 ? "+" : ""}${f1(dL)}</span></div><div><span class="k">Their weekly total</span><span class="v">${f1(thB)} → ${f1(thA)}</span><span class="small ${thA - thB >= 0 ? "up" : "down"}">${thA - thB >= 0 ? "+" : ""}${f1(thA - thB)}</span></div></div>
      <p class="muted small" style="margin:10px 0 0">The verdict weighs dynasty value 60% and this season 40%. Dynasty value is 0–100 per player or pick. Weekly total = each team's best 9 lock values, so a 2-for-1 that clogs your bench shows up here. Pick values are estimates: next year's 1sts are worth more from teams that look weak now.</p>`;
  }
  const strength = {}; D.teams.forEach(t => (strength[t.rid] = groupStrength(t.rid)));
  const rank = (g, rid) => 1 + D.teams.filter(t => strength[t.rid][g] > strength[rid][g]).length;
  const myRanks = Object.fromEntries(Object.keys(GROUPS).map(g => [g, rank(g, D.me)])); const weak = Object.entries(myRanks).sort((a, b) => b[1] - a[1])[0][0];
  const startOf = ids => new Set(optimize(ids, id => (OUT.has(P[id].inj) ? null : lockValue(id))).lineup.map(x => x.id));
  const myStart = startOf(active(me));
  const myWorst = Math.min(...active(me).filter(id => myStart.has(id) && P[id].pos.some(x => GROUPS[weak].includes(x))).map(lockValue), 99);
  const ideas = [];
  others.forEach(t => { const ids = active(t); const start = startOf(ids);
    ids.filter(id => !start.has(id) && !OUT.has(P[id].inj) && P[id].pos.some(x => GROUPS[weak].includes(x)) && lockValue(id) > myWorst).forEach(id => ideas.push({ id, t }));
    if (rank(weak, t.rid) <= 3) ids.filter(id => start.has(id) && P[id].pos.some(x => GROUPS[weak].includes(x))).sort((a, b) => lockValue(a) - lockValue(b)).slice(0, 1).forEach(id => { if (lockValue(id) > myWorst && !ideas.find(x => x.id === id)) ideas.push({ id, t }); });
  });
  ideas.sort((a, b) => lockValue(b.id) - lockValue(a.id));
  const heat = D.teams.map(t => `<tr${t.rid === D.me ? ' class="swapin"' : ""}><td><div class="pl"><span class="a">${esc(t.name)}</span><span class="b">${esc(t.user)}</span></div></td>${Object.keys(GROUPS).map(g => { const r = rank(g, t.rid); const bg = r <= 4 ? "var(--good-bg)" : r >= 9 ? "var(--bad-bg)" : "transparent"; return `<td class="h" style="background:${bg}">${r}</td>`; }).join("")}</tr>`).join("");
  const opts = others.map(t => `<option value="${t.rid}" ${t.rid === st.partner ? "selected" : ""}>${esc(t.name)} (${esc(t.user)})</option>`).join("");
  return `
  <section class="panel"><div class="hd"><h2>Trade Analyzer</h2><span class="r">Numbers: lock value · <b>dynasty value</b></span></div><label class="small muted" for="partner">Trade partner</label><br><select class="sel" id="partner">${opts}</select></section>
  <div class="tradecols">
    <section class="panel"><div class="hd"><h3>You give</h3><span class="r">${esc(me.name)}</span></div>${pick(me, st.give, "give")}</section>
    <section class="panel"><div class="hd"><h3>You get</h3><span class="r">${esc(them.name)}</span></div>${pick(them, st.get, "get")}</section>
  </div>
  <section class="panel"><div class="hd"><h3>Result</h3>${give.length || get.length ? `<button class="btn" id="clearTrade" type="button" style="margin-left:auto">Clear</button>` : ""}</div>${result}</section>
  <div class="grid2">
    <section class="panel"><div class="hd"><h3>Trade targets</h3><span class="r">Your weakest spot: ${weak === "G" ? "guards" : weak === "F" ? "forwards" : "centers"} (rank ${myRanks[weak]} of ${D.teams.length})</span></div>
      ${ideas.length ? `<div class="tbl"><table><tbody>${ideas.slice(0, 8).map(x => `<tr><td>${plCell(x.id, x.t, null)}</td><td class="muted small">${esc(x.t.name)}</td><td class="n score">${f1(lockValue(x.id))}</td><td class="n">${dv(x.id)}</td></tr>`).join("")}</tbody></table></div>` : `<div class="empty">No obvious targets right now.</div>`}</section>
    <section class="panel"><div class="hd"><h3>Positional rank by team</h3><span class="r">1 = deepest</span></div><div class="tbl"><table class="heat"><thead><tr><th>Team</th><th style="text-align:center">G</th><th style="text-align:center">F</th><th style="text-align:center">C</th></tr></thead><tbody>${heat}</tbody></table></div></section>
  </div>`;
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
const VIEWS = { lock: viewLock, lineup: viewLineup, team: viewTeam, matchup: viewMatchup, waivers: viewWaivers, trade: viewTrade, dynasty: viewDynasty, league: viewLeague };
function currentView() { const h = (location.hash || "").slice(1); return VIEWS[h] ? h : "lock"; }
function render() {
  if (!D) return; const v = currentView();
  document.querySelectorAll("#tabs a").forEach(a => a.classList.toggle("on", a.dataset.v === v));
  try { document.getElementById("view").innerHTML = VIEWS[v](); }
  catch (e) { console.error(e); document.getElementById("view").innerHTML = `<div class="panel empty">This tab hit an error: ${esc(e.message)}</div>`; }
}
window.addEventListener("hashchange", render);
document.addEventListener("click", e => {
  const t = e.target.closest("[data-day],[data-pos],[data-sort],[data-k],[data-mark],[data-unmark],#clearTrade,#refresh"); if (!t) return;
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
    D = body; P = D.players; TEAMS = Object.fromEntries(D.teams.map(t => [t.rid, t])); DV = null;
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
