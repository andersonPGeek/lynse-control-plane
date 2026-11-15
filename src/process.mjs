// Guardião do processo: inconsistências, turnos (prompts) e ajustes manuais.
//
// Regra de ouro: nada aqui pode impedir o ABE de trabalhar. Quando o processo não é seguido
// (US esquecida aberta, sessão sem US, turno sem classificação…), o Control Plane REGISTRA uma
// inconsistência e segue. O tratamento é manual, pela tela "Inconsistências".

import { query, transaction } from './db.mjs';

export const ACTIVE_SQL = `status NOT IN ('done','cancelled','inconsistent')`;
export const STALE_HOURS = Number.parseInt(process.env.LYNSE_STALE_HOURS ?? '12', 10) || 12;

export const INCONSISTENCY_TYPES = {
  US_ABERTA_AO_INICIAR_OUTRA: { severity: 'high', label: 'US deixada aberta ao iniciar outra' },
  US_PARADA: { severity: 'medium', label: `US aberta há mais de ${STALE_HOURS}h` },
  SESSAO_SEM_US: { severity: 'medium', label: 'Código alterado em sessão sem US' },
  TURNO_NAO_CLASSIFICADO: { severity: 'low', label: 'Prompts com código sem classificação' },
  CLASSIFICACAO_DIVERGENTE: { severity: 'low', label: 'Classificação diverge do que foi feito' },
  CONCLUSAO_SEM_EVIDENCIA: { severity: 'high', label: 'US concluída sem as evidências esperadas' },
  APROVACAO_SEM_EVIDENCIA: { severity: 'medium', label: 'Aprovação sem prompt do ABE correspondente' },
};

export const TURN_KINDS = ['nova_funcionalidade', 'melhoria', 'correcao', 'sem_codigo'];
export const FIX_ORIGINS = ['abe_apontou', 'teste_build_falhou', 'revisao_pr', 'pos_deploy'];
const STAGE_ORDER = ['briefing', 'planning', 'building', 'verifying', 'release', 'observing'];
const GATE_NEXT_STAGE = { plan: 'building', pr: 'release', deploy: 'release' };
// Evidências esperadas para concluir. O deploy fica de fora até a integração com o CI/CD dos clientes.
const EXPECTED_GATES = ['plan', 'pr'];

const fail = (status, message, details) => Object.assign(new Error(message), { status, details });
const runner = (client) => client ?? { query };

// ---------- Inconsistências ----------

export async function recordInconsistency(client, { actorId, executionId = null, sessionId = null, type, dedupeKey, details = {} }) {
  const def = INCONSISTENCY_TYPES[type];
  if (!def) throw new Error(`Tipo de inconsistência desconhecido: ${type}`);
  const result = await runner(client).query(
    `INSERT INTO inconsistencies (actor_id, execution_id, claude_session_id, type, severity, dedupe_key, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     ON CONFLICT (type, dedupe_key) WHERE status = 'open'
     DO UPDATE SET details = EXCLUDED.details
     RETURNING id`,
    [actorId, executionId, sessionId, type, def.severity, dedupeKey, JSON.stringify(details)],
  );
  return result.rows[0]?.id ?? null;
}

export async function autoResolve(client, { executionId = null, sessionId = null, types, note }) {
  const result = await runner(client).query(
    `UPDATE inconsistencies
        SET status = 'resolved', resolved_at = now(), resolved_by = 'automático', resolution_note = $4
      WHERE status = 'open' AND type = ANY($3::text[])
        AND (($1::uuid IS NOT NULL AND execution_id = $1) OR ($2::text IS NOT NULL AND claude_session_id = $2))
      RETURNING id`,
    [executionId, sessionId, types, note],
  );
  return result.rowCount;
}

// Detecções que dependem do tempo ou de dados acumulados. Idempotente; roda antes das leituras.
// Uma inconsistência já tratada (resolvida/justificada) não é recriada para a mesma execução/sessão.
const NOT_TREATED = (type, key) => `NOT EXISTS (SELECT 1 FROM inconsistencies i WHERE i.type = '${type}' AND i.dedupe_key = ${key} AND i.status <> 'open')`;

