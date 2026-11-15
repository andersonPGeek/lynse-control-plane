// Medição de cada prompt do ABE ("turno"), toda feita NA MÁQUINA do ABE.
//
// O que sai daqui para o Control Plane são só números: tokens por tipo, linhas incluídas/removidas,
// quantidade de arquivos (nunca os nomes: só um hash local é guardado para detectar re-edição),
// usos e falhas de ferramenta, e a classificação que o próprio agente declarou no fim da resposta.
// O texto do prompt, do código e das respostas nunca sai da máquina.

import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, fstatSync, openSync, readFileSync, readSync, statSync, unlinkSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';

const STATE_DIR = resolve(homedir(), '.claude', 'lynse', 'state');
const hash = (value, size = 20) => createHash('sha256').update(String(value)).digest('hex').slice(0, size);

// ---------- Linhas alteradas ----------

export const splitLines = (text) => {
  const s = String(text ?? '').replace(/\r\n/g, '\n');
  if (s === '') return [];
  return (s.endsWith('\n') ? s.slice(0, -1) : s).split('\n');
};

// Diferença por linha (como o git conta): prefixo/sufixo comuns + maior subsequência comum.
export function lineDiff(before, after) {
  const x = splitLines(before);
  const y = splitLines(after);
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i += 1;
  let j = 0;
  while (j < x.length - i && j < y.length - i && x[x.length - 1 - j] === y[y.length - 1 - j]) j += 1;
  const a = x.slice(i, x.length - j);
  const b = y.slice(i, y.length - j);
  if (!a.length || !b.length || a.length * b.length > 4_000_000) return { added: b.length, removed: a.length };
  let prev = new Uint32Array(b.length + 1);
  let cur = new Uint32Array(b.length + 1);
  for (let p = 1; p <= a.length; p += 1) {
    for (let q = 1; q <= b.length; q += 1) cur[q] = a[p - 1] === b[q - 1] ? prev[q - 1] + 1 : Math.max(prev[q], cur[q - 1]);
    [prev, cur] = [cur, prev];
  }
  const common = prev[b.length];
  return { added: b.length - common, removed: a.length - common };
}

function countPatch(patch) {
  let added = 0;
  let removed = 0;
  for (const hunk of patch) {
    for (const line of hunk?.lines ?? []) {
      if (line.startsWith('+')) added += 1;
      else if (line.startsWith('-')) removed += 1;
    }
  }
  return { added, removed };
}

export const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

// Linhas incluídas/removidas por uma ferramenta de edição. Prefere o patch que o próprio Claude Code
// devolve (structuredPatch); sem ele, calcula a partir da entrada da ferramenta.
export function countEditLines(toolName, input = {}, response = {}) {
  if (!EDIT_TOOLS.has(toolName)) return null;
  const file = input?.file_path ?? input?.notebook_path ?? response?.filePath ?? null;
  const patch = response?.structuredPatch;
  if (Array.isArray(patch) && patch.length) return { file, ...countPatch(patch) };
  if (toolName === 'Write') {
    if (typeof response?.originalFile === 'string') return { file, ...lineDiff(response.originalFile, input.content) };
    if (response?.type === 'update' && Array.isArray(patch)) return { file, added: 0, removed: 0 };
    return { file, added: splitLines(input.content).length, removed: 0 };
  }
  if (toolName === 'Edit') return { file, ...lineDiff(input.old_string, input.new_string) };
  if (toolName === 'MultiEdit') {
    const total = { added: 0, removed: 0 };
    for (const edit of input.edits ?? []) {
      const d = lineDiff(edit.old_string, edit.new_string);
      total.added += d.added;
      total.removed += d.removed;
    }
    return { file, ...total };
  }
  if (input.edit_mode === 'delete') return { file, added: 0, removed: 0 };
  return { file, added: splitLines(input.new_source).length, removed: 0 };
}

