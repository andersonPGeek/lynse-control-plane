import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hook = resolve(project, 'client-kit/hooks/lynse-hook.mjs');
const cli = resolve(project, 'client-kit/hooks/lynse-cli.mjs');
const REMOTE = 'https://github.com/cliente-secreto/sistema-interno.git';
const EXECUTION_ID = '11111111-1111-4111-8111-111111111111';

function sha(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function setup() {
  const home = await mkdtemp(resolve(tmpdir(), 'lynse-home-'));
  const repo = await mkdtemp(resolve(tmpdir(), 'lynse-repo-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['remote', 'add', 'origin', REMOTE], { cwd: repo });

  const stateDir = resolve(home, '.claude/lynse/state');
  await mkdir(stateDir, { recursive: true });
  await writeFile(
    resolve(stateDir, `${sha(REMOTE).slice(0, 20)}.json`),
    JSON.stringify({ active: true, execution_id: EXECUTION_ID, mode: 'audit' }),
  );

  const requests = [];
  const server = http.createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    requests.push({ path: request.url, raw, body: raw ? JSON.parse(raw) : {} });
    response.writeHead(201, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      id: EXECUTION_ID, external_ref: 'US-1', title: 'US-1', mode: 'audit', started_at: '2026-09-03T10:00:00.000Z',
    }));
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));

  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('LYNSE_')));
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    CLAUDE_PROJECT_DIR: repo,
    LYNSE_API_URL: `http://127.0.0.1:${server.address().port}`,
    LYNSE_API_KEY: 'test-key',
  });

  return {
    home, repo, requests, env,
    close: async () => {
      await new Promise((done) => server.close(done));
      await rm(home, { recursive: true, force: true });
      await rm(repo, { recursive: true, force: true });
    },
  };
}

function run(script, args, { env, cwd, input = '' }) {
  return new Promise((resolveProcess, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolveProcess({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

test('hook decide a política localmente e nunca envia texto bruto ao servidor', async () => {
  const ctx = await setup();
  try {
    const result = await run(hook, [], {
      env: { ...ctx.env, LYNSE_MODE: 'enforcement' },
      cwd: ctx.repo,
      input: JSON.stringify({
        session_id: 's1', cwd: ctx.repo, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 't1',
        tool_input: { command: 'sqlcmd -Q "DROP TABLE FAT_FATURAMENTO" # password=SuperSecret123' },
      }),
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'deny');

    assert.deepEqual(ctx.requests.map((r) => r.path).sort(), ['/api/v1/events', '/api/v1/policies/record']);
    const record = ctx.requests.find((r) => r.path === '/api/v1/policies/record').body;
    assert.equal(record.rule_code, 'SEC-SECRET-01');
    assert.equal(record.decision, 'block');
    assert.equal(record.mode, 'enforcement');

    const everything = ctx.requests.map((r) => r.raw).join('\n');
    for (const forbidden of ['DROP TABLE', 'FAT_FATURAMENTO', 'SuperSecret123', basename(ctx.repo), REMOTE, 'cliente-secreto']) {
      assert.ok(!everything.includes(forbidden), `vazou: ${forbidden}`);
    }
  } finally {
    await ctx.close();
  }
});

test('modo audit registra would_block sem bloquear', async () => {
  const ctx = await setup();
  try {
    const result = await run(hook, [], {
      env: ctx.env,
      cwd: ctx.repo,
      input: JSON.stringify({
        session_id: 's1', hook_event_name: 'UserPromptSubmit', prompt: 'rode git reset --hard e DROP TABLE clientes',
      }),
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, '');
    const record = ctx.requests.find((r) => r.path === '/api/v1/policies/record').body;
    assert.equal(record.decision, 'would_block');
    assert.equal(record.mode, 'audit');
  } finally {
    await ctx.close();
  }
});

test('saída da ferramenta e prompt não levam prévia nem no modo classified', async () => {
  const ctx = await setup();
  try {
    await run(hook, [], {
      env: { ...ctx.env, LYNSE_CAPTURE_MODE: 'classified' },
      cwd: ctx.repo,
      input: JSON.stringify({
        session_id: 's1', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 't2',
        tool_input: { command: 'ls' },
        tool_response: { stdout: 'NOTA FISCAL 123 CLIENTE ACME' },
      }),
    });
    const event = ctx.requests.find((r) => r.path === '/api/v1/events').body;
    assert.ok(event.payload.tool_response.sha256);
    assert.equal(event.payload.tool_response.redacted_preview, undefined);
    assert.ok(!ctx.requests.map((r) => r.raw).join('\n').includes('ACME'));
  } finally {
    await ctx.close();
  }
});

test('padrão é metadata: eventos de prompt carregam só hash e tamanho', async () => {
  const ctx = await setup();
  try {
    await run(hook, [], {
      env: ctx.env,
      cwd: ctx.repo,
      input: JSON.stringify({ session_id: 's1', hook_event_name: 'UserPromptSubmit', prompt: 'detalhes do contrato da obra X' }),
    });
    const event = ctx.requests.find((r) => r.path === '/api/v1/events').body;
    assert.equal(event.payload.prompt.redacted_preview, undefined);
    assert.equal(event.payload.prompt.length, 'detalhes do contrato da obra X'.length);
    assert.equal(event.cwd, undefined);
  } finally {
    await ctx.close();
  }
});

test('lynse-start não envia cwd nem o git remote em texto puro', async () => {
  const ctx = await setup();
  try {
    const result = await run(cli, ['start', 'US-1', 'session-1'], { env: ctx.env, cwd: ctx.repo });
    assert.equal(result.code, 0, result.stderr);
    const { body, raw } = ctx.requests[0];
    assert.equal(body.cwd, undefined);
    assert.equal(body.context_snapshot.git_remote, undefined);
    assert.equal(body.context_snapshot.git_remote_hash, sha(REMOTE));
    assert.ok(!raw.includes(basename(ctx.repo)));
    assert.ok(!raw.includes('cliente-secreto'));
  } finally {
    await ctx.close();
  }
});

test('o motor de política e a redação do kit são idênticos aos do servidor', async () => {
  for (const file of ['policy-engine.mjs', 'redact.mjs']) {
    const server = await readFile(resolve(project, 'src', file), 'utf8');
    const kit = await readFile(resolve(project, 'client-kit/hooks', file), 'utf8');
    assert.equal(kit, server, `${file} divergiu entre src/ e client-kit/hooks/`);
  }
});
