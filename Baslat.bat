@echo off
chcp 65001 >nul
title Seslendirme Studyosu
cd /d "%~dp0"
python server.py
if errorlevel 1 pause