export async function detectInconsistencies() {
  await query(
    `INSERT INTO inconsistencies (actor_id, execution_id, type, severity, dedupe_key, details)
     SELECT e.abe_id, e.id, 'US_PARADA', 'medium', e.id::text,
            jsonb_build_object('horas_aberta', round(extract(epoch FROM now() - e.started_at) / 3600), 'limite_horas', $1::int, 'status', e.status)
       FROM executions e
      WHERE e.${ACTIVE_SQL} AND e.started_at < now() - make_interval(hours => $1::int)
        AND ${NOT_TREATED('US_PARADA', 'e.id::text')}
     ON CONFLICT (type, dedupe_key) WHERE status = 'open' DO UPDATE SET details = EXCLUDED.details`,
    [STALE_HOURS],
  );
  // Prompts que alteraram código e ficaram sem classificação (10 min de folga para o hook fechar o turno).
  await query(
    `INSERT INTO inconsistencies (actor_id, execution_id, type, severity, dedupe_key, details)
     SELECT t.actor_id, t.execution_id, 'TURNO_NAO_CLASSIFICADO', 'low', t.execution_id::text,
            jsonb_build_object('turnos', count(*), 'linhas', sum(t.lines_added + t.lines_removed))
       FROM prompt_turns t
      WHERE t.execution_id IS NOT NULL AND t.kind IS NULL AND (t.lines_added + t.lines_removed) > 0
        AND COALESCE(t.ended_at, t.started_at) < now() - interval '10 minutes'
        AND ${NOT_TREATED('TURNO_NAO_CLASSIFICADO', 't.execution_id::text')}
      GROUP BY t.actor_id, t.execution_id
     ON CONFLICT (type, dedupe_key) WHERE status = 'open' DO UPDATE SET details = EXCLUDED.details`,
  );
  await query(
    `INSERT INTO inconsistencies (actor_id, execution_id, type, severity, dedupe_key, details)
     SELECT t.actor_id, t.execution_id, 'CLASSIFICACAO_DIVERGENTE', 'low', t.execution_id::text,
            jsonb_build_object('turnos', count(*), 'motivo', 'classificado como sem_codigo, mas alterou linhas')
       FROM prompt_turns t
      WHERE t.execution_id IS NOT NULL AND t.kind = 'sem_codigo' AND (t.lines_added + t.lines_removed) > 0
        AND ${NOT_TREATED('CLASSIFICACAO_DIVERGENTE', 't.execution_id::text')}
      GROUP BY t.actor_id, t.execution_id
     ON CONFLICT (type, dedupe_key) WHERE status = 'open' DO UPDATE SET details = EXCLUDED.details`,
  );
  // Auto-resolução quando a causa deixou de existir.
  await query(
    `UPDATE inconsistencies i SET status = 'resolved', resolved_at = now(), resolved_by = 'automático',
            resolution_note = 'Todos os prompts com código foram classificados'
      WHERE i.status = 'open' AND i.type = 'TURNO_NAO_CLASSIFICADO'
        AND NOT EXISTS (SELECT 1 FROM prompt_turns t WHERE t.execution_id = i.execution_id AND t.kind IS NULL AND (t.lines_added + t.lines_removed) > 0)`,
  );
  await query(
    `UPDATE inconsistencies i SET status = 'resolved', resolved_at = now(), resolved_by = 'automático',
            resolution_note = 'Classificação corrigida'
      WHERE i.status = 'open' AND i.type = 'CLASSIFICACAO_DIVERGENTE'
        AND NOT EXISTS (SELECT 1 FROM prompt_turns t WHERE t.execution_id = i.execution_id AND t.kind = 'sem_codigo' AND (t.lines_added + t.lines_removed) > 0)`,
  );
  await query(
    `UPDATE inconsistencies i SET status = 'resolved', resolved_at = now(), resolved_by = 'automático',
            resolution_note = 'A US foi encerrada ou já está registrada como deixada aberta ao iniciar outra'
      WHERE i.status = 'open' AND i.type = 'US_PARADA'
        AND EXISTS (SELECT 1 FROM executions e WHERE e.id = i.execution_id AND e.status IN ('done','cancelled','inconsistent'))`,
  );
}

const CLOSING_TYPES = ['US_PARADA', 'US_ABERTA_AO_INICIAR_OUTRA'];

// ---------- Etapas e evidências ----------

export async function advanceStageForGate(client, executionId, gate) {
  const next = GATE_NEXT_STAGE[gate];
  if (!next) return null;
  const current = await client.query(`SELECT status FROM executions WHERE id = $1 AND ${ACTIVE_SQL}`, [executionId]);
  if (!current.rowCount) return null;
  const from = STAGE_ORDER.indexOf(current.rows[0].status);
  if (from === -1 || from >= STAGE_ORDER.indexOf(next)) return current.rows[0].status;
  await client.query('UPDATE executions SET status = $2 WHERE id = $1', [executionId, next]);
  return next;
}

export async function missingEvidence(client, executionId) {
  const result = await client.query(
    `SELECT gate FROM approvals WHERE execution_id = $1 AND decision = 'approved' AND gate = ANY($2::text[])`,
    [executionId, EXPECTED_GATES],
  );
  const present = new Set(result.rows.map((r) => r.gate));
  return EXPECTED_GATES.filter((g) => !present.has(g));
}

