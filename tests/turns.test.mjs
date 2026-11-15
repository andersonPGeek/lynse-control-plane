import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  countEditLines, insideProject, lineDiff, parseMarkers, readTranscriptSegment,
} from '../client-kit/hooks/lynse-turns.mjs';
import { mergeLynseSection } from '../client-kit/install.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hook = resolve(project, 'client-kit/hooks/lynse-hook.mjs');
const REMOTE = 'https://github.com/cliente-secreto/sistema-interno.git';
const EXECUTION_ID = '22222222-2222-4222-8222-222222222222';
const sha = (v) => createHash('sha256').update(v).digest('hex');

test('lineDiff conta como o git: linha alterada = 1 incluída + 1 removida', () => {
  assert.deepEqual(lineDiff('a\nb\nc', 'a\nB\nc'), { added: 1, removed: 1 });
  assert.deepEqual(lineDiff('a\nb', 'a\nb\nc\nd'), { added: 2, removed: 0 });
  assert.deepEqual(lineDiff('a\nb\nc', 'c'), { added: 0, removed: 2 });
  assert.deepEqual(lineDiff('', 'x\ny'), { added: 2, removed: 0 });
});

test('countEditLines prefere o structuredPatch do Claude Code e cai para a entrada da ferramenta', () => {
  const patch = [{ lines: [' ctx', '-velho', '+novo', '+mais'] }];
  assert.deepEqual(countEditLines('Edit', { file_path: 'a.js' }, { structuredPatch: patch }), { file: 'a.js', added: 2, removed: 1 });
  assert.deepEqual(countEditLines('Write', { file_path: 'b.js', content: 'x\ny\nz\n' }, { type: 'create', structuredPatch: [] }), { file: 'b.js', added: 3, removed: 0 });
  assert.deepEqual(countEditLines('MultiEdit', { file_path: 'c.js', edits: [{ old_string: 'a', new_string: 'b' }, { old_string: '', new_string: 'x\ny' }] }, {}), { file: 'c.js', added: 3, removed: 1 });
  assert.equal(countEditLines('Bash', { command: 'ls' }, {}), null);
});

test('insideProject ignora arquivos fora do repositório (planos, memórias)', () => {
  assert.equal(insideProject('/repo/src/a.js', '/repo'), true);
  assert.equal(insideProject('src/a.js', '/repo'), true);
  assert.equal(insideProject('/home/x/.claude/plans/p.md', '/repo'), false);
});

test('parseMarkers entende classificação, origem da correção e aprovações, com ou sem acento', () => {
  assert.deepEqual(parseMarkers(['feito.\n[lynse: correção abe_apontou]']), { kind: 'correcao', fix_origin: 'abe_apontou', approvals: [] });
  assert.deepEqual(parseMarkers(['[lynse: melhoria]', '[lynse: aprovado plano] [lynse: aprovado pr]']), { kind: 'melhoria', fix_origin: null, approvals: ['plan', 'pr'] });
  assert.deepEqual(parseMarkers(['[lynse: nova funcionalidade]']).kind, 'nova_funcionalidade');
  assert.deepEqual(parseMarkers(['[lynse: sem_codigo]']).kind, 'sem_codigo');
  assert.deepEqual(parseMarkers(['texto qualquer']), { kind: null, fix_origin: null, approvals: [] });
});

