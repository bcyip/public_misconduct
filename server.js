// Public Misconduct Page - minimal, read-only, no authentication.
// Deliberately kept as small as possible: one endpoint, one query, no
// session/OAuth logic at all, since nothing here should ever require
// login. Meant to be embedded (e.g. via <iframe>) on the public website.
//
// Required environment variables:
//   DATABASE_URL - same shared matchday/admin console Postgres database
//                   (read-only access is all this app ever needs)
//   PORT          - defaults to 3000 if not set
//
// PRIVACY: only Red Card suspensions are shown - not Yellow Cards, not
// committee notes, not who reviewed it, not incident report text, not
// referee-pay/MO-report/forfeit admin bookkeeping. See the query below
// for the exact column list - nothing outside it is ever selected.

const http = require('http');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
pool.on('error', (err) => {
  console.error('[postgres] Unexpected error on idle client - code:', err.code, '- message:', err.message);
});

const INDEX_HTML = require('fs').readFileSync(__dirname + '/index.html', 'utf8');

// Same games_served computation and effective-required-games logic used
// in the admin console, capped at the requirement so it stops climbing
// once satisfied (see prior fix in that app for why the cap matters).
const SUSPENSIONS_QUERY = `
  SELECT
    ms.game_date,
    ms.gender,
    e.team_name,
    e.name AS player_name,
    e.reason,
    s.games_suspended,
    s.standard_games,
    COALESCE(r.status, 'pending') AS review_status,
    LEAST(
      (SELECT COUNT(*) FROM match_report_scores mrs2
       WHERE (mrs2.team1_id = s.team_id OR mrs2.team2_id = s.team_id)
       AND mrs2.game_date > s.issued_from_game_date
       AND mrs2.game_date < now()),
      COALESCE(s.games_suspended, s.standard_games)
    ) AS games_served
  FROM suspensions s
  JOIN match_report_entries e ON e.id = s.entry_id
  LEFT JOIN match_report_scores ms ON ms.game_id = e.game_id
  LEFT JOIN misconduct_reviews r ON r.entry_id = s.entry_id
  WHERE e.event_type = 'Red Card'
    AND (r.status IS NULL OR r.status IN ('pending', 'reviewed'))
  ORDER BY ms.game_date DESC NULLS LAST
`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/api/suspensions') {
    try {
      const result = await pool.query(SUSPENSIONS_QUERY);
      const suspensions = result.rows.map(r => {
        const required = r.games_suspended != null ? r.games_suspended : r.standard_games;
        return {
          gameDate: r.game_date,
          gender: r.gender,
          teamName: r.team_name,
          playerName: r.player_name,
          reason: r.reason,
          gamesRequired: required,
          gamesServed: r.games_served,
          reviewStatus: r.review_status, // 'pending' | 'reviewed'
        };
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ suspensions }));
    } catch (err) {
      console.error('[api/suspensions] Error - code:', err.code, '- message:', err.message, '- full:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to load suspensions.' }));
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(INDEX_HTML);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.listen(PORT, () => console.log(`Public misconduct page listening on port ${PORT}`));