// Conclusão pelo ABE: nunca recusa. Falta de evidência vira inconsistência.
export async function completeExecution(id) {
  return transaction(async (client) => {
    const current = await client.query(
      `SELECT e.*, wi.external_ref FROM executions e JOIN work_items wi ON wi.id = e.work_item_id WHERE e.id = $1 FOR UPDATE OF e`,
      [id],
    );
    if (!current.rowCount) throw fail(404, 'Execução não encontrada');
    const before = current.rows[0];
    if (['done', 'cancelled'].includes(before.status)) {
      return { ...before, already_closed: true, missing_evidence: [] };
    }
    const updated = await client.query(
      `UPDATE executions SET previous_status = status, status = 'done', ended_at = now(), close_reason = COALESCE(close_reason, 'concluida_pelo_abe')
        WHERE id = $1 RETURNING *`,
      [id],
    );
    await client.query(`UPDATE work_items SET status = 'done' WHERE id = $1`, [before.work_item_id]);
    await autoResolve(client, { executionId: id, types: CLOSING_TYPES, note: 'US concluída pelo ABE' });
    const missing = await missingEvidence(client, id);
    if (missing.length) {
      await recordInconsistency(client, {
        actorId: before.abe_id, executionId: id, type: 'CONCLUSAO_SEM_EVIDENCIA', dedupeKey: id,
        details: { faltando: missing, us: before.external_ref },
      });
    }
    return {
      ...updated.rows[0],
      external_ref: before.external_ref,
      missing_evidence: missing,
      ...(missing.length ? {
        agent_instruction: `A US ${before.external_ref} foi concluída, mas sem as aprovações: ${missing.join(', ')}. Isso ficou registrado como inconsistência para tratativa manual. Informe o ABE em uma linha e siga.`,
      } : {}),
    };
  });
}

// ---------- Turnos ----------

const int = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v)) : 0);

async function resolveActorId(client, actor, body) {
  if (actor) return actor.id;
  if (!body.abe_email) throw fail(400, 'Campos obrigatórios: abe_email (ao usar a chave administrativa)');
  const found = await client.query('SELECT id FROM actors WHERE lower(email) = lower($1) ORDER BY created_at LIMIT 1', [body.abe_email]);
  if (!found.rowCount) throw fail(404, 'ABE não encontrado');
  return found.rows[0].id;
}

export async function upsertTurn(body, actor) {
  for (const field of ['turn_key', 'claude_session_id', 'started_at']) {
    if (!body[field]) throw fail(400, `Campos obrigatórios: ${field}`);
  }
  const kind = TURN_KINDS.includes(body.kind) ? body.kind : null;
  const fixOrigin = kind === 'correcao' && FIX_ORIGINS.includes(body.fix_origin) ? body.fix_origin : null;

  return transaction(async (client) => {
    const actorId = await resolveActorId(client, actor, body);
    let executionId = null;
    if (body.execution_id) {
      const owned = await client.query('SELECT id FROM executions WHERE id = $1 AND abe_id = $2', [body.execution_id, actorId]);
      executionId = owned.rowCount ? owned.rows[0].id : null;
    }
    const result = await client.query(
      `INSERT INTO prompt_turns
         (turn_key, actor_id, execution_id, claude_session_id, seq, prompt_hash, prompt_kind, started_at, ended_at, model,
          input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, subagent_tokens,
          lines_added, lines_removed, files_changed, files_reedited, tool_calls, tool_failures,
          kind, fix_origin, classified_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23, CASE WHEN $22::text IS NULL THEN NULL ELSE 'agente' END)
       ON CONFLICT (turn_key) DO UPDATE SET
         execution_id = COALESCE(prompt_turns.execution_id, EXCLUDED.execution_id),
         ended_at = COALESCE(EXCLUDED.ended_at, prompt_turns.ended_at),
         model = COALESCE(EXCLUDED.model, prompt_turns.model),
         input_tokens = GREATEST(prompt_turns.input_tokens, EXCLUDED.input_tokens),
         output_tokens = GREATEST(prompt_turns.output_tokens, EXCLUDED.output_tokens),
         cache_read_tokens = GREATEST(prompt_turns.cache_read_tokens, EXCLUDED.cache_read_tokens),
         cache_creation_tokens = GREATEST(prompt_turns.cache_creation_tokens, EXCLUDED.cache_creation_tokens),
         subagent_tokens = GREATEST(prompt_turns.subagent_tokens, EXCLUDED.subagent_tokens),
         lines_added = GREATEST(prompt_turns.lines_added, EXCLUDED.lines_added),
         lines_removed = GREATEST(prompt_turns.lines_removed, EXCLUDED.lines_removed),
         files_changed = GREATEST(prompt_turns.files_changed, EXCLUDED.files_changed),
         files_reedited = GREATEST(prompt_turns.files_reedited, EXCLUDED.files_reedited),
         tool_calls = GREATEST(prompt_turns.tool_calls, EXCLUDED.tool_calls),
         tool_failures = GREATEST(prompt_turns.tool_failures, EXCLUDED.tool_failures),
         kind = CASE WHEN prompt_turns.classified_by = 'gestor' THEN prompt_turns.kind ELSE COALESCE(EXCLUDED.kind, prompt_turns.kind) END,
         fix_origin = CASE WHEN prompt_turns.classified_by = 'gestor' THEN prompt_turns.fix_origin
                           WHEN EXCLUDED.kind IS NOT NULL THEN EXCLUDED.fix_origin ELSE prompt_turns.fix_origin END,
         classified_by = CASE WHEN prompt_turns.classified_by = 'gestor' THEN 'gestor'
                              WHEN EXCLUDED.kind IS NOT NULL THEN 'agente' ELSE prompt_turns.classified_by END
       WHERE prompt_turns.actor_id = EXCLUDED.actor_id
       RETURNING id, execution_id, kind, lines_added, lines_removed`,
      [
        String(body.turn_key).slice(0, 80), actorId, executionId, String(body.claude_session_id).slice(0, 200),
        int(body.seq), body.prompt_hash ? String(body.prompt_hash).slice(0, 128) : null,
        body.prompt_kind === 'comando' ? 'comando' : 'prompt', body.started_at, body.ended_at ?? null,
        body.model ? String(body.model).slice(0, 100) : null,
        int(body.input_tokens), int(body.output_tokens), int(body.cache_read_tokens), int(body.cache_creation_tokens), int(body.subagent_tokens),
        int(body.lines_added), int(body.lines_removed), int(body.files_changed), int(body.files_reedited), int(body.tool_calls), int(body.tool_failures),
        kind, fixOrigin,
      ],
    );
    if (!result.rowCount) throw fail(409, 'Turno pertence a outro ABE');
    const turn = result.rows[0];

    if (turn.execution_id) {
      await client.query(
        `INSERT INTO agent_sessions (execution_id, claude_session_id) VALUES ($1, $2)
         ON CONFLICT (execution_id, claude_session_id) DO UPDATE SET last_seen_at = now()`,
        [turn.execution_id, body.claude_session_id],
      );
      // Turnos anteriores da MESMA sessão sem US (ex.: exploração antes do /lynse-start) passam para esta US.
      const attached = await client.query(
        `UPDATE prompt_turns SET execution_id = $1
          WHERE claude_session_id = $2 AND actor_id = $3 AND execution_id IS NULL AND started_at <= $4
          RETURNING id`,
        [turn.execution_id, body.claude_session_id, actorId, body.started_at],
      );
      if (attached.rowCount) {
        await autoResolve(client, { sessionId: body.claude_session_id, types: ['SESSAO_SEM_US'], note: 'US iniciada na mesma sessão; prompts anteriores vinculados a ela' });
      }
    } else if (turn.lines_added + turn.lines_removed > 0) {
      const totals = await client.query(
        `SELECT count(*)::int AS turnos, COALESCE(sum(lines_added + lines_removed), 0)::int AS linhas
           FROM prompt_turns WHERE claude_session_id = $1 AND actor_id = $2 AND execution_id IS NULL`,
        [body.claude_session_id, actorId],
      );
      await recordInconsistency(client, {
        actorId, sessionId: body.claude_session_id, type: 'SESSAO_SEM_US', dedupeKey: body.claude_session_id,
        details: totals.rows[0],
      });
    }
    return { id: turn.id, execution_id: turn.execution_id, kind: turn.kind };
  });
}

