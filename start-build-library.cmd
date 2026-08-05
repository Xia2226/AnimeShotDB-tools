@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo ============================================
echo  精简题库 anime-library 与封面构建工具
echo ============================================
echo.

REM ---------- 检查 Node.js ----------
set "NODE_MAJOR=0"
set "NODE_MINOR=0"
for /f "tokens=*" %%v in ('node --version 2^>nul') do set "NODE_VER=%%v"
if "%NODE_VER%"=="" (
  echo [错误] 未找到 Node.js，请先安装 Node.js 20.11 或更高版本。
  goto :fail
)
set "NODE_VER=%NODE_VER:v=%"
for /f "tokens=1,2 delims=." %%a in ("%NODE_VER%") do (
  set "NODE_MAJOR=%%a"
  set "NODE_MINOR=%%b"
)
if %NODE_MAJOR% LSS 20 goto :node_too_old
if %NODE_MAJOR% EQU 20 if %NODE_MINOR% LSS 11 goto :node_too_old
echo 当前 Node.js 版本：v%NODE_VER%（可用）
echo.

REM ---------- 检查必需输入文件 ----------
set "MISSING=0"
if not exist "resources\fancaps_anime_images.jsonl" (
  echo [错误] 缺少 resources\fancaps_anime_images.jsonl
  set "MISSING=1"
)
if not exist "resources\subject.jsonlines" (
  echo [错误] 缺少 resources\subject.jsonlines
  set "MISSING=1"
)
if "%MISSING%"=="1" (
  echo.
  echo 请先准备好上述输入文件（来源与获取方式见 README.md）。
  goto :fail
)
echo 输入文件检查通过。
echo.

REM ---------- 检查依赖 ----------
if not exist "node_modules\undici" (
  echo 正在安装依赖（undici，用于封面下载的本地代理支持）…
  call npm install
  if errorlevel 1 (
    echo [错误] 依赖安装失败，请检查网络后重试。
    goto :fail
  )
)

echo 请选择操作：
echo   1. 完整构建：生成精简题库并下载全部封面（推荐，首次使用）
echo   2. 仅构建题库：跳过封面下载（适合先看题库是否可用）
echo   3. 校验：检查已生成的题库与隔离报告（不访问网络）
echo   4. 强制刷新封面并完整构建（忽略本地已有封面，全部重新下载）
echo.
set /p CHOICE=请输入数字后回车：
echo.

if "%CHOICE%"=="1" goto :build_full
if "%CHOICE%"=="2" goto :build_no_cover
if "%CHOICE%"=="3" goto :check_only
if "%CHOICE%"=="4" goto :build_force_covers
echo 无效输入，未执行任何操作。
goto :end

:build_full
echo 开始完整构建（约需几分钟，封面下载受网络与代理影响）…
echo 提示：封面请求默认经 http://127.0.0.1:10808 代理访问 Bangumi；
echo 若你的代理端口不同，请先运行 set HTTPS_PROXY=http://127.0.0.1:端口 再启动本程序。
echo.
node "tools\build-anime-library.mjs"
set "BUILD_EXIT_CODE=%ERRORLEVEL%"
goto :done

:build_no_cover
echo 开始构建（跳过封面下载，题库中 cover 字段将为空）…
echo.
set "NO_COVER_FETCH=1"
node "tools\build-anime-library.mjs"
set "BUILD_EXIT_CODE=%ERRORLEVEL%"
goto :done

:build_force_covers
echo 开始强制刷新封面并完整构建（忽略本地已有封面，全部重新下载）…
echo.
node "tools\build-anime-library.mjs" --force-covers
set "BUILD_EXIT_CODE=%ERRORLEVEL%"
goto :done

:check_only
echo 开始校验已生成题库…
echo.
node "tools\build-anime-library.mjs" --check
set "BUILD_EXIT_CODE=%ERRORLEVEL%"
goto :done

:done
echo.
if not "%BUILD_EXIT_CODE%"=="0" (
  echo 构建未完成。请根据上方错误信息检查输入文件或网络/代理设置。
) else (
  echo 构建完成。产物如下：
  echo   - public\data\anime-library.json       精简题库
  echo   - public\data\covers\                  封面图片目录
  echo   - resources\generated\anime-library-quarantine.json  隔离报告
  echo 如需部署到 Anime-Frame-Quiz 项目，请将 anime-library.json 与 covers 目录
  echo 复制到该项目的 public\data\ 下。
)
goto :end

:node_too_old
echo [错误] Node.js 版本过低（当前 v%NODE_VER%），构建脚本需要 20.11 或更高版本。
goto :fail

:fail
echo.
echo 构建未能启动。
echo.

:end
echo.
pause
exit /b %ERRORLEVEL%
