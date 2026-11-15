---
name: lynse-approve
description: Registra a aprovação humana de um gate da Operação Lynse.
argument-hint: <plan|pr|deploy|rollback|close> [justificativa]
disable-model-invocation: true
---

## Aprovação registrada

!`node "${CLAUDE_SKILL_DIR}/../../hooks/lynse-cli.mjs" approve "${CLAUDE_SESSION_ID}" "$ARGUMENTS"`

Confirme qual gate foi aprovado e prossiga somente com as ações autorizadas por esse gate.
O ABE também pode aprovar em linguagem natural ("pode seguir", "aprovado"): nesse caso, você termina a resposta com `[lynse: aprovado <gate>]` e não precisa deste comando.