// Liga uma aprovação ao prompt do ABE que a originou. Nunca recusa: sem evidência, registra inconsistência.
export async function approvalEvidence(client, { executionId, actorId, gate, turnKey, evidence }) {
  if (evidence === 'manual') return { evidence: 'manual', promptTurnId: null };
  if (!turnKey) {
    // Sem referência a prompt: comando explícito (/lynse-approve) ou integração. Só a aprovação
    // em linguagem natural (marcador do agente) exige o prompt do ABE como evidência.
    if (evidence !== 'turno_abe') return { evidence: 'comando', promptTurnId: null };
    await recordInconsistency(client, {
      actorId, executionId, type: 'APROVACAO_SEM_EVIDENCIA', dedupeKey: `${executionId}:${gate}`,
      details: { gate, motivo: 'aprovação sem referência a um prompt do ABE' },
    });
    return { evidence: 'sem_evidencia', promptTurnId: null };
  }
  const turn = await client.query(
    `SELECT t.id, t.claude_session_id, t.started_at,
            NOT EXISTS (SELECT 1 FROM prompt_turns n WHERE n.claude_session_id = t.claude_session_id AND n.started_at > t.started_at) AS is_latest
       FROM prompt_turns t WHERE t.turn_key = $1 AND t.actor_id = $2`,
    [turnKey, actorId],
  );
  const row = turn.rows[0];
  if (!row || !row.is_latest) {
    await recordInconsistency(client, {
      actorId, executionId, type: 'APROVACAO_SEM_EVIDENCIA', dedupeKey: `${executionId}:${gate}`,
      details: { gate, motivo: row ? 'a aprovação não veio do prompt mais recente do ABE' : 'prompt de origem não encontrado' },
    });
    return { evidence: 'sem_evidencia', promptTurnId: row?.id ?? null };
  }
  return { evidence: evidence === 'comando' ? 'comando' : 'turno_abe', promptTurnId: row.id };
}

// ---------- Contexto para o início de sessão ----------

