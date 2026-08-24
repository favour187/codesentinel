// DEMO FIXTURE — minimal stub so the fixture parses as a coherent module graph.
const { DB_CONFIG } = require('./config');

async function raw(query) {
  console.log('[demo-db] executing', query, 'against', DB_CONFIG.host);
  return [];
}

module.exports = { raw, config: DB_CONFIG };
