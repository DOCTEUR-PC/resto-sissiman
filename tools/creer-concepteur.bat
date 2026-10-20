@echo off
title Compte concepteur Docteur PC
cd /d "%~dp0.."
node tools\creer-concepteur.js %*
echo.
pause
