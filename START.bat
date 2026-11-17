@echo off
cd /d "%~dp0"
echo Starting Stock Portal...
echo Retailer page:  http://localhost:3000
echo Admin panel:    http://localhost:3000/admin
start "" http://localhost:3000/admin
node server.js
pause
