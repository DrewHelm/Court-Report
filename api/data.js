import { buildData } from "../lib/build.js";
import { LEAGUE_ID, OWNER_ID } from "../lib/config.js";

export default async function handler(req, res) {
  try {
    const data = await buildData({ leagueId: LEAGUE_ID, ownerId: OWNER_ID });
    // Vercel's CDN keeps a copy for 60s and serves a slightly stale one while it rebuilds
    res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=300");
    res.status(200).json(data);
  } catch (e) {
    console.error(e);
    res.status(502).json({ error: "Couldn't reach Sleeper right now. Try again in a minute.", detail: e.message });
  }
}
