// Bootstrap (or reset) a Super Manager login. Needed once, to create the very
// first manager — after that, managers create each other from the portal.
//
//   node scripts/create-super-manager.js --mobile 9999999999 --password "S3cret!" --name "Owner"
//
// If the mobile already exists, its password is reset and the account re-activated.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const bcrypt = require('bcryptjs');
const { executeQuery } = require('../config/database');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

(async () => {
  const mobile = String(arg('mobile') || '').trim();
  const password = String(arg('password') || '');
  const name = String(arg('name') || 'Super Manager').trim();
  if (!/^\d{10}$/.test(mobile) || password.length < 6) {
    console.error('Usage: node scripts/create-super-manager.js --mobile <10 digits> --password <min 6 chars> [--name "Name"]');
    process.exit(1);
  }
  const hash = await bcrypt.hash(password, 10);
  const existing = await executeQuery('SELECT SMID FROM SuperManagers WHERE Mobile=@mobile', { mobile });
  if (existing.length) {
    await executeQuery(
      'UPDATE SuperManagers SET PasswordHash=@hash, Name=@name, IsActive=1 WHERE SMID=@id',
      { hash, name, id: existing[0].SMID }
    );
    console.log(`✔ Super Manager #${existing[0].SMID} (${mobile}) password reset and activated.`);
  } else {
    const rows = await executeQuery(
      'INSERT INTO SuperManagers (Name, Mobile, PasswordHash, IsActive) OUTPUT INSERTED.SMID VALUES (@name, @mobile, @hash, 1)',
      { name, mobile, hash }
    );
    console.log(`✔ Super Manager #${rows[0].SMID} created for ${mobile}.`);
  }
  process.exit(0);
})().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});
