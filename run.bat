@echo off
REM Lake Cement Dashboard — one-click launcher
REM Starts the backend API and opens the app in the browser.

cd /d "%~dp0"

echo Starting backend server (http://localhost:5000)...
start "Lake Cement MIS Backend" cmd /k "cd /d "%~dp0backend" && npm start"

echo Waiting for backend to boot...
timeout /t 3 /nobreak >nul

echo Opening app in browser...
start "" "%~dp0login.html"

echo.
echo Backend is running in its own window. Close that window to stop the server.
