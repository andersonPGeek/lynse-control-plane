import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { loadLynseEnv } from './lynse-env.mjs';
import { readState, saveState } from './lynse-state.mjs';
import { evaluatePolicy } from './policy-engine.mjs';
import { classifyText, redactSecrets, sha256 } from './redact.mjs';
import {
  appendTurnLog, buildTurnPayload, countEditLines, EDIT_TOOLS, fileKey, fileSize, insideProject,
  readSession, readTranscriptSegment, removeTurnLog, saveSession,
} from './lynse-turns.mjs';

// Regra de ouro: este hook NUNCA atrapalha o trabalho do ABE por causa do processo. Qualquer falha
// (Control Plane fora do ar, estado local ausente, transcript ilegível) é engolida em silêncio.
// O único bloqueio possível é o da Policy Engine (segurança), e só em modo enforcement.

loadLynseEnv();

const API_URL = process.env.LYNSE_API_URL ?? 'http://localhost:3333';
const API_KEY = process.env.LYNSE_API_KEY ?? '';

async function stdinJson() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

function projectRoot(input) {
  return process.env.CLAUDE_PROJECT_DIR ?? input.cwd ?? process.cwd();
}

function git(args, cwd) {
  try {
    const out = execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: 2_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

async function api(path, body, { method = 'POST', timeout = 4_000 } = {}) {
  const response = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-api-key': API_KEY,
    },
    body: method === 'GET' ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error ?? `Control Plane respondeu ${response.status}`);
  return result;
}
const quiet = (promise) => promise.catch(() => null);

function capture(value, mode, allowPreview = true) {
  const raw = typeof value === 'string' ? value : JSON.stringify(value ?? {});
  if (mode === 'full') {
    const redacted = redactSecrets(raw);
    return {
      sha256: sha256(raw),
      length: raw.length,
      redacted_categories: redacted.categories,
      redacted_content: redacted.text.slice(0, 20_000),
      truncated: redacted.text.length > 20_000,
    };
  }
  const classified = classifyText(raw);
  if (mode === 'metadata' || !allowPreview) delete classified.redacted_preview;
  return classified;
}

function diffSnapshot(cwd) {
  try {
    const raw = execFileSync('git', ['diff', '--numstat', '--no-ext-diff'], {
      cwd,
      encoding: 'utf8',
      timeout: 2_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const files = raw.trim().split('\n').filter(Boolean).map((line) => {
      const [added, deleted, ...file] = line.split('\t');
      return { file: file.join('\t'), added: Number(added) || 0, deleted: Number(deleted) || 0 };
    });
    return {
      files: files.length,
      added: files.reduce((sum, file) => sum + file.added, 0),
      deleted: files.reduce((sum, file) => sum + file.deleted, 0),
    };
  } catch {
    return null;
  }
}

function eventPayload(input, captureMode) {
  const payload = {
    hook_event_name: input.hook_event_name,
    permission_mode: input.permission_mode,
    tool_use_id: input.tool_use_id,
    agent_id: input.agent_id,
    agent_type: input.agent_type,
    task_id: input.task_id,
    source: input.source,
  };
  if (input.prompt !== undefined) payload.prompt = capture(input.prompt, captureMode);
  if (input.tool_input !== undefined) payload.tool_input = capture(input.tool_input, captureMode);
  if (input.tool_response !== undefined) payload.tool_response = capture(input.tool_response, captureMode, false);
  if (input.error !== undefined) payload.error = capture(input.error, captureMode, false);
  if (['PostToolUse', 'PostToolUseFailure'].includes(input.hook_event_name)) {
    payload.diff = diffSnapshot(input.cwd ?? process.cwd());
  }
  return Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined));
}

function denyOutput(eventName, reason) {
  if (eventName === 'UserPromptSubmit') return { decision: 'block', reason };
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

function askOutput(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
      permissionDecisionReason: reason,
    },
  };
}

// ---------- Início de sessão: sincroniza com o Control Plane ----------

async function syncAtSessionStart(identity, state, remote, root) {
  const params = new URLSearchParams();
  if (remote) params.set('repository_hash', sha256(remote));
  const ctx = await api(`/api/v1/me/context?${params}`, null, { method: 'GET', timeout: 4_000 });
  if (ctx.available !== true) return null;
  const a = ctx.active;
  const lines = [];
  if (a && a.same_repository) {
    if (!state?.active || state.execution_id !== a.id) {
      await saveState(identity, {
        active: true, execution_id: a.id, external_ref: a.external_ref, title: a.title, mode: a.mode,
        started_at: a.started_at, project_root: root, synced_from_server: true,
      });
    }
    lines.push(`Operação Lynse: a User Story ${a.external_ref}${a.title && a.title !== a.external_ref ? ` (${a.title})` : ''} está ativa neste repositório; o trabalho desta sessão será registrado nela.`
      + ' Se o ABE pedir algo de outra User Story, confirme com ele e rode /lynse-start <ID>.');
    if (a.stale) lines.push(`Ela está aberta há ${a.hours_open}h (o esperado é concluir no mesmo dia). Pergunte ao ABE, uma vez, se já pode ser concluída (/lynse-finish).`);
  } else {
    if (state?.active) await saveState(identity, { ...state, active: false, cleared_at: new Date().toISOString() });
    if (a) {
      lines.push(`Operação Lynse: a User Story ativa do ABE é ${a.external_ref}, em outro repositório (${a.project_slug}).`
        + ' Se o trabalho aqui for de outra US, pergunte o ID ao ABE e rode /lynse-start <ID>.');
    } else {
      lines.push('Operação Lynse: não há User Story ativa. Quando o ABE pedir uma alteração de código, pergunte uma vez qual é a User Story e rode /lynse-start <ID>.'
        + ' Nunca invente o ID e nunca deixe de atender o pedido por causa disso.');
    }
  }
  return lines.join(' ');
}

