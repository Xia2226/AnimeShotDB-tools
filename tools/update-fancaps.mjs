// tools/update-fancaps.mjs
// AnimeShotDB 增量更新编排器（update-fancaps.ps1 的 Node 移植版，行为保持一致）
// 入口：node tools/update-fancaps.mjs（由 start-update.cmd 双击调用）
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const TOOL_ROOT = path.resolve(import.meta.dirname, "..");
process.chdir(TOOL_ROOT);

const OUTPUT_ROOT = path.join(TOOL_ROOT, "output");

const pad = (n) => String(n).padStart(2, "0");

function localTimestamp() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function localDate() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function isoNow() {
  return new Date().toISOString();
}

function formatLocalMtime(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function sha256Of(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const input = createReadStream(filePath);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("end", () => resolve(hash.digest("hex")));
    input.on("error", reject);
  });
}

// 输出一行日志：控制台 + 追加写入日志文件
function log(level, message, logPath) {
  const line = `[${localTimestamp()}] [${level}] ${message}`;
  console.log(line);
  if (logPath) appendLog(logPath, `${line}\n`);
}

function appendLog(logPath, text) {
  // 以追加方式写日志文件（异步，进程退出前事件循环会保证完成）
  const file = createWriteStream(logPath, { flags: "a", encoding: "utf8" });
  file.end(text);
}

// 运行子进程并实时把 stdout/stderr 转发到控制台和日志文件；返回退出码
function streamProcess(cmd, args, logPath) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { windowsHide: true });
    const onData = (chunk) => {
      const text = chunk.toString("utf8");
      process.stdout.write(text);
      if (logPath) appendLog(logPath, text);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (error) => resolve({ code: -1, error }));
    child.on("close", (code) => resolve({ code: code ?? -1 }));
  });
}

// 运行子进程，静默捕获输出；返回 { code, output }
function runQuiet(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let output = "";
    const onData = (chunk) => {
      output += chunk.toString("utf8");
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (error) => resolve({ code: -1, output, error }));
    child.on("close", (code) => resolve({ code: code ?? -1, output }));
  });
}

// 等价于 ps1 的 Invoke-LoggedNode：记录开始/结束日志，子进程失败时抛出
async function runNode(stage, args, logPath) {
  log("INFO", `开始：${stage}`, logPath);
  const result = await streamProcess(process.execPath, args, logPath);
  if (result.error || result.code !== 0) {
    const detail = result.error ? `（${result.error.message}）` : "";
    throw new Error(`${stage} 失败，Node 退出码：${result.code}${detail}`);
  }
  log("SUCCESS", `完成：${stage}`, logPath);
}

// 等价于 ps1 的 New-RunDirectory：复用今天的未完成目录，否则新建 dateName[-NN]
async function newRunDirectory(root) {
  await mkdir(root, { recursive: true });
  const dateName = localDate();

  let incomplete = null;
  let latestMtime = 0;
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(dateName)) continue;
    if (!existsSync(path.join(root, entry.name, ".update-incomplete"))) continue;
    const info = await stat(path.join(root, entry.name));
    if (info.mtimeMs > latestMtime) {
      latestMtime = info.mtimeMs;
      incomplete = path.join(root, entry.name);
    }
  }
  if (incomplete) return incomplete;

  let candidate = path.join(root, dateName);
  let suffix = 2;
  while (existsSync(candidate)) {
    candidate = path.join(root, `${dateName}-${pad(suffix)}`);
    suffix += 1;
  }
  await mkdir(candidate, { recursive: true });
  await writeFile(path.join(candidate, ".update-incomplete"), isoNow(), "utf8");
  return candidate;
}

// 等价于 ps1 的 Get-ConfigValue：缺失/空字符串时返回默认值
function getConfigValue(config, name, fallback) {
  const value = config?.[name];
  if (value === undefined || value === null) return fallback;
  if (typeof value === "string" && value.trim() === "") return fallback;
  return value;
}

