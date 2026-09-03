import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { closePool, query } from '../src/db.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const databaseDir = resolve(root, 'database');

try {
  const files = (await readdir(databaseDir))
    .filter((name) => name.endsWith('.sql') && !name.includes('seed'))
    .sort();
  for (const file of files) {
    const sql = await readFile(resolve(databaseDir, file), 'utf8');
    await query(sql);
    console.log(`Aplicado: ${file}`);
  }
  console.log('Schema aplicado com sucesso.');
} finally {
  await closePool();
}

