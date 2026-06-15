@echo off
REM fast-vibe launcher — auto-build if needed, then start the supervisor.
REM The supervisor (dist/app.js) opens the browser at http://localhost:3333
REM as soon as the server is ready.

setlocal
cd /d "%~dp0\.."

if not exist "dist\app.js" (
  echo [launcher] dist missing, running npm run build...
  call npm run build
  if errorlevel 1 (
    echo [launcher] build failed.
    pause
    exit /b 1
  )
)

node dist\app.js
