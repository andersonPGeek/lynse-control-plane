-- 004 — Guardião do processo: inconsistências, ajustes manuais e métricas por prompt (turno).
--
-- Princípio: nenhuma falha de processo atrapalha o trabalho do ABE. O Control Plane registra a
-- inconsistência e segue; o tratamento é manual, na tela "Inconsistências".
--
-- Rode o arquivo inteiro de uma vez. Ele é idempotente (pode ser rodado de novo sem efeito colateral)
-- e termina com COMMIT. Antes de aplicar, veja o que será regularizado com a consulta do fim do arquivo.

BEGIN;

-- 1) Execuções: novo status "inconsistent" e campos de fechamento/ajuste ---------------------------
ALTER TABLE executions DROP CONSTRAINT IF EXISTS executions_status_check;
ALTER TABLE executions ADD CONSTRAINT executions_status_check CHECK (status IN (
  'briefing','planning','building','verifying','release','observing','done','blocked','cancelled','inconsistent'
));
ALTER TABLE executions ADD COLUMN IF NOT EXISTS previous_status text;
ALTER TABLE executions ADD COLUMN IF NOT EXISTS close_reason text;
ALTER TABLE executions ADD COLUMN IF NOT EXISTS manually_adjusted boolean NOT NULL DEFAULT false;
ALTER TABLE executions ADD COLUMN IF NOT EXISTS reopen_of uuid REFERENCES executions(id) ON DELETE SET NULL;

-- 2) Inconsistências ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS inconsistencies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  execution_id uuid REFERENCES executions(id) ON DELETE CASCADE,
  claude_session_id text,
  type text NOT NULL CHECK (type IN (
    'US_ABERTA_AO_INICIAR_OUTRA', 'US_PARADA', 'SESSAO_SEM_US', 'TURNO_NAO_CLASSIFICADO',
    'CLASSIFICACAO_DIVERGENTE', 'CONCLUSAO_SEM_EVIDENCIA', 'APROVACAO_SEM_EVIDENCIA'
  )),
  severity text NOT NULL DEFAULT 'medium' CHECK (severity IN ('low','medium','high')),
  dedupe_key text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','justified')),
  detected_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by text,
  resolution_note text
);
-- Uma inconsistência aberta por tipo + chave (execução ou sessão): detecções repetidas atualizam a mesma linha.
CREATE UNIQUE INDEX IF NOT EXISTS uq_inconsistencies_open ON inconsistencies (type, dedupe_key) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_inconsistencies_actor ON inconsistencies (actor_id, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_inconsistencies_execution ON inconsistencies (execution_id);

-- 3) Turnos: um registro por prompt do ABE, só com números (nunca o texto) --------------------------
CREATE TABLE IF NOT EXISTS prompt_turns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  turn_key text NOT NULL UNIQUE,
  actor_id uuid NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  execution_id uuid REFERENCES executions(id) ON DELETE CASCADE,
  claude_session_id text NOT NULL,
  seq integer NOT NULL,
  prompt_hash text,
  prompt_kind text NOT NULL DEFAULT 'prompt' CHECK (prompt_kind IN ('prompt','comando')),
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  model text,
  input_tokens bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  cache_read_tokens bigint NOT NULL DEFAULT 0,
  cache_creation_tokens bigint NOT NULL DEFAULT 0,
  subagent_tokens bigint NOT NULL DEFAULT 0,
  lines_added integer NOT NULL DEFAULT 0,
  lines_removed integer NOT NULL DEFAULT 0,
  files_changed integer NOT NULL DEFAULT 0,
  files_reedited integer NOT NULL DEFAULT 0,
  tool_calls integer NOT NULL DEFAULT 0,
  tool_failures integer NOT NULL DEFAULT 0,
  kind text CHECK (kind IS NULL OR kind IN ('nova_funcionalidade','melhoria','correcao','sem_codigo')),
  fix_origin text CHECK (fix_origin IS NULL OR fix_origin IN ('abe_apontou','teste_build_falhou','revisao_pr','pos_deploy')),
  classified_by text CHECK (classified_by IS NULL OR classified_by IN ('agente','gestor')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_turns_execution ON prompt_turns (execution_id, started_at);
CREATE INDEX IF NOT EXISTS idx_turns_actor ON prompt_turns (actor_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_turns_session ON prompt_turns (claude_session_id, started_at);

-- 4) Aprovações: de qual prompt do ABE veio a aprovação --------------------------------------------
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS prompt_turn_id uuid REFERENCES prompt_turns(id) ON DELETE SET NULL;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS evidence text NOT NULL DEFAULT 'comando';
ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_evidence_check;
ALTER TABLE approvals ADD CONSTRAINT approvals_evidence_check CHECK (evidence IN ('comando','turno_abe','manual','sem_evidencia'));

-- 5) Histórico de ajustes manuais (auditoria) ------------------------------------------------------
CREATE TABLE IF NOT EXISTS manual_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action text NOT NULL,
  actor_id uuid REFERENCES actors(id) ON DELETE SET NULL,
  execution_id uuid REFERENCES executions(id) ON DELETE SET NULL,
  target_execution_id uuid REFERENCES executions(id) ON DELETE SET NULL,
  prompt_turn_id uuid REFERENCES prompt_turns(id) ON DELETE SET NULL,
  inconsistency_id uuid REFERENCES inconsistencies(id) ON DELETE SET NULL,
  performed_by text NOT NULL,
  reason text NOT NULL,
  before jsonb NOT NULL DEFAULT '{}'::jsonb,
  after jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_adjustments_actor ON manual_adjustments (actor_id, created_at DESC);

