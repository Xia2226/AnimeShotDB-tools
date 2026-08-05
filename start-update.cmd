@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

for /f "tokens=*" %%v in ('node --version 2^>nul') do set "NODE_VER=%%v"
if "%NODE_VER%"=="" (
  echo [错误] 未找到 Node.js，请先安装 Node.js 20.11 或更高版本。
  echo.
  pause
  exit /b 1
)
set "NODE_VER=%NODE_VER:v=%"
for /f "tokens=1,2 delims=." %%a in ("%NODE_VER%") do (
  set "NODE_MAJOR=%%a"
  set "NODE_MINOR=%%b"
)
if %NODE_MAJOR% LSS 20 goto :node_too_old
if %NODE_MAJOR% EQU 20 if %NODE_MINOR% LSS 11 goto :node_too_old

node "tools\update-fancaps.mjs"
set "UPDATE_EXIT_CODE=%ERRORLEVEL%"
echo.
if not "%UPDATE_EXIT_CODE%"=="0" (
  echo 更新未完成。请查看 output 目录下当日文件夹的 update.log。
) else (
  echo 更新完成。详情见 output 目录下当日文件夹。
  echo 若 error_report_records 为 0，已自动替换 resources\fancaps_anime_images.jsonl。
)
echo.
pause
exit /b %UPDATE_EXIT_CODE%

:node_too_old
echo [错误] Node.js 版本过低（当前 v%NODE_VER%），需要 20.11 或更高版本。
echo.
pause
exit /b 1
