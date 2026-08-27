@echo off
title Monitor del equipo
cd /d "%~dp0"

echo.
echo   Monitor del equipo
echo   ------------------
echo.

REM Primera vez: ofrece bajar LibreHardwareMonitor (temperatura de CPU,
REM ventiladores y voltajes). Se puede saltear: el monitor anda igual.
if not exist "LibreHardwareMonitor\LibreHardwareMonitor.exe" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0descargar-lhm.ps1"
)

REM LHM necesita administrador para leer los sensores del hardware.
if exist "LibreHardwareMonitor\LibreHardwareMonitor.exe" (
  tasklist /FI "IMAGENAME eq LibreHardwareMonitor.exe" 2>NUL | find /I "LibreHardwareMonitor.exe" >NUL
  if errorlevel 1 (
    echo   Levantando LibreHardwareMonitor ^(pide administrador^)...
    powershell -NoProfile -Command "Start-Process -FilePath '%~dp0LibreHardwareMonitor\LibreHardwareMonitor.exe' -Verb RunAs"
    timeout /t 6 /nobreak >NUL
  )
)

REM El panel lo abre server.js: asi puede cerrar la ventana solo
REM cuando parás el monitor con Ctrl+C.
node server.js
