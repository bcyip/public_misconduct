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

const INDEX_HTML = require('fs').readFileSync(__dirname + '/index.html', 'utf8');

// Same games_served computation and effective-required-games logic used
// in the admin console, capped at the requirement so it stops climbing
// once satisfied (see prior fix in that app for why the cap matters).
const SUSPENSIONS_QUERY = `
  SELECT
    e.name AS player_name,
    e.team_name,
    s.games_suspended,
    s.standard_games,
    LEAST(
      (SELECT COUNT(*) FROM match_report_scores mrs2
       WHERE (mrs2.team1_id = s.team_id OR mrs2.team2_id = s.team_id)
       AND mrs2.game_date > s.issued_from_game_date
       AND mrs2.game_date < now()),
      COALESCE(s.games_suspended, s.standard_games)
    ) AS games_served
  FROM suspensions s
  JOIN match_report_entries e ON e.id = s.entry_id
  LEFT JOIN misconduct_reviews r ON r.entry_id = s.entry_id
  WHERE e.event_type = 'Red Card'
    AND (r.status IS NULL OR r.status IN ('pending', 'reviewed'))
  ORDER BY e.name ASC
`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/api/suspensions') {
    try {
      const result = await pool.query(SUSPENSIONS_QUERY);
      const suspensions = result.rows.map(r => {
        const required = r.games_suspended != null ? r.games_suspended : r.standard_games;
        return {
          playerName: r.player_name,
          teamName: r.team_name,
          gamesRequired: required,
          gamesServed: r.games_served,
          eligible: r.games_served >= required,
        };
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ suspensions }));
    } catch (err) {
      console.error('[api/suspensions] Error:', err.message);
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
