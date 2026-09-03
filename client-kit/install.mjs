import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const KIT_DIR = dirname(fileURLToPath(import.meta.url));
const CLAUDE_DIR = resolve(homedir(), '.claude');
const HOOKS_DIR = resolve(CLAUDE_DIR, 'hooks');
const SKILLS_DIR = resolve(CLAUDE_DIR, 'skills');
const LYNSE_DIR = resolve(CLAUDE_DIR, 'lynse');
const SETTINGS_PATH = resolve(CLAUDE_DIR, 'settings.json');
const CLAUDE_MD_PATH = resolve(CLAUDE_DIR, 'CLAUDE.md');
const ENV_PATH = resolve(LYNSE_DIR, '.env');

const HOOK_FILES = ['lynse-cli.mjs', 'lynse-hook.mjs', 'lynse-env.mjs', 'lynse-state.mjs', 'redact.mjs'];
const SKILL_NAMES = ['lynse-start', 'lynse-approve', 'lynse-status', 'lynse-finish'];
const HOOK_EVENTS = [
  'SessionStart', 'UserPromptSubmit', 'UserPromptExpansion', 'PreToolUse', 'PostToolUse',
  'PostToolUseFailure', 'InstructionsLoaded', 'SubagentStart', 'SubagentStop',
  'TaskCreated', 'TaskCompleted', 'Stop', 'SessionEnd',
];

async function ensureDir(dir) {
  await mkdir(dir, { recursive: true });
}

async function copyHooks() {
  await ensureDir(HOOKS_DIR);
  for (const file of HOOK_FILES) {
    await copyFile(join(KIT_DIR, 'hooks', file), join(HOOKS_DIR, file));
  }
  console.log(`OK  hooks copiados para ${HOOKS_DIR}`);
}

async function copySkills() {
  for (const name of SKILL_NAMES) {
    const dest = join(SKILLS_DIR, name);
    await ensureDir(dest);
    await copyFile(join(KIT_DIR, 'skills', name, 'SKILL.md'), join(dest, 'SKILL.md'));
  }
  console.log(`OK  skills copiados para ${SKILLS_DIR}`);
}

function lynseHookEntry() {
  return { type: 'command', command: 'node', args: [join(HOOKS_DIR, 'lynse-hook.mjs')] };
}

function isLynseHookEntry(entry) {
  return entry?.type === 'command' && typeof entry.args?.[0] === 'string' && entry.args[0].includes('lynse-hook.mjs');
}

async function mergeSettings() {
  let settings = {};
  if (existsSync(SETTINGS_PATH)) {
    try {
      settings = JSON.parse(await readFile(SETTINGS_PATH, 'utf8'));
    } catch {
      throw new Error(`${SETTINGS_PATH} existe mas não é um JSON valido -- corrija manualmente e rode de novo.`);
    }
  }
  settings.hooks ??= {};
  for (const event of HOOK_EVENTS) {
    settings.hooks[event] ??= [];
    const already = settings.hooks[event].some((group) => (group.hooks ?? []).some(isLynseHookEntry));
    if (!already) settings.hooks[event].push({ hooks: [lynseHookEntry()] });
  }
  await writeFile(SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`);
  console.log(`OK  ${SETTINGS_PATH} atualizado (mesclado -- nada existente foi removido)`);
}

async function mergeClaudeMd() {
  const snippet = await readFile(join(KIT_DIR, 'CLAUDE.md.snippet'), 'utf8');
  let existing = '';
  if (existsSync(CLAUDE_MD_PATH)) existing = await readFile(CLAUDE_MD_PATH, 'utf8');
  if (existing.includes('## Operação Lynse')) {
    console.log('OK  CLAUDE.md já contém a seção da Operação Lynse -- nada mudou');
    return;
  }
  const merged = existing.trim().length ? `${existing.trim()}\n\n${snippet}` : snippet;
  await writeFile(CLAUDE_MD_PATH, merged);
  console.log(`OK  ${CLAUDE_MD_PATH} atualizado`);
}

async function ensureEnvFile() {
  await ensureDir(LYNSE_DIR);
  if (existsSync(ENV_PATH)) {
    console.log(`OK  ${ENV_PATH} já existe -- não sobrescrito`);
    return;
  }
  await copyFile(join(KIT_DIR, 'lynse.env.example'), ENV_PATH);
  console.log(`OK  ${ENV_PATH} criado -- edite e cole sua LYNSE_API_KEY pessoal`);
}

await copyHooks();
await copySkills();
await mergeSettings();
await mergeClaudeMd();
await ensureEnvFile();

console.log('\nInstalação concluída.');
console.log(`Próximo passo: edite ${ENV_PATH} com sua LYNSE_API_KEY pessoal, reabra o Claude Code e rode /lynse-start <US-ID> em qualquer repositório.`);
