const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3001;
const MLB_BASE = 'https://statsapi.mlb.com/api/v1';

app.use(cors());
app.use(express.json());

async function mlbFetch(path) {
  const res = await fetch(`${MLB_BASE}${path}`);
  if (!res.ok) throw new Error(`MLB API error ${res.status}: ${path}`);
  return res.json();
}

app.get('/api/teams', async (req, res) => {
  try {
    const { season = 2025 } = req.query;
    const data = await mlbFetch(`/teams?sportId=1&season=${season}`);
    const teams = data.teams
      .filter(t => t.active)
      .map(t => ({ id: t.id, name: t.name, abbreviation: t.abbreviation }))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json(teams);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/roster/:teamId', async (req, res) => {
  try {
    const { teamId } = req.params;
    const { season = 2025 } = req.query;
    const data = await mlbFetch(`/teams/${teamId}/roster?rosterType=active&season=${season}&hydrate=person`);
    const pitchers = (data.roster || [])
      .filter(p => p.position?.code === 'P')
      .map(p => ({ id: p.person.id, name: p.person.fullName }))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json(pitchers);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/pitcher/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { season = 2025 } = req.query;
    const data = await mlbFetch(`/people/${id}?hydrate=stats(group=pitching,type=season,season=${season})`);
    const person = data.people?.[0];
    if (!person) return res.status(404).json({ error: 'Pitcher not found' });
    const stat = person.stats?.[0]?.splits?.[0]?.stat || {};
    res.json({
      id: person.id,
      name: person.fullName,
      number: person.primaryNumber,
      throws: person.pitchHand?.description || 'R',
      position: person.primaryPosition?.name,
      era: stat.era || '—',
      whip: stat.whip || '—',
      k9: stat.strikeoutsPer9Inn ? parseFloat(stat.strikeoutsPer9Inn).toFixed(1) : '—',
      ip: stat.inningsPitched || '—',
      wins: stat.wins || 0,
      losses: stat.losses || 0,
      saves: stat.saves || 0,
      strikeouts: stat.strikeOuts || 0,
      bb: stat.baseOnBalls || 0,
      hits: stat.hits || 0,
      hr: stat.homeRuns || 0,
      batAvgAgainst: stat.avg || '—',
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/batters/:teamId', async (req, res) => {
  try {
    const { teamId } = req.params;
    const { season = 2025, hand = 'all' } = req.query;
    const rosterData = await mlbFetch(`/teams/${teamId}/roster?rosterType=active&season=${season}&hydrate=person`);
    const nonPitchers = (rosterData.roster || []).filter(p => p.position?.code !== 'P' && p.position?.code !== 'TWP');

    const batterStats = await Promise.allSettled(
      nonPitchers.map(async p => {
        const pid = p.person.id;
        const statData = await mlbFetch(`/people/${pid}?hydrate=stats(group=hitting,type=season,season=${season})`);
        const person = statData.people?.[0];
        const stat = person?.stats?.[0]?.splits?.[0]?.stat || {};
        const batSide = person?.batSide?.code || 'R';
        if (hand !== 'all' && batSide !== hand) return null;
        const avg = parseFloat(stat.avg) || 0;
        const obp = parseFloat(stat.obp) || 0;
        const slg = parseFloat(stat.slg) || 0;
        const kpct = stat.strikeOuts && stat.atBats ? stat.strikeOuts / stat.atBats : 0.22;
        const bbpct = stat.baseOnBalls && stat.atBats ? stat.baseOnBalls / stat.atBats : 0.08;
        const ops = parseFloat(stat.ops) || 0;
        const ab = parseInt(stat.atBats) || 0;
        return {
          id: pid,
          name: person?.fullName || p.person.fullName,
          position: p.position?.abbreviation || '?',
          hand: batSide,
          avg, obp, slg, ops,
          kpct: parseFloat(kpct.toFixed(3)),
          bbpct: parseFloat(bbpct.toFixed(3)),
          ab,
          hits: parseInt(stat.hits) || 0,
          hr: parseInt(stat.homeRuns) || 0,
          rbi: parseInt(stat.rbi) || 0,
        };
      })
    );

    const batters = batterStats
      .filter(r => r.status === 'fulfilled' && r.value !== null)
      .map(r => r.value)
      .filter(b => b.ab > 0);
    res.json(batters);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/matchup', async (req, res) => {
  try {
    const { pitcherId, battingTeamId, season = 2025, hand = 'all' } = req.query;
    if (!pitcherId || !battingTeamId) return res.status(400).json({ error: 'pitcherId and battingTeamId are required' });

    const baseUrl = `http://localhost:${PORT}`;
    const [pitcher, batters] = await Promise.all([
      fetch(`${baseUrl}/api/pitcher/${pitcherId}?season=${season}`).then(r => r.json()),
      fetch(`${baseUrl}/api/batters/${battingTeamId}?season=${season}&hand=${hand}`).then(r => r.json()),
    ]);

    if (pitcher.error) return res.status(404).json({ error: pitcher.error });

    const pitcherEra = parseFloat(pitcher.era) || 4.0;
    const pitcherK9 = parseFloat(pitcher.k9) || 8.0;
    const pitcherWhip = parseFloat(pitcher.whip) || 1.3;
    const throwsRight = pitcher.throws === 'Right' || pitcher.throws === 'R';

    const scored = batters.map(b => {
      const platoonBonus = (throwsRight && b.hand === 'L') || (!throwsRight && b.hand === 'R') ? 0.04 : 0;
      const kFactor = pitcherK9 > 11 ? -0.05 : pitcherK9 > 9 ? -0.02 : 0.02;
      const eraFactor = pitcherEra < 2.5 ? -0.04 : pitcherEra < 3.5 ? -0.02 : pitcherEra > 4.5 ? 0.03 : 0;
      const whipFactor = pitcherWhip < 1.0 ? -0.03 : pitcherWhip > 1.4 ? 0.03 : 0;
      const base = b.avg * 0.35 + b.obp * 0.25 + b.slg * 0.15 + (1 - b.kpct) * 0.15 + b.bbpct * 0.10;
      const score = Math.min(0.99, Math.max(0.01, base + platoonBonus + kFactor + eraFactor + whipFactor));
      return { ...b, matchupScore: parseFloat(score.toFixed(3)) };
    });

    scored.sort((a, b) => b.matchupScore - a.matchupScore);
    res.json({ pitcher, batters: scored });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/health', (_, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

app.listen(PORT, () => console.log(`⚾ MLB Matchup proxy running on port ${PORT}`));
