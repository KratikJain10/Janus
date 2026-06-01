import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';
import { loadEnv } from '../config/env.js';

// why: a tiny forward-only migrator — apply every *.sql in migrations/ once, in
// filename order, tracked in schema_migrations. No rollback (intentionally simple).
const config = loadEnv();
const migrationsDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'migrations',
);

async function main() {
  const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
  try {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         filename   text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );

    const files = (await readdir(migrationsDir))
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      const { rows } = await pool.query(
        'SELECT 1 FROM schema_migrations WHERE filename = $1',
        [file],
      );
      if (rows.length > 0) {
        console.log(`skip    ${file} (already applied)`);
        continue;
      }

      const sql = await readFile(path.join(migrationsDir, file), 'utf8');
      const client = await pool.connect();
      try {
        // why: each migration runs in a transaction so a failure leaves no
        // half-applied schema.
        await client.query('BEGIN');
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (filename) VALUES ($1)',
          [file],
        );
        await client.query('COMMIT');
        console.log(`applied ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    }

    console.log('migrations complete');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('migration failed:', err.message);
  process.exit(1);
});
