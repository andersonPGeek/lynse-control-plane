#!/usr/bin/env sh
set -eu

if [ ! -f .env.lynse ]; then
  echo "Arquivo .env.lynse não encontrado. Copie .env.lynse.example e ajuste os valores." >&2
  exit 1
fi

set -a
. ./.env.lynse
set +a

exec claude "$@"

