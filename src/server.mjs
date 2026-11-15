import http from 'node:http';
import { randomBytes, createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.mjs';
import { closePool, query, transaction } from './db.mjs';
import { evaluatePolicy } from './policy-engine.mjs';
import { parseLogRequest, parseMetricRequest, summarizeMeasurements } from './otel.mjs';
import {
  getByActor,
  getByOrganization,
  getByProject,
  getExecutions,
  getFilterOptions,
  getPromptAnalytics,
  getSummary as getAnalyticsSummary,
  getTimeseries,
  getUsage,
} from './analytics.mjs';
import { deleteActor, getActorImpact, listActors } from './actors-admin.mjs';
import {
  ACTIVE_SQL,
  adjustExecution,
  advanceStageForGate,
  approvalEvidence,
  assignTurns,
  autoResolve,
  classifyTurnManually,
  completeExecution,
  getContext,
  getExecutionTurns,
  listAdjustments,
  listInconsistencies,
  recordInconsistency,
  resolveInconsistency,
  upsertTurn,
} from './process.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DASHBOARD_PATH = resolve(__dirname, '../public/dashboard.html');

const EXECUTION_STATUSES = new Set([
  'briefing', 'planning', 'building', 'verifying', 'release', 'observing',
  'done', 'blocked', 'cancelled', 'inconsistent',
]);
const STAGES = ['briefing', 'planning', 'building', 'verifying', 'release', 'observing'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'access-control-allow-headers': 'content-type, x-api-key',
  'access-control-max-age': '600',
};

function send(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...CORS_HEADERS,
  });
  response.end(JSON.stringify(body));
}

function apiKeyMatches(received) {
  const expectedBuffer = Buffer.from(config.apiKey);
  const receivedBuffer = Buffer.from(received ?? '');
  return expectedBuffer.length === receivedBuffer.length && timingSafeEqual(expectedBuffer, receivedBuffer);
}

function hashApiKey(rawKey) {
  return createHash('sha256').update(rawKey).digest('hex');
}

async function resolveActor(receivedKey) {
  if (!receivedKey) return null;
  const result = await query(
    `SELECT a.id, a.email, a.display_name, a.organization_id, o.slug AS organization_slug
       FROM api_keys k
       JOIN actors a ON a.id = k.actor_id
       JOIN organizations o ON o.id = a.organization_id
      WHERE k.key_hash = $1 AND k.revoked_at IS NULL`,
    [hashApiKey(receivedKey)],
  );
  return result.rowCount ? result.rows[0] : null;
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > config.bodyLimitBytes) throw new HttpError(413, 'Corpo da requisição excede o limite');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'JSON inválido');
  }
}

function requireFields(body, fields) {
  const missing = fields.filter((field) => body[field] === undefined || body[field] === null || body[field] === '');
  if (missing.length) throw new HttpError(400, `Campos obrigatórios: ${missing.join(', ')}`);
}

function matchPath(pathname, expression) {
  const match = pathname.match(expression);
  return match ? match.groups ?? {} : null;
}

async function linkSession(client, executionId, body) {
  await client.query(
    `INSERT INTO agent_sessions
      (execution_id, claude_session_id, model, cwd)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (execution_id, claude_session_id) DO UPDATE SET
       model = COALESCE(EXCLUDED.model, agent_sessions.model),
       cwd = COALESCE(EXCLUDED.cwd, agent_sessions.cwd),
       last_seen_at = now()`,
    [executionId, body.claude_session_id, body.model ?? null, body.cwd ?? null],
  );
}

