import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { loadEnv } from '../config/env.js';
import { sha256 } from '../lib/hash.js';

// why: only the hash is stored; the plaintext key is printed once here and
// never recoverable afterward — the same model as GitHub/Stripe tokens.
function parseArgs(argv) {
  const args = { name: 'default', rpm: 60 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--name') args.name = argv[++i];
    else if (argv[i] === '--rpm') args.rpm = Number.parseInt(argv[++i], 10);
  }
  if (!Number.isInteger(args.rpm) || args.rpm <= 0) {
    throw new Error('--rpm must be a positive integer');
  }
  return args;
}

async function main() {
  const config = loadEnv();
  const { name, rpm } = parseArgs(process.argv.slice(2));

  // why: jns_ prefix makes keys greppable/identifiable; base64url is URL-safe.
  const token = `jns_${randomBytes(32).toString('base64url')}`;
  const keyHash = sha256(token);

  const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
  try {
    const { rows } = await pool.query(
      `INSERT INTO api_keys (name, key_hash, rate_limit_rpm)
       VALUES ($1, $2, $3)
       RETURNING id, name, rate_limit_rpm, created_at`,
      [name, keyHash, rpm],
    );
    const key = rows[0];
    console.log(
      '\nAPI key created — store it now, it will NOT be shown again:\n',
    );
    console.log(`  ${token}\n`);
    console.log(`  id:   ${key.id}`);
    console.log(`  name: ${key.name}`);
    console.log(`  rpm:  ${key.rate_limit_rpm}\n`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('failed to mint key:', err.message);
  process.exit(1);
});
