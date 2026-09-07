@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Ultimate Animation Index needs Node.js 22.16+ or 24+.
  echo Download and install Node.js, then double-click start.bat again.
  echo.
  pause
  exit /b 1
)
where npm >nul 2>nul
if errorlevel 1 (
  echo.
  echo npm was not found. Repair or reinstall Node.js, then try again.
  echo.
  pause
  exit /b 1
)
if "%PORT%"=="" (set "UAI_PORT=8787") else (set "UAI_PORT=%PORT%")
set "UAI_URL=http://localhost:%UAI_PORT%"
start "" powershell -NoProfile -WindowStyle Hidden -Command "$u='%UAI_URL%'; for($i=0;$i -lt 80;$i++){ try { $r=Invoke-WebRequest -UseBasicParsing -Uri ($u + '/api/health') -TimeoutSec 1; if($r.StatusCode -eq 200){ Start-Process $u; break } } catch {}; Start-Sleep -Milliseconds 250 }"
echo.
echo Ultimate Animation Index
echo Starting the site and opening it in your default browser...
echo Keep this window open while you use the site.
echo Close this window to stop the local server.
echo.
npm start
if errorlevel 1 (
  echo.
  echo The server stopped with an error.
  pause
)
