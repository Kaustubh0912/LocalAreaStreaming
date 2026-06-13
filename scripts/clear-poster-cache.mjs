import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const dbPaths = [
  path.join(root, 'data', 'db.json'),
  path.join(root, 'server', 'data', 'db.json'),
];

let cleared = 0;

for (const dbPath of dbPaths) {
  if (!fs.existsSync(dbPath)) continue;

  const raw = fs.readFileSync(dbPath, 'utf8');
  const db = JSON.parse(raw || '{}');
  const count = db.posters && typeof db.posters === 'object' ? Object.keys(db.posters).length : 0;
  db.posters = {};
  fs.writeFileSync(dbPath, `${JSON.stringify(db, null, 2)}\n`);
  cleared += count;
  console.log(`Cleared ${count} poster cache entries from ${path.relative(root, dbPath)}`);
}

if (cleared === 0) {
  console.log('No poster cache entries found.');
}
