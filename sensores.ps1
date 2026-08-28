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

param([int]$IntervaloMs = 2000, [string]$AgentesArchivo = '')

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

# Cache de titulos de sesion. Cada sesion de Claude Code lleva --resume=<uuid>
# en su linea de comandos, y ese uuid es el nombre de su transcript dentro de
# ~/.claude/projects/<carpeta-del-proyecto>/. De ahi salen el proyecto y el
# primer mensaje, que sirve de titulo. Se cachea porque no cambia y los
# transcripts pueden pesar cientos de MB.
$titulos = @{}
# Los agentes a seguir vienen de config.json, via server.js. Claude Code es
# solo el que viene activo por defecto: cualquier CLI que corra como proceso
# propio se puede agregar ahi sin tocar este archivo.
$AGENTES = @()
if ($AgentesArchivo -and (Test-Path $AgentesArchivo)) {
    try {
        # OJO con el @() de afuera: en Windows PowerShell 5.1, ConvertFrom-Json
        # devuelve el array como UN solo objeto por la tuberia, asi que @() lo
        # envuelve en un array de un elemento en vez de darnos los N agentes.
        # El ForEach-Object fuerza la enumeracion.
        $AGENTES = @(Get-Content $AgentesArchivo -Raw | ConvertFrom-Json | ForEach-Object { $_ })
    } catch { $AGENTES = @() }
}

function Obtener-Titulo($uuid, $raiz) {
    if ($titulos.ContainsKey($uuid)) { return $titulos[$uuid] }
    if (-not $raiz -or -not (Test-Path $raiz)) { return $null }

    $r = [ordered]@{ proyecto = $null; titulo = $null; ruta = $null }
    # Se guarda tambien la RUTA del transcript. Sin eso habria que hacer una
    # busqueda recursiva por todas las carpetas de proyecto en cada muestra,
    # o sea cada 2 segundos por sesion, que es carisimo.
    $f = Get-ChildItem $raiz -Recurse -Filter "$uuid.jsonl" -ErrorAction SilentlyContinue |
         Select-Object -First 1
    if ($f) {
        $r.ruta = $f.FullName
        # el nombre de la carpeta es la ruta con guiones: interesa el final
        $r.proyecto = (($f.Directory.Name -split '-' | Where-Object { $_ }) | Select-Object -Last 1)
        # solo las primeras lineas: el archivo puede pesar cientos de MB
        foreach ($l in (Get-Content $f.FullName -TotalCount 60 -ErrorAction SilentlyContinue)) {
            try { $j = $l | ConvertFrom-Json } catch { continue }
            if ($j.type -eq 'user' -and $j.message.content) {
                $c = $j.message.content
                if ($c -is [string]) { $t = $c }
                else { $t = ($c | Where-Object { $_.type -eq 'text' } | Select-Object -First 1).text }
                if ($t) {
                    $t = ($t -replace '\s+', ' ').Trim()
                    # los mensajes del sistema no sirven como titulo
                    if ($t -notmatch '^<' -and $t.Length -gt 3) {
                        $r.titulo = if ($t.Length -gt 70) { $t.Substring(0, 70) } else { $t }
                        break
                    }
                }
            }
        }
        # el titulo no cambia nunca: se cachea
        $titulos[$uuid] = $r
    }
    return $r
}

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

    # --- agentes de IA -----------------------------------------------------
    # Cualquier CLI de agente que corra como proceso propio se puede seguir:
    # sale de la lista "agentes" de config.json. Claude Code viene activo por
    # defecto, el resto se prende ahi.
    #
    # El filtro por linea de comandos importa porque varios comparten el
    # binario entre el CLI y la app de escritorio: en Claude, las sesiones
    # llevan --output-format stream-json y la app de escritorio es Electron,
    # un proceso principal mas su cortejo de --type=renderer/gpu/utility.
    # Sumarlas juntas da un numero que no significa nada.
    $agentesSalida = @()

    foreach ($ag in $AGENTES) {
        if (-not $ag.activo) { continue }
        $nombreProc = "$($ag.proceso).exe"
        $cands = @($procs | Where-Object { $_.Name -eq $nombreProc })
        if (-not $cands) { continue }

        $raiz = $null
        if ($ag.transcripts) { $raiz = Join-Path $env:USERPROFILE $ag.transcripts }

        $sesiones = @()
        $otrosMB = 0
        $otrosProcs = 0

        foreach ($c in $cands) {
            $cl = $c.CommandLine
            $mb = [math]::Round($c.PrivatePageCount / 1048576, 0)
            $esSesion = if ($ag.patronSesion) { $cl -and $cl -match $ag.patronSesion } else { $true }

            if (-not $esSesion) { $otrosMB += $mb; $otrosProcs++; continue }

            # los hijos de una sesion son sus servidores MCP (cada uno cmd -> node)
            $hijos = @($procs | Where-Object { $_.ParentProcessId -eq $c.ProcessId })
            $mcp = @($hijos | Where-Object { $_.Name -eq 'cmd.exe' }).Count
            $mcpMB = 0
            foreach ($h in $hijos) {
                $mcpMB += [math]::Round($h.PrivatePageCount / 1048576, 0)
                foreach ($n in @($procs | Where-Object { $_.ParentProcessId -eq $h.ProcessId })) {
                    $mcpMB += [math]::Round($n.PrivatePageCount / 1048576, 0)
                }
            }

            # proyecto y titulo, solo si el agente guarda transcripts y su id
            # aparece en la linea de comandos
            $uuid = $null
            if ($ag.patronId -and $cl -and $cl -match $ag.patronId) { $uuid = $matches[1] }
            $info = if ($uuid) { Obtener-Titulo $uuid $raiz } else { $null }
            # La fecha se relee en cada muestra porque es lo que dice cuando
            # trabajo por ultima vez, pero sobre la ruta cacheada: volver a
            # buscar el archivo cada 2 segundos por sesion seria carisimo.
            $ultima = $null
            if ($info -and $info.ruta -and (Test-Path $info.ruta)) {
                $ultima = (Get-Item $info.ruta).LastWriteTime.ToString('o')
            }

            $sesiones += [ordered]@{
                pid      = $c.ProcessId
                mb       = [int]$mb
                mcp      = [int]$mcp
                mcpMB    = [int]$mcpMB
                inicio   = $c.CreationDate.ToString('o')
                cpuSeg   = [int](($c.KernelModeTime + $c.UserModeTime) / 10000000)
                uuid     = $uuid
                proyecto = if ($info) { $info.proyecto } else { $null }
                titulo   = if ($info) { $info.titulo } else { $null }
                ultima   = $ultima
            }
        }

        if ($sesiones.Count -or $otrosProcs) {
            $agentesSalida += [ordered]@{
                nombre     = $ag.nombre
                proceso    = $ag.proceso
                sesiones   = @($sesiones)
                otrosMB    = [int]$otrosMB
                otrosProcs = [int]$otrosProcs
            }
        }
    }

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
        agentes      = @($agentesSalida)
    } | ConvertTo-Json -Compress -Depth 5

    $tardo = ((Get-Date) - $t0).TotalMilliseconds
    $esperar = $IntervaloMs - $tardo
    if ($esperar -gt 50) { Start-Sleep -Milliseconds $esperar }
}
