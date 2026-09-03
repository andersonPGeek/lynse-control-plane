# Setup da Operação Lynse — cole isto no chat do Claude Code

> Este arquivo é um prompt para o **Claude Code**, não um manual para o humano ler e digitar comandos. Cole o conteúdo abaixo (ou peça para o Claude Code ler este arquivo) numa sessão do Claude Code, em qualquer pasta — não precisa ser dentro de um projeto específico — e deixe o agente executar os passos.

---

Você vai configurar a Operação Lynse (governança e auditoria de sessões do Claude Code) nesta máquina. Isso é uma configuração **pessoal e global** — nada disso pode ser criado, copiado ou commitado dentro de repositórios de clientes. Tudo fica em `~/.claude/` (a pasta de configuração do usuário no Claude Code), fora de qualquer projeto.

Siga estes passos, na ordem, confirmando com o usuário antes de qualquer ação destrutiva:

## 1. Verifique os pré-requisitos

- `node --version` — precisa ser 20 ou superior.
- `git --version` — precisa existir.
- `claude --version` — se der para checar, confirme que é razoavelmente recente (a integração usa `${CLAUDE_SKILL_DIR}`, recurso do Claude Code 2.1.196+). Se a versão for muito antiga, avise o usuário antes de continuar.

Se algum pré-requisito faltar, pare e explique o que falta em vez de tentar instalar sozinho.

## 2. Baixe o kit de distribuição

Clone o repositório interno (não é o repositório do cliente — é um repositório da nossa empresa) num diretório temporário fora de qualquer projeto de cliente, por exemplo dentro da pasta pessoal do usuário:

```bash
git clone https://github.com/andersonPGeek/lynse-control-plane.git /tmp/lynse-kit-setup
```

(No Windows, use um caminho como `%TEMP%\lynse-kit-setup` em vez de `/tmp/...`.)

O que interessa é a pasta `client-kit/` dentro desse clone.

## 3. Rode o instalador

O instalador **nunca sobrescreve** configuração existente do usuário — ele mescla com o que já existir em `~/.claude/settings.json` e `~/.claude/CLAUDE.md`, e é seguro rodar mais de uma vez.

- macOS/Linux: `bash client-kit/install.sh` (a partir da raiz do clone)
- Windows (PowerShell): `.\client-kit\install.ps1`

Isso copia os hooks e os comandos `/lynse-start`, `/lynse-approve`, `/lynse-status`, `/lynse-finish` para `~/.claude/`, e cria (se ainda não existir) o arquivo `~/.claude/lynse/.env`.

## 4. Peça a chave pessoal ao usuário

Pergunte ao usuário, no chat: **"Você já recebeu sua chave pessoal da Operação Lynse (LYNSE_API_KEY)? Se não, peça ao Anderson."** Não invente nem reutilize uma chave de outra pessoa.

Quando o usuário informar a chave, edite `~/.claude/lynse/.env` e substitua a linha `LYNSE_API_KEY=COLE_AQUI_SUA_CHAVE_PESSOAL` pela chave real. Confirme também que `LYNSE_API_URL` aponta para `https://lynse-control-plane.onrender.com` (já vem assim por padrão — só ajuste se o usuário disser que é outro ambiente).

Nunca imprima a chave de volta no chat depois de salva, nem a inclua em nenhum outro arquivo.

## 5. Limpe o clone temporário

Depois que o instalador rodar com sucesso, o clone em `/tmp/lynse-kit-setup` (ou equivalente) não é mais necessário — tudo que importa já foi copiado para `~/.claude/`. Pergunte ao usuário se pode apagar essa pasta temporária; se ele confirmar, apague.

## 6. Valide

Explique ao usuário que a partir de agora, em **qualquer** repositório que ele abrir no Claude Code (inclusive repositórios de clientes), os comandos abaixo vão funcionar:

- `/lynse-start <ID-DA-US>` — abre uma execução governada
- `/lynse-status` — mostra o estado atual
- `/lynse-approve <plan|pr|deploy|rollback|close> <justificativa>` — registra uma aprovação
- `/lynse-finish` — encerra a execução

Projeto e repositório são identificados automaticamente pelo `git remote` do repositório aberto — não precisa configurar nada por projeto. Se o usuário quiser testar agora, sugira reabrir o Claude Code (para carregar os novos comandos e hooks) e rodar `/lynse-start TESTE-1` em qualquer repositório com `git remote` configurado, só para confirmar que a execução foi criada (depois pode rodar `/lynse-finish` sem nunca ter feito nenhuma alteração real, é só um teste de conectividade).

## 7. Opcional — telemetria de tokens e custo

O dashboard também mostra consumo de tokens e custo em USD por ABE/projeto/organização/User Story, alimentado pela telemetria nativa do Claude Code — mas isso **não** vem do `~/.claude/lynse/.env` (esse arquivo só é lido pelos hooks). O processo `claude` em si precisa dessas variáveis no ambiente do shell:

```
CLAUDE_CODE_ENABLE_TELEMETRY=1
OTEL_METRICS_EXPORTER=otlp
OTEL_EXPORTER_OTLP_PROTOCOL=http/json
OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=https://lynse-control-plane.onrender.com/otel/v1/metrics
OTEL_EXPORTER_OTLP_HEADERS=x-api-key=<a mesma LYNSE_API_KEY pessoal do passo 4>
OTEL_METRICS_INCLUDE_SESSION_ID=true
```

Isso é **opcional** e muda o ambiente persistente do usuário — **pergunte antes de aplicar.** Se o usuário quiser habilitar, explique que isso normalmente significa adicionar essas linhas ao perfil do shell dele (`$PROFILE` no PowerShell, `~/.zshrc`/`~/.bashrc` no macOS/Linux) e reiniciar o terminal. Só edite esse arquivo com a confirmação explícita do usuário, e mostre exatamente o que vai ser adicionado antes de fazer.

## Lembre o usuário

- Nada disso cria, altera ou versiona qualquer arquivo dentro do repositório do cliente. Tudo vive em `~/.claude/` (fora de qualquer projeto) e em `~/.claude/lynse/.env` (a chave pessoal).
- Se algo der errado, o comando mais útil para diagnosticar é `/lynse-status` — ele mostra claramente se existe uma execução ativa e o que já foi registrado.
- Dúvidas ou problemas de acesso: falar com Anderson.
