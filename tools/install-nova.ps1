<#
  NOVA — Installations- und Wartungsscript (OHNE Administrator)
  ---------------------------------------------------------------------------
  Sorgt dafür, dass NOVA immer betriebsbereit ist:
    • liegt am richtigen Ort  ->  %LOCALAPPDATA%\NOVA   (benutzereigen = kein Admin nötig)
    • hat die richtige Version ->  optional automatisch vom GitHub-Release aktualisieren
    • ist erreichbar           ->  Startmenü- + Desktop-Verknüpfung, Taskleiste (best effort)

  WARUM DER ORT WICHTIG IST:
  Liegt NOVA in "C:\Program Files" o. ä., darf es dort ohne Admin nicht schreiben — deshalb
  startete es auf manchen PCs nur "als Administrator". Unter %LOCALAPPDATA% gehört der Ordner
  dem angemeldeten Benutzer -> NOVA startet immer normal.

  VERWENDUNG (normale PowerShell, KEIN Admin):
    .\install-nova.ps1                 # installiert/repariert aus dem aktuellen Ordner
    .\install-nova.ps1 -Update         # holt zusätzlich die neueste Version von GitHub
    .\install-nova.ps1 -RegisterTask   # legt eine tägliche Prüfung an (Autostart-Wartung)
    .\install-nova.ps1 -Status         # zeigt nur den Zustand an, ändert nichts

  Falls die Ausführung blockiert ist:
    powershell -ExecutionPolicy Bypass -File .\install-nova.ps1
#>
[CmdletBinding()]
param(
  [switch]$Update,          # neueste Version vom GitHub-Release holen
  [switch]$RegisterTask,    # geplante Aufgabe für regelmäßige Prüfung anlegen
  [switch]$Status,          # nur Zustand anzeigen
  [switch]$NoStart,         # nach der Installation nicht starten
  [string]$Source           # Quellordner (Standard: Ordner dieses Scripts bzw. dessen Eltern)
)

$ErrorActionPreference = 'Stop'
$Repo      = 'DtheG-Code/NOVA'
$AppName   = 'NOVA'
$Aumid     = 'com.spark.nova-browser'
$Target    = Join-Path $env:LOCALAPPDATA 'NOVA'
$ExeName   = 'NOVA.exe'
$TargetExe = Join-Path $Target $ExeName
$TaskName  = 'NOVA Wartung'