// ---------- Turnos (um por prompt do ABE) ----------

async function sendTurn(sessionId, session, turn, endOffset, ended) {
  const repoState = await readState(turn.identity);
  const executionId = turn.execution_id ?? (repoState?.active ? repoState.execution_id : null);
  const history = session.files?.[executionId ?? 'sem_us'] ?? [];
  const { payload, approvals, files } = buildTurnPayload({ sessionId, turn, history, executionId, endOffset, ended });
  await api('/api/v1/turns', payload, { timeout: 3_000 });
  for (const gate of executionId ? approvals : []) {
    await quiet(api('/api/v1/approvals', {
      execution_id: executionId, gate, decision: 'approved', evidence: 'turno_abe', turn_key: turn.turn_key,
      rationale: `Aprovado pelo ABE em linguagem natural (prompt ${turn.seq} da sessão)`,
    }, { timeout: 3_000 }));
  }
  return { executionId, files };
}

function mergeHistory(session, executionId, files) {
  const key = executionId ?? 'sem_us';
  session.files ??= {};
  session.files[key] = [...new Set([...(session.files[key] ?? []), ...files])].slice(-2000);
}

async function onPromptSubmit(input, identity, state) {
  const sessionId = input.session_id;
  const session = (await readSession(sessionId)) ?? { seq: 0, files: {} };
  const size = fileSize(input.transcript_path);

  // Fecha o turno anterior (de novo, se o transcript cresceu depois do Stop) e arquiva seus arquivos.
  const prev = session.turn;
  if (prev) {
    const grew = !prev.finalized_at || readTranscriptSegment(prev.transcript_path, prev.final_offset ?? 0, size).has_assistant;
    if (grew) {
      const sent = await quiet(sendTurn(sessionId, session, prev, size, true));
      if (sent) mergeHistory(session, sent.executionId, sent.files);
    } else if (prev.files) {
      mergeHistory(session, prev.sent_execution_id ?? null, prev.files);
    }
    removeTurnLog(sessionId, prev.turn_key);
  }

  const prompt = String(input.prompt ?? '');
  session.seq = (session.seq ?? 0) + 1;
  session.turn = {
    turn_key: randomUUID(),
    seq: session.seq,
    identity,
    started_at: new Date().toISOString(),
    prompt_hash: sha256(prompt),
    prompt_kind: prompt.trim().startsWith('/') ? 'comando' : 'prompt',
    transcript_path: input.transcript_path ?? null,
    offset: size,
    execution_id: state?.active ? state.execution_id : null,
  };
  await saveSession(sessionId, session);
  await quiet(api('/api/v1/turns', {
    turn_key: session.turn.turn_key, claude_session_id: sessionId, seq: session.turn.seq,
    execution_id: session.turn.execution_id ?? undefined, prompt_hash: session.turn.prompt_hash,
    prompt_kind: session.turn.prompt_kind, started_at: session.turn.started_at,
  }, { timeout: 3_000 }));

  if (state?.active) {
    return `Operação Lynse (US ${state.external_ref ?? 'ativa'}): se esta resposta alterar código, termine com uma linha `
      + '[lynse: nova_funcionalidade | melhoria | correcao <origem> | sem_codigo]. '
      + 'Se o ABE aprovou plano, PR ou deploy nesta mensagem, inclua também [lynse: aprovado <plan|pr|deploy>].';
  }
  if (session.seq === 1) {
    return 'Operação Lynse: não há User Story ativa nesta sessão. Se este pedido envolver alteração de código, pergunte uma vez ao ABE qual é a US e rode /lynse-start <ID>; atenda o pedido normalmente.';
  }
  return null;
}

async function onStop(input) {
  const sessionId = input.session_id;
  const session = await readSession(sessionId);
  const turn = session?.turn;
  if (!turn) return;
  const size = fileSize(turn.transcript_path ?? input.transcript_path);
  const sent = await quiet(sendTurn(sessionId, session, turn, size, true));
  turn.finalized_at = new Date().toISOString();
  turn.final_offset = size;
  if (sent) { turn.files = sent.files; turn.sent_execution_id = sent.executionId; }
  await saveSession(sessionId, session);
}

