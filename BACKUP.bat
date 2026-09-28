@echo off
cd /d "%~dp0"
if not exist copias mkdir copias
set FECHA=%date:/=-%_%time::=-%
set FECHA=%FECHA: =0%
copy data\kiosco.sqlite copias\kiosco_%FECHA%.sqlite >nul
xcopy storage copias\storage_%FECHA%\ /E /I /Q >nul
echo Copia realizada en la carpeta copias.
pause
