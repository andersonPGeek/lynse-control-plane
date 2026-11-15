import { query } from './db.mjs';

const TIMEZONE = process.env.LYNSE_TIMEZONE || 'America/Sao_Paulo';

function toNumber(value) {
  return value === null || value === undefined ? null : Number(value);
}

function mapCountRow(row) {
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = key === 'count' ? Number(value) : value;
  }
  return out;
}

export function windowFor(days) {
  const n = Math.min(Math.max(Number.isFinite(days) ? Math.trunc(days) : 30, 1), 3650);
  const end = new Date();
  const start = new Date(end.getTime() - n * 86_400_000);
  const previousStart = new Date(start.getTime() - n * 86_400_000);
  return {
    days: n,
    start: start.toISOString(),
    end: end.toISOString(),
    previous_start: previousStart.toISOString(),
    previous_end: start.toISOString(),
  };
}

// $1 organização, $2 projeto, $3 início da janela, $4 fim da janela.
const SCOPE_JOIN = `
  JOIN repositories r ON r.id = e.repository_id
  JOIN projects p ON p.id = r.project_id
  JOIN organizations o ON o.id = p.organization_id`;
const SCOPE_WHERE = `($1::text IS NULL OR o.slug = $1) AND ($2::text IS NULL OR p.slug = $2)`;
// Filtro por ABE (e-mail), sempre no parâmetro indicado.
const ABE_WHERE = (n) => `($${n}::text IS NULL OR e.abe_id IN (SELECT ax.id FROM actors ax WHERE lower(ax.email) = lower($${n})))`;
const STARTED_IN = `(e.started_at >= $3 AND e.started_at < $4)`;
const DONE_IN = `(e.status = 'done' AND e.ended_at >= $3 AND e.ended_at < $4)`;
const OPEN = `(e.status NOT IN ('done', 'cancelled', 'blocked', 'inconsistent'))`;
const DURATION = `extract(epoch FROM (e.ended_at - e.started_at))`;

async function executionMetrics(scope, start, end) {
  const result = await query(
    `
    SELECT
      count(*) FILTER (WHERE ${STARTED_IN}) AS started,
      count(*) FILTER (WHERE ${DONE_IN}) AS done,
      count(*) FILTER (WHERE ${STARTED_IN} AND e.status = 'done') AS started_and_done,
      count(DISTINCT e.work_item_id) FILTER (WHERE ${DONE_IN}) AS work_items_done,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY ${DURATION}) FILTER (WHERE ${DONE_IN}) AS median_duration_seconds,
      percentile_cont(0.9) WITHIN GROUP (ORDER BY ${DURATION}) FILTER (WHERE ${DONE_IN}) AS p90_duration_seconds,
      count(*) FILTER (WHERE ${OPEN}) AS in_progress,
      count(*) FILTER (WHERE e.status = 'blocked') AS blocked,
      count(DISTINCT r.project_id) FILTER (WHERE ${STARTED_IN}) AS active_projects
    FROM executions e
    ${SCOPE_JOIN}
    WHERE ${SCOPE_WHERE} AND ${ABE_WHERE(5)}
    `,
    [scope.organizationSlug || null, scope.projectSlug || null, start, end, scope.abeEmail || null],
  );
  const row = result.rows[0];
  const started = toNumber(row.started);
  return {
    started,
    done: toNumber(row.done),
    completion_rate: started > 0 ? toNumber(row.started_and_done) / started : null,
    work_items_done: toNumber(row.work_items_done),
    median_duration_seconds: toNumber(row.median_duration_seconds),
    p90_duration_seconds: toNumber(row.p90_duration_seconds),
    in_progress: toNumber(row.in_progress),
    blocked: toNumber(row.blocked),
    active_projects: toNumber(row.active_projects),
  };
}

async function scopedGroupCount(table, timeColumn, groupColumns, scope, start, end, extraOrder = '') {
  const result = await query(
    `
    SELECT ${groupColumns.map((c) => `x.${c}`).join(', ')}, count(*)::int AS count
    FROM ${table} x
    JOIN executions e ON e.id = x.execution_id
    ${SCOPE_JOIN}
    WHERE ${SCOPE_WHERE} AND ${ABE_WHERE(5)}
      AND x.${timeColumn} >= $3 AND x.${timeColumn} < $4
    GROUP BY ${groupColumns.map((c) => `x.${c}`).join(', ')}
    ${extraOrder}
    `,
    [scope.organizationSlug || null, scope.projectSlug || null, start, end, scope.abeEmail || null],
  );
  return result.rows.map(mapCountRow);
}