// Só conta arquivos dentro do projeto (planos e memórias em ~/.claude não são código do cliente).
export function insideProject(file, root) {
  if (!file || !root) return false;
  const rel = relative(resolve(root), isAbsolute(file) ? resolve(file) : resolve(root, file));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

export const fileKey = (file, root) => hash(relative(resolve(root), resolve(root, file)).replace(/\\/g, '/'), 16);

// ---------- Tokens a partir do transcript local ----------

const EMPTY_USAGE = () => ({ input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, sidechain_tokens: 0, model: null, texts: [], has_assistant: false });

export function fileSize(path) {
  try { return statSync(path).size; } catch { return 0; }
}

// Soma o uso de tokens das respostas do agente entre dois offsets (bytes) do transcript JSONL.
// Cada mensagem pode aparecer em várias linhas (uma por bloco); conta-se uma vez, com o maior valor.
export function readTranscriptSegment(path, start = 0, end = null) {
  const out = EMPTY_USAGE();
  if (!path) return out;
  let fd;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const to = end === null ? size : Math.min(end, size);
    const from = Math.max(0, Math.min(start, to));
    if (to <= from) return out;
    const buffer = Buffer.alloc(to - from);
    readSync(fd, buffer, 0, buffer.length, from);
    const messages = new Map();
    for (const line of buffer.toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry?.type !== 'assistant' || !entry.message) continue;
      out.has_assistant = true;
      const msg = entry.message;
      for (const block of Array.isArray(msg.content) ? msg.content : []) {
        if (block?.type === 'text' && typeof block.text === 'string' && !entry.isSidechain) out.texts.push(block.text);
      }
      const usage = msg.usage;
      if (!usage) continue;
      const key = msg.id ?? entry.uuid ?? line;
      const prev = messages.get(key) ?? { input: 0, output: 0, read: 0, creation: 0, sidechain: Boolean(entry.isSidechain), model: msg.model };
      prev.input = Math.max(prev.input, Number(usage.input_tokens) || 0);
      prev.output = Math.max(prev.output, Number(usage.output_tokens) || 0);
      prev.read = Math.max(prev.read, Number(usage.cache_read_input_tokens) || 0);
      prev.creation = Math.max(prev.creation, Number(usage.cache_creation_input_tokens) || 0);
      if (msg.model && msg.model !== '<synthetic>') prev.model = msg.model;
      messages.set(key, prev);
    }
    const models = new Map();
    for (const m of messages.values()) {
      out.input_tokens += m.input;
      out.output_tokens += m.output;
      out.cache_read_tokens += m.read;
      out.cache_creation_tokens += m.creation;
      if (m.sidechain) out.sidechain_tokens += m.input + m.output + m.read + m.creation;
      if (m.model && m.model !== '<synthetic>' && !m.sidechain) models.set(m.model, (models.get(m.model) ?? 0) + m.output + 1);
    }
    out.model = [...models.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    return out;
  } catch {
    return out;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* ignorado */ }
  }
}

// ---------- Marcadores declarados pelo agente ----------
//
// No fim de cada resposta o agente escreve, por exemplo:
//   [lynse: correcao abe_apontou]   [lynse: melhoria]   [lynse: aprovado plan]
// O hook lê esses marcadores do transcript local; nenhuma ferramenta ou permissão extra é necessária.

const KIND_ALIASES = {
  nova_funcionalidade: 'nova_funcionalidade', nova: 'nova_funcionalidade', funcionalidade: 'nova_funcionalidade', feature: 'nova_funcionalidade',
  melhoria: 'melhoria', ajuste: 'melhoria', refino: 'melhoria',
  correcao: 'correcao', fix: 'correcao', bug: 'correcao', reparo: 'correcao',
  sem_codigo: 'sem_codigo', 'sem-codigo': 'sem_codigo', nenhum: 'sem_codigo',
};
const ORIGIN_ALIASES = {
  abe_apontou: 'abe_apontou', abe: 'abe_apontou',
  teste_build_falhou: 'teste_build_falhou', teste: 'teste_build_falhou', build: 'teste_build_falhou', testes: 'teste_build_falhou',
  revisao_pr: 'revisao_pr', revisao: 'revisao_pr', review: 'revisao_pr', pr: 'revisao_pr',
  pos_deploy: 'pos_deploy', producao: 'pos_deploy', deploy: 'pos_deploy',
};
const GATE_ALIASES = { plan: 'plan', plano: 'plan', pr: 'pr', deploy: 'deploy', rollback: 'rollback', close: 'close', fechamento: 'close' };

