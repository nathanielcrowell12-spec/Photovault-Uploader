@echo off
echo Building PhotoVault Desktop App...
echo.

REM Build the TypeScript
echo Step 1: Building TypeScript...
call npm run build
if %errorlevel% neq 0 (
    echo Build failed!
    pause
    exit /b 1
)

echo.
echo Step 2: Creating distribution folder...
if exist "dist" (
    echo TypeScript build successful!
    echo.
    echo The app is ready to run with: npm start
    echo.
    echo To create an installer, run PowerShell as Administrator and then:
    echo   npm run dist
    echo.
    echo Or distribute the source code directly to users.
) else (
    echo Build failed - dist folder not found
)

echo.
pause
