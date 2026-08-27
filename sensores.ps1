# sensores.ps1 - emite una linea JSON por muestra a stdout.
#
# OJO: en esta maquina las clases Win32_PerfFormattedData_* y Win32_PerfRawData_*
# NO existen (contadores de rendimiento de WMI rotos). Por eso NO se usan.
# Todo sale de clases WMI normales y de cmdlets, que si responden:
#   Win32_OperatingSystem    -> RAM libre y commit charge
#   Win32_PageFileUsage      -> uso y pico del pagefile
#   Win32_Process            -> memoria privada por proceso + IO acumulada
#   Get-NetAdapterStatistics -> bytes de red (se derivan por delta)
# El % de CPU lo calcula server.js con os.cpus(), que tampoco necesita WMI.

param([int]$IntervaloMs = 2000)

$ErrorActionPreference = 'SilentlyContinue'
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

$os  = Get-CimInstance Win32_OperatingSystem
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1

[ordered]@{
    tipo       = 'inicio'
    ts         = (Get-Date).ToString('o')
    cpu        = $cpu.Name.Trim()
    nucleos    = $cpu.NumberOfCores
    hilos      = $cpu.NumberOfLogicalProcessors
    ramTotalMB = [math]::Round($os.TotalVisibleMemorySize / 1024, 0)
    arranque   = $os.LastBootUpTime.ToString('o')
    so         = "$($os.Caption) $($os.Version)"
} | ConvertTo-Json -Compress -Depth 4

# Estado previo para calcular deltas (red y disco son contadores acumulados)
$antesRed    = $null
$antesDisco  = $null
$antesTiempo = $null

while ($true) {
    $t0 = Get-Date

    $osn  = Get-CimInstance Win32_OperatingSystem
    $pf   = Get-CimInstance Win32_PageFileUsage | Select-Object -First 1
    $procs = Get-CimInstance Win32_Process

    # --- memoria -----------------------------------------------------------
    $ramLibreMB = [math]::Round($osn.FreePhysicalMemory / 1024, 0)
    $ramTotalMB = [math]::Round($osn.TotalVisibleMemorySize / 1024, 0)
    # commit charge: el limite es TotalVirtualMemorySize, lo usado es la resta
    $commitTope = [math]::Round($osn.TotalVirtualMemorySize / 1024, 0)
    $commitUso  = $commitTope - [math]::Round($osn.FreeVirtualMemory / 1024, 0)

    # --- red (delta sobre contadores acumulados) ---------------------------
    $red = Get-NetAdapterStatistics | Measure-Object -Property ReceivedBytes, SentBytes -Sum
    $redTotal = ($red | Measure-Object -Property Sum -Sum).Sum

    # --- disco: IO de procesos (delta) -------------------------------------
    $ioLee = ($procs | Measure-Object -Property ReadTransferCount  -Sum).Sum
    $ioEsc = ($procs | Measure-Object -Property WriteTransferCount -Sum).Sum

    $redMbps = 0; $discoLeeMB = 0; $discoEscMB = 0
    if ($antesTiempo) {
        $seg = ($t0 - $antesTiempo).TotalSeconds
        if ($seg -gt 0) {
            $dRed = $redTotal - $antesRed
            if ($dRed -gt 0) { $redMbps = [math]::Round(($dRed * 8) / $seg / 1000000, 2) }
            $dLee = $ioLee - $antesDisco[0]
            $dEsc = $ioEsc - $antesDisco[1]
            if ($dLee -gt 0) { $discoLeeMB = [math]::Round($dLee / $seg / 1048576, 2) }
            if ($dEsc -gt 0) { $discoEscMB = [math]::Round($dEsc / $seg / 1048576, 2) }
        }
    }
    $antesRed    = $redTotal
    $antesDisco  = @($ioLee, $ioEsc)
    $antesTiempo = $t0

    # --- top 8 procesos por memoria privada --------------------------------
    $tops = $procs |
        Where-Object { $_.PrivatePageCount -gt 0 } |
        Group-Object Name |
        ForEach-Object {
            [ordered]@{
                n = $_.Name -replace '\.exe$', ''
                p = $_.Count
                m = [math]::Round((($_.Group | Measure-Object PrivatePageCount -Sum).Sum) / 1048576, 0)
            }
        } | Sort-Object { $_.m } -Descending | Select-Object -First 8

    [ordered]@{
        tipo         = 'muestra'
        ts           = (Get-Date).ToString('o')
        ramLibreMB   = [int]$ramLibreMB
        ramTotalMB   = [int]$ramTotalMB
        commitMB     = [int]$commitUso
        commitTopeMB = [int]$commitTope
        commitPct    = if ($commitTope -gt 0) { [math]::Round(100 * $commitUso / $commitTope, 1) } else { 0 }
        pfUsoMB      = [int]$pf.CurrentUsage
        pfPicoMB     = [int]$pf.PeakUsage
        pfTotalMB    = [int]$pf.AllocatedBaseSize
        discoLeeMB   = $discoLeeMB
        discoEscMB   = $discoEscMB
        redMbps      = $redMbps
        nProcesos    = $procs.Count
        procesos     = @($tops)
    } | ConvertTo-Json -Compress -Depth 4

    $tardo = ((Get-Date) - $t0).TotalMilliseconds
    $esperar = $IntervaloMs - $tardo
    if ($esperar -gt 50) { Start-Sleep -Milliseconds $esperar }
}