export async function getContext(actor, { repositoryHash, repositorySlug } = {}) {
  // Com a chave administrativa não há "ABE dono": o kit não deve sincronizar nada a partir daqui.
  if (!actor) return { available: false, active: null, open_inconsistencies: 0, stale_hours: STALE_HOURS };
  await detectInconsistencies().catch(() => {});
  const [active, open] = await Promise.all([
    query(
      `SELECT e.id, e.status, e.mode, e.started_at, wi.external_ref, wi.title, p.slug AS project_slug, r.slug AS repository_slug,
              (e.context_snapshot->>'git_remote_hash') AS git_remote_hash,
              (SELECT max(s.last_seen_at) FROM agent_sessions s WHERE s.execution_id = e.id) AS last_activity_at,
              round(extract(epoch FROM now() - e.started_at) / 3600)::int AS hours_open
         FROM executions e
         JOIN work_items wi ON wi.id = e.work_item_id
         JOIN repositories r ON r.id = e.repository_id
         JOIN projects p ON p.id = r.project_id
        WHERE e.abe_id = $1 AND e.${ACTIVE_SQL}
        ORDER BY e.started_at DESC LIMIT 1`,
      [actor.id],
    ),
    query(`SELECT count(*)::int AS n FROM inconsistencies WHERE actor_id = $1 AND status = 'open'`, [actor.id]),
  ]);
  const a = active.rows[0];
  return {
    available: true,
    active: a ? {
      id: a.id, status: a.status, mode: a.mode, started_at: a.started_at, external_ref: a.external_ref, title: a.title,
      project_slug: a.project_slug, repository_slug: a.repository_slug, last_activity_at: a.last_activity_at, hours_open: a.hours_open,
      same_repository: Boolean((repositoryHash && a.git_remote_hash === repositoryHash) || (!a.git_remote_hash && repositorySlug && a.repository_slug === repositorySlug)),
      stale: a.hours_open >= STALE_HOURS,
    } : null,
    open_inconsistencies: open.rows[0].n,
    stale_hours: STALE_HOURS,
  };
}

// ---------- Leitura: inconsistências e ajustes ----------

export async function listInconsistencies({ organizationSlug, projectSlug, abeEmail, days, status = 'open', type } = {}, actor = null) {
  await detectInconsistencies().catch(() => {});
  const n = Math.min(Math.max(Number.isFinite(days) ? Math.trunc(days) : 30, 1), 3650);
  const since = new Date(Date.now() - n * 86_400_000).toISOString();
  const result = await query(
    `SELECT i.id, i.type, i.severity, i.status, i.details, i.detected_at, i.updated_at, i.resolved_at, i.resolved_by, i.resolution_note,
            i.claude_session_id, i.execution_id,
            a.id AS actor_id, a.email AS abe_email, a.display_name, o.slug AS organization_slug,
            wi.external_ref, wi.title, e.status AS execution_status, e.started_at AS execution_started_at, e.ended_at AS execution_ended_at,
            p.slug AS project_slug, p.name AS project_name
       FROM inconsistencies i
       JOIN actors a ON a.id = i.actor_id
       JOIN organizations o ON o.id = a.organization_id
       LEFT JOIN executions e ON e.id = i.execution_id
       LEFT JOIN work_items wi ON wi.id = e.work_item_id
       LEFT JOIN repositories r ON r.id = e.repository_id
       LEFT JOIN projects p ON p.id = r.project_id
      WHERE ($1::text IS NULL OR o.slug = $1)
        AND ($2::text IS NULL OR p.slug = $2)
        AND ($3::text IS NULL OR lower(a.email) = lower($3))
        AND ($4::uuid IS NULL OR a.id = $4)
        AND ($5::text IS NULL OR i.type = $5)
        AND (CASE $6::text WHEN 'open' THEN i.status = 'open'
                           WHEN 'treated' THEN i.status <> 'open' AND i.resolved_at >= $7
                           ELSE (i.status = 'open' OR i.detected_at >= $7 OR i.resolved_at >= $7) END)
      ORDER BY (i.status = 'open') DESC, CASE i.severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, i.detected_at DESC
      LIMIT 1000`,
    [organizationSlug || null, projectSlug || null, abeEmail || null, actor?.id ?? null, type || null, status, since],
  );
  const items = result.rows.map((r) => ({ ...r, label: INCONSISTENCY_TYPES[r.type]?.label ?? r.type }));
  const byActor = new Map();
  for (const r of items) {
    if (!byActor.has(r.abe_email)) byActor.set(r.abe_email, { abe_email: r.abe_email, display_name: r.display_name, actor_id: r.actor_id, open: 0, treated: 0, high_open: 0, by_type: {} });
    const g = byActor.get(r.abe_email);
    if (r.status === 'open') { g.open += 1; if (r.severity === 'high') g.high_open += 1; } else g.treated += 1;
    g.by_type[r.type] = (g.by_type[r.type] ?? 0) + 1;
  }
  return {
    window: { days: n, start: since },
    types: Object.fromEntries(Object.entries(INCONSISTENCY_TYPES).map(([k, v]) => [k, v.label])),
    stale_hours: STALE_HOURS,
    items,
    by_actor: [...byActor.values()].sort((a, b) => b.open - a.open || b.treated - a.treated),
  };
}

