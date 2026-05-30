@echo off
title Wind Cycling App Starter
color 0A
echo ===================================================
echo             WIND CYCLING APP STARTER
echo ===================================================
echo.
if not exist node_modules (
    echo [INFO] node_modules folder not found. Installing dependencies...
    call npm install
) else (
    echo [INFO] Dependencies already installed. Skipping npm install.
)
echo.
echo [INFO] Starting Vite development server and opening app in your browser...
call npm run dev -- --open
echo.
pause
