@echo off
REM Double-click this to preview the app against the local database.
REM Opens two windows (backend API, frontend static server) and the browser.
cd /d "%~dp0"

start "LCL Backend  (localhost:5000)" cmd /k "cd backend && npm run dev"
start "LCL Frontend (localhost:3000)" cmd /k "node preview-server.js"

timeout /t 3 /nobreak >nul
start http://localhost:3000/login.html
