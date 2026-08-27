# descargar-lhm.ps1
# Baja LibreHardwareMonitor desde su release oficial en GitHub y lo deja
# configurado con el servidor web JSON encendido en el puerto 8085.
#
# No se incluye el binario en el repositorio a proposito: es un proyecto
# aparte (licencia MPL-2.0) y conviene que cada uno se baje el ejecutable
# firmado por sus autores en vez de una copia de un tercero.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$destino = Join-Path $PSScriptRoot 'LibreHardwareMonitor'
$exe = Join-Path $destino 'LibreHardwareMonitor.exe'

if (Test-Path $exe) {
    Write-Host "LibreHardwareMonitor ya esta en $destino" -ForegroundColor Green
    exit 0
}

Write-Host ""
Write-Host "  LibreHardwareMonitor" -ForegroundColor Cyan
Write-Host "  --------------------"
Write-Host "  Es lo unico que puede leer la temperatura del procesador, las"
Write-Host "  vueltas de los ventiladores y los voltajes de la fuente."
Write-Host ""
Write-Host "  Antes de instalarlo conviene que sepas:" -ForegroundColor Yellow
Write-Host "   - Es open source (MPL-2.0) y muy usado, pero su ejecutable NO"
Write-Host "     esta firmado digitalmente."
Write-Host "   - Para leer los sensores carga un driver de kernel (WinRing0),"
Write-Host "     el mismo que usan HWiNFO y herramientas similares. Como da"
Write-Host "     acceso directo al hardware, algunos antivirus lo marcan."
Write-Host "   - Por eso pide permisos de administrador al abrirse."
Write-Host ""
Write-Host "  El monitor funciona igual sin el, pero sin esos tres datos."
Write-Host ""

$r = Read-Host "  Descargar LibreHardwareMonitor? (s/N)"
if ($r -notmatch '^[sSyY]') {
    Write-Host "  Salteado. El monitor va a andar sin temperatura de CPU ni voltajes."
    exit 0
}

Write-Host "  Buscando la ultima version..."
$rel = Invoke-RestMethod 'https://api.github.com/repos/LibreHardwareMonitor/LibreHardwareMonitor/releases/latest' -Headers @{ 'User-Agent' = 'monitor-sistema' }
$asset = $rel.assets | Where-Object { $_.name -eq 'LibreHardwareMonitor.zip' } | Select-Object -First 1
if (-not $asset) { $asset = $rel.assets | Where-Object { $_.name -like '*.zip' } | Select-Object -First 1 }
if (-not $asset) { Write-Host "  No se encontro el archivo en el release." -ForegroundColor Red; exit 1 }

Write-Host "  Bajando $($rel.tag_name) ($([math]::Round($asset.size/1MB,1)) MB)..."
$zip = Join-Path $env:TEMP 'lhm.zip'
Invoke-WebRequest $asset.browser_download_url -OutFile $zip -UseBasicParsing
Expand-Archive $zip -DestinationPath $destino -Force
Remove-Item $zip -Force

# Config: servidor web JSON encendido, arranque minimizado en la bandeja
$cfg = Join-Path $destino 'LibreHardwareMonitor.config'
@'
<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <appSettings>
    <add key="listenerPort" value="8085" />
    <add key="runWebServerMenuItem" value="true" />
    <add key="minTrayMenuItem" value="true" />
    <add key="startMinMenuItem" value="true" />
    <add key="minCloseMenuItem" value="true" />
    <add key="cpuMenuItem" value="true" />
    <add key="gpuMenuItem" value="true" />
    <add key="mainboardMenuItem" value="true" />
    <add key="hddMenuItem" value="true" />
    <add key="ramMenuItem" value="true" />
    <add key="fanControllerMenuItem" value="true" />
  </appSettings>
</configuration>
'@ | Set-Content -Path $cfg -Encoding UTF8

Write-Host "  Listo: $destino" -ForegroundColor Green
Write-Host "  El servidor JSON queda en http://localhost:8085/data.json"
