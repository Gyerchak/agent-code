@echo off
rem acode for Windows (cmd): runs bin\acode.ps1 with the same arguments.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0acode.ps1" %*