function exceptionsCount(policyRows) {
  return policyRows.filter((r) => r.decision !== 'allow').reduce((sum, r) => sum + r.count, 0);
}

export async function getSummary({ organizationSlug, projectSlug, abeEmail, days } = {}) {
  const scope = { organizationSlug, projectSlug, abeEmail };
  const w = windowFor(days);

  const lastDone = query(
    `SELECT max(e.ended_at) AS last_done_at FROM executions e ${SCOPE_JOIN} WHERE ${SCOPE_WHERE} AND ${ABE_WHERE(3)} AND e.status = 'done'`,
    [organizationSlug || null, projectSlug || null, abeEmail || null],
  );
  const [current, previous, policy, previousPolicy, deployments, events, rules, lastDoneResult] = await Promise.all([
    executionMetrics(scope, w.start, w.end),
    executionMetrics(scope, w.previous_start, w.previous_end),
    scopedGroupCount('policy_decisions', 'created_at', ['decision', 'risk_level'], scope, w.start, w.end, 'ORDER BY 1, 2'),
    scopedGroupCount('policy_decisions', 'created_at', ['decision'], scope, w.previous_start, w.previous_end),
    scopedGroupCount('deployments', 'started_at', ['environment', 'status'], scope, w.start, w.end, 'ORDER BY 1, 2'),
    scopedGroupCount('audit_events', 'occurred_at', ['event_type'], scope, w.start, w.end, 'ORDER BY count DESC'),
    scopedGroupCount('policy_decisions', 'created_at', ['rule_code', 'decision'], scope, w.start, w.end, 'ORDER BY count DESC'),
    lastDone,
  ]);

  return {
    window: w,
    last_done_at: lastDoneResult.rows[0]?.last_done_at ?? null,
    executions: current,
    previous: {
      started: previous.started,
      done: previous.done,
      completion_rate: previous.completion_rate,
      median_duration_seconds: previous.median_duration_seconds,
      policy_exceptions: exceptionsCount(previousPolicy),
    },
    policy_decisions: policy,
    policy_exceptions: exceptionsCount(policy),
    policy_by_rule: rules.filter((r) => r.decision !== 'allow'),
    deployments,
    events_by_type: events,
  };
}

const DIMENSIONS = {
  organization: {
    select: 'o.slug AS organization_slug, o.name AS organization_name',
    group: 'o.slug, o.name',
    keys: ['organization_slug', 'organization_name'],
  },
  project: {
    select: 'o.slug AS organization_slug, p.slug AS project_slug, p.name AS project_name',
    group: 'o.slug, p.slug, p.name',
    keys: ['organization_slug', 'project_slug', 'project_name'],
  },
  actor: {
    select: 'o.slug AS organization_slug, a.email AS abe_email, a.display_name AS display_name',
    group: 'o.slug, a.email, a.display_name',
    keys: ['organization_slug', 'abe_email', 'display_name'],
  },
};

async function getBreakdown(dimension, { organizationSlug, projectSlug, abeEmail, days } = {}) {
  const dim = DIMENSIONS[dimension];
  const w = windowFor(days);
  const params = [organizationSlug || null, projectSlug || null, w.start, w.end, abeEmail || null];
  const result = await query(
    `
    SELECT
      ${dim.select},
      count(*) FILTER (WHERE ${STARTED_IN}) AS total_executions,
      count(*) FILTER (WHERE ${DONE_IN}) AS done_executions,
      count(*) FILTER (WHERE e.status = 'blocked') AS blocked_executions,
      count(*) FILTER (WHERE ${OPEN}) AS in_progress_executions,
      count(DISTINCT e.work_item_id) FILTER (WHERE ${STARTED_IN}) AS work_items_total,
      count(DISTINCT e.work_item_id) FILTER (WHERE ${DONE_IN}) AS work_items_done,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY ${DURATION}) FILTER (WHERE ${DONE_IN}) AS median_duration_seconds,
      percentile_cont(0.9) WITHIN GROUP (ORDER BY ${DURATION}) FILTER (WHERE ${DONE_IN}) AS p90_duration_seconds,
      max(e.started_at) AS last_execution_at
    FROM executions e
    ${SCOPE_JOIN}
    JOIN actors a ON a.id = e.abe_id
    WHERE ${SCOPE_WHERE} AND ${ABE_WHERE(5)}
      AND (${STARTED_IN} OR ${DONE_IN} OR ${OPEN} OR e.status = 'blocked')
    GROUP BY ${dim.group}
    ORDER BY total_executions DESC
    `,
    params,
  );

  let approvals = new Map();
  if (dimension === 'actor') {
    const appr = await query(
      `
      SELECT a.email, count(*)::int AS approvals_count
      FROM approvals ap
      JOIN executions e ON e.id = ap.execution_id
      ${SCOPE_JOIN}
      JOIN actors a ON a.id = ap.actor_id
      WHERE ${SCOPE_WHERE} AND ${ABE_WHERE(5)} AND ap.decision = 'approved' AND ap.created_at >= $3 AND ap.created_at < $4
      GROUP BY a.email
      `,
      params,
    );
    approvals = new Map(appr.rows.map((r) => [r.email, r.approvals_count]));
  }

  return result.rows.map((row) => ({
    ...Object.fromEntries(dim.keys.map((k) => [k, row[k]])),
    total_executions: toNumber(row.total_executions) ?? 0,
    done_executions: toNumber(row.done_executions) ?? 0,
    blocked_executions: toNumber(row.blocked_executions) ?? 0,
    in_progress_executions: toNumber(row.in_progress_executions) ?? 0,
    work_items_total: toNumber(row.work_items_total) ?? 0,
    work_items_done: toNumber(row.work_items_done) ?? 0,
    median_duration_seconds: toNumber(row.median_duration_seconds),
    p90_duration_seconds: toNumber(row.p90_duration_seconds),
    last_execution_at: row.last_execution_at,
    ...(dimension === 'actor' ? { approvals_count: approvals.get(row.abe_email) ?? 0 } : {}),
  }));
}

