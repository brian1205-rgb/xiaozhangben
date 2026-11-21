# Renders _dev\tools\icon.svg into the app's PNG icons using Microsoft Edge (headless).
# Usage (from the repo root): powershell -ExecutionPolicy Bypass -File _dev\tools\render-icons.ps1
$tools = Split-Path -Parent $MyInvocation.MyCommand.Path
$app = Join-Path $tools '..\..'   # site files (icons) are at the repo root
$edge = "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
if (-not (Test-Path $edge)) { $edge = "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe" }
$profile = Join-Path $env:TEMP 'xiaozhangben-icon-render'
$svgUri = ([Uri](Join-Path $tools 'icon.svg')).AbsoluteUri

$targets = @(@{ Name = 'icon-512.png'; Size = 512 }, @{ Name = 'icon-192.png'; Size = 192 }, @{ Name = 'apple-touch-icon.png'; Size = 180 })
foreach ($t in $targets) {
  $s = $t.Size
  $html = Join-Path $profile "render-$s.html"
  New-Item -ItemType Directory -Force -Path $profile | Out-Null
  Set-Content -LiteralPath $html -Encoding ascii -Value "<!doctype html><html><body style='margin:0;overflow:hidden'><img src='$svgUri' width='$s' height='$s' style='display:block'></body></html>"
  $out = [IO.Path]::GetFullPath((Join-Path $app $t.Name))
  $edgeArgs = @('--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
            "--user-data-dir=`"$profile`"", "--window-size=$s,$s", "--screenshot=`"$out`"", ([Uri]$html).AbsoluteUri)
  Start-Process -FilePath $edge -ArgumentList $edgeArgs -Wait -WindowStyle Hidden
  Write-Host "$($t.Name): $((Get-Item $out).Length) bytes"
}
