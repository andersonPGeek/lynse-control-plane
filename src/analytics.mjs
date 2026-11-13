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
  const n = Math.min(Math.max(Number.isFinite(days) ? Math.trunc(days) : 30, 1), 365);
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
const STARTED_IN = `(e.started_at >= $3 AND e.started_at < $4)`;
const DONE_IN = `(e.status = 'done' AND e.ended_at >= $3 AND e.ended_at < $4)`;
const OPEN = `(e.status NOT IN ('done', 'cancelled', 'blocked'))`;
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
    WHERE ${SCOPE_WHERE}
    `,
    [scope.organizationSlug || null, scope.projectSlug || null, start, end],
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
    WHERE ${SCOPE_WHERE}
      AND x.${timeColumn} >= $3 AND x.${timeColumn} < $4
    GROUP BY ${groupColumns.map((c) => `x.${c}`).join(', ')}
    ${extraOrder}
    `,
    [scope.organizationSlug || null, scope.projectSlug || null, start, end],
  );
  return result.rows.map(mapCountRow);
}

function exceptionsCount(policyRows) {
  return policyRows.filter((r) => r.decision !== 'allow').reduce((sum, r) => sum + r.count, 0);
}

export async function getSummary({ organizationSlug, projectSlug, days } = {}) {
  const scope = { organizationSlug, projectSlug };
  const w = windowFor(days);

  const [current, previous, policy, previousPolicy, deployments, events, rules] = await Promise.all([
    executionMetrics(scope, w.start, w.end),
    executionMetrics(scope, w.previous_start, w.previous_end),
    scopedGroupCount('policy_decisions', 'created_at', ['decision', 'risk_level'], scope, w.start, w.end, 'ORDER BY 1, 2'),
    scopedGroupCount('policy_decisions', 'created_at', ['decision'], scope, w.previous_start, w.previous_end),
    scopedGroupCount('deployments', 'started_at', ['environment', 'status'], scope, w.start, w.end, 'ORDER BY 1, 2'),
    scopedGroupCount('audit_events', 'occurred_at', ['event_type'], scope, w.start, w.end, 'ORDER BY count DESC'),
    scopedGroupCount('policy_decisions', 'created_at', ['rule_code', 'decision'], scope, w.start, w.end, 'ORDER BY count DESC'),
  ]);

  return {
    window: w,
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

async function getBreakdown(dimension, { organizationSlug, projectSlug, days } = {}) {
  const dim = DIMENSIONS[dimension];
  const w = windowFor(days);
  const params = [organizationSlug || null, projectSlug || null, w.start, w.end];
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
    WHERE ${SCOPE_WHERE}
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
      WHERE ${SCOPE_WHERE} AND ap.decision = 'approved' AND ap.created_at >= $3 AND ap.created_at < $4
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

export async function getFilterOptions() {
  const result = await query(`
    SELECT o.slug AS organization_slug, o.name AS organization_name, p.slug AS project_slug, p.name AS project_name
    FROM projects p JOIN organizations o ON o.id = p.organization_id
    ORDER BY o.name, p.name
  `);
  return result.rows;
}

export async function getTimeseries({ organizationSlug, projectSlug, days } = {}) {
  const w = windowFor(days);
  const result = await query(
    `
    WITH scoped AS (
      SELECT (e.started_at AT TIME ZONE $5)::date AS started_day,
             CASE WHEN e.status = 'done' THEN (e.ended_at AT TIME ZONE $5)::date END AS done_day
      FROM executions e
      ${SCOPE_JOIN}
      WHERE ${SCOPE_WHERE}
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
    [organizationSlug || null, projectSlug || null, w.start, w.end, TIMEZONE],
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

async function reducedUsageRows({ organizationSlug, projectSlug, start, end } = {}) {
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
    `,
    [USAGE_METRIC_NAMES, organizationSlug || null, projectSlug || null, start, end],
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

export async function getUsage({ organizationSlug, projectSlug, days } = {}) {
  const w = windowFor(days);
  const [{ rows, diagnostics }, previous] = await Promise.all([
    reducedUsageRows({ organizationSlug, projectSlug, start: w.start, end: w.end }),
    reducedUsageRows({ organizationSlug, projectSlug, start: w.previous_start, end: w.previous_end }),
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
