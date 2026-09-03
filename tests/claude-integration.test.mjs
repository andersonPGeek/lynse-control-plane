import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function runNode(script, args, { env, input = '' }) {
  return new Promise((resolveProcess, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: env.CLAUDE_PROJECT_DIR,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolveProcess({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

async function mockApi(handler) {
  const server = http.createServer(handler);
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolveClose) => server.close(resolveClose)),
  };
}

test('lynse-start usa POST e persiste o execution_id local', async () => {
  const temp = await mkdtemp(resolve(tmpdir(), 'lynse-cli-'));
  let received;
  const api = await mockApi(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    received = { method: request.method, path: request.url, body: JSON.parse(raw) };
    response.writeHead(201, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      id: '11111111-1111-4111-8111-111111111111',
      external_ref: 'US-1842',
      title: 'Recuperação de senha',
      mode: 'audit',
      started_at: '2026-09-03T10:00:00.000Z',
    }));
  });

  try {
    const result = await runNode(resolve(project, '.claude/hooks/lynse-cli.mjs'), ['start', 'US-1842', 'session-1'], {
      env: { CLAUDE_PROJECT_DIR: temp, LYNSE_API_URL: api.url },
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(received.method, 'POST');
    assert.equal(received.path, '/api/v1/executions/start');
    assert.equal(received.body.claude_session_id, 'session-1');
    const state = JSON.parse(await readFile(resolve(temp, '.claude/.lynse-state.json'), 'utf8'));
    assert.equal(state.execution_id, '11111111-1111-4111-8111-111111111111');
    assert.equal(state.active, true);
  } finally {
    await api.close();
    await rm(temp, { recursive: true, force: true });
  }
});

test('PreToolUse devolve deny quando o Control Plane bloqueia', async () => {
  const temp = await mkdtemp(resolve(tmpdir(), 'lynse-hook-'));
  await mkdir(resolve(temp, '.claude'), { recursive: true });
  await writeFile(resolve(temp, '.claude/.lynse-state.json'), JSON.stringify({
    active: true,
    execution_id: '11111111-1111-4111-8111-111111111111',
    mode: 'enforcement',
  }));

  const api = await mockApi(async (request, response) => {
    for await (const _chunk of request) { /* consume body */ }
    response.writeHead(request.url.includes('/policies/') ? 200 : 202, { 'content-type': 'application/json' });
    response.end(JSON.stringify(request.url.includes('/policies/') ? {
      decision: 'block',
      recorded_decision: 'block',
      rule_code: 'SEC-DB-04',
      risk_level: 'critical',
      reason: 'Operação destrutiva bloqueada.',
    } : { duplicate: false }));
  });

  try {
    const result = await runNode(resolve(project, '.claude/hooks/lynse-hook.mjs'), [], {
      env: {
        CLAUDE_PROJECT_DIR: temp,
        LYNSE_API_URL: api.url,
        LYNSE_MODE: 'enforcement',
      },
      input: JSON.stringify({
        session_id: 'session-1',
        cwd: temp,
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_use_id: 'tool-1',
        tool_input: { command: 'echo "DROP TABLE customers"' },
      }),
    });
    assert.equal(result.code, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(output.hookSpecificOutput.hookEventName, 'PreToolUse');
  } finally {
    await api.close();
    await rm(temp, { recursive: true, force: true });
  }
});
