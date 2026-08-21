@echo off
title Nimbus Drive Startup Installer
setlocal enabledelayedexpansion

echo =======================================================
echo   Nimbus Drive - Automatic Startup Installer
echo =======================================================
echo.

set "PROJECT_DIR=%~dp0.."
pushd "%PROJECT_DIR%"
set "PROJECT_DIR=%CD%"
popd

set "BAT_PATH=%PROJECT_DIR%\scripts\nimbus-autostart.bat"
set "STARTUP_FOLDER=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "VBS_PATH=%STARTUP_FOLDER%\NimbusDrive.vbs"

echo Project directory: %PROJECT_DIR%
echo Installing silent launcher into Windows Startup folder:
echo %VBS_PATH%
echo.

(
echo Set WshShell = CreateObject("WScript.Shell"^)
echo Set fso = CreateObject("Scripting.FileSystemObject"^)
echo WshShell.Run "cmd /c """ ^& "%BAT_PATH%" ^& """", 0, False
) > "%VBS_PATH%"

echo =======================================================
echo SUCCESS! Nimbus Drive auto-start is fully configured.
echo Whenever this computer powers on or restarts, Nimbus
echo Drive and Cloudflare Tunnel will launch automatically
echo in the background.
echo =======================================================
timeout /t 3 >nul 2>&1