// 等价于 ps1 的 Resolve-ToolPath：相对路径基于工具目录解析
function resolveToolPath(value) {
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(TOOL_ROOT, value);
}

async function main() {
  let LogPath = "";
  let RunDirectory = "";
  try {
    RunDirectory = await newRunDirectory(OUTPUT_ROOT);
    LogPath = path.join(RunDirectory, "update.log");

    log("INFO", "AnimeShotDB 增量更新开始", LogPath);
    log("INFO", `工具目录：${TOOL_ROOT}`, LogPath);
    log("INFO", `本次产出目录：${RunDirectory}`, LogPath);

    // ---------- 配置与输入文件检查 ----------
    const ConfigPath = path.join(TOOL_ROOT, "update-config.json");
    if (!existsSync(ConfigPath)) throw new Error(`缺少配置文件：${ConfigPath}`);
    const config = JSON.parse(await readFile(ConfigPath, "utf8"));
    await copyFile(ConfigPath, path.join(RunDirectory, "update-config.used.json"));

    const SubjectPath = resolveToolPath(String(getConfigValue(config, "subject_dump", "resources/subject.jsonlines")));
    let TitlesPath = resolveToolPath(String(getConfigValue(config, "anidb_titles", "resources/anime-titles.xml")));
    if (!existsSync(TitlesPath) && existsSync(`${TitlesPath}.gz`)) TitlesPath = `${TitlesPath}.gz`;
    const MappingPath = resolveToolPath(String(getConfigValue(config, "anime_map", "resources/anime_map.json")));
    const DatasetPath = resolveToolPath(String(getConfigValue(config, "current_dataset", "resources/fancaps_anime_images.jsonl")));
    const ToolScript = path.join(TOOL_ROOT, "tools", "append-fancaps-new-anime.mjs");
    const FinalizeScript = path.join(TOOL_ROOT, "tools", "finalize-update.mjs");

    const requiredFiles = [
      { label: "Bangumi subject dump", path: SubjectPath },
      { label: "AniDB title dump", path: TitlesPath },
      { label: "Bangumi/AniDB mapping", path: MappingPath },
      { label: "current FanCaps dataset", path: DatasetPath },
      { label: "crawler", path: ToolScript },
      { label: "finalizer", path: FinalizeScript },
    ];
    for (const item of requiredFiles) {
      if (!existsSync(item.path)) throw new Error(`缺少 ${item.label}：${item.path}`);
      const info = await stat(item.path);
      const size = info.size.toLocaleString("en-US");
      log("INFO", `输入：${item.label} | ${item.path} | ${size} bytes | 修改时间 ${formatLocalMtime(info.mtime)}`, LogPath);
    }

    // ---------- Node 与依赖检查 ----------
    const nodeVersion = await streamProcess(process.execPath, ["--version"], LogPath);
    if (nodeVersion.error || nodeVersion.code !== 0) {
      throw new Error("未找到 Node.js，请先安装 Node.js 20 或更高版本");
    }

    const depCheck = await runQuiet(process.execPath, ["-e", "import('cheerio').then(()=>process.exit(0)).catch(()=>process.exit(1))"]);
    if (depCheck.code !== 0) {
      log("INFO", "首次运行：正在安装固定版本依赖 cheerio@1.1.2", LogPath);
      const installResult = await streamProcess(npmCommand(), ["install", "--no-audit", "--no-fund"], LogPath);
      if (installResult.code !== 0) throw new Error("npm install 失败，请检查 Node/npm 和网络");
    }

    // ---------- 配置项读取与校验 ----------
    const BaseCutoff = String(getConfigValue(config, "base_cutoff", "2026-05-27"));
    const ToDate = String(getConfigValue(config, "to_date", localDate()));
    const MinDone = Number(getConfigValue(config, "min_done", 100));
    const FanCapsHttpTransport = String(getConfigValue(config, "fancaps_http_transport", "curl"));
    const FanCapsUserAgent = String(getConfigValue(config, "fancaps_user_agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36"));
    const DelayMs = Number(getConfigValue(config, "delay_ms", 3000));
    const TimeoutMs = Number(getConfigValue(config, "timeout_ms", 45000));
    const Retries = Number(getConfigValue(config, "retries", 2));
    const MaxShowPages = Number(getConfigValue(config, "max_show_pages", 30));
    const ConnectivityTest = Boolean(getConfigValue(config, "connectivity_test", true));
    const ConnectivityLimit = Number(getConfigValue(config, "connectivity_test_limit", 1));
    const AcceptFirstAmbiguous = Boolean(getConfigValue(config, "accept_first_ambiguous", false));

    if (!/^\d{4}-\d{2}-\d{2}$/.test(BaseCutoff)) throw new Error("update-config.json 的 base_cutoff 必须是 YYYY-MM-DD");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ToDate)) throw new Error("update-config.json 的 to_date 必须留空或使用 YYYY-MM-DD");
    if (!["fetch", "curl"].includes(FanCapsHttpTransport)) throw new Error("update-config.json 的 fancaps_http_transport 只能是 fetch 或 curl");
    if (FanCapsHttpTransport === "curl") {
      const curlResult = await runQuiet("curl.exe", ["--version"]);
      if (curlResult.code !== 0) throw new Error("未找到 curl.exe；Windows 10/11 通常自带，请安装或修复系统 curl 后重试");
    }

    log("INFO", `增量范围：${BaseCutoff} 之后至 ${ToDate}；最低看过人数：${MinDone}`, LogPath);
    log("INFO", FanCapsHttpTransport === "curl"
      ? "FanCaps 请求方式：curl（本机兼容模式，使用系统/VPN 网络）"
      : "FanCaps 请求方式：Node fetch", LogPath);
    process.env.FANCAPS_USER_AGENT = FanCapsUserAgent;
    process.env.FANCAPS_HTTP_TRANSPORT = FanCapsHttpTransport;
    log("INFO", "FanCaps 请求头：使用浏览器兼容 User-Agent", LogPath);
    log("INFO", `连接参数：delay=${DelayMs}ms timeout=${TimeoutMs}ms retries=${Retries} maxShowPages=${MaxShowPages}`, LogPath);

    // ---------- 备份输入题库 ----------
    const BackupDirectory = path.join(RunDirectory, "backup");
    await mkdir(BackupDirectory, { recursive: true });
    const BackupPath = path.join(BackupDirectory, "fancaps_anime_images.before-update.jsonl");
    if (!existsSync(BackupPath)) await copyFile(DatasetPath, BackupPath);
    const InputHash = await sha256Of(DatasetPath);
    const BackupHash = await sha256Of(BackupPath);
    if (InputHash !== BackupHash) throw new Error("题库备份哈希与输入不一致，已停止");
    log("SUCCESS", `输入题库备份完成，SHA-256：${BackupHash}`, LogPath);

    // ---------- 增量抓取（三个子阶段） ----------
    const MergedPath = path.join(RunDirectory, "fancaps_anime_images.updated.jsonl");
    const commonArgs = [
      ToolScript,
      "--existing", DatasetPath,
      "--bangumi-dump", SubjectPath,
      "--mapping", MappingPath,
      "--anidb-titles", TitlesPath,
      "--cutoff", BaseCutoff,
      "--to", ToDate,
      "--min-done", String(MinDone),
      "--delay-ms", String(DelayMs),
      "--timeout-ms", String(TimeoutMs),
      "--retries", String(Retries),
      "--max-show-pages", String(MaxShowPages),
      "--http-transport", FanCapsHttpTransport,
    ];
    if (AcceptFirstAmbiguous) commonArgs.push("--accept-first-ambiguous");

    await runNode("候选预检（不访问 FanCaps）", [...commonArgs, "--output", MergedPath, "--dry-run"], LogPath);

    if (ConnectivityTest) {
      const TestPath = path.join(RunDirectory, "connectivity-test.jsonl");
      await runNode(`FanCaps 连通性测试（${ConnectivityLimit} 条）`, [...commonArgs, "--output", TestPath, "--limit", String(ConnectivityLimit)], LogPath);
    }

    const CrawlMarker = path.join(RunDirectory, ".crawl-complete");
    if (!existsSync(CrawlMarker)) {
      await runNode("完整增量抓取", [...commonArgs, "--output", MergedPath], LogPath);
      await writeFile(CrawlMarker, isoNow(), "utf8");
    } else {
      log("INFO", "检测到完整抓取完成标记，跳过重复抓取并继续整理产物", LogPath);
    }

    // ---------- 整理 unmapped / errors 产物 ----------
    const UnmappedSource = `${MergedPath}.unmapped.jsonl`;
    const ErrorsSource = `${MergedPath}.errors.jsonl`;
    const UnmappedPath = path.join(RunDirectory, "unmapped.jsonl");
    const ErrorsPath = path.join(RunDirectory, "errors.jsonl");
    if (existsSync(UnmappedSource)) await copyFile(UnmappedSource, UnmappedPath);
    if (existsSync(ErrorsSource)) await copyFile(ErrorsSource, ErrorsPath);
    if (!existsSync(UnmappedPath)) await writeFile(UnmappedPath, "", "utf8");
    if (!existsSync(ErrorsPath)) await writeFile(ErrorsPath, "", "utf8");

    // ---------- 校验并生成摘要 ----------
    const IncrementalPath = path.join(RunDirectory, "fancaps_anime_images.incremental-only.jsonl");
    const SummaryPath = path.join(RunDirectory, "update-summary.json");
    const finalizeArgs = [
      FinalizeScript,
      "--existing", DatasetPath,
      "--updated", MergedPath,
      "--incremental", IncrementalPath,
      "--unmapped", UnmappedPath,
      "--errors", ErrorsPath,
      "--summary", SummaryPath,
      "--subject", SubjectPath,
      "--titles", TitlesPath,
      "--mapping", MappingPath,
      "--cutoff", BaseCutoff,
      "--to", ToDate,
      "--min-done", String(MinDone),
    ];
    await runNode("校验 JSONL 并生成纯增量和摘要", finalizeArgs, LogPath);

    // ---------- 收尾：标记完成、替换题库 ----------
    const UpdatedHash = await sha256Of(MergedPath);
    log("SUCCESS", `合并题库 SHA-256：${UpdatedHash}`, LogPath);
    log("SUCCESS", `更新成功，产出目录：${RunDirectory}`, LogPath);
    await rm(path.join(RunDirectory, ".update-incomplete"), { force: true });
    await writeFile(
      path.join(RunDirectory, "SUCCESS.txt"),
      `Completed: ${isoNow()}\r\nDataset SHA-256: ${UpdatedHash}`,
      "utf8",
    );

    const summary = JSON.parse(await readFile(SummaryPath, "utf8"));
    const errorReportCount = Number(summary?.result?.error_report_records ?? 0);
    if (errorReportCount === 0) {
      await copyFile(MergedPath, DatasetPath);
      log("SUCCESS", `已自动替换资源题库：${DatasetPath}`, LogPath);
    } else {
      log("WARN", `error_report_records=${errorReportCount}，未自动替换资源题库；请人工检查 errors.jsonl 后手动替换`, LogPath);
    }
  } catch (error) {
    const message = error?.message ?? String(error);
    log("ERROR", message, LogPath);
    if (LogPath) {
      log("ERROR", `更新未完成；修复问题后再次双击脚本，将自动继续今天的未完成目录：${RunDirectory}`, LogPath);
    }
    process.exitCode = 1;
  }
}

main();