export async function listAdjustments({ abeEmail, days } = {}) {
  const n = Math.min(Math.max(Number.isFinite(days) ? Math.trunc(days) : 30, 1), 3650);
  const result = await query(
    `SELECT m.id, m.action, m.performed_by, m.reason, m.before, m.after, m.created_at,
            a.email AS abe_email, a.display_name, wi.external_ref, twi.external_ref AS target_external_ref
       FROM manual_adjustments m
       LEFT JOIN actors a ON a.id = m.actor_id
       LEFT JOIN executions e ON e.id = m.execution_id
       LEFT JOIN work_items wi ON wi.id = e.work_item_id
       LEFT JOIN executions te ON te.id = m.target_execution_id
       LEFT JOIN work_items twi ON twi.id = te.work_item_id
      WHERE ($1::text IS NULL OR lower(a.email) = lower($1)) AND m.created_at >= now() - make_interval(days => $2::int)
      ORDER BY m.created_at DESC LIMIT 300`,
    [abeEmail || null, n],
  );
  return { items: result.rows };
}

export async function getExecutionTurns(executionId) {
  const result = await query(
    `SELECT t.id, t.seq, t.claude_session_id, t.prompt_kind, t.started_at, t.ended_at, t.model,
            t.input_tokens, t.output_tokens, t.cache_read_tokens, t.cache_creation_tokens, t.subagent_tokens,
            t.lines_added, t.lines_removed, t.files_changed, t.files_reedited, t.tool_calls, t.tool_failures,
            t.kind, t.fix_origin, t.classified_by
       FROM prompt_turns t WHERE t.execution_id = $1 ORDER BY t.started_at`,
    [executionId],
  );
  return result.rows;
}

// ---------- Ajustes manuais (somente chave administrativa) ----------

async function logAdjustment(client, { action, actorId, executionId = null, targetExecutionId = null, promptTurnId = null, inconsistencyId = null, performedBy, reason, before = {}, after = {} }) {
  await client.query(
    `INSERT INTO manual_adjustments (action, actor_id, execution_id, target_execution_id, prompt_turn_id, inconsistency_id, performed_by, reason, before, after)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb)`,
    [action, actorId, executionId, targetExecutionId, promptTurnId, inconsistencyId, performedBy, reason, JSON.stringify(before), JSON.stringify(after)],
  );
}

function requireReason(body) {
  const reason = String(body.reason ?? '').trim();
  if (reason.length < 5) throw fail(400, 'Informe o motivo do ajuste (mínimo de 5 caracteres)');
  return reason.slice(0, 1000);
}
const performer = (body) => String(body.performed_by ?? '').trim().slice(0, 120) || 'gestor';
const snap = (e) => ({ status: e.status, ended_at: e.ended_at, close_reason: e.close_reason });

const ADJUST_ACTIONS = new Set(['complete', 'cancel', 'reopen', 'merge', 'add_approval', 'set_ended_at']);

