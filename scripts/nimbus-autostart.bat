@echo off
title Nimbus Drive Auto-Start Daemon
cd /d "%~dp0\.."

:: 1. Start API Server (Port 4400) directly with Node
start "Nimbus API Server" /b node server/src/index.js

:: 2. Start Web Server (Port 3000) directly with Node
start "Nimbus Web Server" /b node web/node_modules/next/dist/bin/next start web

:: 3. Start Cloudflare Named Tunnel
start "Cloudflare Tunnel" /b cloudflared tunnel run nimbus
