@echo off
REM AgentCore 一键启动（双击本文件即可）。调用同目录 start-dev.ps1，自动绕过执行策略。
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-dev.ps1"