function transcriptLines() {
  return [
    { type: 'user', message: { role: 'user', content: 'corrija o bug do contrato da obra X' } },
    { type: 'assistant', message: { id: 'm1', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Vou corrigir.' }], usage: { input_tokens: 10, output_tokens: 30, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 } } },
    { type: 'assistant', message: { id: 'm1', model: 'claude-opus-5-5', content: [{ type: 'tool_use', name: 'Edit' }], usage: { input_tokens: 10, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 } } },
    { type: 'assistant', isSidechain: true, message: { id: 's1', model: 'claude-haiku-5-5', content: [{ type: 'text', text: '[lynse: melhoria]' }], usage: { input_tokens: 7, output_tokens: 3 } } },
    { type: 'assistant', message: { id: 'm2', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Corrigido.\n[lynse: correcao abe_apontou]\n[lynse: aprovado pr]' }], usage: { input_tokens: 5, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 40 } } },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n';
}

test('readTranscriptSegment soma cada mensagem uma vez, separa subagente e ignora texto do subagente', async () => {
  const dir = await mkdtemp(resolve(tmpdir(), 'lynse-tr-'));
  try {
    const path = resolve(dir, 't.jsonl');
    await writeFile(path, transcriptLines());
    const u = readTranscriptSegment(path);
    assert.equal(u.input_tokens, 22);
    assert.equal(u.output_tokens, 73);
    assert.equal(u.cache_read_tokens, 1000);
    assert.equal(u.cache_creation_tokens, 40);
    assert.equal(u.sidechain_tokens, 10);
    assert.equal(u.model, 'claude-opus-5-5');
    assert.equal(parseMarkers(u.texts).kind, 'correcao', 'marcador do subagente não conta');
    assert.equal(readTranscriptSegment(path, 999_999).input_tokens, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('instalador substitui a seção Lynse antiga e preserva o resto do CLAUDE.md', () => {
  const snippet = '<!-- lynse:inicio -->\n## Operação Lynse\nNOVO\n<!-- lynse:fim -->\n';
  const legacy = '# Minhas regras\nA\n\n## Operação Lynse\nANTIGO\n### Sub\nX\n\n## Outra seção\nB\n';
  const merged = mergeLynseSection(legacy, snippet);
  assert.match(merged, /NOVO/);
  assert.doesNotMatch(merged, /ANTIGO/);
  assert.match(merged, /# Minhas regras\nA/);
  assert.match(merged, /## Outra seção\nB/);
  const again = mergeLynseSection(merged, snippet.replace('NOVO', 'NOVÍSSIMO'));
  assert.match(again, /NOVÍSSIMO/);
  assert.equal((again.match(/lynse:inicio/g) ?? []).length, 1);
  assert.equal(mergeLynseSection('', snippet), snippet);
});

async function setup({ context = { available: true, active: null } } = {}) {
  const home = await mkdtemp(resolve(tmpdir(), 'lynse-home-'));
  const repo = await mkdtemp(resolve(tmpdir(), 'lynse-repo-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['remote', 'add', 'origin', REMOTE], { cwd: repo });
  const stateDir = resolve(home, '.claude/lynse/state');
  await mkdir(stateDir, { recursive: true });
  const requests = [];
  const server = http.createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    requests.push({ method: request.method, path: request.url, raw, body: raw ? JSON.parse(raw) : {} });
    response.writeHead(request.url.startsWith('/api/v1/me/context') ? 200 : 201, { 'content-type': 'application/json' });
    response.end(JSON.stringify(request.url.startsWith('/api/v1/me/context') ? context : { id: 'x' }));
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('LYNSE_') && key !== 'CLAUDE_PROJECT_DIR'));
  Object.assign(env, { HOME: home, USERPROFILE: home, CLAUDE_PROJECT_DIR: repo, LYNSE_API_URL: `http://127.0.0.1:${server.address().port}`, LYNSE_API_KEY: 'test-key' });
  const run = (payload) => new Promise((done, reject) => {
    const child = spawn(process.execPath, [hook], { cwd: repo, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', reject);
    child.on('close', (code) => done({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(payload));
  });
  const stateFile = resolve(stateDir, `${sha(REMOTE).slice(0, 20)}.json`);
  return {
    home, repo, requests, run, stateFile,
    close: async () => {
      await new Promise((done) => server.close(done));
      await rm(home, { recursive: true, force: true });
      await rm(repo, { recursive: true, force: true });
    },
  };
}

test('hook mede o prompt: tokens, linhas, arquivos, classificação e aprovação — sem enviar texto', async () => {
  const ctx = await setup();
  try {
    await writeFile(ctx.stateFile, JSON.stringify({ active: true, execution_id: EXECUTION_ID, external_ref: '70864', mode: 'audit' }));
    const transcript = resolve(ctx.home, 'session.jsonl');
    await writeFile(transcript, '');
    const base = { session_id: 'sess-1', transcript_path: transcript, cwd: ctx.repo };

    const prompt = await ctx.run({ ...base, hook_event_name: 'UserPromptSubmit', prompt: 'corrija o bug do contrato da obra X' });
    assert.equal(prompt.code, 0, prompt.stderr);
    const opened = ctx.requests.find((r) => r.path === '/api/v1/turns');
    assert.equal(opened.body.execution_id, EXECUTION_ID);
    assert.equal(opened.body.prompt_hash, sha('corrija o bug do contrato da obra X'));

    await appendFile(transcript, transcriptLines());
    await ctx.run({ ...base, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_use_id: 't1',
      tool_input: { file_path: resolve(ctx.repo, 'src/segredo-do-cliente.js'), old_string: 'a', new_string: 'b' },
      tool_response: { structuredPatch: [{ lines: ['-velho', '+novo', '+outro'] }] } });
    await ctx.run({ ...base, hook_event_name: 'PostToolUse', tool_name: 'Write', tool_use_id: 't2',
      tool_input: { file_path: resolve(ctx.home, '.claude/plans/plano.md'), content: 'a\nb\nc' }, tool_response: { type: 'create' } });
    await ctx.run({ ...base, hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_use_id: 't3', tool_input: { command: 'npm test' }, error: 'falhou' });
    const stop = await ctx.run({ ...base, hook_event_name: 'Stop' });
    assert.equal(stop.code, 0, stop.stderr);

    const turns = ctx.requests.filter((r) => r.path === '/api/v1/turns');
    const final = turns.at(-1).body;
    assert.equal(final.turn_key, opened.body.turn_key);
    assert.equal(final.lines_added, 2);
    assert.equal(final.lines_removed, 1);
    assert.equal(final.files_changed, 1, 'o plano em ~/.claude não conta');
    assert.equal(final.tool_calls, 3);
    assert.equal(final.tool_failures, 1);
    assert.equal(final.input_tokens, 22);
    assert.equal(final.output_tokens, 73);
    assert.equal(final.subagent_tokens, 10);
    assert.equal(final.kind, 'correcao');
    assert.equal(final.fix_origin, 'abe_apontou');

    const approval = ctx.requests.find((r) => r.path === '/api/v1/approvals').body;
    assert.equal(approval.gate, 'pr');
    assert.equal(approval.evidence, 'turno_abe');
    assert.equal(approval.turn_key, opened.body.turn_key);

    const everything = ctx.requests.map((r) => r.raw).join('\n');
    for (const forbidden of ['contrato', 'obra X', 'segredo-do-cliente', 'Corrigido', 'cliente-secreto', 'plano.md']) {
      assert.ok(!everything.includes(forbidden), `vazou: ${forbidden}`);
    }

    // Próximo prompt sem novas respostas no transcript: não reenvia o turno anterior, abre o seguinte.
    const before = ctx.requests.length;
    await ctx.run({ ...base, hook_event_name: 'UserPromptSubmit', prompt: 'agora a melhoria' });
    const after = ctx.requests.slice(before).filter((r) => r.path === '/api/v1/turns');
    assert.equal(after.length, 1);
    assert.equal(after[0].body.seq, 2);
  } finally {
    await ctx.close();
  }
});

test('sessão sem US: o hook não bloqueia nada e orienta o agente a perguntar a US uma única vez', async () => {
  const ctx = await setup();
  try {
    const transcript = resolve(ctx.home, 's.jsonl');
    await writeFile(transcript, '');
    const base = { session_id: 'sess-2', transcript_path: transcript, cwd: ctx.repo };
    const start = await ctx.run({ ...base, hook_event_name: 'SessionStart', source: 'startup' });
    assert.match(JSON.parse(start.stdout).hookSpecificOutput.additionalContext, /não há User Story ativa/);
    await ctx.run({ ...base, hook_event_name: 'UserPromptSubmit', prompt: 'ajuste o relatório' });
    const edit = { ...base, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: resolve(ctx.repo, 'a.js'), old_string: 'a', new_string: 'b' }, tool_response: {} };
    const first = await ctx.run({ ...edit, tool_use_id: 'e1' });
    assert.match(JSON.parse(first.stdout).hookSpecificOutput.additionalContext, /sem User Story registrada/);
    assert.equal(JSON.parse(first.stdout).hookSpecificOutput.permissionDecision, undefined);
    const second = await ctx.run({ ...edit, tool_use_id: 'e2' });
    assert.equal(second.stdout, '', 'o aviso aparece uma vez por sessão');
    const pre = await ctx.run({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_use_id: 'e3', tool_input: { file_path: 'a.js' } });
    assert.equal(pre.stdout, '', 'nenhum bloqueio por falta de US');
    assert.ok(!ctx.requests.some((r) => r.path === '/api/v1/events'), 'sem US, não há eventos de execução');
  } finally {
    await ctx.close();
  }
});

test('SessionStart adota a US ativa do servidor neste repositório e limpa estado local vencido', async () => {
  const ctx = await setup({ context: { available: true, active: { id: EXECUTION_ID, external_ref: '70864', title: 'Bugs onda 4', mode: 'audit', started_at: '2026-11-15T10:00:00Z', same_repository: true, hours_open: 14, stale: true } } });
  try {
    const out = await ctx.run({ session_id: 's3', hook_event_name: 'SessionStart', cwd: ctx.repo });
    const text = JSON.parse(out.stdout).hookSpecificOutput.additionalContext;
    assert.match(text, /70864/);
    assert.match(text, /14h/);
    const state = JSON.parse(await readFile(ctx.stateFile, 'utf8'));
    assert.equal(state.active, true);
    assert.equal(state.execution_id, EXECUTION_ID);
    const call = ctx.requests.find((r) => r.path.startsWith('/api/v1/me/context'));
    assert.ok(call.path.includes(sha(REMOTE)), 'identifica o repositório só pelo hash');
    assert.ok(!call.path.includes('sistema-interno'));
  } finally {
    await ctx.close();
  }
});

test('Control Plane fora do ar: o hook não falha nem bloqueia', async () => {
  const ctx = await setup();
  try {
    await writeFile(ctx.stateFile, JSON.stringify({ active: true, execution_id: EXECUTION_ID, mode: 'audit' }));
    await ctx.close();
  } catch { /* fechado abaixo */ }
  const env = { ...process.env, HOME: ctx.home, USERPROFILE: ctx.home, LYNSE_API_URL: 'http://127.0.0.1:9', LYNSE_API_KEY: 'k' };
  delete env.CLAUDE_PROJECT_DIR;
  const child = spawn(process.execPath, [hook], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  child.stdout.on('data', (c) => { stdout += c; });
  child.stdin.end(JSON.stringify({ session_id: 's4', hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: 'a.js' } }));
  const code = await new Promise((done) => child.on('close', done));
  assert.equal(code, 0);
  assert.equal(stdout, '');
});