export const getByOrganization = (filters) => getBreakdown('organization', filters);
export const getByProject = (filters) => getBreakdown('project', filters);
export const getByActor = (filters) => getBreakdown('actor', filters);

export async function getExecutions({ organizationSlug, projectSlug, abeEmail, days } = {}) {
  const w = windowFor(days);
  const result = await query(
    `
    SELECT
      e.id, e.status, e.mode, e.started_at, e.ended_at, e.close_reason, e.manually_adjusted, e.reopen_of,
      wi.external_ref, wi.title,
      o.slug AS organization_slug, o.name AS organization_name,
      p.slug AS project_slug, p.name AS project_name,
      a.email AS abe_email, a.display_name,
      EXISTS (SELECT 1 FROM approvals ap WHERE ap.execution_id = e.id AND ap.gate = 'plan' AND ap.decision = 'approved') AS plan_approved,
      EXISTS (SELECT 1 FROM approvals ap WHERE ap.execution_id = e.id AND ap.gate = 'pr' AND ap.decision = 'approved') AS pr_approved,
      EXISTS (SELECT 1 FROM approvals ap WHERE ap.execution_id = e.id AND ap.gate = 'deploy' AND ap.decision = 'approved') AS deploy_approved,
      EXISTS (SELECT 1 FROM deployments d WHERE d.execution_id = e.id AND d.environment = 'prod' AND d.status = 'succeeded') AS prod_deployed,
      (SELECT max(s.last_seen_at) FROM agent_sessions s WHERE s.execution_id = e.id) AS last_activity_at,
      (SELECT count(*) FROM agent_sessions s WHERE s.execution_id = e.id)::int AS sessions_count,
      (SELECT count(*) FROM prompt_turns t WHERE t.execution_id = e.id)::int AS prompts_count,
      (SELECT count(*) FROM inconsistencies i WHERE i.execution_id = e.id AND i.status = 'open')::int AS open_inconsistencies
    FROM executions e
    ${SCOPE_JOIN}
    JOIN work_items wi ON wi.id = e.work_item_id
    JOIN actors a ON a.id = e.abe_id
    WHERE ${SCOPE_WHERE} AND ${ABE_WHERE(5)}
      AND (${STARTED_IN} OR ${DONE_IN} OR ${OPEN} OR e.status IN ('blocked', 'inconsistent'))
    ORDER BY e.started_at DESC
    LIMIT 500
    `,
    [organizationSlug || null, projectSlug || null, w.start, w.end, abeEmail || null],
  );
  return { window: w, items: result.rows };
}

export async function getFilterOptions() {
  const [projects, actors] = await Promise.all([
    query(`
      SELECT o.slug AS organization_slug, o.name AS organization_name, p.slug AS project_slug, p.name AS project_name
      FROM projects p JOIN organizations o ON o.id = p.organization_id
      ORDER BY o.name, p.name
    `),
    query(`
      SELECT a.email AS abe_email, a.display_name, o.slug AS organization_slug
      FROM actors a JOIN organizations o ON o.id = a.organization_id
      WHERE EXISTS (SELECT 1 FROM executions e WHERE e.abe_id = a.id)
         OR EXISTS (SELECT 1 FROM api_keys k WHERE k.actor_id = a.id AND k.revoked_at IS NULL)
      ORDER BY COALESCE(NULLIF(a.display_name, ''), a.email)
    `),
  ]);
  return { items: projects.rows, actors: actors.rows };
}