const normalize = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export function parseMarkers(texts) {
  const result = { kind: null, fix_origin: null, approvals: [] };
  const re = /\[lynse:\s*([^\]\n]{1,80})\]/gi;
  for (const text of texts ?? []) {
    for (const match of String(text).matchAll(re)) {
      const words = normalize(match[1]).split(/[\s,;|·/]+/).filter(Boolean);
      const [first, second] = words;
      if (['aprovado', 'aprovada', 'aprovacao', 'aprova'].includes(first)) {
        const gate = GATE_ALIASES[second];
        if (gate && !result.approvals.includes(gate)) result.approvals.push(gate);
        continue;
      }
      const kind = KIND_ALIASES[first] ?? KIND_ALIASES[words.join('_')];
      if (!kind) continue;
      result.kind = kind;
      result.fix_origin = kind === 'correcao' ? (ORIGIN_ALIASES[second] ?? null) : null;
    }
  }
  return result;
}

// ---------- Estado local por sessão ----------

const sessionFile = (sessionId) => resolve(STATE_DIR, `turn-${hash(sessionId)}.json`);
const logFile = (sessionId, turnKey) => resolve(STATE_DIR, `turn-${hash(sessionId)}-${hash(turnKey, 12)}.log`);

export async function readSession(sessionId) {
  try { return JSON.parse(await readFile(sessionFile(sessionId), 'utf8')); } catch { return null; }
}

export async function saveSession(sessionId, data) {
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(sessionFile(sessionId), `${JSON.stringify(data)}\n`, { mode: 0o600 });
}

// Um arquivo de log por turno, só com acréscimos (ferramentas podem rodar em paralelo).
export async function appendTurnLog(sessionId, turnKey, record) {
  await mkdir(STATE_DIR, { recursive: true });
  appendFileSync(logFile(sessionId, turnKey), `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

export function readTurnLog(sessionId, turnKey) {
  const out = { added: 0, removed: 0, files: new Set(), tools: 0, failures: 0, subagents: new Set() };
  let raw = '';
  try { raw = readFileSync(logFile(sessionId, turnKey), 'utf8'); } catch { return out; }
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (r.t === 'edit') { out.tools += 1; out.added += r.a || 0; out.removed += r.r || 0; if (r.f) out.files.add(r.f); }
    else if (r.t === 'tool') out.tools += 1;
    else if (r.t === 'fail') { out.tools += 1; out.failures += 1; }
    else if (r.t === 'sub' && r.p) out.subagents.add(r.p);
  }
  return out;
}

export function removeTurnLog(sessionId, turnKey) {
  try { unlinkSync(logFile(sessionId, turnKey)); } catch { /* já removido */ }
}

// Monta o registro do turno (só números) a partir do transcript, do log e do histórico de arquivos.
export function buildTurnPayload({ sessionId, turn, history = [], executionId = null, endOffset = null, ended = true }) {
  const usage = readTranscriptSegment(turn.transcript_path, turn.offset ?? 0, endOffset);
  const log = readTurnLog(sessionId, turn.turn_key);
  const sub = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 };
  for (const path of log.subagents) {
    const s = readTranscriptSegment(path);
    for (const k of Object.keys(sub)) sub[k] += s[k];
  }
  const subTotal = Object.values(sub).reduce((a, b) => a + b, 0) + usage.sidechain_tokens;
  const markers = parseMarkers(usage.texts);
  const known = new Set(history);
  return {
    payload: {
      turn_key: turn.turn_key,
      claude_session_id: sessionId,
      seq: turn.seq,
      execution_id: turn.execution_id ?? executionId ?? undefined,
      prompt_hash: turn.prompt_hash,
      prompt_kind: turn.prompt_kind,
      started_at: turn.started_at,
      ended_at: ended ? new Date().toISOString() : undefined,
      model: usage.model ?? undefined,
      input_tokens: usage.input_tokens + sub.input_tokens,
      output_tokens: usage.output_tokens + sub.output_tokens,
      cache_read_tokens: usage.cache_read_tokens + sub.cache_read_tokens,
      cache_creation_tokens: usage.cache_creation_tokens + sub.cache_creation_tokens,
      subagent_tokens: subTotal,
      lines_added: log.added,
      lines_removed: log.removed,
      files_changed: log.files.size,
      files_reedited: [...log.files].filter((f) => known.has(f)).length,
      tool_calls: log.tools,
      tool_failures: log.failures,
      kind: markers.kind ?? undefined,
      fix_origin: markers.fix_origin ?? undefined,
    },
    approvals: markers.approvals,
    files: [...log.files],
  };
}
