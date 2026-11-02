# Court Report

Fantasy basketball command center for Andrew's Sleeper league (BFBA, league id `1408273089707417600`, 12 teams). It's a **dynasty** league (Sleeper `settings.type` 2): rosters carry over every year, rookie picks are tradable three drafts out, 2 IR slots, a 3-man taxi squad for rookies only. Ignore the leftover `max_keepers` setting; it isn't a keeper league. Built for one user (Andrew), used on phone and laptop. Think "FantasyPros, but for this one league."

## The league format matters: Sleeper NBA Lock-In
- Weekly head-to-head points. Weeks run Monday to Sunday.
- Each of the 9 starting slots (PG, SG, G, SF, PF, F, C, UTIL, UTIL) counts **one game per week**, not every game.
- After a player's game ends, you can lock that game's score. You must do it before his next game tips, and he must be in your starting lineup that day.
- Locks can't be undone. A locked player stays in his slot for the rest of the week.
- If a player is never locked, his **last game of the week** counts, even if it's bad.
- So: daily lineups only matter for which games are lock-eligible, and player value is about ceiling and number of chances, not just averages.
- Scoring (from the league): pts 0.5, 3PM 0.5, reb 1, ast 1, stl 2, blk 2, TO -1, double-double +2, triple-double +3, 40+ pts +2, 50+ pts +2, 20+ reb +2, 15+ ast +2, technical/flagrant -2.

## How it's built
- No framework and no build step. Static files at the root plus Vercel serverless functions in `api/`.
- `index.html`, `styles.css`, `app.js`: the whole front end. `app.js` fetches `/api/data` and renders one tab at a time (hash routes: `#lock`, `#lineup`, `#team`, `#matchup`, `#waivers`, `#trade`, `#dynasty`, `#league`).
- `api/data.js` → `lib/build.js`: pulls Sleeper + ESPN and returns one JSON payload. Vercel's CDN caches it for 60 seconds.
- `lib/config.js`: league id and Andrew's Sleeper user id (`998451229829328896`). Env vars `SLEEPER_LEAGUE_ID` / `SLEEPER_USER_ID` override.
- Design: dark "arena scoreboard" look, dense stat tables. Colors and fonts are tokens at the top of `styles.css`; reuse them instead of adding new literal colors.

## Data sources (all public, no keys)
- `api.sleeper.app/v1/league/{id}`, `/users`, `/rosters`, `/matchups/{week}`, `/state/nba`, `/players/nba` (2.5 MB, cached 6h in memory).
- `api.sleeper.com/stats/nba/{season}/{week}?season_type=regular`: one row per player per game (has `date`, `opponent`, full box score).
- `api.sleeper.com/projections/nba/{season}/{week}?season_type=regular`: per-game projections for the week. Without `/{week}`: preseason per-game projections plus `adp_dynasty`.
- `api.sleeper.com/schedule/nba/regular/{season}`: every game with `week` and `date`.
- ESPN scoreboard (`site.api.espn.com/.../scoreboard?dates=YYYYMMDD`): tip times and live game state. ESPN team codes differ (GS, NY, NO, SA, UTAH, WSH); `lib/build.js` maps them.

## Key logic (in app.js)
- **Player value** (`val`, computed server-side): preseason projection shrunk toward season average (5-game prior), then tilted up to 40% toward the last 14 days. `sd` is game-to-game spread.
- **Lock or Pass** (`lockCall`): compares the latest finished game's score with the value of waiting, computed by backward induction over his remaining games (last game must count). Leans toward locking when win chance > 70%, toward passing when < 35%.
- **Lock detection** (`lockState`): Sleeper's public API has no lock flag. In Lock-In, `players_points` in the matchup is the game that currently counts. If it matches an earlier game rather than the latest, the player is locked. Locks on the latest game can't be told apart, so the user can tap "I locked him" (saved in localStorage).
- **Daily lineup** (`startValue`): fills open slots with players whose game today is worth the most as a lock option, plus anyone playing his last game of the week.
- **Lineup optimizer**: Hungarian algorithm over slot eligibility (G = PG/SG, F = SF/PF, UTIL = anyone).
- **Lock value** (`lockValue`): avg + 0.85 × sd, roughly the best of ~3.5 games. Used for waivers, trades, power rankings.
- **Dynasty value** (`dv`, 0–100): percentile among all rostered players, 55% age-adjusted lock value (steep age curve, `ageMult`) and 45% Sleeper dynasty ADP. Used in the Dynasty tab, trades, waivers, My Team.
- **Draft picks** (`pickValue`): on the same 0–100 scale. Next year's picks scale with how weak the original team's roster looks now; later years are flat and discounted 10% a year. Pick ownership comes from `/league/{id}/traded_picks` (`lib/build.js` → `futurePicks`).
- **Trade verdict**: 60% dynasty value change, 40% this-season change (weekly lineup total and rest-of-season points), each squashed with tanh so neither side dominates.
- **My Team** (`viewTeam`): starters as set in Sleeper, bench, IR (flags players healthy enough that Sleeper will force a move), taxi (flags rookies clearly better than your weakest bench player).

## Working on it
- Run locally: `npx vercel dev` (first time: `npx vercel link`). Then open http://localhost:3000.
- Quick data check: `npm run check`.
- Deploys happen automatically when you push to `main` on GitHub.
- Keep the page fast on a phone: no heavy libraries, and keep the payload small.
- League nicknames come from Sleeper roster metadata. Show them as-is; they're the league's own.
