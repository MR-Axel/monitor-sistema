@echo off
REM Corta el monitor dejando marca de cierre limpio, para que la proxima
REM vez NO lo interprete como un corte de energia.
taskkill /IM node.exe /FI "WINDOWTITLE eq Monitor*" >NUL 2>&1
echo Para cortar bien, usa Ctrl+C en la ventana del monitor.
echo Si la cerraste con la X, el proximo arranque lo va a marcar como corte.
pause
