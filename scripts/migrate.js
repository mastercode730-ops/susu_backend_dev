// Runs every migrations/*.sql file in name order against the DB in .env.
// Each file is split on lines containing only "GO" (SSMS batch separator).
//
//   node scripts/migrate.js
//
// All migrations are written to be idempotent, so re-running is safe.
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getPool } = require('../config/database');

(async () => {
  const dir = path.join(__dirname, '..', 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  console.log(`Target database: ${process.env.DB_DATABASE} @ ${process.env.DB_SERVER}`);
  const pool = await getPool();
  for (const file of files) {
    const sqlText = fs.readFileSync(path.join(dir, file), 'utf8');
    const batches = sqlText.split(/^\s*GO\s*$/im).map((b) => b.trim()).filter(Boolean);
    console.log(`▶ ${file} (${batches.length} batches)`);
    for (const batch of batches) {
      await pool.request().batch(batch);
    }
    console.log(`  ✔ ${file}`);
  }
  console.log('All migrations applied.');
  process.exit(0);
})().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
