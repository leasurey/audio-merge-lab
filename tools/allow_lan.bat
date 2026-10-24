@echo off
cd /d %~dp0
title Allow LAN access for Audio Merge Lab

rem Default port matches tools/serve.js; override with: allow_lan.bat 8020
set PORT=8010
if not "%~1"=="" set PORT=%~1

rem --- Require administrator: relaunch with UAC if not elevated ---
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo [i] Administrator rights are required. Asking for elevation...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -ArgumentList '%PORT%' -Verb RunAs"
  exit /b
)

echo.
echo Allowing inbound TCP %PORT% (private/domain profiles, local subnet only)...
netsh advfirewall firewall delete rule name="AML-Serve-%PORT%" >nul 2>&1
netsh advfirewall firewall add rule name="AML-Serve-%PORT%" dir=in action=allow protocol=TCP localport=%PORT% profile=private,domain remoteip=localsubnet

if %errorlevel% equ 0 (
  echo.
  echo [OK] Firewall rule added for TCP %PORT% (local subnet only).
  echo      Start the server first:  node tools\serve.js --port %PORT%
  echo      Then open this address on your phone (same Wi-Fi):
  for /f "delims=" %%A in ('powershell -NoProfile -Command "(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notmatch '^(127|169)' -and $_.InterfaceAlias -notmatch 'Loopback' } | Select-Object -First 1).IPAddress"') do echo          http://%%A:%PORT%
  echo.
  echo To remove the rule later:
  echo      netsh advfirewall firewall delete rule name="AML-Serve-%PORT%"
) else (
  echo [!] Failed to add the rule. Make sure you allowed the UAC prompt.
)
echo.
pause