async function startExecution(body, actor) {
  requireFields(body, actor ? ['external_ref', 'repository_slug'] : ['external_ref', 'project_slug', 'repository_slug', 'abe_email']);
  const mode = ['audit', 'enforcement'].includes(body.mode) ? body.mode : config.defaultMode;
  const projectSlug = body.project_slug || body.repository_slug;

  return transaction(async (client) => {
    let ids;
    if (actor) {
      const context = await client.query(
        `SELECT p.id AS project_id, p.organization_id, r.id AS repository_id
           FROM projects p
           JOIN repositories r ON r.project_id = p.id
          WHERE p.slug = $1 AND r.slug = $2 AND p.organization_id = $3`,
        [projectSlug, body.repository_slug, actor.organization_id],
      );
      if (context.rowCount) {
        ids = context.rows[0];
      } else {
        const project = await client.query(
          `INSERT INTO projects (organization_id, slug, name)
           VALUES ($1, $2, $3)
           ON CONFLICT (organization_id, slug) DO UPDATE SET name = projects.name
           RETURNING id, organization_id`,
          [actor.organization_id, projectSlug, body.project_name ?? projectSlug],
        );
        const repository = await client.query(
          `INSERT INTO repositories (project_id, slug, remote_url, default_branch)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (project_id, slug) DO UPDATE SET
             remote_url = COALESCE(EXCLUDED.remote_url, repositories.remote_url)
           RETURNING id`,
          [project.rows[0].id, body.repository_slug, body.context_snapshot?.git_remote ?? null, body.default_branch ?? 'main'],
        );
        ids = { project_id: project.rows[0].id, organization_id: actor.organization_id, repository_id: repository.rows[0].id };
      }
    } else {
      const context = await client.query(
        `SELECT p.id AS project_id, p.organization_id, r.id AS repository_id
           FROM projects p
           JOIN repositories r ON r.project_id = p.id
          WHERE p.slug = $1 AND r.slug = $2`,
        [projectSlug, body.repository_slug],
      );
      if (!context.rowCount) throw new HttpError(404, 'Projeto ou repositório não encontrado');
      ids = context.rows[0];
    }

    let abeId = actor?.id;
    if (!abeId) {
      const abe = await client.query(
        `INSERT INTO actors (organization_id, email, display_name, role)
         VALUES ($1, $2, $3, 'abe')
         ON CONFLICT (organization_id, email) DO UPDATE
           SET display_name = COALESCE(NULLIF(EXCLUDED.display_name, ''), actors.display_name)
         RETURNING id`,
        [ids.organization_id, body.abe_email, body.abe_name ?? body.abe_email.split('@')[0]],
      );
      abeId = abe.rows[0].id;
    }

    // Serializa os inícios do mesmo ABE: duas sessões ao mesmo tempo não criam duplicidade.
    await client.query('SELECT id FROM actors WHERE id = $1 FOR UPDATE', [abeId]);

    // A mesma US do mesmo ABE é sempre retomada (inclusive de outra sessão do Claude Code ou depois
    // de ter sido marcada como inconsistente). Uma US diferente nunca reaproveita a execução de outra.
    const sameWorkItem = await client.query(
      `SELECT e.id, e.status, e.previous_status, e.mode, e.started_at, wi.external_ref, wi.title
         FROM executions e
         JOIN work_items wi ON wi.id = e.work_item_id
        WHERE wi.project_id = $1 AND wi.external_ref = $2 AND e.abe_id = $3
          AND e.status NOT IN ('done','cancelled')
        ORDER BY (e.status <> 'inconsistent') DESC, e.started_at DESC LIMIT 1`,
      [ids.project_id, body.external_ref, abeId],
    );
    const resumable = sameWorkItem.rows[0] ?? null;

    // Uma US ativa por ABE. Se outra ficou aberta, ela vira "inconsistente" e a nova segue:
    // o trabalho do ABE nunca é bloqueado; o agente avisa e a tratativa é manual.
    const others = await client.query(
      `SELECT e.id, e.status, e.started_at, wi.external_ref, wi.title, p.slug AS project_slug
         FROM executions e
         JOIN work_items wi ON wi.id = e.work_item_id
         JOIN repositories r ON r.id = e.repository_id
         JOIN projects p ON p.id = r.project_id
        WHERE e.abe_id = $1 AND e.${ACTIVE_SQL}
          AND ($2::uuid IS NULL OR e.id <> $2)`,
      [abeId, resumable?.id ?? null],
    );
    const previous = [];
    for (const other of others.rows) {
      await client.query(
        `UPDATE executions SET previous_status = status, status = 'inconsistent', close_reason = 'aberta_ao_iniciar_outra' WHERE id = $1`,
        [other.id],
      );
      await recordInconsistency(client, {
        actorId: abeId, executionId: other.id, type: 'US_ABERTA_AO_INICIAR_OUTRA', dedupeKey: other.id,
        details: { status_anterior: other.status, nova_us: body.external_ref },
      });
      previous.push({ id: other.id, external_ref: other.external_ref, title: other.title, project_slug: other.project_slug, status: other.status, started_at: other.started_at });
    }
    const notice = previous.length ? {
      previous_marked_inconsistent: previous,
      agent_instruction: `A US ${previous.map((p) => p.external_ref).join(', ')} ainda estava aberta e foi registrada como inconsistente (o trabalho segue normalmente). `
        + 'Avise o ABE em uma linha e pergunte se ela já foi concluída. Se ele confirmar, rode /lynse-finish com o id dela; se não, apenas siga — a tratativa será manual.',
    } : {};

    if (resumable) {
      let resumed = resumable;
      if (resumable.status === 'inconsistent') {
        const back = STAGES.includes(resumable.previous_status) ? resumable.previous_status : 'building';
        resumed = { ...resumable, ...(await client.query(
          `UPDATE executions SET status = $2, previous_status = 'inconsistent', close_reason = NULL WHERE id = $1 RETURNING id, status, mode, started_at`,
          [resumable.id, back],
        )).rows[0] };
        await autoResolve(client, { executionId: resumable.id, types: ['US_ABERTA_AO_INICIAR_OUTRA'], note: 'US retomada pelo ABE' });
      }
      if (body.claude_session_id) await linkSession(client, resumed.id, body);
      const { previous_status: _ignored, ...out } = resumed;
      return { ...out, reused: true, ...notice };
    }

    const reopenOf = await client.query(
      `SELECT e.id FROM executions e JOIN work_items wi ON wi.id = e.work_item_id
        WHERE wi.project_id = $1 AND wi.external_ref = $2 AND e.abe_id = $3 AND e.status = 'done'
        ORDER BY e.ended_at DESC NULLS LAST LIMIT 1`,
      [ids.project_id, body.external_ref, abeId],
    );

    const workItem = await client.query(
      `INSERT INTO work_items
         (project_id, external_ref, title, description, acceptance_criteria, risk_level, status)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, 'in_progress')
       ON CONFLICT (project_id, external_ref) DO UPDATE SET
         title = CASE WHEN $7::boolean THEN EXCLUDED.title ELSE work_items.title END,
         description = COALESCE(EXCLUDED.description, work_items.description),
         acceptance_criteria = CASE
           WHEN EXCLUDED.acceptance_criteria = '[]'::jsonb THEN work_items.acceptance_criteria
           ELSE EXCLUDED.acceptance_criteria
         END,
         risk_level = EXCLUDED.risk_level,
         status = 'in_progress'
       RETURNING id, external_ref, title`,
      [
        ids.project_id,
        body.external_ref,
        body.title ?? body.external_ref,
        body.description ?? null,
        JSON.stringify(body.acceptance_criteria ?? []),
        ['low', 'medium', 'high'].includes(body.risk_level) ? body.risk_level : 'medium',
        body.title !== undefined,
      ],
    );

    const execution = await client.query(
      `INSERT INTO executions
         (work_item_id, repository_id, abe_id, mode, status, branch_name, context_snapshot, reopen_of)
       VALUES ($1, $2, $3, $4, 'planning', $5, $6::jsonb, $7)
       RETURNING id, status, mode, started_at`,
      [
        workItem.rows[0].id,
        ids.repository_id,
        abeId,
        mode,
        body.branch_name ?? null,
        JSON.stringify(body.context_snapshot ?? {}),
        reopenOf.rows[0]?.id ?? null,
      ],
    );

    if (body.claude_session_id) await linkSession(client, execution.rows[0].id, body);

    return {
      ...execution.rows[0],
      external_ref: workItem.rows[0].external_ref,
      title: workItem.rows[0].title,
      reused: false,
      ...(reopenOf.rowCount ? {
        reopened: true,
        reopen_note: `A US ${body.external_ref} já tinha sido concluída antes; esta nova execução conta como reabertura (retrabalho pós-entrega).`,
      } : {}),
      ...notice,
    };
  });
}

