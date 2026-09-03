$ErrorActionPreference = "Stop"

if (-not (Test-Path ".env.lynse")) {
  throw "Arquivo .env.lynse não encontrado. Copie .env.lynse.example e ajuste os valores."
}

Get-Content ".env.lynse" | ForEach-Object {
  $line = $_.Trim()
  if ($line -and -not $line.StartsWith("#")) {
    $parts = $line.Split("=", 2)
    [Environment]::SetEnvironmentVariable($parts[0], $parts[1], "Process")
  }
}

& claude @args
exit $LASTEXITCODE

