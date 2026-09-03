---
name: lynse-finish
description: Encerra a execução Lynse depois do deploy e da observação pós-produção.
disable-model-invocation: true
---

## Execução encerrada

!`node "${CLAUDE_SKILL_DIR}/../../hooks/lynse-cli.mjs" finish`

Apresente o resultado final, as evidências e qualquer risco residual. A história só pode ser declarada concluída se os critérios de aceite e a validação pós-deploy estiverem registrados.