export async function adjustExecution(id, body) {
  if (!ADJUST_ACTIONS.has(body.action)) throw fail(400, `Ação inválida. Use: ${[...ADJUST_ACTIONS].join(', ')}`);
  const reason = requireReason(body);
  const by = performer(body);

  return transaction(async (client) => {
    const found = await client.query(
      `SELECT e.*, wi.external_ref FROM executions e JOIN work_items wi ON wi.id = e.work_item_id WHERE e.id = $1 FOR UPDATE OF e`,
      [id],
    );
    if (!found.rowCount) throw fail(404, 'Execução não encontrada');
    const before = found.rows[0];
    const note = `Ajuste manual (${by}): ${reason}`;
    let after;
    let targetId = null;

    if (body.action === 'complete' || body.action === 'cancel') {
      const status = body.action === 'complete' ? 'done' : 'cancelled';
      const endedAt = body.ended_at ? new Date(body.ended_at) : new Date();
      if (Number.isNaN(endedAt.getTime())) throw fail(400, 'Data de fim inválida');
      if (endedAt < new Date(before.started_at)) throw fail(400, 'A data de fim não pode ser anterior ao início da execução');
      after = (await client.query(
        `UPDATE executions SET previous_status = status, status = $2, ended_at = $3, close_reason = 'ajuste_manual', manually_adjusted = true
          WHERE id = $1 RETURNING *`,
        [id, status, endedAt.toISOString()],
      )).rows[0];
      await client.query(
        `UPDATE work_items SET status = $2 WHERE id = $1
           AND NOT EXISTS (SELECT 1 FROM executions o WHERE o.work_item_id = $1 AND o.id <> $3 AND o.${ACTIVE_SQL})`,
        [before.work_item_id, status, id],
      );
      await autoResolve(client, { executionId: id, types: [...CLOSING_TYPES, ...(status === 'cancelled' ? ['CONCLUSAO_SEM_EVIDENCIA'] : [])], note });
    } else if (body.action === 'reopen') {
      if (!['done', 'cancelled', 'inconsistent'].includes(before.status)) throw fail(400, 'A execução já está ativa');
      const back = STAGE_ORDER.includes(before.previous_status) ? before.previous_status : 'building';
      await client.query('SELECT id FROM actors WHERE id = $1 FOR UPDATE', [before.abe_id]);
      const other = await client.query(
        `SELECT wi.external_ref FROM executions e JOIN work_items wi ON wi.id = e.work_item_id
          WHERE e.abe_id = $1 AND e.id <> $2 AND e.${ACTIVE_SQL} LIMIT 1`,
        [before.abe_id, id],
      );
      if (other.rowCount) {
        throw fail(409, `O ABE já tem outra US ativa (${other.rows[0].external_ref}). Conclua, cancele ou ajuste aquela antes de reabrir esta.`);
      }
      after = (await client.query(
        `UPDATE executions SET previous_status = status, status = $2, ended_at = NULL, close_reason = NULL, manually_adjusted = true
          WHERE id = $1 RETURNING *`,
        [id, back],
      )).rows[0];
      await client.query(`UPDATE work_items SET status = 'in_progress' WHERE id = $1`, [before.work_item_id]);
      await autoResolve(client, { executionId: id, types: ['US_ABERTA_AO_INICIAR_OUTRA'], note });
    } else if (body.action === 'set_ended_at') {
      if (!['done', 'cancelled'].includes(before.status)) throw fail(400, 'Só é possível corrigir a data de fim de uma execução encerrada');
      const endedAt = new Date(body.ended_at);
      if (Number.isNaN(endedAt.getTime()) || endedAt < new Date(before.started_at)) throw fail(400, 'Data de fim inválida');
      after = (await client.query(`UPDATE executions SET ended_at = $2, manually_adjusted = true WHERE id = $1 RETURNING *`, [id, endedAt.toISOString()])).rows[0];
    } else if (body.action === 'add_approval') {
      if (!['plan', 'pr', 'deploy', 'rollback', 'close'].includes(body.gate)) throw fail(400, 'Gate inválido');
      await client.query(
        `INSERT INTO approvals (execution_id, actor_id, gate, decision, rationale, evidence) VALUES ($1, $2, $3, 'approved', $4, 'manual')`,
        [id, before.abe_id, body.gate, note],
      );
      await advanceStageForGate(client, id, body.gate);
      await client.query('UPDATE executions SET manually_adjusted = true WHERE id = $1', [id]);
      await client.query(
        `UPDATE inconsistencies SET status = 'resolved', resolved_at = now(), resolved_by = $3, resolution_note = $4
          WHERE status = 'open' AND type = 'APROVACAO_SEM_EVIDENCIA' AND dedupe_key = $1 || ':' || $2`,
        [id, body.gate, by, note],
      );
      if (before.status === 'done' && !(await missingEvidence(client, id)).length) {
        await autoResolve(client, { executionId: id, types: ['CONCLUSAO_SEM_EVIDENCIA'], note });
      }
      after = (await client.query('SELECT * FROM executions WHERE id = $1', [id])).rows[0];
      after.gate = body.gate;
    } else if (body.action === 'merge') {
      targetId = body.target_execution_id;
      if (!targetId || targetId === id) throw fail(400, 'Informe a execução de destino (diferente desta)');
      const target = await client.query('SELECT id, abe_id FROM executions WHERE id = $1', [targetId]);
      if (!target.rowCount) throw fail(404, 'Execução de destino não encontrada');
      await client.query(
        `DELETE FROM agent_sessions s WHERE s.execution_id = $1
           AND EXISTS (SELECT 1 FROM agent_sessions t WHERE t.execution_id = $2 AND t.claude_session_id = s.claude_session_id)`,
        [id, targetId],
      );
      for (const table of ['agent_sessions', 'audit_events', 'policy_decisions', 'approvals', 'pull_requests', 'deployments', 'prompt_turns']) {
        await client.query(`UPDATE ${table} SET execution_id = $2 WHERE execution_id = $1`, [id, targetId]);
      }
      await autoResolve(client, { executionId: id, types: Object.keys(INCONSISTENCY_TYPES), note: `${note} (mesclada em outra execução)` });
      after = (await client.query(
        `UPDATE executions SET previous_status = status, status = 'cancelled', ended_at = COALESCE(ended_at, now()), close_reason = 'mesclada', manually_adjusted = true
          WHERE id = $1 RETURNING *`,
        [id],
      )).rows[0];
      await client.query('UPDATE executions SET manually_adjusted = true WHERE id = $1', [targetId]);
      // Se a mesclada era a US ativa do ABE e o destino estava inconsistente, o destino assume o lugar dela.
      if (!['done', 'cancelled', 'inconsistent'].includes(before.status)) {
        const reactivated = await client.query(
          `UPDATE executions SET status = CASE WHEN previous_status = ANY($2::text[]) THEN previous_status ELSE 'building' END,
                  previous_status = 'inconsistent', close_reason = NULL
            WHERE id = $1 AND status = 'inconsistent' AND abe_id = $3 RETURNING id`,
          [targetId, STAGE_ORDER, before.abe_id],
        );
        if (reactivated.rowCount) await autoResolve(client, { executionId: targetId, types: ['US_ABERTA_AO_INICIAR_OUTRA'], note: `${note} (assumiu como US ativa)` });
      }
    }

    await logAdjustment(client, {
      action: body.action, actorId: before.abe_id, executionId: id, targetExecutionId: targetId,
      performedBy: by, reason, before: snap(before), after: { ...snap(after), ...(after.gate ? { gate: after.gate } : {}) },
    });
    return { ...after, external_ref: before.external_ref };
  });
}

