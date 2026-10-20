@echo off
title Reinitialisation mot de passe admin
cd /d "%~dp0.."
node tools\reset-admin-password.js %*
echo.
pause
