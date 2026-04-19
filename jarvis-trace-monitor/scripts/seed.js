const fs = require('fs');
const path = require('path');
const db = require('../src/db');
const { ingestEvent } = require('../src/traceService');

const datasetPath = path.join(__dirname, 'seed-events.json');
const payload = JSON.parse(fs.readFileSync(datasetPath, 'utf8'));

db.prepare('DELETE FROM events').run();
for (const event of payload) {
  ingestEvent(event);
}

console.log(`[seed] ${payload.length} événements injectés`);
