@echo off
title Nouveau mot de passe - compte concepteur drpc
cd /d "%~dp0.."
node tools\reset-admin-password.js --restaurant docteurpc --user drpc
echo.
pause