async function onToolUse(input, root, state) {
  const sessionId = input.session_id;
  const session = await readSession(sessionId);
  const turn = session?.turn;
  if (!turn) return null;
  if (input.hook_event_name === 'PostToolUseFailure') {
    await appendTurnLog(sessionId, turn.turn_key, { t: 'fail' });
    return null;
  }
  const lines = EDIT_TOOLS.has(input.tool_name) ? countEditLines(input.tool_name, input.tool_input, input.tool_response) : null;
  if (!lines || !insideProject(lines.file, root)) {
    await appendTurnLog(sessionId, turn.turn_key, { t: 'tool' });
    return null;
  }
  await appendTurnLog(sessionId, turn.turn_key, { t: 'edit', f: fileKey(lines.file, root), a: lines.added, r: lines.removed });
  if (!state?.active && !session.warned_no_us && lines.added + lines.removed > 0) {
    session.warned_no_us = true;
    await saveSession(sessionId, session);
    return 'Operação Lynse: esta sessão está alterando código sem User Story registrada. Sem interromper o trabalho, pergunte ao ABE qual é a US e rode /lynse-start <ID>'
      + ' (os prompts anteriores desta sessão serão vinculados a ela). Se ele não souber ou preferir seguir, siga: fica registrado para tratativa manual.';
  }
  return null;
}

async function onSubagentStop(input) {
  const session = await readSession(input.session_id);
  if (session?.turn && input.agent_transcript_path) {
    await appendTurnLog(input.session_id, session.turn.turn_key, { t: 'sub', p: input.agent_transcript_path });
  }
}

async function trackProcess(event, input, ctx) {
  if (!API_KEY || !input.session_id) return null;
  try {
    if (event === 'SessionStart') return await syncAtSessionStart(ctx.identity, ctx.state, ctx.remote, ctx.root);
    if (event === 'UserPromptSubmit') return await onPromptSubmit(input, ctx.identity, ctx.state);
    if (event === 'PostToolUse' || event === 'PostToolUseFailure') return await onToolUse(input, ctx.root, ctx.state);
    if (event === 'SubagentStop') await onSubagentStop(input);
    if (event === 'Stop' || event === 'SessionEnd') await onStop(input);
  } catch {
    // Falha de medição nunca interfere no trabalho.
  }
  return null;
}

// ---------- Execução ----------

const input = await stdinJson();
const event = input.hook_event_name;
const root = projectRoot(input);
const remote = git(['remote', 'get-url', 'origin'], root);
const identity = remote || root;
let state = await readState(identity);

const processContext = await trackProcess(event, input, { identity, state, remote, root });
if (event === 'SessionStart') state = await readState(identity);

const contextOutput = processContext && ['SessionStart', 'UserPromptSubmit', 'PostToolUse'].includes(event)
  ? { hookSpecificOutput: { hookEventName: event, additionalContext: processContext } }
  : null;

if (!state?.active || !state.execution_id) {
  if (contextOutput) process.stdout.write(JSON.stringify(contextOutput));
  process.exit(0);
}

const captureMode = process.env.LYNSE_CAPTURE_MODE ?? 'metadata';
const isPolicyEvent = ['PreToolUse', 'UserPromptSubmit'].includes(event);

let policy = null;
const occurredAt = new Date().toISOString();
const pending = [];

if (isPolicyEvent) {
  const mode = process.env.LYNSE_MODE ?? state.mode;
  policy = evaluatePolicy({
    hook_event_name: event,
    tool_name: input.tool_name,
    tool_input: input.tool_input,
    prompt: input.prompt,
    mode,
  });
  pending.push(quiet(api('/api/v1/policies/record', {
    execution_id: state.execution_id,
    claude_session_id: input.session_id,
    rule_code: policy.rule_code,
    decision: policy.recorded_decision,
    risk_level: policy.risk_level,
    reason: policy.reason,
    mode: mode === 'enforcement' ? 'enforcement' : 'audit',
    input_hash: policy.input_hash,
  })));
}

pending.push(quiet(api('/api/v1/events', {
  execution_id: state.execution_id,
  claude_session_id: input.session_id,
  event_type: event ?? 'Unknown',
  tool_name: input.tool_name,
  source: 'claude-hook',
  risk_level: policy?.risk_level,
  occurred_at: occurredAt,
  idempotency_key: sha256([
    state.execution_id,
    input.session_id,
    event,
    input.tool_use_id,
    input.task_id,
    occurredAt,
    JSON.stringify(input.tool_input ?? input.prompt ?? ''),
  ].join('|')),
  payload: eventPayload(input, captureMode),
})));

await Promise.all(pending);

if (policy?.decision === 'block') {
  process.stdout.write(JSON.stringify(denyOutput(event, policy.reason)));
} else if (policy?.decision === 'ask' && event === 'PreToolUse') {
  process.stdout.write(JSON.stringify(askOutput(policy.reason)));
} else if (contextOutput) {
  process.stdout.write(JSON.stringify(contextOutput));
}
