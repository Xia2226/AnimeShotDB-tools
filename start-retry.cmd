@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo ============================================
echo  FanCaps 未找到图片条目补抓工具
echo ============================================
echo.
echo 请选择操作：
echo   1. 只查看待补抓列表（不访问网络，不修改数据）
echo   2. 补抓前 50 条
echo   3. 补抓前 100 条
echo   4. 补抓后 50 条
echo   5. 补抓后 100 条
echo   6. 补抓全部（数量较大，耗时较长）
echo   7. 按 AniDB ID 补抓（可输入多个，逗号分隔）
echo   8. 继续上次中断（断点续跑）
echo   9. 补抓全部 error 状态条目（上次请求失败的）
echo  10. 按 AniDB ID + 自定义番剧页链接补抓（人工复核歧义条目用）
echo.
set /p CHOICE=请输入数字后回车：
echo.

if "%CHOICE%"=="1" goto :opt1
if "%CHOICE%"=="2" goto :opt2
if "%CHOICE%"=="3" goto :opt3
if "%CHOICE%"=="4" goto :opt4
if "%CHOICE%"=="5" goto :opt5
if "%CHOICE%"=="6" goto :opt6
if "%CHOICE%"=="7" goto :opt7
if "%CHOICE%"=="8" goto :opt8
if "%CHOICE%"=="9" goto :opt9
if "%CHOICE%"=="10" goto :opt10
echo 无效输入，未执行任何操作。
goto :end

:opt1
node "tools\retry-fancaps-missing.mjs" --dry-run
goto :end

:opt2
node "tools\retry-fancaps-missing.mjs" --limit 50
goto :end

:opt3
node "tools\retry-fancaps-missing.mjs" --limit 100
goto :end

:opt4
node "tools\retry-fancaps-missing.mjs" --limit-tail 50
goto :end

:opt5
node "tools\retry-fancaps-missing.mjs" --limit-tail 100
goto :end

:opt6
node "tools\retry-fancaps-missing.mjs"
goto :end

:opt7
set "ANIDB_IDS="
echo 请输入要补抓的 AniDB ID，可输入多个（用英文或中文逗号分隔），例如：
echo   14291
echo   14291,14785,16063
echo.
set /p ANIDB_IDS=请输入 AniDB ID 后回车：
echo.
if "%ANIDB_IDS%"=="" (
  echo 未输入任何 ID，已取消本次操作。
) else (
  node "tools\retry-fancaps-missing.mjs" --anidb-ids "%ANIDB_IDS%"
)
goto :end

:opt8
node "tools\retry-fancaps-missing.mjs" --resume
goto :end

:opt9
node "tools\retry-fancaps-missing.mjs" --status error
goto :end

:opt10
set "MANUAL_ID="
set "MANUAL_URL="
echo 说明：当补抓提示"多个候选，无法唯一确认"时，先在浏览器打开日志给出的搜索页，
echo 核对正确条目并点进去，复制地址栏的番剧页链接（形如：
echo   https://fancaps.net/anime/showimages.php?<anidb_id>-<标题>
echo 注意是番剧页，不是单集或单张图片页）。
echo.
set /p MANUAL_ID=请输入 AniDB ID 后回车：
echo.
if "%MANUAL_ID%"=="" (
  echo 未输入 ID，已取消本次操作。
  goto :end
)
set /p MANUAL_URL=请输入番剧 show 页面链接后回车：
echo.
if "%MANUAL_URL%"=="" (
  echo 未输入链接，已取消本次操作。
  goto :end
)
node "tools\retry-fancaps-missing.mjs" --anidb-ids "%MANUAL_ID%" --override "%MANUAL_ID%=%MANUAL_URL%"
goto :end

:end
echo.
pause
exit /b %ERRORLEVEL%
