@echo off
setlocal
cd /d "%~dp0"

echo ==================================================
echo   Student Management ^& Notification System
echo ==================================================
echo.

where npm >nul 2>nul
if errorlevel 1 (
    echo ERROR: npm was not found on this machine.
    echo Install Node.js 24 from https://nodejs.org and run this file again.
    goto :failed
)

if not exist "node_modules" (
    echo Installing root tools ^(concurrently^) ...
    call npm install
    if errorlevel 1 goto :failed
    echo.
)

if not exist "server\node_modules" (
    echo First run detected - installing dependencies and preparing the database.
    echo This can take a few minutes. Please wait.
    echo.
    call npm run setup
    if errorlevel 1 goto :failed
    echo.
    echo Setup finished successfully.
    echo.
)

echo Starting the system...
echo   API : http://localhost:4000
echo   App : http://localhost:5173
echo.
echo Press Ctrl+C in this window to stop.
echo.

call npm run dev
if errorlevel 1 goto :failed

goto :done

:failed
echo.
echo --------------------------------------------------
echo  Something went wrong. Read the message above.
echo --------------------------------------------------
echo.
pause
exit /b 1

:done
endlocal
