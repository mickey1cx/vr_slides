@echo off
cd /d "%~dp0"
if not exist "cert\cert.pem" (
  echo Generating self-signed certificate...
  python tools\make_cert.py
  if errorlevel 1 pause & exit /b 1
)
python server.py
pause