export async function classifyTurnManually(turnId, body) {
  const reason = requireReason(body);
  if (!TURN_KINDS.includes(body.kind)) throw fail(400, `Tipo inválido. Use: ${TURN_KINDS.join(', ')}`);
  const fixOrigin = body.kind === 'correcao' ? (FIX_ORIGINS.includes(body.fix_origin) ? body.fix_origin : null) : null;
  if (body.kind === 'correcao' && !fixOrigin) throw fail(400, `Informe a origem da correção: ${FIX_ORIGINS.join(', ')}`);
  const result = await transaction(async (client) => {
    const found = await client.query('SELECT * FROM prompt_turns WHERE id = $1 FOR UPDATE', [turnId]);
    if (!found.rowCount) throw fail(404, 'Turno não encontrado');
    const before = found.rows[0];
    const after = (await client.query(
      `UPDATE prompt_turns SET kind = $2, fix_origin = $3, classified_by = 'gestor' WHERE id = $1 RETURNING *`,
      [turnId, body.kind, fixOrigin],
    )).rows[0];
    await logAdjustment(client, {
      action: 'classify_turn', actorId: before.actor_id, executionId: before.execution_id, promptTurnId: turnId,
      performedBy: performer(body), reason,
      before: { kind: before.kind, fix_origin: before.fix_origin, classified_by: before.classified_by },
      after: { kind: after.kind, fix_origin: after.fix_origin, classified_by: 'gestor' },
    });
    return after;
  });
  await detectInconsistencies().catch(() => {});
  return result;
}

export async function assignTurns(body) {
  const reason = requireReason(body);
  if (!body.execution_id) throw fail(400, 'Campos obrigatórios: execution_id');
  if (!body.claude_session_id && !(Array.isArray(body.turn_ids) && body.turn_ids.length)) throw fail(400, 'Informe claude_session_id ou turn_ids');
  return transaction(async (client) => {
    const execution = await client.query('SELECT id, abe_id FROM executions WHERE id = $1', [body.execution_id]);
    if (!execution.rowCount) throw fail(404, 'Execução não encontrada');
    const moved = await client.query(
      `UPDATE prompt_turns SET execution_id = $1
        WHERE actor_id = $2
          AND (($3::text IS NOT NULL AND claude_session_id = $3 AND execution_id IS NULL) OR id = ANY($4::uuid[]))
        RETURNING id, claude_session_id`,
      [body.execution_id, execution.rows[0].abe_id, body.claude_session_id ?? null, Array.isArray(body.turn_ids) ? body.turn_ids : []],
    );
    const sessions = [...new Set(moved.rows.map((r) => r.claude_session_id))];
    for (const sessionId of sessions) {
      await client.query(
        `INSERT INTO agent_sessions (execution_id, claude_session_id) VALUES ($1, $2) ON CONFLICT (execution_id, claude_session_id) DO NOTHING`,
        [body.execution_id, sessionId],
      );
      const remaining = await client.query('SELECT 1 FROM prompt_turns WHERE claude_session_id = $1 AND execution_id IS NULL LIMIT 1', [sessionId]);
      if (!remaining.rowCount) await autoResolve(client, { sessionId, types: ['SESSAO_SEM_US'], note: `Prompts vinculados manualmente: ${reason}` });
    }
    await logAdjustment(client, {
      action: 'assign_turns', actorId: execution.rows[0].abe_id, executionId: body.execution_id, performedBy: performer(body), reason,
      after: { turnos: moved.rowCount, sessoes: sessions.length },
    });
    return { moved: moved.rowCount, sessions: sessions.length };
  });
}

export async function resolveInconsistency(id, body) {
  const reason = requireReason(body);
  const status = body.status === 'justified' ? 'justified' : 'resolved';
  const by = performer(body);
  return transaction(async (client) => {
    const result = await client.query(
      `UPDATE inconsistencies SET status = $2, resolved_at = now(), resolved_by = $3, resolution_note = $4
        WHERE id = $1 AND status = 'open' RETURNING *`,
      [id, status, by, reason],
    );
    if (!result.rowCount) throw fail(404, 'Inconsistência não encontrada ou já tratada');
    const row = result.rows[0];
    await logAdjustment(client, {
      action: status === 'justified' ? 'justify_inconsistency' : 'resolve_inconsistency',
      actorId: row.actor_id, executionId: row.execution_id, inconsistencyId: id, performedBy: by, reason,
      before: { status: 'open', type: row.type }, after: { status },
    });
    return row;
  });
}
