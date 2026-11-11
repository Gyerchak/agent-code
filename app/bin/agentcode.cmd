@echo off
rem agentcode for Windows (cmd): runs bin\agentcode.ps1 with the same arguments.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0agentcode.ps1" %*
