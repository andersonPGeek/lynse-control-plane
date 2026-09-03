import { query } from './db.mjs';

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

export async function getSummary() {
  const [totals, inventory, policy, deployments, events] = await Promise.all([
    query(`
      SELECT
        count(*) AS total_executions,
        count(*) FILTER (WHERE status = 'done') AS done_executions,
        count(*) FILTER (WHERE status = 'blocked') AS blocked_executions,
        count(*) FILTER (WHERE status = 'cancelled') AS cancelled_executions,
        count(*) FILTER (WHERE status NOT IN ('done', 'blocked', 'cancelled')) AS in_progress_executions,
        avg(extract(epoch FROM (ended_at - started_at)))
          FILTER (WHERE status = 'done' AND ended_at IS NOT NULL) AS avg_duration_seconds,
        min(started_at) AS first_execution_at,
        max(started_at) AS last_execution_at
      FROM executions
    `),
    query(`
      SELECT
        (SELECT count(*) FROM organizations) AS organizations_count,
        (SELECT count(*) FROM projects) AS projects_count,
        (SELECT count(*) FROM repositories) AS repositories_count,
        (SELECT count(*) FROM actors) AS actors_count,
        (SELECT count(*) FROM work_items) AS work_items_total,
        (SELECT count(*) FROM work_items WHERE status = 'done') AS work_items_done
    `),
    query(`
      SELECT decision, risk_level, count(*)::int AS count
      FROM policy_decisions
      GROUP BY decision, risk_level
      ORDER BY decision, risk_level
    `),
    query(`
      SELECT environment, status, count(*)::int AS count
      FROM deployments
      GROUP BY environment, status
      ORDER BY environment, status
    `),
    query(`
      SELECT event_type, count(*)::int AS count
      FROM audit_events
      GROUP BY event_type
      ORDER BY count DESC
    `),
  ]);

  const t = totals.rows[0];
  const i = inventory.rows[0];

  return {
    executions: {
      total: toNumber(t.total_executions),
      done: toNumber(t.done_executions),
      blocked: toNumber(t.blocked_executions),
      cancelled: toNumber(t.cancelled_executions),
      in_progress: toNumber(t.in_progress_executions),
      avg_duration_seconds: toNumber(t.avg_duration_seconds),
      first_execution_at: t.first_execution_at,
      last_execution_at: t.last_execution_at,
    },
    inventory: {
      organizations: toNumber(i.organizations_count),
      projects: toNumber(i.projects_count),
      repositories: toNumber(i.repositories_count),
      actors: toNumber(i.actors_count),
      work_items_total: toNumber(i.work_items_total),
      work_items_done: toNumber(i.work_items_done),
    },
    policy_decisions: policy.rows.map(mapCountRow),
    deployments: deployments.rows.map(mapCountRow),
    events_by_type: events.rows.map(mapCountRow),
  };
}

export async function getByOrganization() {
  const result = await query(`
    SELECT
      o.slug AS organization_slug,
      o.name AS organization_name,
      (SELECT count(*) FROM projects p WHERE p.organization_id = o.id) AS projects_count,
      stats.total_executions,
      stats.done_executions,
      stats.blocked_executions,
      stats.avg_duration_seconds,
      stats.last_execution_at
    FROM organizations o
    LEFT JOIN LATERAL (
      SELECT
        count(*) AS total_executions,
        count(*) FILTER (WHERE e.status = 'done') AS done_executions,
        count(*) FILTER (WHERE e.status = 'blocked') AS blocked_executions,
        avg(extract(epoch FROM (e.ended_at - e.started_at))) FILTER (WHERE e.status = 'done') AS avg_duration_seconds,
        max(e.started_at) AS last_execution_at
      FROM executions e
      JOIN repositories r ON r.id = e.repository_id
      JOIN projects p ON p.id = r.project_id
      WHERE p.organization_id = o.id
    ) stats ON true
    ORDER BY o.slug
  `);

  return result.rows.map((row) => ({
    organization_slug: row.organization_slug,
    organization_name: row.organization_name,
    projects_count: toNumber(row.projects_count),
    total_executions: toNumber(row.total_executions) ?? 0,
    done_executions: toNumber(row.done_executions) ?? 0,
    blocked_executions: toNumber(row.blocked_executions) ?? 0,
    avg_duration_seconds: toNumber(row.avg_duration_seconds),
    last_execution_at: row.last_execution_at,
  }));
}

