import http from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { config } from './config.mjs';
import { closePool, query, transaction } from './db.mjs';
import { evaluatePolicy } from './policy-engine.mjs';
import { parseLogRequest, parseMetricRequest, summarizeMeasurements } from './otel.mjs';

const EXECUTION_STATUSES = new Set([
  'briefing', 'planning', 'building', 'verifying', 'release', 'observing',
  'done', 'blocked', 'cancelled',
]);

class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

function send(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

function apiKeyMatches(received) {
  const expectedBuffer = Buffer.from(config.apiKey);
  const receivedBuffer = Buffer.from(received ?? '');
  return expectedBuffer.length === receivedBuffer.length && timingSafeEqual(expectedBuffer, receivedBuffer);
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

async function startExecution(body) {
  requireFields(body, ['external_ref', 'project_slug', 'repository_slug', 'abe_email']);
  const mode = ['audit', 'enforcement'].includes(body.mode) ? body.mode : config.defaultMode;

  return transaction(async (client) => {
    const context = await client.query(
      `SELECT p.id AS project_id, p.organization_id, r.id AS repository_id
         FROM projects p
         JOIN repositories r ON r.project_id = p.id
        WHERE p.slug = $1 AND r.slug = $2`,
      [body.project_slug, body.repository_slug],
    );
    if (!context.rowCount) throw new HttpError(404, 'Projeto ou repositório não encontrado');
    const ids = context.rows[0];

    if (body.claude_session_id) {
      const existing = await client.query(
        `SELECT e.id, e.status, e.mode, e.started_at, wi.external_ref, wi.title
           FROM agent_sessions s
           JOIN executions e ON e.id = s.execution_id
           JOIN work_items wi ON wi.id = e.work_item_id
          WHERE s.claude_session_id = $1
            AND e.status NOT IN ('done','cancelled')
          ORDER BY e.started_at DESC LIMIT 1`,
        [body.claude_session_id],
      );
      if (existing.rowCount) return { ...existing.rows[0], reused: true };
    }

    const actor = await client.query(
      `INSERT INTO actors (organization_id, email, display_name, role)
       VALUES ($1, $2, $3, 'abe')
       ON CONFLICT (organization_id, email) DO UPDATE
         SET display_name = COALESCE(NULLIF(EXCLUDED.display_name, ''), actors.display_name)
       RETURNING id`,
      [ids.organization_id, body.abe_email, body.abe_name ?? body.abe_email.split('@')[0]],
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
         (work_item_id, repository_id, abe_id, mode, status, branch_name, context_snapshot)
       VALUES ($1, $2, $3, $4, 'planning', $5, $6::jsonb)
       RETURNING id, status, mode, started_at`,
      [
        workItem.rows[0].id,
        ids.repository_id,
        actor.rows[0].id,
        mode,
        body.branch_name ?? null,
        JSON.stringify(body.context_snapshot ?? {}),
      ],
    );

    if (body.claude_session_id) {
      await client.query(
        `INSERT INTO agent_sessions
          (execution_id, claude_session_id, model, cwd)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (execution_id, claude_session_id) DO UPDATE SET
           model = COALESCE(EXCLUDED.model, agent_sessions.model),
           cwd = COALESCE(EXCLUDED.cwd, agent_sessions.cwd),
           last_seen_at = now()`,
        [execution.rows[0].id, body.claude_session_id, body.model ?? null, body.cwd ?? null],
      );
    }

    return {
      ...execution.rows[0],
      external_ref: workItem.rows[0].external_ref,
      title: workItem.rows[0].title,
      reused: false,
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

async function createApproval(body) {
  requireFields(body, ['execution_id', 'abe_email', 'gate', 'decision']);
  if (!['plan', 'pr', 'deploy', 'rollback', 'close'].includes(body.gate)) {
    throw new HttpError(400, 'Gate inválido');
  }
  if (!['approved', 'rejected', 'changes_requested'].includes(body.decision)) {
    throw new HttpError(400, 'Decisão inválida');
  }
  const actor = await query(
    `SELECT a.id
       FROM actors a
       JOIN executions e ON e.abe_id = a.id
      WHERE e.id = $1 AND a.email = $2`,
    [body.execution_id, body.abe_email],
  );
  if (!actor.rowCount) throw new HttpError(404, 'ABE não encontrado para esta execução');
  const result = await query(
    `INSERT INTO approvals (execution_id, actor_id, gate, decision, rationale)
     VALUES ($1,$2,$3,$4,$5)
     RETURNING *`,
    [body.execution_id, actor.rows[0].id, body.gate, body.decision, body.rationale ?? null],
  );
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

async function updateExecutionStatus(id, body) {
  requireFields(body, ['status']);
  if (!EXECUTION_STATUSES.has(body.status)) throw new HttpError(400, 'Status inválido');
  const result = await query(
    `UPDATE executions SET status = $2,
       ended_at = CASE WHEN $2 IN ('done','cancelled') THEN COALESCE(ended_at,now()) ELSE ended_at END
     WHERE id = $1 RETURNING *`,
    [id, body.status],
  );
  if (!result.rowCount) throw new HttpError(404, 'Execução não encontrada');
  return result.rows[0];
}

async function completeExecution(id) {
  const gates = await query(
    `SELECT
       EXISTS (SELECT 1 FROM approvals WHERE execution_id = $1 AND gate = 'plan' AND decision = 'approved') AS plan,
       EXISTS (SELECT 1 FROM approvals WHERE execution_id = $1 AND gate = 'pr' AND decision = 'approved') AS pr,
       EXISTS (SELECT 1 FROM approvals WHERE execution_id = $1 AND gate = 'deploy' AND decision = 'approved') AS deploy,
       EXISTS (SELECT 1 FROM deployments WHERE execution_id = $1 AND environment = 'prod' AND status = 'succeeded') AS production`,
    [id],
  );
  const evidence = gates.rows[0];
  const missing = Object.entries(evidence).filter(([, present]) => !present).map(([name]) => name);
  if (missing.length) {
    throw new HttpError(409, `Execução não pode ser encerrada. Evidências ausentes: ${missing.join(', ')}`, evidence);
  }
  return updateExecutionStatus(id, { status: 'done' });
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

  if (!apiKeyMatches(request.headers['x-api-key'])) throw new HttpError(401, 'API key inválida');

  if (request.method === 'POST' && pathname === '/api/v1/executions/start') {
    return send(response, 201, await startExecution(await readJson(request)));
  }
  if (request.method === 'GET' && pathname === '/api/v1/executions') {
    return send(response, 200, await listExecutions(url));
  }
  if (request.method === 'POST' && pathname === '/api/v1/events') {
    return send(response, 202, await registerEvent(await readJson(request)));
  }
  if (request.method === 'POST' && pathname === '/api/v1/policies/evaluate') {
    return send(response, 200, await evaluateAndStorePolicy(await readJson(request)));
  }
  if (request.method === 'POST' && pathname === '/api/v1/approvals') {
    return send(response, 201, await createApproval(await readJson(request)));
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

  const statusPath = matchPath(pathname, /^\/api\/v1\/executions\/(?<id>[0-9a-f-]+)\/status$/i);
  if (request.method === 'PATCH' && statusPath) {
    return send(response, 200, await updateExecutionStatus(statusPath.id, await readJson(request)));
  }
  const completePath = matchPath(pathname, /^\/api\/v1\/executions\/(?<id>[0-9a-f-]+)\/complete$/i);
  if (request.method === 'POST' && completePath) {
    return send(response, 200, await completeExecution(completePath.id));
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
  route(request, response).catch((error) => {
    const status = error.status ?? (error.code === '23503' ? 409 : 500);
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