export async function getTimeseries({ organizationSlug, projectSlug, abeEmail, days } = {}) {
  const w = windowFor(days);
  const result = await query(
    `
    WITH scoped AS (
      SELECT (e.started_at AT TIME ZONE $5)::date AS started_day,
             CASE WHEN e.status = 'done' THEN (e.ended_at AT TIME ZONE $5)::date END AS done_day
      FROM executions e
      ${SCOPE_JOIN}
      WHERE ${SCOPE_WHERE} AND ${ABE_WHERE(6)}
        AND (${STARTED_IN} OR ${DONE_IN})
    ),
    days AS (
      SELECT generate_series(($3::timestamptz AT TIME ZONE $5)::date, ($4::timestamptz AT TIME ZONE $5)::date, interval '1 day')::date AS day
    )
    SELECT d.day::text AS day,
      (SELECT count(*) FROM scoped s WHERE s.started_day = d.day) AS started,
      (SELECT count(*) FROM scoped s WHERE s.done_day = d.day) AS done
    FROM days d
    ORDER BY d.day
    `,
    [organizationSlug || null, projectSlug || null, w.start, w.end, TIMEZONE, abeEmail || null],
  );

  return result.rows.map((row) => ({
    day: row.day,
    started: toNumber(row.started),
    done: toNumber(row.done),
  }));
}

const USAGE_METRIC_NAMES = ['claude_code.token.usage', 'claude_code.cost.usage'];
const TOKEN_TYPE_FIELD = {
  input: 'input_tokens',
  output: 'output_tokens',
  cacheRead: 'cache_read_tokens',
  cacheCreation: 'cache_creation_tokens',
};

async function reducedUsageRows({ organizationSlug, projectSlug, abeEmail, start, end } = {}) {
  const result = await query(
    `
    SELECT
      om.name, om.value, om.temporality, om.attributes, om.observed_at, om.session_id,
      e.id AS execution_id,
      a.email AS abe_email, a.display_name,
      wi.id AS work_item_id, wi.external_ref, wi.title AS work_item_title,
      p.slug AS project_slug, p.name AS project_name,
      o.slug AS organization_slug, o.name AS organization_name
    FROM otel_measurements om
    JOIN (
      SELECT DISTINCT ON (claude_session_id) claude_session_id, execution_id
        FROM agent_sessions
       ORDER BY claude_session_id, last_seen_at DESC
    ) sem ON sem.claude_session_id = om.session_id
    JOIN executions e ON e.id = sem.execution_id
    JOIN actors a ON a.id = e.abe_id
    JOIN work_items wi ON wi.id = e.work_item_id
    JOIN repositories r ON r.id = e.repository_id
    JOIN projects p ON p.id = r.project_id
    JOIN organizations o ON o.id = p.organization_id
    WHERE om.name = ANY($1::text[])
      AND ($2::text IS NULL OR o.slug = $2)
      AND ($3::text IS NULL OR p.slug = $3)
      AND COALESCE(om.observed_at, om.received_at) >= $4
      AND COALESCE(om.observed_at, om.received_at) < $5
      AND ($6::text IS NULL OR lower(a.email) = lower($6))
    `,
    [USAGE_METRIC_NAMES, organizationSlug || null, projectSlug || null, start, end, abeEmail || null],
  );

  return reduceUsageRows(result.rows);
}

export function reduceUsageRows(rawRows) {
  // 1) Descarta linhas duplicadas (mesma série, mesmo instante, mesmo valor): um lote OTLP reenviado
  //    após timeout (ex.: servidor acordando) seria somado duas vezes em métricas DELTA.
  // 2) Reduz cada série (todos os atributos, não só modelo/tipo) respeitando a temporalidade:
  //    DELTA soma, CUMULATIVE fica com o maior valor observado. As séries são somadas depois.
  const seen = new Set();
  const series = new Map();
  const diagnostics = { raw_rows: rawRows.length, duplicate_rows_removed: 0, delta_rows: 0, cumulative_rows: 0 };
  for (const row of rawRows) {
    const attributes = row.attributes ?? {};
    const attributesKey = JSON.stringify(Object.keys(attributes).sort().map((k) => [k, attributes[k]]));
    const value = Number(row.value ?? 0);
    const rowKey = [row.session_id, row.name, attributesKey, row.observed_at?.toISOString?.() ?? row.observed_at, value].join('|');
    if (seen.has(rowKey)) { diagnostics.duplicate_rows_removed += 1; continue; }
    seen.add(rowKey);

    const isDelta = Number(row.temporality) === 1;
    if (isDelta) diagnostics.delta_rows += 1; else diagnostics.cumulative_rows += 1;

    const model = attributes.model ?? 'desconhecido';
    const type = attributes.type ?? null;
    const key = [row.execution_id, row.session_id, row.name, attributesKey].join('|');
    const existing = series.get(key);
    if (!existing) {
      series.set(key, { ...row, model, type, value });
    } else if (isDelta) {
      existing.value += value;
    } else {
      existing.value = Math.max(existing.value, value);
    }
  }
  return { rows: [...series.values()], diagnostics };
}

