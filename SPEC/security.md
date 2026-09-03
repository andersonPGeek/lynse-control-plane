# Segurança

- Segredos ficam em Secret Manager ou variáveis injetadas; nunca no repositório.
- Valide entrada na fronteira e autorização no caso de uso protegido.
- Use tokens aleatórios, armazenados como hash, com expiração e consumo atômico.
- Registre eventos de segurança sem conteúdo sensível.
- Operações destrutivas e produção exigem aprovação humana.

