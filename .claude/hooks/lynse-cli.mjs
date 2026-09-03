import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const statePath = resolve(root, '.claude/.lynse-state.json');
const baseUrl = process.env.LYNSE_API_URL ?? 'http://localhost:3333';
const apiKey = process.env.LYNSE_API_KEY ?? 'change-me-local';

async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(5_000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
  return result;
}

function git(args, fallback = null) {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      timeout: 2_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return fallback;
  }
}

async function readState() {
  try {
    return JSON.parse(await readFile(statePath, 'utf8'));
  } catch {
    throw new Error('Nenhuma execução ativa. Use /lynse-start <US-ID>.');
  }
}

async function saveState(state) {
  await mkdir(resolve(root, '.claude'), { recursive: true });
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

async function start(externalRef, sessionId) {
  if (!externalRef) throw new Error('Uso: /lynse-start <US-ID>');
  const result = await api('/api/v1/executions/start', {
    method: 'POST',
    body: {
      external_ref: externalRef,
      project_slug: process.env.LYNSE_PROJECT_SLUG ?? 'customer-portal',
      repository_slug: process.env.LYNSE_REPOSITORY_SLUG ?? 'customer-api',
      abe_email: process.env.LYNSE_ABE_EMAIL ?? 'anderson@lynse.ai',
      claude_session_id: sessionId || undefined,
      branch_name: git(['branch', '--show-current']),
      mode: process.env.LYNSE_MODE ?? 'audit',
      cwd: root,
      context_snapshot: {
        git_remote: git(['remote', 'get-url', 'origin']),
        head_sha: git(['rev-parse', 'HEAD']),
      },
    },
  });
  await saveState({
    active: true,
    execution_id: result.id,
    external_ref: result.external_ref,
    title: result.title,
    mode: result.mode,
    claude_session_id: sessionId || null,
    started_at: result.started_at,
  });
  return result;
}

async function status() {
  const state = await readState();
  return api(`/api/v1/executions/${state.execution_id}/summary`);
}

async function approve(rawArguments) {
  const state = await readState();
  const [gate, ...words] = rawArguments.trim().split(/\s+/);
  if (!['plan', 'pr', 'deploy', 'rollback', 'close'].includes(gate)) {
    throw new Error('Gate esperado: plan, pr, deploy, rollback ou close.');
  }
  const approval = await api('/api/v1/approvals', {
    method: 'POST',
    body: {
      execution_id: state.execution_id,
      abe_email: process.env.LYNSE_ABE_EMAIL ?? 'anderson@lynse.ai',
      gate,
      decision: 'approved',
      rationale: words.join(' ') || `Aprovado via /lynse-approve ${gate}`,
    },
  });
  const nextStage = { plan: 'building', pr: 'release', deploy: 'release', rollback: 'blocked' }[gate];
  if (!nextStage) return approval;
  const execution = await api(`/api/v1/executions/${state.execution_id}/status`, {
    method: 'PATCH',
    body: { status: nextStage },
  });
  return { approval, execution_status: execution.status };
}

async function finish() {
  const state = await readState();
  const result = await api(`/api/v1/executions/${state.execution_id}/complete`, { method: 'POST', body: {} });
  await saveState({ ...state, active: false, ended_at: result.ended_at });
  return result;
}

async function setStage(stage) {
  const state = await readState();
  return api(`/api/v1/executions/${state.execution_id}/status`, {
    method: 'PATCH',
    body: { status: stage },
  });
}

const [command, ...args] = process.argv.slice(2);

try {
  let result;
  if (command === 'start') result = await start(args[0], args[1]);
  else if (command === 'status') result = await status();
  else if (command === 'approve') result = await approve(args.join(' '));
  else if (command === 'finish') result = await finish();
  else if (command === 'stage') result = await setStage(args[0]);
  else throw new Error('Comando esperado: start, status, approve, stage ou finish.');
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`Lynse: ${error.message}\n`);
  process.exitCode = 1;
}
