@echo off
cd /d "%~dp0"
if not exist "logs" mkdir logs
if not exist "cert\cert.pem" (
  echo Generating self-signed certificate...
  python tools\make_cert.py
  if errorlevel 1 pause & exit /b 1
)
echo Debug mode: log file is created in logs\ with the server start time in its name.
echo Open the page and press the "Logs" button to read it in the browser.
python server.py --log
pause
