import { query, transaction } from './db.mjs';

export async function listActors() {
  const [actors, organizations] = await Promise.all([
    query(`
      SELECT
        a.id, a.email, a.display_name, a.role, a.created_at,
        o.slug AS organization_slug, o.name AS organization_name,
        (SELECT count(*) FROM api_keys k WHERE k.actor_id = a.id AND k.revoked_at IS NULL)::int AS active_keys,
        (SELECT count(*) FROM executions e WHERE e.abe_id = a.id)::int AS executions_total,
        (SELECT count(*) FROM executions e WHERE e.abe_id = a.id AND e.status NOT IN ('done','cancelled','blocked'))::int AS executions_open,
        GREATEST(
          (SELECT max(s.last_seen_at) FROM agent_sessions s JOIN executions e ON e.id = s.execution_id WHERE e.abe_id = a.id),
          (SELECT max(e.started_at) FROM executions e WHERE e.abe_id = a.id)
        ) AS last_activity_at
      FROM actors a
      JOIN organizations o ON o.id = a.organization_id
      ORDER BY o.name, COALESCE(NULLIF(a.display_name, ''), a.email)
    `),
    query('SELECT slug, name FROM organizations ORDER BY name'),
  ]);
  return { items: actors.rows, organizations: organizations.rows };
}

// Calcula, dentro da conexão informada, tudo o que some junto com o ABE.
// Dados compartilhados com outros ABEs (User Stories, sessões, projetos) são preservados.
async function computeImpact(client, actorId) {
  const actor = await client.query(
    `SELECT a.id, a.email, a.display_name, o.slug AS organization_slug, o.name AS organization_name
       FROM actors a JOIN organizations o ON o.id = a.organization_id WHERE a.id = $1`,
    [actorId],
  );
  if (!actor.rowCount) return null;

  const execs = (await client.query('SELECT id, work_item_id, repository_id FROM executions WHERE abe_id = $1', [actorId])).rows;
  const execIds = execs.map((e) => e.id);
  const wiCandidates = [...new Set(execs.map((e) => e.work_item_id))];
  const repoCandidates = [...new Set(execs.map((e) => e.repository_id))];

  const sessions = (await client.query(
    `SELECT DISTINCT s.claude_session_id FROM agent_sessions s
      WHERE s.execution_id = ANY($1::uuid[])
        AND NOT EXISTS (SELECT 1 FROM agent_sessions o
                         WHERE o.claude_session_id = s.claude_session_id AND NOT (o.execution_id = ANY($1::uuid[])))`,
    [execIds],
  )).rows.map((r) => r.claude_session_id);

  const workItems = (await client.query(
    `SELECT wi.id, wi.external_ref, wi.title FROM work_items wi
      WHERE wi.id = ANY($1::uuid[])
        AND NOT EXISTS (SELECT 1 FROM executions e WHERE e.work_item_id = wi.id AND NOT (e.id = ANY($2::uuid[])))
      ORDER BY wi.external_ref`,
    [wiCandidates, execIds],
  )).rows;
  const wiIds = workItems.map((w) => w.id);

  const repos = (await client.query(
    `SELECT r.id, r.project_id FROM repositories r
      WHERE r.id = ANY($1::uuid[])
        AND NOT EXISTS (SELECT 1 FROM executions e WHERE e.repository_id = r.id AND NOT (e.id = ANY($2::uuid[])))`,
    [repoCandidates, execIds],
  )).rows;
  const repoIds = repos.map((r) => r.id);

  const projects = (await client.query(
    `SELECT p.id, p.slug, p.name FROM projects p
      WHERE p.id = ANY($1::uuid[])
        AND NOT EXISTS (SELECT 1 FROM repositories r WHERE r.project_id = p.id AND NOT (r.id = ANY($2::uuid[])))
        AND NOT EXISTS (SELECT 1 FROM work_items wi WHERE wi.project_id = p.id AND NOT (wi.id = ANY($3::uuid[])))
      ORDER BY p.name`,
    [[...new Set(repos.map((r) => r.project_id))], repoIds, wiIds],
  )).rows;

  const counts = (await client.query(
    `SELECT
       (SELECT count(*) FROM agent_sessions WHERE execution_id = ANY($1::uuid[]))::int AS agent_sessions,
       (SELECT count(*) FROM audit_events WHERE execution_id = ANY($1::uuid[]))::int AS audit_events,
       (SELECT count(*) FROM policy_decisions WHERE execution_id = ANY($1::uuid[]))::int AS policy_decisions,
       (SELECT count(*) FROM approvals WHERE execution_id = ANY($1::uuid[]) OR actor_id = $2)::int AS approvals,
       (SELECT count(*) FROM pull_requests WHERE execution_id = ANY($1::uuid[]))::int AS pull_requests,
       (SELECT count(*) FROM deployments WHERE execution_id = ANY($1::uuid[]))::int AS deployments,
       (SELECT count(*) FROM otel_measurements WHERE session_id = ANY($3::text[]))::int AS telemetry,
       (SELECT count(*) FROM api_keys WHERE actor_id = $2)::int AS api_keys`,
    [execIds, actorId, sessions],
  )).rows[0];

  return {
    actor: actor.rows[0],
    ids: { execIds, sessions, wiIds, repoIds, projectIds: projects.map((p) => p.id) },
    impact: {
      executions: execIds.length,
      ...counts,
      work_items: workItems.map(({ external_ref, title }) => ({ external_ref, title })),
      projects: projects.map(({ slug, name }) => ({ slug, name })),
      repositories: repoIds.length,
    },
  };
}

export async function getActorImpact(actorId) {
  const result = await transaction((client) => computeImpact(client, actorId));
  return result && { actor: result.actor, impact: result.impact };
}

export async function deleteActor(actorId, confirmEmail) {
  return transaction(async (client) => {
    const result = await computeImpact(client, actorId);
    if (!result) return { status: 'not_found' };
    if (String(confirmEmail || '').trim().toLowerCase() !== result.actor.email.toLowerCase()) return { status: 'confirmation_mismatch' };
    const { execIds, sessions, wiIds, repoIds, projectIds } = result.ids;
    await client.query('DELETE FROM otel_measurements WHERE session_id = ANY($1::text[])', [sessions]);
    await client.query('DELETE FROM approvals WHERE execution_id = ANY($1::uuid[]) OR actor_id = $2', [execIds, actorId]);
    await client.query('DELETE FROM executions WHERE id = ANY($1::uuid[])', [execIds]);
    await client.query('DELETE FROM work_items WHERE id = ANY($1::uuid[])', [wiIds]);
    await client.query('DELETE FROM api_keys WHERE actor_id = $1', [actorId]);
    await client.query('DELETE FROM actors WHERE id = $1', [actorId]);
    await client.query('DELETE FROM repositories WHERE id = ANY($1::uuid[])', [repoIds]);
    await client.query('DELETE FROM projects WHERE id = ANY($1::uuid[])', [projectIds]);
    return { status: 'deleted', actor: result.actor, impact: result.impact };
  });
}
