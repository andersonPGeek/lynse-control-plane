import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { classifyText, redactSecrets, sha256 } from '../../src/redact.mjs';

async function stdinJson() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

function projectRoot(input) {
  return process.env.CLAUDE_PROJECT_DIR ?? input.cwd ?? process.cwd();
}

async function readState(root) {
  try {
    return JSON.parse(await readFile(resolve(root, '.claude/.lynse-state.json'), 'utf8'));
  } catch {
    return null;
  }
}

async function api(path, body) {
  const baseUrl = process.env.LYNSE_API_URL ?? 'http://localhost:3333';
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.LYNSE_API_KEY ?? 'change-me-local',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(4_000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error ?? `Control Plane respondeu ${response.status}`);
  return result;
}

function capture(value, mode) {
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
  if (mode === 'metadata') delete classified.redacted_preview;
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
  if (input.tool_response !== undefined) payload.tool_response = capture(input.tool_response, captureMode);
  if (input.error !== undefined) payload.error = capture(input.error, captureMode);
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

const input = await stdinJson();
const root = projectRoot(input);
const state = await readState(root);

if (!state?.active || !state.execution_id) process.exit(0);

const captureMode = process.env.LYNSE_CAPTURE_MODE ?? 'classified';
const failMode = process.env.LYNSE_FAIL_MODE ?? 'open';
const isPolicyEvent = ['PreToolUse', 'UserPromptSubmit'].includes(input.hook_event_name);

let policy = null;
const occurredAt = new Date().toISOString();

try {
  if (isPolicyEvent) {
    policy = await api('/api/v1/policies/evaluate', {
      execution_id: state.execution_id,
      claude_session_id: input.session_id,
      hook_event_name: input.hook_event_name,
      tool_name: input.tool_name,
      tool_input: input.tool_input,
      prompt: input.prompt,
      mode: process.env.LYNSE_MODE ?? state.mode,
    });
  }

} catch (error) {
  if (failMode === 'closed' && isPolicyEvent) {
    process.stdout.write(JSON.stringify(denyOutput(
      input.hook_event_name,
      `Control Plane Lynse indisponível: ${error.message}`,
    )));
    process.exit(0);
  }
}

try {
  await api('/api/v1/events', {
    execution_id: state.execution_id,
    claude_session_id: input.session_id,
    event_type: input.hook_event_name ?? 'Unknown',
    tool_name: input.tool_name,
    source: 'claude-hook',
    risk_level: policy?.risk_level,
    occurred_at: occurredAt,
    idempotency_key: sha256([
      state.execution_id,
      input.session_id,
      input.hook_event_name,
      input.tool_use_id,
      input.task_id,
      occurredAt,
      JSON.stringify(input.tool_input ?? input.prompt ?? ''),
    ].join('|')),
    payload: eventPayload(input, captureMode),
    cwd: input.cwd,
  });

} catch {
  // A decisão já obtida continua valendo mesmo que o registro do evento falhe.
}

if (policy?.decision === 'block') {
  process.stdout.write(JSON.stringify(denyOutput(input.hook_event_name, policy.reason)));
} else if (policy?.decision === 'ask' && input.hook_event_name === 'PreToolUse') {
  process.stdout.write(JSON.stringify(askOutput(policy.reason)));
}
