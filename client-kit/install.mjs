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

const HOOK_FILES = ['lynse-cli.mjs', 'lynse-hook.mjs', 'lynse-env.mjs', 'lynse-state.mjs', 'lynse-turns.mjs', 'redact.mjs', 'policy-engine.mjs'];
// O agente aciona estas skills sozinho (início, status e conclusão); sem a permissão, cada uso
// pediria confirmação ao ABE. /lynse-approve continua só manual.
const SKILL_PERMISSIONS = ['Skill(lynse-start)', 'Skill(lynse-status)', 'Skill(lynse-finish)'];
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
  settings.permissions ??= {};
  settings.permissions.allow ??= [];
  for (const rule of SKILL_PERMISSIONS) if (!settings.permissions.allow.includes(rule)) settings.permissions.allow.push(rule);
  await writeFile(SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`);
  console.log(`OK  ${SETTINGS_PATH} atualizado (mesclado -- nada existente foi removido)`);
}

// Substitui a seção da Operação Lynse (entre os marcadores, ou a seção antiga sem marcadores) e
// preserva todo o resto do CLAUDE.md do desenvolvedor.
export function mergeLynseSection(existing, snippet) {
  const section = snippet.trim();
  const marked = /<!-- lynse:inicio[\s\S]*?<!-- lynse:fim -->/;
  if (marked.test(existing)) return existing.replace(marked, section);
  const legacy = existing.match(/^## Operação Lynse[\s\S]*?(?=^## (?!#)|(?![\s\S]))/m);
  if (legacy) return existing.replace(legacy[0], `${section}\n\n`).replace(/\n{3,}/g, '\n\n');
  return existing.trim().length ? `${existing.trim()}\n\n${section}\n` : `${section}\n`;
}

async function mergeClaudeMd() {
  const snippet = await readFile(join(KIT_DIR, 'CLAUDE.md.snippet'), 'utf8');
  const existing = existsSync(CLAUDE_MD_PATH) ? await readFile(CLAUDE_MD_PATH, 'utf8') : '';
  const merged = mergeLynseSection(existing, snippet);
  if (merged === existing) {
    console.log('OK  CLAUDE.md já está atualizado');
    return;
  }
  await writeFile(CLAUDE_MD_PATH, merged);
  console.log(`OK  ${CLAUDE_MD_PATH} atualizado (seção da Operação Lynse; o resto foi preservado)`);
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await copyHooks();
  await copySkills();
  await mergeSettings();
  await mergeClaudeMd();
  await ensureEnvFile();
  console.log('\nInstalação concluída.');
  console.log(`Próximo passo: edite ${ENV_PATH} com sua LYNSE_API_KEY pessoal (se ainda não fez) e reabra o Claude Code.`);
}
