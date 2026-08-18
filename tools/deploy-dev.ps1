<#
  NOVA — Build ins Entwicklerverzeichnis einspielen (release\NOVA), WAEHREND NOVA laeuft.
  ---------------------------------------------------------------------------------------
  Windows sperrt laufende EXE/DLLs gegen Ueberschreiben — aber UMBENENNEN ist erlaubt.
  Gesperrte Dateien werden deshalb auf *.nova-old geschoben und die neuen daneben gelegt.
  Nach einem einfachen NOVA-Neustart laeuft die neue Version; Reste raeumt der naechste
  Deploy-Lauf auf. Das Profil (NovaData) wird nie angetastet.

  Verwendung:
    powershell -ExecutionPolicy Bypass -File tools\deploy-dev.ps1                # nimmt %TEMP%\nova-out\NOVA
    powershell -ExecutionPolicy Bypass -File tools\deploy-dev.ps1 -Source <dir> # eigener Build-Ordner
#>
[CmdletBinding()]
param(
  [string]$Source = (Join-Path $env:TEMP 'nova-out\NOVA'),
  [string]$Target
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
if (-not $Target) { $Target = Join-Path $repo 'release\NOVA' }

if (-not (Test-Path (Join-Path $Source 'NOVA.exe'))) {
  Write-Host "FEHLER: Quelle enthaelt keine NOVA.exe: $Source" -ForegroundColor Red
  Write-Host "Erst bauen:  `$env:NOVA_OUT='$Source'; node tools\build-portable.mjs" -ForegroundColor Yellow
  exit 1
}
New-Item -ItemType Directory -Force -Path $Target | Out-Null

# Alte Umbenennungs-Reste vom letzten Deploy loeschen (jetzt nicht mehr gesperrt)
Get-ChildItem -Path $Target -Recurse -Filter '*.nova-old' -ErrorAction SilentlyContinue | ForEach-Object {
  try { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction Stop } catch {}
}

$copied = 0; $renamed = 0; $sameRuntime = 0; $failed = @()
Get-ChildItem -Path $Source -Recurse -File | ForEach-Object {
  $srcFile = $_   # NICHT $_ weiterverwenden: in catch-Bloecken ist $_ der Fehler (PS-5.1-Falle)
  $rel = $srcFile.FullName.Substring($Source.Length).TrimStart('\')
  $dst = Join-Path $Target $rel
  $dir = Split-Path $dst -Parent
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  try {
    Copy-Item -LiteralPath $srcFile.FullName -Destination $dst -Force -ErrorAction Stop
    $copied++
  } catch {
    # Datei ist von der laufenden NOVA gesperrt -> wegschieben, dann neue Version hinlegen
    $leaf = Split-Path $dst -Leaf
    $renOk = $false
    try { Rename-Item -LiteralPath $dst -NewName ($leaf + '.nova-old') -Force -ErrorAction Stop; $renOk = $true } catch {}
    $copyOk = $false
    if ($renOk) {
      # Direkt nach dem Umbenennen kann die Neuanlage kurz blockiert sein (Virenscanner) -> Retries
      for ($i = 0; $i -lt 5 -and -not $copyOk; $i++) {
        try { Copy-Item -LiteralPath $srcFile.FullName -Destination $dst -Force -ErrorAction Stop; $copyOk = $true }
        catch { Start-Sleep -Milliseconds 400 }
      }
      if ($copyOk) { $renamed++ }
      else {
        # WICHTIG: nie ein Loch hinterlassen — Umbenennung rueckgaengig machen
        try { Rename-Item -LiteralPath ($dst + '.nova-old') -NewName $leaf -Force -ErrorAction Stop } catch {}
      }
    }
    if (-not $copyOk) {
      # Nicht ersetzbar. Unkritisch, wenn die Datei ohnehin identisch ist (Electron-Runtime aendert
      # sich zwischen NOVA-Versionen nicht — nur resources\app). Groessenvergleich reicht dafuer.
      $old = Get-Item -LiteralPath $dst -ErrorAction SilentlyContinue
      if ($old -and $old.Length -eq $srcFile.Length) { $sameRuntime++ } else { $failed += $rel }
    }
  }
}

$ver = ''
try { $ver = (Get-Content (Join-Path $Target 'resources\app\package.json') -Raw | ConvertFrom-Json).version } catch {}
Write-Host ''
Write-Host ("Deploy fertig: v{0}  ->  {1}" -f $ver, $Target) -ForegroundColor Green
Write-Host ("  {0} Dateien kopiert, {1} gesperrte ersetzt, {2} gesperrt-aber-identisch (Runtime, unkritisch)" -f $copied, $renamed, $sameRuntime)
if ($failed.Count) {
  Write-Host ("  {0} Dateien NICHT ersetzbar (und veraendert!) — NOVA schliessen und Deploy wiederholen:" -f $failed.Count) -ForegroundColor Yellow
  $failed | Select-Object -First 8 | ForEach-Object { Write-Host "    $_" -ForegroundColor Yellow }
}
Write-Host '  -> NOVA einfach neu starten, dann laeuft die neue Version.' -ForegroundColor Cyan
