@echo off
REM Uso normal: Ctrl+C en la ventana del monitor. Eso deja la marca de cierre
REM limpio y cierra la ventana del panel.
REM
REM Este script es para el caso feo: la consola se cerro con la X y quedaron
REM procesos dando vueltas. Ojo, NO deja marca de cierre limpio, asi que el
REM proximo arranque lo va a reportar como un corte de energia.

echo.
echo   Cerrando procesos huerfanos del monitor...
echo.

REM ventanas del panel (identificadas por su perfil temporal propio)
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe' OR Name='chrome.exe' OR Name='brave.exe'\" | Where-Object { $_.CommandLine -match 'monitor-sistema-perfil' } | ForEach-Object { Write-Host ('   ventana del panel, PID ' + $_.ProcessId); Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"

REM el server
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'monitor-sistema' } | ForEach-Object { Write-Host ('   server, PID ' + $_.ProcessId); Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"

echo.
echo   Listo.
pause
