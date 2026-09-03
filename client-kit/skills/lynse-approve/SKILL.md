---
name: lynse-approve
description: Registra a aprovação humana de um gate da Operação Lynse.
argument-hint: <plan|pr|deploy|rollback|close> [justificativa]
disable-model-invocation: true
---

## Aprovação registrada

!`node "${CLAUDE_SKILL_DIR}/../../hooks/lynse-cli.mjs" approve "$ARGUMENTS"`

Confirme qual gate foi aprovado e prossiga somente com as ações autorizadas por esse gate.
