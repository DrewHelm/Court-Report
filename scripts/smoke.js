// Quick check that the data builder works: `npm run check`
import { buildData } from "../lib/build.js";
import { LEAGUE_ID, OWNER_ID } from "../lib/config.js";

const t = Date.now();
const d = await buildData({ leagueId: LEAGUE_ID, ownerId: OWNER_ID });
const me = d.teams.find(x => x.rid === d.me);
console.log(`Built in ${Date.now() - t}ms · week ${d.week} · ${Object.keys(d.players).length} players · ${d.games.length} games`);
console.log(`Your team: ${me?.name} (${me?.w}-${me?.l})`);