function Info($m) { Write-Host "• $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "✓ $m" -ForegroundColor Green }
function Warn($m) { Write-Host "! $m" -ForegroundColor Yellow }
function Err($m)  { Write-Host "✗ $m" -ForegroundColor Red }

# ---------------------------------------------------------------- Hilfsfunktionen
function Get-NovaVersion([string]$dir) {
  $pkg = Join-Path $dir 'resources\app\package.json'
  if (-not (Test-Path $pkg)) { return $null }
  try { return (Get-Content $pkg -Raw | ConvertFrom-Json).version } catch { return $null }
}

function Get-LatestRelease {
  try {
    $h = @{ 'User-Agent' = 'NOVA-Installer' }
    $r = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -Headers $h -TimeoutSec 25
    $asset = $r.assets | Where-Object { $_.name -like '*win-x64.zip' } | Select-Object -First 1
    if (-not $asset) { return $null }
    return [pscustomobject]@{ Version = ($r.tag_name -replace '^v', ''); Url = $asset.browser_download_url; Size = $asset.size }
  } catch { return $null }
}

function Compare-Version([string]$a, [string]$b) {   # -1 a<b | 0 gleich | 1 a>b
  if (-not $a) { return -1 }; if (-not $b) { return 1 }
  try { return ([version]$a).CompareTo([version]$b) } catch { return [string]::Compare($a, $b) }
}

function Stop-Nova {
  $p = Get-Process -Name 'NOVA' -ErrorAction SilentlyContinue
  if ($p) {
    Info 'NOVA läuft — wird beendet …'
    $p | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 1200
  }
}

function Copy-Tree([string]$from, [string]$to) {
  New-Item -ItemType Directory -Force -Path $to | Out-Null
  # robocopy spiegelt schnell; /XD NovaData schützt ein evtl. vorhandenes portables Profil
  $null = robocopy $from $to /E /R:2 /W:1 /NFL /NDL /NJH /NJS /XD 'NovaData'
  if ($LASTEXITCODE -ge 8) { throw "Kopieren fehlgeschlagen (robocopy $LASTEXITCODE)" }
}

function New-Shortcut([string]$linkPath, [string]$targetExe) {
  $sh = New-Object -ComObject WScript.Shell
  $sc = $sh.CreateShortcut($linkPath)
  $sc.TargetPath       = $targetExe
  $sc.WorkingDirectory = Split-Path $targetExe -Parent
  $sc.Description      = 'NOVA Browser'
  $ico = Join-Path $env:APPDATA 'NovaBrowser\icon.ico'
  if (Test-Path $ico) { $sc.IconLocation = $ico } else { $sc.IconLocation = "$targetExe,0" }
  $sc.Save()
}

# ---------------------------------------------------------------- Zustand
$installedVersion = Get-NovaVersion $Target
Write-Host ''
Write-Host "  NOVA — Installation & Wartung" -ForegroundColor Magenta
Write-Host "  Ziel: $Target"
if ($installedVersion) { Write-Host "  Installiert: v$installedVersion" } else { Write-Host '  Installiert: (noch nicht)' }

if ($Status) {
  $latest = Get-LatestRelease
  if ($latest) { Write-Host "  Neueste Version online: v$($latest.Version)" }
  $lnkPath = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\$AppName.lnk"
  $hasLnk = if (Test-Path $lnkPath) { 'ja' } else { 'nein' }
  $hasTask = if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { 'ja' } else { 'nein' }
  Write-Host "  Startmenü-Verknüpfung: $hasLnk"
  Write-Host "  Geplante Wartung: $hasTask"
  Write-Host ''
  return
}

# ---------------------------------------------------------------- Quelle bestimmen
$stage = $null
if ($Update) {
  $latest = Get-LatestRelease
  if (-not $latest) { Warn 'GitHub nicht erreichbar — nutze die lokale Quelle.' }
  elseif ((Compare-Version $installedVersion $latest.Version) -ge 0) {
    Ok "Bereits aktuell (v$installedVersion)."
    if (-not $installedVersion) { Warn 'Keine Installation gefunden — fahre mit lokaler Quelle fort.' } else { $Update = $false }
  } else {
    Info "Lade v$($latest.Version) ($([math]::Round($latest.Size/1MB)) MB) …"
    $zip = Join-Path $env:TEMP "nova-$($latest.Version).zip"
    $tmp = Join-Path $env:TEMP "nova-stage-$([guid]::NewGuid().ToString('N').Substring(0,8))"
    $pp = $ProgressPreference; $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest -Uri $latest.Url -OutFile $zip -UseBasicParsing
    $ProgressPreference = $pp
    Info 'Entpacke …'
    Expand-Archive -LiteralPath $zip -DestinationPath $tmp -Force
    Remove-Item $zip -Force -ErrorAction SilentlyContinue
    # das ZIP enthält den Ordner "NOVA"
    $inner = Join-Path $tmp 'NOVA'
    $stage = if (Test-Path (Join-Path $inner $ExeName)) { $inner } else { $tmp }
    Ok "v$($latest.Version) heruntergeladen"
  }
}

if (-not $stage) {
  # lokale Quelle: übergebener Pfad, Ordner des Scripts oder dessen Elternordner (release\NOVA)
  $cands = @()
  if ($Source) { $cands += $Source }
  $here = Split-Path -Parent $MyInvocation.MyCommand.Path
  $cands += $here, (Split-Path $here -Parent), (Join-Path (Split-Path $here -Parent) 'release\NOVA')
  $stage = $cands | Where-Object { $_ -and (Test-Path (Join-Path $_ $ExeName)) } | Select-Object -First 1
}

if (-not $stage) {
  if ($installedVersion) { Info 'Keine neue Quelle — prüfe nur Verknüpfungen.' }
  else { Err "Keine NOVA.exe gefunden. Script neben NOVA.exe legen oder -Update nutzen."; return }
}

# ---------------------------------------------------------------- Installieren / aktualisieren
if ($stage) {
  $srcVersion = Get-NovaVersion $stage
  $same = ($stage.TrimEnd('\') -ieq $Target.TrimEnd('\'))
  if ($same) {
    Ok "NOVA liegt bereits am richtigen Ort (v$srcVersion)."
  } else {
    $verTx = if ($srcVersion) { " (v$srcVersion)" } else { '' }
    Info "Installiere aus: $stage$verTx"
    Stop-Nova
    Copy-Tree $stage $Target
    Ok "Nach $Target installiert"
    if ($stage -like "$env:TEMP*") { Remove-Item (Split-Path $stage -Parent) -Recurse -Force -ErrorAction SilentlyContinue }
  }
}

if (-not (Test-Path $TargetExe)) { Err "NOVA.exe fehlt in $Target"; return }

# ---------------------------------------------------------------- Verknüpfungen
$startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
New-Item -ItemType Directory -Force -Path $startMenu | Out-Null
$lnk = Join-Path $startMenu "$AppName.lnk"
New-Shortcut $lnk $TargetExe
Ok 'Startmenü-Verknüpfung aktualisiert'

$desktop = [Environment]::GetFolderPath('Desktop')
if ($desktop) { New-Shortcut (Join-Path $desktop "$AppName.lnk") $TargetExe; Ok 'Desktop-Verknüpfung aktualisiert' }

# Taskleiste: Windows 10/11 lässt programmatisches Anheften nur eingeschränkt zu — Versuch + Hinweis
try {
  $shellApp = New-Object -ComObject Shell.Application
  $folder = $shellApp.Namespace((Split-Path $lnk -Parent))
  $item = $folder.ParseName((Split-Path $lnk -Leaf))
  $verb = $item.Verbs() | Where-Object { $_.Name -replace '&', '' -match 'An Taskleiste anheften|Pin to taskbar' }
  if ($verb) { $verb.DoIt(); Ok 'An die Taskleiste angeheftet' }
  else { Warn 'Taskleiste: bitte einmalig manuell anheften (Rechtsklick auf NOVA -> An Taskleiste anheften).' }
} catch {
  Warn 'Taskleiste: bitte einmalig manuell anheften (Windows blockiert das automatische Anheften).'
}

# ---------------------------------------------------------------- Geplante Wartung (optional)
if ($RegisterTask) {
  try {
    $selfDir = Join-Path $Target 'tools'
    New-Item -ItemType Directory -Force -Path $selfDir | Out-Null
    $selfCopy = Join-Path $selfDir 'install-nova.ps1'
    Copy-Item -LiteralPath $MyInvocation.MyCommand.Path -Destination $selfCopy -Force
    $action  = New-ScheduledTaskAction -Execute 'powershell.exe' `
               -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$selfCopy`" -Update -NoStart"
    $trigger = New-ScheduledTaskTrigger -Daily -At 12:00
    $set     = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $set -Force -RunLevel Limited | Out-Null
    Ok "Geplante Wartung eingerichtet ('$TaskName', täglich 12:00, ohne Admin)"
  } catch { Warn "Geplante Aufgabe konnte nicht angelegt werden: $($_.Exception.Message)" }
}

# ---------------------------------------------------------------- Abschluss
$finalVersion = Get-NovaVersion $Target
Write-Host ''
Ok "NOVA v$finalVersion ist betriebsbereit"
Write-Host "  Programm : $TargetExe"
Write-Host "  Profil   : $env:APPDATA\NovaBrowser"
Write-Host ''

if (-not $NoStart) {
  Info 'Starte NOVA …'
  Start-Process -FilePath $TargetExe -WorkingDirectory $Target
}
