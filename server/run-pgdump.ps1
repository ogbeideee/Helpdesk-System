$ErrorActionPreference = 'Stop'
cd 'C:\Users\dogbeide\TICKETING SYSTEM\server'

# Read connection values from .env; never print them.
$vars = @{}
Get-Content .env | ForEach-Object {
  if ($_ -match '^\s*([A-Za-z_]\w*)\s*=\s*(.*)\s*$') { $vars[$Matches[1]] = $Matches[2].Trim('"').Trim("'") }
}
$url = [Uri]$vars['DIRECT_URL']
$ui = [Uri]::UnescapeDataString($url.UserInfo)
$user = $ui.Split(':')[0]
$pw   = ($ui -split ':', 2)[1]
$hostname = $url.Host
$port = if ($url.IsDefaultPort) { 5432 } else { $url.Port }

$env:PGHOST = $hostname
$env:PGPORT = "$port"
$env:PGUSER = $user
$env:PGPASSWORD = $pw
$env:PGDATABASE = 'postgres'
$env:PGSSLMODE = 'verify-full'
$env:PGSSLROOTCERT = 'C:\Users\dogbeide\TICKETING SYSTEM\server\certs\supabase-ca.pem'
$env:PGCONNECT_TIMEOUT = '30'

$pgdump = Get-ChildItem 'C:\Program Files\PostgreSQL' -Recurse -Filter pg_dump.exe -ErrorAction SilentlyContinue |
  Select-Object -First 1 -ExpandProperty FullName
if (-not $pgdump) { throw 'pg_dump not found after install' }

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$out = "C:\Users\dogbeide\TICKETING SYSTEM\backups\supabase-pg-backup-$stamp.dump"
Write-Host "pg_dump : $pgdump"
Write-Host "host    : $hostname (port $port)  [$($env:PGSSLMODE) TLS, root cert set]"
Write-Host "target  : $out"

& $pgdump -h $hostname -p $port -U $user -d 'postgres' -Fc --no-owner --no-acl -f $out
if ($LASTEXITCODE -ne 0) { throw "pg_dump failed with exit $LASTEXITCODE" }

Write-Host "exit    : $LASTEXITCODE"
Write-Host "size    : $((Get-Item $out).Length) bytes"
Write-Host "sha256  : $((Get-FileHash $out -Algorithm SHA256).Hash)"
Write-Host "BACKUP OK"