function emptyUsageBucket() {
  return {
    input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0,
    cost_usd: 0, executions: new Set(),
  };
}

function addUsageRow(bucket, row) {
  if (row.name === 'claude_code.token.usage') {
    const field = TOKEN_TYPE_FIELD[row.type];
    if (field) bucket[field] += row.value;
  } else if (row.name === 'claude_code.cost.usage') {
    bucket.cost_usd += row.value;
  }
  bucket.executions.add(row.execution_id);
}

function finalizeUsageBucket(bucket, extra) {
  const total_tokens = bucket.input_tokens + bucket.output_tokens + bucket.cache_read_tokens + bucket.cache_creation_tokens;
  return {
    ...extra,
    input_tokens: Math.round(bucket.input_tokens),
    output_tokens: Math.round(bucket.output_tokens),
    cache_read_tokens: Math.round(bucket.cache_read_tokens),
    cache_creation_tokens: Math.round(bucket.cache_creation_tokens),
    total_tokens: Math.round(total_tokens),
    cost_usd: Math.round(bucket.cost_usd * 1e6) / 1e6,
    executions_with_usage: bucket.executions.size,
  };
}

function rollupUsage(rows, keyFn, extraFn) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (key === null || key === undefined) continue;
    if (!groups.has(key)) groups.set(key, { bucket: emptyUsageBucket(), extra: extraFn(row) });
    addUsageRow(groups.get(key).bucket, row);
  }
  return [...groups.values()]
    .map(({ bucket, extra }) => finalizeUsageBucket(bucket, extra))
    .sort((a, b) => b.cost_usd - a.cost_usd);
}

