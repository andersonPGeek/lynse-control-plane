INSERT INTO organizations (id, slug, name)
VALUES ('10000000-0000-4000-8000-000000000001', 'lynse-demo', 'Lynse Demo')
ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name;

INSERT INTO projects (id, organization_id, slug, name)
VALUES (
  '20000000-0000-4000-8000-000000000001',
  (SELECT id FROM organizations WHERE slug = 'lynse-demo'),
  'customer-portal',
  'Customer Portal'
)
ON CONFLICT (organization_id, slug) DO UPDATE SET name = EXCLUDED.name;

INSERT INTO repositories (id, project_id, slug, remote_url, default_branch)
VALUES (
  '30000000-0000-4000-8000-000000000001',
  (SELECT id FROM projects WHERE slug = 'customer-portal'),
  'customer-api',
  'https://github.com/example/customer-api.git',
  'main'
)
ON CONFLICT (project_id, slug) DO UPDATE
SET remote_url = EXCLUDED.remote_url, default_branch = EXCLUDED.default_branch;

INSERT INTO actors (id, organization_id, email, display_name, role)
VALUES (
  '40000000-0000-4000-8000-000000000001',
  (SELECT id FROM organizations WHERE slug = 'lynse-demo'),
  'anderson@lynse.ai',
  'Anderson',
  'abe'
)
ON CONFLICT (organization_id, email) DO UPDATE
SET display_name = EXCLUDED.display_name, role = EXCLUDED.role;

INSERT INTO work_items (
  id, project_id, external_ref, title, description, acceptance_criteria, risk_level, status
)
VALUES (
  '50000000-0000-4000-8000-000000000001',
  (SELECT id FROM projects WHERE slug = 'customer-portal'),
  'US-1842',
  'Recuperação de senha',
  'Como usuário, quero recuperar minha senha por e-mail para voltar a acessar a plataforma.',
  '[
    "Usuário informa o e-mail",
    "Recebe um link de recuperação",
    "O link expira em 30 minutos",
    "O token só pode ser usado uma vez",
    "A nova senha respeita a política existente",
    "Um evento de segurança é registrado"
  ]'::jsonb,
  'medium',
  'ready'
)
ON CONFLICT (project_id, external_ref) DO UPDATE SET
  title = EXCLUDED.title,
  description = EXCLUDED.description,
  acceptance_criteria = EXCLUDED.acceptance_criteria,
  risk_level = EXCLUDED.risk_level;
