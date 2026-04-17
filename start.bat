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

:: Start frontend
where python >nul 2>nul
if %ERRORLEVEL% equ 0 (
    start http://localhost:8080
    python -m http.server 8080
    goto :end
)

where py >nul 2>nul
if %ERRORLEVEL% equ 0 (
    start http://localhost:8080
    py -m http.server 8080
    goto :end
)

where npx >nul 2>nul
if %ERRORLEVEL% equ 0 (
    start http://localhost:8080
    npx serve -l 8080
    goto :end
)

echo.
echo  ERREUR: Ni Python ni Node.js n'ont ete trouves.
echo.
pause

:end