async function registerEvent(body) {
  requireFields(body, ['execution_id', 'event_type']);
  const occurredAt = body.occurred_at ?? new Date().toISOString();
  const idempotencyKey = body.idempotency_key ?? randomUUID();

  return transaction(async (client) => {
    let sessionId = null;
    if (body.claude_session_id) {
      const session = await client.query(
        `INSERT INTO agent_sessions
          (execution_id, claude_session_id, model, cwd)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (execution_id, claude_session_id) DO UPDATE SET
           model = COALESCE(EXCLUDED.model, agent_sessions.model),
           cwd = COALESCE(EXCLUDED.cwd, agent_sessions.cwd),
           last_seen_at = now(),
           ended_at = CASE WHEN $5 = 'SessionEnd' THEN now() ELSE agent_sessions.ended_at END
         RETURNING id`,
        [body.execution_id, body.claude_session_id, body.model ?? null, body.cwd ?? null, body.event_type],
      );
      sessionId = session.rows[0].id;
    }

    const inserted = await client.query(
      `INSERT INTO audit_events
        (execution_id, session_id, idempotency_key, event_type, source, tool_name,
         risk_level, duration_ms, payload, occurred_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id, received_at`,
      [
        body.execution_id,
        sessionId,
        idempotencyKey,
        body.event_type,
        body.source ?? 'claude-hook',
        body.tool_name ?? null,
        body.risk_level ?? null,
        Number.isFinite(body.duration_ms) ? body.duration_ms : null,
        JSON.stringify(body.payload ?? {}),
        occurredAt,
      ],
    );
    return inserted.rowCount ? { ...inserted.rows[0], duplicate: false } : { duplicate: true };
  });
}

