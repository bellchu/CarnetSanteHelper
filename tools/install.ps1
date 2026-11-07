# Install/update CarnetSanteHelper on Windows (PowerShell twin of install.sh):
#   locate or clone the repo -> update code -> copy the extension path to the
#   clipboard -> open the browser extensions page.
# Manual steps left: enable "Developer mode" (first time only) -> "Load unpacked" -> paste the path.
# Run from PowerShell:  powershell -ExecutionPolicy Bypass -File tools\install.ps1
# ASCII-only on purpose: Windows PowerShell 5.1 reads BOM-less files as ANSI.

$ErrorActionPreference = 'Stop'
$Repo = 'bellchu/CarnetSanteHelper'
$Dest = Join-Path $HOME 'Code\CarnetSanteHelper'

# 1. Locate or clone the repo
if ((Test-Path '.\manifest.json') -and (Test-Path '.\.git')) {
  $Dir = (Get-Location).ProviderPath
} elseif (Test-Path (Join-Path $Dest '.git')) {
  $Dir = $Dest
} else {
  Write-Output "-> Cloning $Repo to $Dest"
  if (Get-Command gh -ErrorAction SilentlyContinue) {
    gh repo clone $Repo $Dest
  } else {
    git clone "https://github.com/$Repo.git" $Dest
  }
  $Dir = $Dest
}

# 2. Update code (skip gracefully when local changes prevent it)
if (git -C $Dir config --get remote.origin.url) {
  Write-Output '-> Updating code'
  git -C $Dir pull --ff-only
  if ($LASTEXITCODE -ne 0) { Write-Output '  (skipped update: local changes or divergence)' }
}
$Dir = (Resolve-Path $Dir).ProviderPath

# 3. Copy the path to the clipboard
$Copied = $false
try { Set-Clipboard -Value $Dir; $Copied = $true } catch { }

# 4. Open the extensions page (Chrome first, then Edge; both resolve via App Paths)
$Opened = $false
foreach ($browser in @(@('chrome.exe', 'chrome://extensions'), @('msedge.exe', 'edge://extensions'))) {
  try { Start-Process $browser[0] $browser[1]; $Opened = $true; break } catch { }
}
if (-not $Opened) { Write-Output '(Chrome/Edge not found - open the extensions page manually)' }

Write-Output ''
Write-Output "OK - code ready: $Dir"
if ($Copied) { Write-Output 'Extension path copied to the clipboard' }
Write-Output ''
Write-Output 'Next steps (first time only):'
Write-Output '  1. Turn on "Developer mode" (top right of the extensions page)'
Write-Output '  2. Click "Load unpacked"'
Write-Output '  3. Paste the path (Ctrl+Shift+V) and press Enter'
Write-Output ''
Write-Output 'Later updates: re-run this script, then click Reload on the extension card.'