export async function getByProject({ organizationSlug } = {}) {
  const result = await query(
    `
    SELECT
      o.slug AS organization_slug,
      p.slug AS project_slug,
      p.name AS project_name,
      (SELECT count(*) FROM work_items wi WHERE wi.project_id = p.id) AS work_items_total,
      (SELECT count(*) FROM work_items wi WHERE wi.project_id = p.id AND wi.status = 'done') AS work_items_done,
      stats.total_executions,
      stats.done_executions,
      stats.blocked_executions,
      stats.avg_duration_seconds,
      stats.first_execution_at,
      stats.last_execution_at
    FROM projects p
    JOIN organizations o ON o.id = p.organization_id
    LEFT JOIN LATERAL (
      SELECT
        count(*) AS total_executions,
        count(*) FILTER (WHERE e.status = 'done') AS done_executions,
        count(*) FILTER (WHERE e.status = 'blocked') AS blocked_executions,
        avg(extract(epoch FROM (e.ended_at - e.started_at))) FILTER (WHERE e.status = 'done') AS avg_duration_seconds,
        min(e.started_at) AS first_execution_at,
        max(e.started_at) AS last_execution_at
      FROM executions e
      JOIN repositories r ON r.id = e.repository_id
      WHERE r.project_id = p.id
    ) stats ON true
    WHERE ($1::text IS NULL OR o.slug = $1)
    ORDER BY o.slug, p.slug
  `,
    [organizationSlug || null],
  );

  return result.rows.map((row) => ({
    organization_slug: row.organization_slug,
    project_slug: row.project_slug,
    project_name: row.project_name,
    work_items_total: toNumber(row.work_items_total),
    work_items_done: toNumber(row.work_items_done),
    total_executions: toNumber(row.total_executions) ?? 0,
    done_executions: toNumber(row.done_executions) ?? 0,
    blocked_executions: toNumber(row.blocked_executions) ?? 0,
    avg_duration_seconds: toNumber(row.avg_duration_seconds),
    first_execution_at: row.first_execution_at,
    last_execution_at: row.last_execution_at,
  }));
}

export async function getByActor({ organizationSlug, projectSlug } = {}) {
  const result = await query(
    `
    SELECT
      o.slug AS organization_slug,
      a.email AS abe_email,
      a.display_name,
      stats.total_executions,
      stats.done_executions,
      stats.blocked_executions,
      stats.avg_duration_seconds,
      stats.last_execution_at,
      appr.approvals_count
    FROM actors a
    JOIN organizations o ON o.id = a.organization_id
    LEFT JOIN LATERAL (
      SELECT
        count(*) AS total_executions,
        count(*) FILTER (WHERE e.status = 'done') AS done_executions,
        count(*) FILTER (WHERE e.status = 'blocked') AS blocked_executions,
        avg(extract(epoch FROM (e.ended_at - e.started_at))) FILTER (WHERE e.status = 'done') AS avg_duration_seconds,
        max(e.started_at) AS last_execution_at
      FROM executions e
      JOIN repositories r ON r.id = e.repository_id
      JOIN projects p ON p.id = r.project_id
      WHERE e.abe_id = a.id
        AND ($2::text IS NULL OR p.slug = $2)
    ) stats ON true
    LEFT JOIN LATERAL (
      SELECT count(*) AS approvals_count
      FROM approvals ap
      JOIN executions e2 ON e2.id = ap.execution_id
      JOIN repositories r2 ON r2.id = e2.repository_id
      JOIN projects p2 ON p2.id = r2.project_id
      WHERE e2.abe_id = a.id
        AND ap.decision = 'approved'
        AND ($2::text IS NULL OR p2.slug = $2)
    ) appr ON true
    WHERE ($1::text IS NULL OR o.slug = $1)
    ORDER BY stats.total_executions DESC NULLS LAST, a.email
  `,
    [organizationSlug || null, projectSlug || null],
  );

  return result.rows
    .filter((row) => toNumber(row.total_executions) > 0 || toNumber(row.approvals_count) > 0)
    .map((row) => ({
      organization_slug: row.organization_slug,
      abe_email: row.abe_email,
      display_name: row.display_name,
      total_executions: toNumber(row.total_executions) ?? 0,
      done_executions: toNumber(row.done_executions) ?? 0,
      blocked_executions: toNumber(row.blocked_executions) ?? 0,
      avg_duration_seconds: toNumber(row.avg_duration_seconds),
      approvals_count: toNumber(row.approvals_count) ?? 0,
      last_execution_at: row.last_execution_at,
    }));
}

export async function getTimeseries({ projectSlug, days = 30 } = {}) {
  const clampedDays = Math.min(Math.max(Number.isFinite(days) ? days : 30, 1), 180);
  const result = await query(
    `
    SELECT
      date_trunc('day', e.started_at) AS day,
      count(*) AS started,
      count(*) FILTER (WHERE e.status = 'done') AS done
    FROM executions e
    JOIN repositories r ON r.id = e.repository_id
    JOIN projects p ON p.id = r.project_id
    WHERE e.started_at >= now() - make_interval(days => $1::int)
      AND ($2::text IS NULL OR p.slug = $2)
    GROUP BY 1
    ORDER BY 1
  `,
    [clampedDays, projectSlug || null],
  );

  return result.rows.map((row) => ({
    day: row.day,
    started: toNumber(row.started),
    done: toNumber(row.done),
  }));
}