async function evaluateAndStorePolicy(body) {
  requireFields(body, ['execution_id']);
  const execution = await query('SELECT mode FROM executions WHERE id = $1', [body.execution_id]);
  if (!execution.rowCount) throw new HttpError(404, 'Execução não encontrada');
  const mode = ['audit', 'enforcement'].includes(body.mode) ? body.mode : execution.rows[0].mode;
  const result = evaluatePolicy({ ...body, mode });
  await query(
    `INSERT INTO policy_decisions
      (execution_id, claude_session_id, rule_code, decision, risk_level, reason, mode, input_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      body.execution_id,
      body.claude_session_id ?? null,
      result.rule_code,
      result.recorded_decision,
      result.risk_level,
      result.reason,
      mode,
      result.input_hash,
    ],
  );
  return { ...result, mode };
}

async function recordPolicyDecision(body) {
  requireFields(body, ['execution_id', 'rule_code', 'decision', 'risk_level', 'reason', 'mode', 'input_hash']);
  if (!['allow', 'ask', 'block', 'would_block'].includes(body.decision)) throw new HttpError(400, 'Decisão inválida');
  if (!['low', 'medium', 'high', 'critical'].includes(body.risk_level)) throw new HttpError(400, 'Nível de risco inválido');
  if (!['audit', 'enforcement'].includes(body.mode)) throw new HttpError(400, 'Modo inválido');
  const result = await query(
    `INSERT INTO policy_decisions
      (execution_id, claude_session_id, rule_code, decision, risk_level, reason, mode, input_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING id`,
    [
      body.execution_id, body.claude_session_id ?? null, String(body.rule_code).slice(0, 64),
      body.decision, body.risk_level, String(body.reason).slice(0, 500), body.mode, String(body.input_hash).slice(0, 128),
    ],
  );
  return { id: result.rows[0].id };
}

async function createApproval(body, actor) {
  const abeEmail = actor?.email ?? body.abe_email;
  requireFields({ ...body, abe_email: abeEmail }, ['execution_id', 'abe_email', 'gate', 'decision']);
  if (!['plan', 'pr', 'deploy', 'rollback', 'close'].includes(body.gate)) {
    throw new HttpError(400, 'Gate inválido');
  }
  if (!['approved', 'rejected', 'changes_requested'].includes(body.decision)) {
    throw new HttpError(400, 'Decisão inválida');
  }
  const approver = actor?.id
    ? await query(
        `SELECT a.id FROM actors a JOIN executions e ON e.abe_id = a.id WHERE e.id = $1 AND a.id = $2`,
        [body.execution_id, actor.id],
      )
    : await query(
        `SELECT a.id
           FROM actors a
           JOIN executions e ON e.abe_id = a.id
          WHERE e.id = $1 AND a.email = $2`,
        [body.execution_id, abeEmail],
      );
  if (!approver.rowCount) throw new HttpError(404, 'ABE não encontrado para esta execução');
  const approverId = approver.rows[0].id;
  return transaction(async (client) => {
    const evidence = await approvalEvidence(client, {
      executionId: body.execution_id, actorId: approverId, gate: body.gate, turnKey: body.turn_key ?? null,
      evidence: body.evidence === 'manual' && actor ? 'comando' : body.evidence,
    });
    if (evidence.promptTurnId) {
      const existing = await client.query(
        'SELECT * FROM approvals WHERE execution_id = $1 AND gate = $2 AND prompt_turn_id = $3 LIMIT 1',
        [body.execution_id, body.gate, evidence.promptTurnId],
      );
      if (existing.rowCount) return { ...existing.rows[0], duplicate: true };
    }
    const result = await client.query(
      `INSERT INTO approvals (execution_id, actor_id, gate, decision, rationale, prompt_turn_id, evidence)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING *`,
      [body.execution_id, approverId, body.gate, body.decision, body.rationale ? String(body.rationale).slice(0, 500) : null, evidence.promptTurnId, evidence.evidence],
    );
    const executionStatus = body.decision === 'approved' ? await advanceStageForGate(client, body.execution_id, body.gate) : null;
    return { ...result.rows[0], execution_status: executionStatus };
  });
}

async function createApiKey(body) {
  requireFields(body, ['email']);
  const organizationSlug = body.organization_slug || 'lynse-demo';
  const organization = await query('SELECT id FROM organizations WHERE slug = $1', [organizationSlug]);
  if (!organization.rowCount) throw new HttpError(404, `Organização '${organizationSlug}' não encontrada`);

  return transaction(async (client) => {
    const actorResult = await client.query(
      `INSERT INTO actors (organization_id, email, display_name, role)
       VALUES ($1, $2, $3, 'abe')
       ON CONFLICT (organization_id, email) DO UPDATE
         SET display_name = COALESCE(NULLIF(EXCLUDED.display_name, ''), actors.display_name)
       RETURNING id, email, display_name`,
      [organization.rows[0].id, body.email, body.display_name ?? body.email.split('@')[0]],
    );

    const rawKey = randomBytes(24).toString('hex');
    const created = await client.query(
      `INSERT INTO api_keys (actor_id, key_hash, label)
       VALUES ($1, $2, $3)
       RETURNING id, created_at`,
      [actorResult.rows[0].id, hashApiKey(rawKey), body.label ?? actorResult.rows[0].display_name],
    );

    return {
      id: created.rows[0].id,
      api_key: rawKey,
      email: actorResult.rows[0].email,
      display_name: actorResult.rows[0].display_name,
      organization_slug: organizationSlug,
      created_at: created.rows[0].created_at,
      note: 'Guarde esta chave agora — ela não pode ser recuperada depois.',
    };
  });
}

async function listApiKeys() {
  const result = await query(
    `SELECT k.id, a.email, a.display_name, k.label, k.created_at, k.revoked_at
       FROM api_keys k
       JOIN actors a ON a.id = k.actor_id
      ORDER BY k.created_at DESC`,
  );
  return result.rows;
}

async function revokeApiKey(id) {
  const result = await query(
    `UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING id, revoked_at`,
    [id],
  );
  if (!result.rowCount) throw new HttpError(404, 'Chave não encontrada ou já revogada');
  return result.rows[0];
}

async function registerPullRequest(body) {
  requireFields(body, ['execution_id', 'external_id']);
  const result = await query(
    `INSERT INTO pull_requests (execution_id, provider, external_id, url, status, payload, merged_at)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)
     ON CONFLICT (provider, external_id) DO UPDATE SET
       status = EXCLUDED.status,
       url = COALESCE(EXCLUDED.url, pull_requests.url),
       payload = pull_requests.payload || EXCLUDED.payload,
       merged_at = COALESCE(EXCLUDED.merged_at, pull_requests.merged_at)
     RETURNING *`,
    [
      body.execution_id,
      body.provider ?? 'github',
      String(body.external_id),
      body.url ?? null,
      body.status ?? 'open',
      JSON.stringify(body.payload ?? {}),
      body.merged_at ?? null,
    ],
  );
  return result.rows[0];
}

async function registerDeployment(body) {
  requireFields(body, ['execution_id', 'environment', 'status']);
  if (!['dev', 'hml', 'prod'].includes(body.environment)) throw new HttpError(400, 'Ambiente inválido');
  if (!['started', 'succeeded', 'failed', 'rolled_back'].includes(body.status)) {
    throw new HttpError(400, 'Status de deploy inválido');
  }
  return transaction(async (client) => {
    const result = await client.query(
      `INSERT INTO deployments
        (execution_id, environment, status, version, url, payload, started_at, finished_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,COALESCE($7::timestamptz,now()),$8)
       RETURNING *`,
      [
        body.execution_id, body.environment, body.status, body.version ?? null,
        body.url ?? null, JSON.stringify(body.payload ?? {}), body.started_at ?? null,
        body.finished_at ?? (body.status === 'started' ? null : new Date().toISOString()),
      ],
    );
    if (body.environment === 'prod' && body.status === 'succeeded') {
      await client.query("UPDATE executions SET status = 'observing' WHERE id = $1", [body.execution_id]);
    } else if (body.environment === 'prod' && body.status === 'failed') {
      await client.query("UPDATE executions SET status = 'blocked' WHERE id = $1", [body.execution_id]);
    }
    return result.rows[0];
  });
}

// Mudança de etapa vinda do kit. Nunca falha por causa do processo: em execução já encerrada ou
// inconsistente a mudança é ignorada (e informada), em vez de reabrir algo sem querer.
async function updateExecutionStatus(id, body) {
  requireFields(body, ['status']);
  if (body.status === 'done') return completeExecution(id);
  if (![...STAGES, 'blocked', 'cancelled'].includes(body.status)) throw new HttpError(400, 'Status inválido');
  return transaction(async (client) => {
    const current = await client.query('SELECT * FROM executions WHERE id = $1 FOR UPDATE', [id]);
    if (!current.rowCount) throw new HttpError(404, 'Execução não encontrada');
    if (['done', 'cancelled', 'inconsistent'].includes(current.rows[0].status)) {
      return { ...current.rows[0], ignored: true, note: `Execução está ${current.rows[0].status}; a etapa não foi alterada.` };
    }
    const result = await client.query(
      `UPDATE executions SET status = $2,
         ended_at = CASE WHEN $2 = 'cancelled' THEN COALESCE(ended_at, now()) ELSE ended_at END
       WHERE id = $1 RETURNING *`,
      [id, body.status],
    );
    if (body.status === 'cancelled') {
      await client.query(
        `UPDATE work_items SET status = 'cancelled' WHERE id = (SELECT work_item_id FROM executions WHERE id = $1)`,
        [id],
      );
      await autoResolve(client, { executionId: id, types: ['US_PARADA', 'US_ABERTA_AO_INICIAR_OUTRA'], note: 'US cancelada pelo ABE' });
    }
    return result.rows[0];
  });
}

async function getExecution(id) {
  const execution = await query(
    `SELECT e.*, wi.external_ref, wi.title, wi.description, wi.acceptance_criteria, wi.risk_level,
            p.slug AS project_slug, r.slug AS repository_slug, a.email AS abe_email
       FROM executions e
       JOIN work_items wi ON wi.id = e.work_item_id
       JOIN repositories r ON r.id = e.repository_id
       JOIN projects p ON p.id = r.project_id
       JOIN actors a ON a.id = e.abe_id
      WHERE e.id = $1`,
    [id],
  );
  if (!execution.rowCount) throw new HttpError(404, 'Execução não encontrada');
  const [sessions, approvals, pullRequests, deployments] = await Promise.all([
    query('SELECT * FROM agent_sessions WHERE execution_id = $1 ORDER BY started_at', [id]),
    query('SELECT * FROM approvals WHERE execution_id = $1 ORDER BY created_at', [id]),
    query('SELECT * FROM pull_requests WHERE execution_id = $1 ORDER BY created_at', [id]),
    query('SELECT * FROM deployments WHERE execution_id = $1 ORDER BY started_at', [id]),
  ]);
  return {
    ...execution.rows[0],
    sessions: sessions.rows,
    approvals: approvals.rows,
    pull_requests: pullRequests.rows,
    deployments: deployments.rows,
  };
}

async function listExecutions(url) {
  const requestedLimit = Number.parseInt(url.searchParams.get('limit') ?? '20', 10);
  const limit = Math.min(Math.max(Number.isFinite(requestedLimit) ? requestedLimit : 20, 1), 100);
  const status = url.searchParams.get('status');
  if (status && !EXECUTION_STATUSES.has(status)) throw new HttpError(400, 'Status inválido');
  const result = await query(
    `SELECT e.id, e.status, e.mode, e.started_at, e.ended_at,
            wi.external_ref, wi.title, p.slug AS project_slug,
            r.slug AS repository_slug, a.email AS abe_email
       FROM executions e
       JOIN work_items wi ON wi.id = e.work_item_id
       JOIN repositories r ON r.id = e.repository_id
       JOIN projects p ON p.id = r.project_id
       JOIN actors a ON a.id = e.abe_id
      WHERE ($1::text IS NULL OR e.status = $1)
      ORDER BY e.started_at DESC
      LIMIT $2`,
    [status, limit],
  );
  return { items: result.rows, count: result.rowCount };
}

async function getSummary(id) {
  const execution = await getExecution(id);
  const [events, policies, measurements] = await Promise.all([
    query(
      `SELECT event_type, count(*)::int AS count,
              COALESCE(sum(duration_ms),0)::bigint AS duration_ms
         FROM audit_events WHERE execution_id = $1 GROUP BY event_type ORDER BY event_type`,
      [id],
    ),
    query(
      `SELECT decision, risk_level, count(*)::int AS count
         FROM policy_decisions WHERE execution_id = $1
        GROUP BY decision, risk_level ORDER BY decision, risk_level`,
      [id],
    ),
    query(
      `SELECT om.* FROM otel_measurements om
        WHERE om.session_id IN
          (SELECT claude_session_id FROM agent_sessions WHERE execution_id = $1)
        ORDER BY om.received_at`,
      [id],
    ),
  ]);

  const end = execution.ended_at ? new Date(execution.ended_at) : new Date();
  const elapsedMs = Math.max(0, end - new Date(execution.started_at));
  const eventCount = events.rows.reduce((sum, item) => sum + item.count, 0);
  const toolCalls = events.rows
    .filter((item) => ['PreToolUse', 'PostToolUse', 'PostToolUseFailure'].includes(item.event_type))
    .reduce((sum, item) => sum + item.count, 0);

  return {
    execution: {
      id: execution.id,
      external_ref: execution.external_ref,
      title: execution.title,
      status: execution.status,
      mode: execution.mode,
      started_at: execution.started_at,
      ended_at: execution.ended_at,
      elapsed_ms: elapsedMs,
    },
    activity: {
      events: eventCount,
      tool_events: toolCalls,
      by_event: events.rows,
      policy_decisions: policies.rows,
      approvals: execution.approvals.length,
      pull_requests: execution.pull_requests.length,
      deployments: execution.deployments.length,
    },
    claude_code_metrics: summarizeMeasurements(measurements.rows),
    note: 'Tempo humano ativo e autoria fina de LOC exigem sinais adicionais de presença/diff; esta POC preserva os dados brutos para essa evolução.',
  };
}

async function storeOtelRows(rows) {
  if (!rows.length) return 0;
  return transaction(async (client) => {
    for (const row of rows) {
      await client.query(
        `INSERT INTO otel_measurements
          (signal, session_id, name, value, temporality, attributes, payload, observed_at)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8)`,
        [
          row.signal, row.session_id, row.name, row.value, row.temporality,
          JSON.stringify(row.attributes), JSON.stringify(row.payload), row.observed_at,
        ],
      );
    }
    return rows.length;
  });
}

async function route(request, response) {
  const url = new URL(request.url, `http://${request.headers.host ?? 'localhost'}`);
  const { pathname } = url;

  if (request.method === 'GET' && pathname === '/health') {
    await query('SELECT 1');
    return send(response, 200, { status: 'ok', service: 'lynse-control-plane', time: new Date().toISOString() });
  }

  if (request.method === 'GET' && (pathname === '/dashboard' || pathname === '/dashboard/')) {
    const html = await readFile(DASHBOARD_PATH, 'utf8');
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...CORS_HEADERS });
    return response.end(html);
  }

  const isAdmin = apiKeyMatches(request.headers['x-api-key']);
  const actor = isAdmin ? null : await resolveActor(request.headers['x-api-key']);
  if (!isAdmin && !actor) throw new HttpError(401, 'API key inválida');

  if (request.method === 'GET' && pathname === '/api/v1/me') {
    return send(response, 200, isAdmin
      ? { role: 'admin' }
      : { role: 'abe', email: actor.email, display_name: actor.display_name, organization_slug: actor.organization_slug });
  }
  if (request.method === 'GET' && pathname === '/api/v1/me/context') {
    return send(response, 200, await getContext(actor, {
      repositoryHash: url.searchParams.get('repository_hash'),
      repositorySlug: url.searchParams.get('repository_slug'),
    }));
  }

  const filters = {
    organizationSlug: url.searchParams.get('organization_slug') || null,
    projectSlug: url.searchParams.get('project_slug') || null,
    abeEmail: url.searchParams.get('abe_email') || null,
    days: Number.parseInt(url.searchParams.get('days') ?? '30', 10),
  };

  if (pathname.startsWith('/api/v1/admin/') && !isAdmin) throw new HttpError(403, 'Requer a chave administrativa');
  if (request.method === 'GET' && pathname === '/api/v1/admin/adjustments') {
    return send(response, 200, await listAdjustments(filters));
  }
  const adjustPath = matchPath(pathname, /^\/api\/v1\/admin\/executions\/(?<id>[0-9a-f-]{36})\/adjust$/i);
  if (request.method === 'POST' && adjustPath) {
    return send(response, 200, await adjustExecution(adjustPath.id, await readJson(request)));
  }
  const classifyPath = matchPath(pathname, /^\/api\/v1\/admin\/turns\/(?<id>[0-9a-f-]{36})\/classify$/i);
  if (request.method === 'POST' && classifyPath) {
    return send(response, 200, await classifyTurnManually(classifyPath.id, await readJson(request)));
  }
  if (request.method === 'POST' && pathname === '/api/v1/admin/turns/assign') {
    return send(response, 200, await assignTurns(await readJson(request)));
  }
  const resolvePath = matchPath(pathname, /^\/api\/v1\/admin\/inconsistencies\/(?<id>[0-9a-f-]{36})\/resolve$/i);
  if (request.method === 'POST' && resolvePath) {
    return send(response, 200, await resolveInconsistency(resolvePath.id, await readJson(request)));
  }
  if (request.method === 'GET' && pathname === '/api/v1/admin/actors') {
    return send(response, 200, await listActors());
  }
  const actorImpactPath = matchPath(pathname, /^\/api\/v1\/admin\/actors\/(?<id>[0-9a-f-]{36})\/impact$/i);
  if (request.method === 'GET' && actorImpactPath) {
    const result = await getActorImpact(actorImpactPath.id);
    if (!result) throw new HttpError(404, 'ABE não encontrado');
    return send(response, 200, result);
  }
  const actorPath = matchPath(pathname, /^\/api\/v1\/admin\/actors\/(?<id>[0-9a-f-]{36})$/i);
  if (request.method === 'DELETE' && actorPath) {
    const body = await readJson(request);
    const result = await deleteActor(actorPath.id, body.confirm_email);
    if (result.status === 'not_found') throw new HttpError(404, 'ABE não encontrado');
    if (result.status === 'confirmation_mismatch') throw new HttpError(400, 'O e-mail de confirmação não confere com o do ABE');
    return send(response, 200, result);
  }
  if (request.method === 'POST' && pathname === '/api/v1/admin/api-keys') {
    if (!isAdmin) throw new HttpError(403, 'Requer a chave administrativa');
    return send(response, 201, await createApiKey(await readJson(request)));
  }
  if (request.method === 'GET' && pathname === '/api/v1/admin/api-keys') {
    if (!isAdmin) throw new HttpError(403, 'Requer a chave administrativa');
    return send(response, 200, { items: await listApiKeys() });
  }
  const revokeKeyPath = matchPath(pathname, /^\/api\/v1\/admin\/api-keys\/(?<id>[0-9a-f-]+)\/revoke$/i);
  if (request.method === 'POST' && revokeKeyPath) {
    if (!isAdmin) throw new HttpError(403, 'Requer a chave administrativa');
    return send(response, 200, await revokeApiKey(revokeKeyPath.id));
  }

  if (request.method === 'POST' && pathname === '/api/v1/executions/start') {
    return send(response, 201, await startExecution(await readJson(request), actor));
  }
  if (request.method === 'GET' && pathname === '/api/v1/executions') {
    return send(response, 200, await listExecutions(url));
  }
  if (request.method === 'POST' && pathname === '/api/v1/turns') {
    return send(response, 201, await upsertTurn(await readJson(request), actor));
  }
  if (request.method === 'GET' && pathname === '/api/v1/inconsistencies') {
    return send(response, 200, await listInconsistencies({
      ...filters,
      status: ['open', 'treated', 'all'].includes(url.searchParams.get('status')) ? url.searchParams.get('status') : 'open',
      type: url.searchParams.get('type') || null,
    }, actor));
  }
  if (request.method === 'POST' && pathname === '/api/v1/events') {
    return send(response, 202, await registerEvent(await readJson(request)));
  }
  if (request.method === 'POST' && pathname === '/api/v1/policies/record') {
    return send(response, 201, await recordPolicyDecision(await readJson(request)));
  }
  if (request.method === 'POST' && pathname === '/api/v1/policies/evaluate') {
    return send(response, 200, await evaluateAndStorePolicy(await readJson(request)));
  }
  if (request.method === 'POST' && pathname === '/api/v1/approvals') {
    return send(response, 201, await createApproval(await readJson(request), actor));
  }
  if (request.method === 'POST' && pathname === '/api/v1/integrations/pr') {
    return send(response, 201, await registerPullRequest(await readJson(request)));
  }
  if (request.method === 'POST' && pathname === '/api/v1/integrations/deploy') {
    return send(response, 201, await registerDeployment(await readJson(request)));
  }
  if (request.method === 'POST' && pathname === '/otel/v1/metrics') {
    const accepted = await storeOtelRows(parseMetricRequest(await readJson(request)));
    return send(response, 200, { partialSuccess: {}, accepted });
  }
  if (request.method === 'POST' && pathname === '/otel/v1/logs') {
    const accepted = await storeOtelRows(parseLogRequest(await readJson(request)));
    return send(response, 200, { partialSuccess: {}, accepted });
  }

  if (request.method === 'GET' && pathname.startsWith('/api/v1/analytics/')) {
    const handlers = {
      '/api/v1/analytics/summary': () => getAnalyticsSummary(filters),
      '/api/v1/analytics/organizations': async () => ({ items: await getByOrganization(filters) }),
      '/api/v1/analytics/projects': async () => ({ items: await getByProject(filters) }),
      '/api/v1/analytics/actors': async () => ({ items: await getByActor(filters) }),
      '/api/v1/analytics/timeseries': async () => ({ items: await getTimeseries(filters) }),
      '/api/v1/analytics/usage': () => getUsage(filters),
      '/api/v1/analytics/filters': () => getFilterOptions(),
      '/api/v1/analytics/prompts': () => getPromptAnalytics(filters),
      '/api/v1/analytics/executions': () => getExecutions(filters),
    };
    if (handlers[pathname]) return send(response, 200, await handlers[pathname]());
  }

  const statusPath = matchPath(pathname, /^\/api\/v1\/executions\/(?<id>[0-9a-f-]+)\/status$/i);
  if (request.method === 'PATCH' && statusPath) {
    return send(response, 200, await updateExecutionStatus(statusPath.id, await readJson(request)));
  }
  const completePath = matchPath(pathname, /^\/api\/v1\/executions\/(?<id>[0-9a-f-]+)\/complete$/i);
  if (request.method === 'POST' && completePath) {
    return send(response, 200, await completeExecution(completePath.id));
  }
  const turnsPath = matchPath(pathname, /^\/api\/v1\/executions\/(?<id>[0-9a-f-]{36})\/turns$/i);
  if (request.method === 'GET' && turnsPath) {
    return send(response, 200, { items: await getExecutionTurns(turnsPath.id) });
  }
  const summaryPath = matchPath(pathname, /^\/api\/v1\/executions\/(?<id>[0-9a-f-]+)\/summary$/i);
  if (request.method === 'GET' && summaryPath) {
    return send(response, 200, await getSummary(summaryPath.id));
  }
  const executionPath = matchPath(pathname, /^\/api\/v1\/executions\/(?<id>[0-9a-f-]+)$/i);
  if (request.method === 'GET' && executionPath) {
    return send(response, 200, await getExecution(executionPath.id));
  }

  throw new HttpError(404, 'Rota não encontrada');
}

const server = http.createServer((request, response) => {
  if (request.method === 'OPTIONS') {
    response.writeHead(204, CORS_HEADERS);
    return response.end();
  }
  route(request, response).catch((error) => {
    const status = error.status ?? (['23503', '23505'].includes(error.code) ? 409 : ['22P02', '22007', '22008'].includes(error.code) ? 400 : 500);
    console.error(JSON.stringify({
      level: status >= 500 ? 'error' : 'warn',
      message: error.message,
      status,
      code: error.code,
    }));
    send(response, status, {
      error: status >= 500 ? 'Erro interno' : error.message,
      details: error.details,
    });
  });
});

server.listen(config.port, '0.0.0.0', () => {
  console.log(JSON.stringify({
    level: 'info',
    message: 'lynse_control_plane_started',
    port: config.port,
    mode: config.defaultMode,
  }));
});

async function shutdown(signal) {
  console.log(JSON.stringify({ level: 'info', message: 'shutdown', signal }));
  server.close(async () => {
    await closePool();
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
