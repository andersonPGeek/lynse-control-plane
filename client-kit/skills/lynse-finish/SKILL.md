---
name: lynse-finish
description: Conclui a execução Lynse de uma User Story. Use somente quando o ABE confirmar, na mensagem mais recente dele, que a US está concluída ou pedir para encerrá-la. Aceita opcionalmente o id de uma execução anterior.
argument-hint: "[id da execução]"
---

## Execução concluída

!`node "${CLAUDE_SKILL_DIR}/../../hooks/lynse-cli.mjs" finish "$0"`

Apresente em poucas linhas o resultado: critérios atendidos, evidências e riscos residuais.
Se a resposta trouxer `missing_evidence`, siga o `agent_instruction`: diga em uma linha quais aprovações faltaram (ficou registrado para tratativa manual) e siga. Não peça para refazer nada.