function costOf(rows) {
  return rows.reduce((sum, row) => sum + (row.name === 'claude_code.cost.usage' ? row.value : 0), 0);
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

export async function getUsage({ organizationSlug, projectSlug, abeEmail, days } = {}) {
  const w = windowFor(days);
  const [{ rows, diagnostics }, previous] = await Promise.all([
    reducedUsageRows({ organizationSlug, projectSlug, abeEmail, start: w.start, end: w.end }),
    reducedUsageRows({ organizationSlug, projectSlug, abeEmail, start: w.previous_start, end: w.previous_end }),
  ]);

  const byActor = rollupUsage(
    rows,
    (row) => row.abe_email,
    (row) => ({ abe_email: row.abe_email, display_name: row.display_name, organization_slug: row.organization_slug }),
  );
  const byProject = rollupUsage(
    rows,
    (row) => `${row.organization_slug}/${row.project_slug}`,
    (row) => ({ organization_slug: row.organization_slug, project_slug: row.project_slug, project_name: row.project_name }),
  );
  const byOrganization = rollupUsage(
    rows,
    (row) => row.organization_slug,
    (row) => ({ organization_slug: row.organization_slug, organization_name: row.organization_name }),
  );
  const byWorkItem = rollupUsage(
    rows,
    (row) => row.work_item_id,
    (row) => ({
      external_ref: row.external_ref,
      title: row.work_item_title,
      project_slug: row.project_slug,
      abe_email: row.abe_email,
    }),
  );

  const totalCost = costOf(rows);
  const totalTokens = byWorkItem.reduce((sum, r) => sum + r.total_tokens, 0);
  const costs = byWorkItem.map((r) => r.cost_usd).filter((v) => v > 0);
  const round = (v) => (v === null ? null : Math.round(v * 1e6) / 1e6);

  return {
    has_data: rows.length > 0,
    window: w,
    diagnostics,
    total_cost_usd: round(totalCost),
    previous_total_cost_usd: round(costOf(previous.rows)),
    total_tokens: totalTokens,
    cost_per_million_tokens: totalTokens > 0 ? round((totalCost / totalTokens) * 1e6) : null,
    cache_read_share: totalTokens > 0 ? byWorkItem.reduce((s, r) => s + r.cache_read_tokens, 0) / totalTokens : null,
    median_cost_per_work_item: round(percentile(costs, 0.5)),
    p90_cost_per_work_item: round(percentile(costs, 0.9)),
    by_actor: byActor,
    by_project: byProject,
    by_organization: byOrganization,
    by_work_item: byWorkItem,
  };
}

// ---------- Prompts (turnos) e retrabalho ----------
//
// Cada prompt do ABE é um "turno": tokens, linhas incluídas/removidas e a classificação do que foi
// feito (nova funcionalidade, melhoria, correção ou sem código). O custo por turno é a fatia do custo
// OTEL da sessão proporcional aos tokens ponderados pelo preço relativo de cada tipo.

const TURN_KINDS = ['nova_funcionalidade', 'melhoria', 'correcao', 'sem_codigo', 'nao_classificado'];
const PRICE_WEIGHT = { input_tokens: 1, output_tokens: 5, cache_creation_tokens: 1.25, cache_read_tokens: 0.1 };
const TOKEN_FIELDS = Object.keys(PRICE_WEIGHT);

const turnTokens = (t) => TOKEN_FIELDS.reduce((sum, f) => sum + Number(t[f] ?? 0), 0);
const turnWeight = (t) => TOKEN_FIELDS.reduce((sum, f) => sum + Number(t[f] ?? 0) * PRICE_WEIGHT[f], 0);
const hasCode = (t) => Number(t.lines_added) + Number(t.lines_removed) > 0;
const kindOf = (t) => t.kind ?? (hasCode(t) ? 'nao_classificado' : 'sem_codigo');

const TURN_SELECT = `
  SELECT t.id, t.execution_id, t.claude_session_id, t.seq, t.started_at, t.ended_at, t.model, t.prompt_kind,
         t.input_tokens, t.output_tokens, t.cache_read_tokens, t.cache_creation_tokens, t.subagent_tokens,
         t.lines_added, t.lines_removed, t.files_changed, t.files_reedited, t.tool_calls, t.tool_failures,
         t.kind, t.fix_origin, t.classified_by,
         a.email AS abe_email, a.display_name,
         wi.external_ref, wi.title, e.status AS execution_status, e.started_at AS execution_started_at, e.ended_at AS execution_ended_at,
         p.slug AS project_slug, p.name AS project_name, COALESCE(o.slug, ao.slug) AS organization_slug
    FROM prompt_turns t
    JOIN actors a ON a.id = t.actor_id
    JOIN organizations ao ON ao.id = a.organization_id
    LEFT JOIN executions e ON e.id = t.execution_id
    LEFT JOIN work_items wi ON wi.id = e.work_item_id
    LEFT JOIN repositories r ON r.id = e.repository_id
    LEFT JOIN projects p ON p.id = r.project_id
    LEFT JOIN organizations o ON o.id = p.organization_id
   WHERE ($1::text IS NULL OR COALESCE(o.slug, ao.slug) = $1)
     AND ($2::text IS NULL OR p.slug = $2)
     AND ($3::text IS NULL OR lower(a.email) = lower($3))`;

async function turnsStartedIn(scope, start, end) {
  const result = await query(`${TURN_SELECT} AND t.started_at >= $4 AND t.started_at < $5 ORDER BY t.started_at`,
    [scope.organizationSlug || null, scope.projectSlug || null, scope.abeEmail || null, start, end]);
  return result.rows;
}

// Todos os turnos (de qualquer data) das execuções concluídas na janela: base do "por US".
async function turnsOfDoneIn(scope, start, end) {
  const result = await query(`${TURN_SELECT} AND e.status = 'done' AND e.ended_at >= $4 AND e.ended_at < $5 ORDER BY t.started_at`,
    [scope.organizationSlug || null, scope.projectSlug || null, scope.abeEmail || null, start, end]);
  return result.rows;
}

export async function attachTurnCosts(turns) {
  const sessions = [...new Set(turns.map((t) => t.claude_session_id))];
  if (!sessions.length) return;
  const [otel, weights] = await Promise.all([
    query(`SELECT session_id, name, value, temporality, attributes, observed_at FROM otel_measurements
            WHERE name = 'claude_code.cost.usage' AND session_id = ANY($1::text[])`, [sessions]),
    query(`SELECT claude_session_id,
                  sum(input_tokens * 1.0 + output_tokens * 5 + cache_creation_tokens * 1.25 + cache_read_tokens * 0.1) AS w
             FROM prompt_turns WHERE claude_session_id = ANY($1::text[]) GROUP BY claude_session_id`, [sessions]),
  ]);
  const { rows } = reduceUsageRows(otel.rows.map((r) => ({ ...r, execution_id: r.session_id })));
  const sessionCost = new Map();
  for (const r of rows) sessionCost.set(r.session_id, (sessionCost.get(r.session_id) ?? 0) + r.value);
  const sessionWeight = new Map(weights.rows.map((r) => [r.claude_session_id, Number(r.w)]));
  for (const t of turns) {
    const cost = sessionCost.get(t.claude_session_id);
    const w = sessionWeight.get(t.claude_session_id);
    t.cost_usd = cost !== undefined && w > 0 ? (cost * turnWeight(t)) / w : null;
  }
}

const round6 = (v) => (v === null || v === undefined ? null : Math.round(v * 1e6) / 1e6);

function summarizeTurns(turns) {
  const byKind = Object.fromEntries(TURN_KINDS.map((k) => [k, { prompts: 0, tokens: 0, cost_usd: 0, lines_added: 0, lines_removed: 0 }]));
  const fixOrigin = {};
  let tokens = 0, cost = 0, costKnown = false, added = 0, removed = 0, withCode = 0;
  for (const t of turns) {
    const k = kindOf(t);
    const tk = turnTokens(t);
    const b = byKind[k];
    b.prompts += 1; b.tokens += tk; b.lines_added += Number(t.lines_added); b.lines_removed += Number(t.lines_removed);
    if (t.cost_usd !== null && t.cost_usd !== undefined) { b.cost_usd += t.cost_usd; cost += t.cost_usd; costKnown = true; }
    if (k === 'correcao') {
      const o = t.fix_origin ?? 'nao_informada';
      fixOrigin[o] ??= { prompts: 0, tokens: 0 };
      fixOrigin[o].prompts += 1; fixOrigin[o].tokens += tk;
    }
    tokens += tk; added += Number(t.lines_added); removed += Number(t.lines_removed);
    if (hasCode(t)) withCode += 1;
  }
  for (const b of Object.values(byKind)) b.cost_usd = round6(b.cost_usd);
  const codeTurns = turns.filter(hasCode);
  return {
    prompts: turns.length,
    prompts_with_code: withCode,
    tokens,
    cost_usd: costKnown ? round6(cost) : null,
    lines_added: added,
    lines_removed: removed,
    correction_prompts: byKind.correcao.prompts,
    correction_tokens: byKind.correcao.tokens,
    correction_cost_usd: costKnown ? byKind.correcao.cost_usd : null,
    correction_token_share: tokens > 0 ? byKind.correcao.tokens / tokens : null,
    unclassified_with_code: byKind.nao_classificado.prompts,
    median_tokens_per_prompt: percentile(turns.map(turnTokens), 0.5),
    p90_tokens_per_prompt: percentile(turns.map(turnTokens), 0.9),
    median_lines_added_per_prompt: percentile(codeTurns.map((t) => Number(t.lines_added)), 0.5),
    median_lines_removed_per_prompt: percentile(codeTurns.map((t) => Number(t.lines_removed)), 0.5),
    by_kind: byKind,
    by_fix_origin: fixOrigin,
  };
}

// Ciclos de reparo: sequências de prompts de correção (prompts sem código no meio não quebram o ciclo).
export function fixCycles(turns) {
  let cycles = 0;
  let inCycle = false;
  for (const t of turns) {
    const k = kindOf(t);
    if (k === 'correcao') { if (!inCycle) cycles += 1; inCycle = true; } else if (k !== 'sem_codigo') inCycle = false;
  }
  return cycles;
}

function perExecution(turns) {
  const groups = new Map();
  for (const t of turns) {
    if (!t.execution_id) continue;
    if (!groups.has(t.execution_id)) groups.set(t.execution_id, []);
    groups.get(t.execution_id).push(t);
  }
  return [...groups.entries()].map(([executionId, list]) => {
    list.sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at));
    const s = summarizeTurns(list);
    const first = list[0];
    return {
      execution_id: executionId,
      external_ref: first.external_ref, title: first.title, status: first.execution_status,
      started_at: first.execution_started_at, ended_at: first.execution_ended_at,
      project_slug: first.project_slug, project_name: first.project_name, abe_email: first.abe_email, display_name: first.display_name,
      prompts: s.prompts, tokens: s.tokens, cost_usd: s.cost_usd,
      lines_added: s.lines_added, lines_removed: s.lines_removed,
      correction_prompts: s.correction_prompts, correction_tokens: s.correction_tokens, correction_token_share: s.correction_token_share,
      improvement_prompts: s.by_kind.melhoria.prompts, feature_prompts: s.by_kind.nova_funcionalidade.prompts,
      unclassified_with_code: s.unclassified_with_code,
      fix_cycles: fixCycles(list),
      reedited_files: list.reduce((x, t) => x + Number(t.files_reedited), 0),
    };
  });
}