DROP TRIGGER IF EXISTS inconsistencies_updated_at ON inconsistencies;
CREATE TRIGGER inconsistencies_updated_at BEFORE UPDATE ON inconsistencies
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS prompt_turns_updated_at ON prompt_turns;
CREATE TRIGGER prompt_turns_updated_at BEFORE UPDATE ON prompt_turns
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 6) Regulariza o que já existe: cada ABE fica com UMA execução ativa (a de atividade mais recente).
--    As demais viram "inconsistent" com uma inconsistência aberta para tratativa manual. Nada é apagado.
WITH ranked AS (
  SELECT e.id, e.abe_id, e.status,
         row_number() OVER w AS rn,
         first_value(wi.external_ref) OVER w AS kept_ref
    FROM executions e
    JOIN work_items wi ON wi.id = e.work_item_id
   WHERE e.status NOT IN ('done','cancelled','inconsistent')
  WINDOW w AS (PARTITION BY e.abe_id ORDER BY
    COALESCE((SELECT max(s.last_seen_at) FROM agent_sessions s WHERE s.execution_id = e.id), e.started_at) DESC, e.started_at DESC)
),
marked AS (
  UPDATE executions e
     SET previous_status = r.status, status = 'inconsistent', close_reason = 'aberta_ao_iniciar_outra'
    FROM ranked r
   WHERE r.id = e.id AND r.rn > 1
  RETURNING e.id, e.abe_id, r.status AS previous_status, r.kept_ref
)
INSERT INTO inconsistencies (actor_id, execution_id, type, severity, dedupe_key, details)
SELECT m.abe_id, m.id, 'US_ABERTA_AO_INICIAR_OUTRA', 'high', m.id::text,
       jsonb_build_object('status_anterior', m.previous_status, 'us_mantida_ativa', m.kept_ref, 'origem', 'migracao_004')
  FROM marked m
ON CONFLICT DO NOTHING;

-- 7) A partir daqui o banco garante: no máximo uma execução ativa por ABE.
CREATE UNIQUE INDEX IF NOT EXISTS uq_executions_one_active_per_abe
  ON executions (abe_id) WHERE status NOT IN ('done','cancelled','inconsistent');

COMMIT;

-- Conferência (rode depois): quantas execuções foram regularizadas e quantas seguem ativas por ABE.
-- SELECT a.email,
--        count(*) FILTER (WHERE e.status = 'inconsistent') AS marcadas_inconsistentes,
--        count(*) FILTER (WHERE e.status NOT IN ('done','cancelled','inconsistent')) AS ativas
--   FROM executions e JOIN actors a ON a.id = e.abe_id GROUP BY a.email ORDER BY a.email;
--
-- Prévia (rode ANTES, se quiser ver o que será marcado como inconsistente):
-- SELECT a.email, wi.external_ref, e.status, e.started_at
--   FROM executions e JOIN actors a ON a.id = e.abe_id JOIN work_items wi ON wi.id = e.work_item_id
--  WHERE e.status NOT IN ('done','cancelled') ORDER BY a.email, e.started_at DESC;
