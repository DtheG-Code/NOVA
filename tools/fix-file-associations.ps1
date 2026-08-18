<#
  NOVA — Dateiverknuepfungen reparieren + auf NOVA umstellen (.pdf, .html, .htm, .svg, .mhtml)
  ---------------------------------------------------------------------------------------------
  Behebt zwei Dinge (alles HKCU, KEIN Admin noetig):

  1) CRASH-FIX: Eine alte Verknuepfung startete `electron.exe "datei.pdf"` OHNE App-Pfad —
     Electron versucht dann, die PDF selbst als App zu laden ("Unknown file extension .pdf").
     Hier werden die Oeffnen-mit-Eintraege von electron.exe UND NOVA.exe mit korrektem
     Startbefehl neu geschrieben.

  2) STANDARD-APP: Traegt NOVA als Handler fuer PDF/HTML/SVG ein (eigene ProgIds mit PDF-Icon),
     setzt sie als Klassen-Standard und loescht die alte Nutzerwahl (UserChoice) der Endungen —
     beim naechsten Doppelklick oeffnet NOVA (ggf. einmalige Windows-Nachfrage: NOVA + "Immer").

  Verwendung:  powershell -ExecutionPolicy Bypass -File tools\fix-file-associations.ps1
#>
$ErrorActionPreference = 'SilentlyContinue'
$repo = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

# ---- Pfade ermitteln -------------------------------------------------------------------------
$novaExe = Join-Path $repo 'release\NOVA\NOVA.exe'
if (-not (Test-Path $novaExe)) { $novaExe = Join-Path $env:LOCALAPPDATA 'NOVA\NOVA.exe' }
if (-not (Test-Path $novaExe)) { Write-Host 'FEHLER: keine NOVA.exe gefunden (release\NOVA oder %LOCALAPPDATA%\NOVA).' -ForegroundColor Red; exit 1 }

$devElectron = Join-Path $repo 'node_modules\electron\dist\electron.exe'

# Icons: portable NovaData (neben der EXE) bevorzugen, sonst AppData-Profil
$dataDirs = @((Join-Path (Split-Path $novaExe -Parent) 'NovaData'), (Join-Path $env:APPDATA 'NovaBrowser'))
$pdfIco = $null; $appIco = $null
foreach ($d in $dataDirs) {
  if (-not $pdfIco -and (Test-Path (Join-Path $d 'pdf.ico')))  { $pdfIco = Join-Path $d 'pdf.ico' }
  if (-not $appIco -and (Test-Path (Join-Path $d 'icon.ico'))) { $appIco = Join-Path $d 'icon.ico' }
}
if (-not $appIco) { $appIco = "$novaExe,0" }
if (-not $pdfIco) { $pdfIco = $appIco }

$launch = ('"{0}" "%1"' -f $novaExe)
Write-Host "NOVA:     $novaExe"
Write-Host "PDF-Icon: $pdfIco"
Write-Host "App-Icon: $appIco"

# Registry ueber den PowerShell-Provider (kein reg.exe: keine Quoting-Probleme mit "%1"-Befehlen)
function KeySet([string]$key, [string]$name, [string]$value) {
  $p = "HKCU:\$key"
  if (-not (Test-Path $p)) { New-Item -Path $p -Force | Out-Null }
  if ($name -eq '') { Set-ItemProperty -LiteralPath $p -Name '(default)' -Value $value }
  else { Set-ItemProperty -LiteralPath $p -Name $name -Value $value }
}

$C = 'Software\Classes'

# ---- 1) Oeffnen-mit-Eintraege mit KORREKTEM Befehl (Crash-Fix) --------------------------------
KeySet "$C\Applications\NOVA.exe" 'FriendlyAppName' 'NOVA'
KeySet "$C\Applications\NOVA.exe\DefaultIcon" '' $appIco
KeySet "$C\Applications\NOVA.exe\shell\open\command" '' $launch
KeySet "$C\Applications\NOVA.exe\SupportedTypes" '.pdf' ''
if (Test-Path $devElectron) {
  # Alte kaputte Zuordnung auf die Dev-Electron-EXE heilen: IMMER mit App-Pfad starten
  $devLaunch = ('"{0}" "{1}" -- "%1"' -f $devElectron, $repo)
  KeySet "$C\Applications\electron.exe" 'FriendlyAppName' 'NOVA (Dev)'
  KeySet "$C\Applications\electron.exe\shell\open\command" '' $devLaunch
  Write-Host 'Dev-electron.exe-Eintrag repariert (Startbefehl enthaelt jetzt den App-Pfad).'
}

# ---- 2) ProgIds + Endungen auf NOVA ------------------------------------------------------------
KeySet "$C\NovaPDF" '' 'PDF-Dokument (NOVA)'
KeySet "$C\NovaPDF\DefaultIcon" '' $pdfIco
KeySet "$C\NovaPDF\shell\open\command" '' $launch

KeySet "$C\NovaBrowserHTM" '' 'Nova Browser Dokument'
KeySet "$C\NovaBrowserHTM\DefaultIcon" '' $appIco
KeySet "$C\NovaBrowserHTM\shell\open\command" '' $launch

$map = [ordered]@{ '.pdf' = 'NovaPDF'; '.html' = 'NovaBrowserHTM'; '.htm' = 'NovaBrowserHTM'; '.svg' = 'NovaBrowserHTM'; '.mhtml' = 'NovaBrowserHTM' }
foreach ($ext in $map.Keys) {
  $progId = $map[$ext]
  KeySet "$C\$ext" '' $progId
  KeySet "$C\$ext\OpenWithProgids" $progId ''
  # Alte Nutzerwahl entfernen -> Windows faellt auf den Klassen-Standard (NOVA) zurueck
  Remove-Item -LiteralPath "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\$ext\UserChoice" -Force -Recurse -ErrorAction SilentlyContinue
  Write-Host ("{0,-7} ->  {1}" -f $ext, $progId)
}

# In den Windows-Standard-Apps als PDF-Handler auffuehren
KeySet 'Software\Clients\StartMenuInternet\NovaBrowser\Capabilities\FileAssociations' '.pdf' 'NovaPDF'

# ---- Icon-Cache auffrischen --------------------------------------------------------------------
Start-Process -FilePath 'ie4uinit.exe' -ArgumentList '-show' -WindowStyle Hidden -ErrorAction SilentlyContinue
Write-Host ''
Write-Host 'Fertig. PDF/HTML/SVG oeffnen jetzt mit NOVA (ggf. fragt Windows EINMAL: NOVA + "Immer" waehlen).' -ForegroundColor Green
Write-Host 'Falls Icons noch alt aussehen: Explorer neu starten oder ab-/anmelden (Icon-Cache).' -ForegroundColor Cyan
