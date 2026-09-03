import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { closePool, query } from '../src/db.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

try {
  const sql = await readFile(resolve(root, 'database/001_schema.sql'), 'utf8');
  await query(sql);
  console.log('Schema aplicado com sucesso.');
} finally {
  await closePool();
}

