import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { loadLynseEnv } from './lynse-env.mjs';
import { readState, saveState } from './lynse-state.mjs';
import { readSession } from './lynse-turns.mjs';

loadLynseEnv();

const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const baseUrl = process.env.LYNSE_API_URL ?? 'http://localhost:3333';
const apiKey = process.env.LYNSE_API_KEY ?? '';

async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(8_000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
  return result;
}

function git(args, fallback = null) {
  try {
    const out = execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      timeout: 2_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out || fallback;
  } catch {
    return fallback;
  }
}

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'repo';
}

function deriveRepoSlug(remote) {
  if (remote) {
    const name = remote.split(/[/:]/).pop()?.replace(/\.git$/, '');
    if (name) return slugify(name);
  }
  return slugify(basename(root));
}

function identityFor(remote) {
  return remote || root;
}

async function start(externalRef, sessionId) {
  if (!externalRef) throw new Error('Uso: /lynse-start <US-ID>');
  if (!apiKey) throw new Error('LYNSE_API_KEY não configurada. Edite ~/.claude/lynse/.env.');

  const remote = git(['remote', 'get-url', 'origin']);
  const repoSlug = process.env.LYNSE_REPOSITORY_SLUG || deriveRepoSlug(remote);
  const projectSlug = process.env.LYNSE_PROJECT_SLUG || repoSlug;

  const result = await api('/api/v1/executions/start', {
    method: 'POST',
    body: {
      external_ref: externalRef,
      project_slug: projectSlug,
      repository_slug: repoSlug,
      abe_email: process.env.LYNSE_ABE_EMAIL || undefined,
      claude_session_id: sessionId || undefined,
      branch_name: git(['branch', '--show-current']),
      mode: process.env.LYNSE_MODE ?? 'audit',
      context_snapshot: {
        git_remote_hash: remote ? createHash('sha256').update(remote).digest('hex') : null,
        head_sha: git(['rev-parse', 'HEAD']),
      },
    },
  });

  await saveState(identityFor(remote), {
    active: true,
    execution_id: result.id,
    external_ref: result.external_ref,
    title: result.title,
    mode: result.mode,
    claude_session_id: sessionId || null,
    started_at: result.started_at,
    project_root: root,
  });

  return result;
}

async function requireState() {
  const remote = git(['remote', 'get-url', 'origin']);
  const state = await readState(identityFor(remote));
  if (!state) throw new Error('Nenhuma execução ativa. Use /lynse-start <US-ID>.');
  return { state, remote };
}

async function status() {
  const { state } = await requireState();
  return api(`/api/v1/executions/${state.execution_id}/summary`);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// /lynse-approve <gate> [justificativa]: o próprio comando digitado pelo ABE é a evidência.
// Quando o hook registrou o prompt atual, a aprovação fica ligada a ele.
async function approve(sessionId, rawArguments) {
  const { state } = await requireState();
  const [gate, ...words] = String(rawArguments ?? '').trim().split(/\s+/);
  if (!['plan', 'pr', 'deploy', 'rollback', 'close'].includes(gate)) {
    throw new Error('Gate esperado: plan, pr, deploy, rollback ou close.');
  }
  const session = sessionId ? await readSession(sessionId) : null;
  return api('/api/v1/approvals', {
    method: 'POST',
    body: {
      execution_id: state.execution_id,
      abe_email: process.env.LYNSE_ABE_EMAIL || undefined,
      gate,
      decision: 'approved',
      evidence: 'comando',
      turn_key: session?.turn?.turn_key,
      rationale: words.join(' ') || `Aprovado via /lynse-approve ${gate}`,
    },
  });
}

// /lynse-finish [id]: sem argumento conclui a US ativa deste repositório; com o id de uma execução
// (ex.: a que foi marcada como inconsistente ao iniciar outra) conclui aquela. Nunca é recusado:
// evidência faltante vira inconsistência no Control Plane.
async function finish(target) {
  const remote = git(['remote', 'get-url', 'origin']);
  const state = await readState(identityFor(remote));
  const id = UUID.test(String(target ?? '').trim()) ? String(target).trim() : state?.execution_id;
  if (!id) throw new Error('Nenhuma execução ativa neste repositório. Informe o id da execução: /lynse-finish <id>.');
  const result = await api(`/api/v1/executions/${id}/complete`, { method: 'POST', body: {} });
  if (state && state.execution_id === id) {
    await saveState(identityFor(remote), { ...state, active: false, ended_at: result.ended_at });
  }
  return result;
}

async function setStage(stage) {
  const { state } = await requireState();
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
  else if (command === 'approve') result = UUID.test(args[0] ?? '') || /^[0-9a-f-]{20,}$/i.test(args[0] ?? '')
    ? await approve(args[0], args.slice(1).join(' '))
    : await approve(null, args.join(' '));
  else if (command === 'finish') result = await finish(args[0]);
  else if (command === 'stage') result = await setStage(args[0]);
  else throw new Error('Comando esperado: start, status, approve, stage ou finish.');
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`Lynse: ${error.message}\n`);
  process.exitCode = 1;
}
