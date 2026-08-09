@echo off
REM ============================================================
REM  Dagou-Tap frontend + backend server launcher
REM  Requires: Node.js v18+ (zero npm dependencies)
REM  Usage: double-click this file, or run ".\start.bat" here.
REM ============================================================
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Please install Node.js v18 or newer.
  echo         Get it from https://nodejs.org/
  echo.
  pause
  exit /b 1
)

REM Port can be overridden by setting PORT before running.
if "%PORT%"=="" set PORT=8000

REM If the requested port is busy, automatically try the next ports.
call :FindFreePort %PORT%
if errorlevel 1 (
  echo [ERROR] Could not find a free port between %PORT% and 8099.
  echo.
  pause
  exit /b 1
)

if not "%PORT%"=="%FREE_PORT%" (
  echo [WARN] Port %PORT% is already in use. Using port %FREE_PORT% instead.
  set PORT=%FREE_PORT%
)

echo ------------------------------------------------------------
echo  Dagou-Tap server
echo  Local:   http://localhost:%PORT%/
echo  API:     http://localhost:%PORT%/api/characters
echo  Press Ctrl+C to stop.
echo ------------------------------------------------------------
node scripts/server.js
set EXIT_CODE=%ERRORLEVEL%

echo.
if not "%EXIT_CODE%"=="0" (
  echo [ERROR] Server exited with code %EXIT_CODE%.
) else (
  echo [INFO] Server stopped.
)
echo.
pause
exit /b %EXIT_CODE%

:FindFreePort
set START_PORT=%~1
set FREE_PORT=
for /l %%P in (%START_PORT%,1,8099) do (
  netstat -ano | findstr /R /C:":%%P .*LISTENING" >nul
  if errorlevel 1 (
    set FREE_PORT=%%P
    exit /b 0
  )
)
exit /b 1