function usMetrics(doneExecutions) {
  const n = doneExecutions.length;
  return {
    done_with_prompts: n,
    median_prompts: percentile(doneExecutions.map((e) => e.prompts), 0.5),
    p90_prompts: percentile(doneExecutions.map((e) => e.prompts), 0.9),
    median_correction_prompts: percentile(doneExecutions.map((e) => e.correction_prompts), 0.5),
    mean_correction_prompts: n ? doneExecutions.reduce((x, e) => x + e.correction_prompts, 0) / n : null,
    with_correction_share: n ? doneExecutions.filter((e) => e.correction_prompts > 0).length / n : null,
    median_fix_cycles: percentile(doneExecutions.map((e) => e.fix_cycles), 0.5),
    median_tokens: percentile(doneExecutions.map((e) => e.tokens), 0.5),
  };
}

const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
const dayKey = (value) => dayFormat.format(new Date(value));

export async function getPromptAnalytics({ organizationSlug, projectSlug, abeEmail, days } = {}) {
  const scope = { organizationSlug, projectSlug, abeEmail };
  const w = windowFor(days);
  const [current, previous, doneNow, donePrev] = await Promise.all([
    turnsStartedIn(scope, w.start, w.end),
    turnsStartedIn(scope, w.previous_start, w.previous_end),
    turnsOfDoneIn(scope, w.start, w.end),
    turnsOfDoneIn(scope, w.previous_start, w.previous_end),
  ]);
  await Promise.all([attachTurnCosts(current), attachTurnCosts(doneNow)]);

  const doneExecs = perExecution(doneNow);
  const doneExecsPrev = perExecution(donePrev);
  const byExecution = new Map(perExecution(current).map((e) => [e.execution_id, e]));
  for (const e of doneExecs) byExecution.set(e.execution_id, e); // concluídas: contam todos os prompts da US

  const actors = new Map();
  const actorEntry = (email, name) => {
    if (!actors.has(email)) actors.set(email, { abe_email: email, display_name: name, turns: [], done: [] });
    return actors.get(email);
  };
  for (const t of current) actorEntry(t.abe_email, t.display_name).turns.push(t);
  for (const e of doneExecs) actorEntry(e.abe_email, e.display_name).done.push(e);
  const byActor = [...actors.values()].map((a) => {
    const s = summarizeTurns(a.turns);
    const u = usMetrics(a.done);
    return {
      abe_email: a.abe_email, display_name: a.display_name,
      prompts: s.prompts, tokens: s.tokens, cost_usd: s.cost_usd, lines_added: s.lines_added, lines_removed: s.lines_removed,
      correction_prompts: s.correction_prompts, correction_tokens: s.correction_tokens, correction_token_share: s.correction_token_share,
      unclassified_with_code: s.unclassified_with_code, prompts_without_us: a.turns.filter((t) => !t.execution_id).length,
      median_tokens_per_prompt: s.median_tokens_per_prompt,
      us_done: u.done_with_prompts, median_prompts_per_us: u.median_prompts, mean_correction_prompts_per_us: u.mean_correction_prompts,
    };
  }).sort((a, b) => b.prompts - a.prompts);

  const byDay = new Map();
  for (let t = Date.parse(w.start); t <= Date.parse(w.end) + 1; t += 86_400_000) {
    const d = dayKey(t);
    if (!byDay.has(d)) byDay.set(d, Object.fromEntries([['day', d], ...TURN_KINDS.map((k) => [k, 0])]));
  }
  const endDay = dayKey(w.end);
  if (!byDay.has(endDay)) byDay.set(endDay, Object.fromEntries([['day', endDay], ...TURN_KINDS.map((k) => [k, 0])]));
  for (const t of current) { const row = byDay.get(dayKey(t.started_at)); if (row) row[kindOf(t)] += 1; }

  const totals = summarizeTurns(current);
  const prev = summarizeTurns(previous);
  return {
    window: w,
    has_data: current.length > 0 || doneNow.length > 0,
    totals,
    previous: {
      prompts: prev.prompts, tokens: prev.tokens, correction_token_share: prev.correction_token_share,
      median_tokens_per_prompt: prev.median_tokens_per_prompt, lines_added: prev.lines_added, lines_removed: prev.lines_removed,
    },
    prompts_without_us: current.filter((t) => !t.execution_id).length,
    us: usMetrics(doneExecs),
    previous_us: usMetrics(doneExecsPrev),
    by_actor: byActor,
    by_work_item: [...byExecution.values()].sort((a, b) => b.correction_prompts - a.correction_prompts || b.prompts - a.prompts).slice(0, 300),
    by_day: [...byDay.values()],
  };
}
