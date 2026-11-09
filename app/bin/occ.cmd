@echo off
rem occ for Windows (cmd): runs bin\occ.ps1 with the same arguments.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0occ.ps1" %*
