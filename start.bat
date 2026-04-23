@echo off
title HYPE Premium Index
echo.
echo  ================================================
echo   HYPE Premium Index - Hyperliquid Buyback Chart
echo  ================================================
echo.
echo  Demarrage des serveurs...
echo  Frontend : http://localhost:8080
echo  Backend  : http://localhost:3001
echo  Mode local: worker auto desactive
echo.
echo  Appuyez sur Ctrl+C pour arreter les serveurs.
echo.

:: Start backend in background with worker disabled in the parent shell
cd backend
set "DISABLE_WORKER=true"
set "ALLOW_NULL_ORIGIN=true"
start "HYPE Premium Backend" /B cmd /c "node server.js"
set "DISABLE_WORKER="
set "ALLOW_NULL_ORIGIN="
cd ..

:: Start frontend with local route rewrites
start http://localhost:8080
node local-frontend-server.js

:end
