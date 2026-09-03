CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  slug text NOT NULL,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, slug)
);

CREATE TABLE IF NOT EXISTS repositories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  slug text NOT NULL,
  remote_url text,
  default_branch text NOT NULL DEFAULT 'main',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, slug)
);

CREATE TABLE IF NOT EXISTS actors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  email text NOT NULL,
  display_name text NOT NULL,
  role text NOT NULL DEFAULT 'abe' CHECK (role IN ('abe','reviewer','technical_responsible','business','system')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, email)
);

CREATE TABLE IF NOT EXISTS work_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  external_ref text NOT NULL,
  title text NOT NULL,
  description text,
  acceptance_criteria jsonb NOT NULL DEFAULT '[]'::jsonb,
  risk_level text NOT NULL DEFAULT 'medium' CHECK (risk_level IN ('low','medium','high')),
  status text NOT NULL DEFAULT 'ready' CHECK (status IN ('draft','ready','in_progress','done','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, external_ref)
);

CREATE TABLE IF NOT EXISTS executions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_item_id uuid NOT NULL REFERENCES work_items(id),
  repository_id uuid NOT NULL REFERENCES repositories(id),
  abe_id uuid NOT NULL REFERENCES actors(id),
  mode text NOT NULL DEFAULT 'audit' CHECK (mode IN ('audit','enforcement')),
  status text NOT NULL DEFAULT 'briefing' CHECK (status IN ('briefing','planning','building','verifying','release','observing','done','blocked','cancelled')),
  branch_name text,
  context_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id uuid NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  claude_session_id text NOT NULL,
  agent_type text NOT NULL DEFAULT 'claude-code',
  model text,
  cwd text,
  started_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  UNIQUE (execution_id, claude_session_id)
);

CREATE TABLE IF NOT EXISTS audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  execution_id uuid NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  session_id uuid REFERENCES agent_sessions(id) ON DELETE SET NULL,
  idempotency_key text NOT NULL UNIQUE,
  event_type text NOT NULL,
  source text NOT NULL DEFAULT 'claude-hook',
  tool_name text,
  risk_level text CHECK (risk_level IS NULL OR risk_level IN ('low','medium','high','critical')),
  duration_ms integer,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS policy_decisions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  execution_id uuid NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  claude_session_id text,
  rule_code text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('allow','ask','block','would_block')),
  risk_level text NOT NULL CHECK (risk_level IN ('low','medium','high','critical')),
  reason text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('audit','enforcement')),
  input_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE policy_decisions
  ADD COLUMN IF NOT EXISTS risk_level text NOT NULL DEFAULT 'low';

CREATE TABLE IF NOT EXISTS approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id uuid NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  actor_id uuid NOT NULL REFERENCES actors(id),
  gate text NOT NULL CHECK (gate IN ('plan','pr','deploy','rollback','close')),
  decision text NOT NULL CHECK (decision IN ('approved','rejected','changes_requested')),
  rationale text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pull_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id uuid NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'github',
  external_id text NOT NULL,
  url text,
  status text NOT NULL DEFAULT 'open',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  merged_at timestamptz,
  UNIQUE (provider, external_id)
);

CREATE TABLE IF NOT EXISTS deployments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id uuid NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  environment text NOT NULL CHECK (environment IN ('dev','hml','prod')),
  status text NOT NULL CHECK (status IN ('started','succeeded','failed','rolled_back')),
  version text,
  url text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE TABLE IF NOT EXISTS otel_measurements (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  signal text NOT NULL CHECK (signal IN ('metric','log')),
  session_id text,
  name text NOT NULL,
  value numeric,
  temporality smallint,
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  observed_at timestamptz,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_executions_work_item ON executions(work_item_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_execution ON agent_sessions(execution_id, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_execution_time ON audit_events(execution_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_events_type ON audit_events(event_type);
CREATE INDEX IF NOT EXISTS idx_policy_execution ON policy_decisions(execution_id, created_at);
CREATE INDEX IF NOT EXISTS idx_otel_session_name ON otel_measurements(session_id, name);

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS work_items_updated_at ON work_items;
CREATE TRIGGER work_items_updated_at BEFORE UPDATE ON work_items
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS executions_updated_at ON executions;
CREATE TRIGGER executions_updated_at BEFORE UPDATE ON executions
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
