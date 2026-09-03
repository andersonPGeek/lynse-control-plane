import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

const STATE_DIR = resolve(homedir(), '.claude', 'lynse', 'state');

function stateFilePath(identity) {
  const hash = createHash('sha256').update(identity).digest('hex').slice(0, 20);
  return resolve(STATE_DIR, `${hash}.json`);
}

export async function readState(identity) {
  try {
    return JSON.parse(await readFile(stateFilePath(identity), 'utf8'));
  } catch {
    return null;
  }
}

export async function saveState(identity, state) {
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(stateFilePath(identity), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}
