@echo off
title HYPE Premium Index
echo.
echo  ================================================
echo   HYPE Premium Index - Hyperliquid Buyback Chart
echo  ================================================
echo.
echo  Demarrage du serveur local...
echo  Le navigateur va s'ouvrir sur http://localhost:8080
echo.
echo  Appuyez sur Ctrl+C pour arreter le serveur.
echo.

:: Try Python 3 first
where python >nul 2>nul
if %ERRORLEVEL% equ 0 (
    start http://localhost:8080
    python -m http.server 8080
    goto :end
)

:: Try Python via py launcher
where py >nul 2>nul
if %ERRORLEVEL% equ 0 (
    start http://localhost:8080
    py -m http.server 8080
    goto :end
)

:: Try npx serve (requires Node.js)
where npx >nul 2>nul
if %ERRORLEVEL% equ 0 (
    start http://localhost:8080
    npx serve -l 8080
    goto :end
)

echo.
echo  ERREUR: Ni Python ni Node.js n'ont ete trouves.
echo.
echo  Installez l'un des deux:
echo    - Python: https://www.python.org/downloads/
echo    - Node.js: https://nodejs.org/
echo.
echo  Ou ouvrez index.html avec l'extension "Live Server" de VS Code.
echo.
pause

:end
