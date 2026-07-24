@echo off
echo ==========================================
echo       Smart Scheduler - Dev Starter
echo ==========================================

:: וודא שאנחנו בתיקייה של הקובץ (התיקייה הראשית)
cd /d "%~dp0"

echo [1/3] Stopping old containers...
docker-compose down

echo [2/3] Starting Backend (Docker)...
:: פותח חלון חדש לשרת
start "Smart Scheduler Backend" docker-compose up --build api

echo [3/3] Starting Frontend (Vite)...
cd frontend
:: פותח חלון חדש לאתר
start "Smart Scheduler Frontend" npm run dev

echo.
echo ==========================================
echo Great Success! The system is starting up.
echo Backend API: http://localhost:8000
echo Frontend UI: http://localhost:5173
echo ==========================================
echo.
pause
