@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo Instalando dependencias del proyecto...
  call npm install
)
if not exist .env (
  copy .env.example .env >nul
  echo.
  echo Se creo .env. Completa los datos de produccion antes de usar pagos.
  echo.
)
node servidor.js
pause
