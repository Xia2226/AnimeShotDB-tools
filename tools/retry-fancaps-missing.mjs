#!/usr/bin/env node

// 未找到图片条目补抓脚本
// 扫描题库 resources/fancaps_anime_images.jsonl 中 status!=="ok" 或 images 为空的条目，
// 依次在 FanCaps 查找并抓取图片：
//   1) 先用记录的 anidb_id 数字搜索；
//   2) 若未找到，用 anidb_id 在 anime-titles.xml（AniDB 标题库）中查出该番的标题，
//      依次用标题搜索（跳过中文标题）。
// - 抓取成功：更新该条目（images/status/crawled_at/fancaps 等），并写入本次更新内容；
// - 仍未找到或请求失败：保持原始条目完全不变。
// - 歧义条目可用 --override <anidb_id>=<show_url>（或便捷写法 --show-url <url>）手工指定
//   FanCaps 番剧 show 页面链接，跳过搜索直接抓取该页图片，用于人工复核时自主选择正确条目。
// 结果自动替换回题库文件（替换前先备份到本次输出目录的 backup/ 下）。
// 支持断点续跑：每条处理结果写入断点快照（*.retry.partial.jsonl），中断后加 --resume 从上次位置继续。

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import zlib from "node:zlib";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { load } from "cheerio";

const FANCAPS_BASE = "https://fancaps.net";
const FANCAPS_IMAGE_HOST = "cdni.fancaps.net";
const FANCAPS_IMAGE_PATH = "/file/fancaps-animeimages/";
// FanCaps 缩略图域名；缩略图与 cdni 原始大图共用同一数字 ID，可直接换算
const FANCAPS_THUMB_HOST = "ant.fancaps.net";
const DEFAULT_FILE = path.join("resources", "fancaps_anime_images.jsonl");
const DEFAULT_TITLES_FILE = path.join("resources", "anime-titles.xml");
const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";

// 注意：必须声明在主流程之前。主流程使用顶层 await，若类声明在文件底部，
// 循环执行时该类仍处于暂时性死区（TDZ），引用会抛 "Cannot access ... before initialization"
class AmbiguousMatchError extends Error {}

const execFileAsync = promisify(execFile);
let lastRequestAt = 0;

const args = parseArgs(process.argv.slice(2));

const filePath = path.resolve(args.file);
assertFile(filePath, "题库文件");
const rows = await readJsonl(filePath);
let missing = rows.map((row, index) => ({ row, index })).filter(
  ({ row }) => row.status !== "ok" || !Array.isArray(row.images) || row.images.length === 0,
);
if (args.statusFilter) {
  const before = missing.length;
  missing = missing.filter(({ row }) => row.status === args.statusFilter);
  console.log(`按状态过滤：仅处理 status=${args.statusFilter}（${before} → ${missing.length} 条）`);
}

console.log(`题库：${filePath}`);
console.log(`总记录：${rows.length}，未找到图片/出错的条目：${missing.length}`);

if (args.dryRun) {
  console.log("--dry-run：仅列出待补抓条目，不访问 FanCaps、不写任何文件");
  let preview = missing;
  if (args.anidbIds.length) {
    const idSet = new Set(args.anidbIds.map((id) => String(id)));
    preview = missing.filter(({ row }) => idSet.has(String(row.anidb_id || "")));
    console.log(`按 anidb_id 过滤：输入 ${args.anidbIds.length} 个 ID，命中 ${preview.length} 条`);
  } else if (args.overrides.size) {
    const idSet = new Set(args.overrides.keys());
    preview = missing.filter(({ row }) => idSet.has(String(row.anidb_id || "")));
    console.log(`按 --override 指定 ID 过滤：输入 ${args.overrides.size} 个，命中 ${preview.length} 条`);
  }
  const shown = preview.slice(0, 30);
  for (const { row } of shown) {
    console.log(`  anidb_id=${row.anidb_id}  status=${row.status}  ${row.label_text}`);
  }
  console.log(`共 ${missing.length} 条待补抓，符合条件 ${preview.length} 条（预览前 ${shown.length} 条）`);
  process.exit(0);
}

// 目标筛选：--anidb-ids / --override（指定 ID）> --limit-tail（尾部 N 条）> --limit（头部 N 条）
let targets;
if (args.anidbIds.length) {
  const idSet = new Set(args.anidbIds.map((id) => String(id)));
  targets = missing.filter(({ row }) => idSet.has(String(row.anidb_id || "")));
  console.log(`按 anidb_id 匹配：输入 ${args.anidbIds.length} 个 ID，命中 ${targets.length} 条待补抓条目`);
} else if (args.overrides.size) {
  const idSet = new Set(args.overrides.keys());
  targets = missing.filter(({ row }) => idSet.has(String(row.anidb_id || "")));
  console.log(`按 --override 指定 ID 匹配：输入 ${args.overrides.size} 个，命中 ${targets.length} 条待补抓条目`);
} else if (args.limitTail > 0) {
  targets = missing.slice(-args.limitTail);
  console.log(`从尾部取 ${targets.length} 条（共 ${missing.length} 条待补抓）`);
} else {
  targets = missing.slice(0, args.limit);
  console.log(`本次处理：${targets.length} 条（共 ${missing.length} 条待补抓）`);
}
if (args.overrides.size) {
  const matchedIds = new Set(targets.map(({ row }) => String(row.anidb_id || "")));
  for (const id of args.overrides.keys()) {
    if (!matchedIds.has(id)) {
      console.log(`警告：--override 指定的 anidb_id=${id} 不在待补抓列表中（可能已补抓成功或不存在），已忽略`);
    }
  }
}
if (targets.length === 0) {
  console.log("没有需要补抓的条目，退出");
  process.exit(0);
}

// 加载 anime-titles.xml 标题映射（anidb_id 数字搜索失败后，依次用标题搜索兜底）。
// 支持 gzip 压缩版：若指定的 .xml 不存在但存在同名 .xml.gz，自动改用它并自动解压。
let titlesFilePath = path.resolve(args.titlesFile);
if (!fs.existsSync(titlesFilePath) && fs.existsSync(`${titlesFilePath}.gz`)) {
  titlesFilePath = `${titlesFilePath}.gz`;
}
let titlesMap = new Map();
if (fs.existsSync(titlesFilePath)) {
  const loaded = loadAnimeTitles(titlesFilePath);
  titlesMap = loaded.map;
  console.log(`已加载标题映射：${titlesFilePath}（${loaded.map.size} 个条目）`);
  console.log(`标题过滤：跳过中文 ${loaded.skippedZh} 条、缩写 ${loaded.skippedShort} 条、纯非拉丁字符 ${loaded.skippedNonLatin} 条`);
} else if (args.titlesFile !== DEFAULT_TITLES_FILE) {
  throw new Error(`找不到标题文件：${titlesFilePath}`);
} else {
  console.log(`未找到标题文件 ${titlesFilePath}，将仅按 anidb_id 数字搜索（可用 --titles-file 指定）`);
}

// 定位本次输出目录：output/YYYY-MM-DD-retry（同日重复运行追加 -02、-03…）
// --resume 时复用最近一个含断点快照的目录，从上次中断处继续
const outputRoot = resolveOutputRoot(args);
await fs.promises.mkdir(path.join(outputRoot, "backup"), { recursive: true });
const logPath = path.join(outputRoot, "retry.log");
const retriedPath = path.join(outputRoot, "fancaps_anime_images.retried.jsonl");
const summaryPath = path.join(outputRoot, "retry-summary.json");
const backupPath = path.join(outputRoot, "backup", "fancaps_anime_images.before-retry.jsonl");
const partialPath = path.join(outputRoot, "fancaps_anime_images.retry.partial.jsonl");
if (!fs.existsSync(backupPath)) await fs.promises.copyFile(filePath, backupPath);
console.log(`本次输出目录：${outputRoot}`);
console.log(`替换前已备份：${backupPath}`);
await logLine(logPath, `补抓开始：${new Date().toISOString()}`);
await logLine(logPath, `题库：${filePath} | 待补抓：${missing.length} | 本次处理：${targets.length}`);

// 断点续跑：--resume 且存在快照时，从快照行数继续；否则清空快照全新开始
let resumeCount = 0;
if (args.resume && fs.existsSync(partialPath)) {
  const partialRows = await readJsonl(partialPath);
  validateResumePrefix(targets, partialRows);
  resumeCount = partialRows.length;
  console.log(`检测到断点快照：已处理 ${resumeCount}/${targets.length} 条，从第 ${resumeCount + 1} 条继续`);
  await logLine(logPath, `断点续跑：快照 ${resumeCount} 条，从第 ${resumeCount + 1} 条继续`);
} else {
  await fs.promises.writeFile(partialPath, "", "utf8");
}

const startedAt = Date.now();

for (let n = resumeCount; n < targets.length; n += 1) {
  const { row } = targets[n];
  const anidbId = String(row.anidb_id || "");
  const labelText = row.label_text || "";
  console.log(`[${n + 1}/${targets.length}] anidb_id=${anidbId} ${labelText}`);
  await logLine(logPath, `[${new Date().toISOString()}] 开始 anidb_id=${anidbId} ${labelText}`);

  const retryTarget = {
    bgmId: row.bgm_id,
    anidbId,
    labelText,
    date: row.date || "",
    doneCount: row.done_count,
    ratingCount: row.rating_count,
  };
  let result;
  try {
    result = await crawlFanCaps(retryTarget, args, titlesMap.get(anidbId) || []);
  } catch (error) {
    result = makeErrorRecord(retryTarget, error);
  }

  if (result.status === "ok") {
    console.log(`  成功：${result.image_count} 张图片 → ${result.fancaps?.show_url}`);
    await logLine(logPath, `  结果=成功 图片数=${result.image_count}`);
  } else {
    console.log(`  未找到/失败：保持原条目不变（${result.error || "无图"}）`);
    await logLine(logPath, `  结果=${result.status} 保持原条目 ${result.error || ""}`);
  }
  // 每条结果立即写入断点快照，中断后 --resume 可从此处继续
  await appendJsonl(partialPath, result);
}

// 从快照重建本次处理记录（覆盖断点续跑前已处理的部分）
const partialRows = await readJsonl(partialPath);
if (partialRows.length !== targets.length) {
  throw new Error(`快照结果不完整：应有 ${targets.length} 条，实际 ${partialRows.length} 条；快照已保留，可再次 --resume 续跑`);
}
const updated = partialRows.filter((record) => record.status === "ok");
const retriedRows = new Map();
partialRows.forEach((record, n) => retriedRows.set(targets[n].index, record));

// 合并：成功条目替换，其余保持原样
const merged = rows.map((row, index) => retriedRows.get(index) || row);
if (!args.noReplace) {
  const tmpPath = `${filePath}.retry.tmp`;
  await writeJsonl(tmpPath, merged);
  await fs.promises.rename(tmpPath, filePath);
  console.log(`已自动替换题库：${filePath}`);
} else {
  console.log("--no-replace：未替换题库，仅输出更新内容");
}
await writeJsonl(retriedPath, updated);
// 全部处理完成，删除断点快照（此后 --resume 不再复用该目录续跑）
await fs.promises.unlink(partialPath);

const durationMs = Date.now() - startedAt;
const summary = {
  generated_at: new Date().toISOString(),
  dataset: path.resolve(filePath),
  total_records: rows.length,
  missing_records: missing.length,
  attempted: targets.length,
  updated: updated.length,
  still_missing: targets.length - updated.length,
  duration_ms: durationMs,
  replaced: !args.noReplace,
  resumed: resumeCount > 0,
  resume_count: resumeCount,
  output_dir: path.resolve(outputRoot),
  outputs: {
    retried: path.resolve(retriedPath),
    summary: path.resolve(summaryPath),
    log: path.resolve(logPath),
    backup: path.resolve(backupPath),
  },
};
await fs.promises.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
await logLine(logPath, `补抓结束：${new Date().toISOString()} | 成功 ${updated.length} / 尝试 ${targets.length} | 耗时 ${durationMs}ms`);
console.log("------------------------------------------");
console.log(`汇总：成功补抓 ${updated.length}/${targets.length}，输出目录 ${outputRoot}${resumeCount > 0 ? `（本次从断点 ${resumeCount} 条继续）` : ""}`);
process.exitCode = 0;

async function crawlFanCaps(target, config, titleCandidates = []) {
  // 用户通过 --override / --show-url 手工指定了 show 页面链接：跳过搜索，直接抓取该页图片
  const overriddenUrl = config.overrides.get(String(target.anidbId));
  if (overriddenUrl) {
    console.log(`  使用手工指定的 show 页面：${overriddenUrl}`);
    const images = await collectShowImages(overriddenUrl, config);
    if (!images.length) {
      return makeNotFoundRecord(target, overriddenUrl, "手工指定的页面未解析到图片（请确认是番剧 show 页，而非单集或单张图片页）", {
        show_url: overriddenUrl,
        manual: true,
      });
    }
    return makeRecord(target, {
      images,
      status: "ok",
      fancaps: {
        search_url: overriddenUrl,
        search_query: `manual:${target.anidbId}`,
        show_url: overriddenUrl,
        show_title: titleFromUrl(overriddenUrl) || "Manual URL",
        result_count: 1,
        manual: true,
      },
    });
  }

  // 查询队列：先用 anidb_id 数字，再依次用标题（去重）
  const queries = [];
  if (String(target.anidbId)) queries.push(String(target.anidbId));
  for (const title of titleCandidates) {
    if (title && !queries.includes(title)) queries.push(title);
  }
  let lastResult = null;
  for (const query of queries) {
    const result = await crawlByQuery(target, query, config);
    if (result.status === "ok") return result;
    lastResult = result;
  }
  if (lastResult && lastResult.status !== "ok") {
    if (!lastResult.fancaps) lastResult.fancaps = {};
    lastResult.fancaps.tried_queries = queries;
    if (!lastResult.error) {
      lastResult.error = `已依次尝试 ${queries.length} 个查询（anidb_id + 标题）均未找到图片`;
    }
  }
  return lastResult;
}

async function crawlByQuery(target, query, config) {
  const searchUrl = `${FANCAPS_BASE}/search.php?q=${encodeURIComponent(query)}&animeCB=Anime&submit=Submit`;
  const searchHtml = await fetchText(searchUrl, config);
  const results = parseSearchResults(searchHtml, searchUrl);
  if (!results.length) {
    return makeNotFoundRecord(target, searchUrl, `FanCaps 无查询 "${query}" 的搜索结果`);
  }
  let selected;
  try {
    selected = chooseFanCapsResult(results, query, config);
  } catch (error) {
    if (error instanceof AmbiguousMatchError) {
      error.searchUrl = searchUrl;
      console.log(`  提示：候选较多，可打开搜索页人工核对并复制正确条目的 show 页链接 → ${searchUrl}`);
    }
    throw error;
  }
  const images = await collectShowImages(selected.url, config);
  if (!images.length) {
    return makeNotFoundRecord(target, searchUrl, "FanCaps 找到条目但未解析到图片", {
      show_url: selected.url,
      show_title: selected.title,
      result_count: results.length,
    });
  }
  return makeRecord(target, {
    images,
    status: "ok",
    fancaps: {
      search_url: searchUrl,
      search_query: query,
      show_url: selected.url,
      show_title: selected.title,
      result_count: results.length,
    },
  });
}

function parseSearchResults(html, baseUrl) {
  const $ = load(html);
  const results = new Map();
  $("a[href]").each((_, anchor) => {
    const href = $(anchor).attr("href") || "";
    if (!href.toLowerCase().includes("anime/showimages.php")) return;
    const url = absoluteUrl(href, baseUrl);
    const title = clean($(anchor).text()) || titleFromUrl(url) || "Anime Result";
    if (url && !isBadTitle(title) && !results.has(url)) results.set(url, { url, title });
  });
  return [...results.values()];
}

function chooseFanCapsResult(results, query, config) {
  if (results.length === 1) return results[0];
  const queryKey = normalizeTitle(query);
  const exact = results.filter((item) => queryKey && normalizeTitle(item.title) === queryKey);
  if (exact.length === 1) return exact[0];
  if (config.acceptFirstAmbiguous) return results[0];
  throw new AmbiguousMatchError(
    `查询 "${query}" 返回 ${results.length} 个候选，无法唯一确认；可在浏览器打开搜索页，点进正确条目后复制其 show 页面链接，用 --override <anidb_id>=<链接> 直接补抓；或使用 --accept-first-ambiguous`,
  );
}

async function collectShowImages(initialUrl, config) {
  const images = new Set();
  const visited = new Set();
  let currentUrl = initialUrl;
  while (currentUrl && !visited.has(currentUrl) && visited.size < config.maxShowPages) {
    visited.add(currentUrl);
    const html = await fetchText(currentUrl, config);
    const $ = load(html);
    $("img").each((_, image) => {
      const src = $(image).attr("data-src") || $(image).attr("data-original") || $(image).attr("data-lazy-src") || $(image).attr("src") || "";
      addImage(images, src, currentUrl);
    });
    $("a[href]").each((_, anchor) => addImage(images, $(anchor).attr("href") || "", currentUrl));
    currentUrl = findNextShowPage($, currentUrl);
  }
  return [...images];
}

function findNextShowPage($, baseUrl) {
  let next = "";
  $("a[href]").each((_, anchor) => {
    if (next) return;
    const text = clean($(anchor).text()).toLowerCase();
    const href = $(anchor).attr("href") || "";
    const lower = href.toLowerCase();
    if (!(text === "next" || text === "next >" || text.includes("next"))) return;
    if (lower.includes("showimages.php") && !lower.includes("episodeimages.php")) next = absoluteUrl(href, baseUrl);
  });
  return next;
}

function addImage(set, rawUrl, baseUrl) {
  const absolute = absoluteUrl(rawUrl, baseUrl);
  if (!absolute) return;
  try {
    const url = new URL(absolute);
    if (!/\.(avif|gif|jpe?g|png|webp)$/i.test(url.pathname)) return;

    // 1) 直接命中的 cdni 原始大图
    if (url.hostname === FANCAPS_IMAGE_HOST && url.pathname.startsWith(FANCAPS_IMAGE_PATH)) {
      url.hash = "";
      set.add(url.toString());
      return;
    }

    // 2) ant.fancaps.net/{id}.jpg 缩略图：与 cdni 原始大图共用同一数字 ID，
    //    直接换算为 cdni 大图 URL（参考原前端项目 getFanCapsImageIdFromUrl/originalToFanCapsThumbnailUrl）
    if (url.hostname === FANCAPS_THUMB_HOST) {
      const id = url.pathname.match(/\/(\d{4,})\.(?:avif|gif|jpe?g|png|webp)$/i)?.[1];
      if (id) set.add(`https://${FANCAPS_IMAGE_HOST}${FANCAPS_IMAGE_PATH}${id}.jpg`);
      return;
    }
  } catch {}
}

async function fetchText(targetUrl, config) {
  let lastError;
  for (let attempt = 1; attempt <= config.retries + 1; attempt += 1) {
    await politeDelay(config.delayMs);
    try {
      const text = await fetchTextWithCurl(targetUrl, config);
      if (!text.trim()) throw new Error(`上游返回空页面：${targetUrl}`);
      return text;
    } catch (error) {
      lastError = error?.name === "AbortError" ? new Error(`请求超时：${targetUrl}`) : error;
      const status = error?.status || 0;
      const retryable = !status || status === 408 || status === 425 || status === 429 || status >= 500;
      if (!retryable || attempt > config.retries) break;
      await sleep(Math.min(5000, config.delayMs * attempt));
    }
  }
  throw lastError || new Error(`请求失败：${targetUrl}`);
}

async function fetchTextWithCurl(targetUrl, config) {
  const marker = "\n__FANCAPS_HTTP_STATUS__";
  const headers = fanCapsHeaders(config);
  let result;
  try {
    result = await execFileAsync(
      "curl.exe",
      [
        "--location", "--silent", "--show-error",
        "--max-time", String(Math.max(1, Math.ceil(config.timeoutMs / 1000))),
        "-A", headers["User-Agent"],
        "-H", `Accept: ${headers.Accept}`,
        "-H", `Accept-Language: ${headers["Accept-Language"]}`,
        "-e", headers.Referer,
        "-w", `${marker}%{http_code}`,
        targetUrl,
      ],
      { windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
    );
  } catch (error) {
    throw new Error(`curl 请求失败：${error?.stderr?.trim() || error?.message || targetUrl}`);
  }
  const statusAt = result.stdout.lastIndexOf(marker);
  if (statusAt < 0) throw new Error(`curl 未返回 HTTP 状态：${targetUrl}`);
  const text = result.stdout.slice(0, statusAt);
  const status = Number(result.stdout.slice(statusAt + marker.length).trim());
  if (!Number.isInteger(status)) throw new Error(`curl 返回无效 HTTP 状态：${targetUrl}`);
  if (status < 200 || status >= 300) {
    const error = new Error(`HTTP ${status}：${targetUrl}`);
    error.status = status;
    throw error;
  }
  return text;
}

function fanCapsHeaders(config) {
  return {
    "User-Agent": config.userAgent,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7",
    Referer: FANCAPS_BASE,
  };
}

async function politeDelay(delayMs) {
  const wait = Math.max(0, lastRequestAt + delayMs - Date.now());
  if (wait) await sleep(wait);
  lastRequestAt = Date.now();
}

function makeRecord(target, values) {
  return {
    bgm_id: Number(target.bgmId),
    anidb_id: String(target.anidbId),
    label_text: target.labelText,
    date: String(target.date || "").slice(0, 7),
    done_count: target.doneCount,
    rating_count: target.ratingCount,
    images: values.images || [],
    image_count: (values.images || []).length,
    status: values.status,
    crawled_at: new Date().toISOString(),
    fancaps: values.fancaps || {},
    ...(values.error ? { error: values.error } : {}),
  };
}

function makeNotFoundRecord(target, searchUrl, error, extra = {}) {
  return makeRecord(target, {
    images: [],
    status: "not_found",
    fancaps: { search_url: searchUrl, ...extra },
    error,
  });
}

function makeErrorRecord(target, error) {
  const message = typeof error === "string" ? error : error?.message || String(error);
  const searchUrl =
    error && typeof error === "object" && error.searchUrl
      ? error.searchUrl
      : `${FANCAPS_BASE}/search.php?q=${encodeURIComponent(target.anidbId)}&animeCB=Anime&submit=Submit`;
  return makeRecord(target, {
    images: [],
    status: "error",
    fancaps: { search_url: searchUrl },
    error: message,
  });
}

// 解析 AniDB 的 anime-titles.xml：aid -> 非中文标题候选列表（按类型/语言优先级排序）
// 支持 gzip 压缩版（检测 gzip 魔数后自动解压），与 append-fancaps-new-anime.mjs 行为一致
function loadAnimeTitles(filePath) {
  let bytes = fs.readFileSync(filePath);
  let isGzip = false;
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    bytes = zlib.gunzipSync(bytes);
    isGzip = true;
  }
  if (isGzip) console.log(`标题库 ${filePath} 为 gzip 压缩格式，已自动解压读取`);
  const xml = bytes.toString("utf8");
  const map = new Map();
  let skippedZh = 0;
  let skippedShort = 0;
  let skippedNonLatin = 0;
  const animeRe = /<anime\s+aid="(\d+)"[^>]*>([\s\S]*?)<\/anime>/g;
  const titleRe = /<title\s+([^>]*)>([\s\S]*?)<\/title>/g;
  let block;
  while ((block = animeRe.exec(xml)) !== null) {
    const aid = block[1];
    const entries = [];
    let title;
    titleRe.lastIndex = 0;
    while ((title = titleRe.exec(block[2])) !== null) {
      const attrs = title[1];
      const lang = (attrs.match(/xml:lang="([^"]*)"/) || [])[1] || "";
      const type = (attrs.match(/type="([^"]*)"/) || [])[1] || "syn";
      const text = clean(title[2]);
      if (!text) continue;
      if (/^zh/i.test(lang)) {
        skippedZh += 1;
        continue; // 跳过中文标题（zh-Hans/zh-Hant 等）
      }
      if (type === "short") {
        skippedShort += 1;
        continue; // 缩写标题（如 CotS、SnS2）绝对不可能命中 FanCaps 搜索
      }
      if (!/[a-zA-Z]/.test(text)) {
        skippedNonLatin += 1;
        continue; // 纯非拉丁字符标题（俄/韩/阿拉伯/日文原文等）FanCaps 英文索引不可能命中
      }
      entries.push({ text, type, lang });
    }
    if (entries.length) map.set(aid, buildTitleCandidates(entries, args.maxTitleCandidates));
  }
  return { map, skippedZh, skippedShort, skippedNonLatin };
}

function buildTitleCandidates(entries, max) {
  const TYPE_PRI = { main: 0, official: 1, synonym: 2, short: 3 };
  const LANG_PRI = { "x-jat": 0, en: 0, ja: 1 };
  const scored = entries.map((e) => ({
    ...e,
    // 语言主导排序：x-jat/en 最优先（FanCaps 使用英文/罗马字标题），ja 次之，
    // 其他语言最后；语言相同才比较类型（main < official < syn < short）。
    // short 缩写（如 "SA"、"SxF2"）对 FanCaps 搜索基本无意义，统一排到最后
    score: (LANG_PRI[e.lang] ?? 2) * 100 + ((e.type === "short" ? 500 : TYPE_PRI[e.type]) ?? 3),
  }));
  scored.sort((a, b) => a.score - b.score || a.text.length - b.text.length);
  const candidates = [];
  for (const e of scored) {
    // 剥离开头括号年份消歧，如 "Spy x Family (2022)" -> "Spy x Family"（FanCaps 标题通常无年份）
    const stripped = e.text.replace(/\s*\(\s*\d{4}(?:[-–]\d{1,4})?\s*\)\s*$/i, "").trim();
    if (stripped && !candidates.includes(stripped)) candidates.push(stripped);
    if (stripped !== e.text && !candidates.includes(e.text)) candidates.push(e.text);
    if (candidates.length >= max) break;
  }
  return candidates.slice(0, max);
}

async function logLine(filePath, line) {
  await fs.promises.appendFile(filePath, `${line}\n`, "utf8");
}

// 补抓输出目录按本地日期命名（与更新脚本 update-fancaps.mjs 的 localDate 保持一致）
function pad(n) {
  return String(n).padStart(2, "0");
}

function localDate() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function makeOutputRoot(args) {
  const dateName = localDate();
  const base = path.resolve(args.outDir);
  let candidate = path.join(base, `${dateName}-retry`);
  let suffix = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(base, `${dateName}-retry-${String(suffix).padStart(2, "0")}`);
    suffix += 1;
  }
  fs.mkdirSync(candidate, { recursive: true });
  return candidate;
}

// --resume 时复用最近一个含断点快照的输出目录；否则新建目录
function resolveOutputRoot(args) {
  const base = path.resolve(args.outDir);
  if (args.resume && fs.existsSync(base)) {
    const candidates = fs.readdirSync(base, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}-retry(?:-\d+)?$/.test(entry.name))
      .map((entry) => ({
        name: entry.name,
        mtime: fs.statSync(path.join(base, entry.name)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const entry of candidates) {
      const dir = path.join(base, entry.name);
      if (fs.existsSync(path.join(dir, "fancaps_anime_images.retry.partial.jsonl"))) return dir;
    }
  }
  return makeOutputRoot(args);
}

// 校验断点快照与本次待处理列表前缀一致，防止中断期间题库变化导致错位
function validateResumePrefix(targets, partialRows) {
  if (partialRows.length > targets.length) {
    throw new Error(`断点快照行数（${partialRows.length}）超过本次待处理（${targets.length}），题库可能已变更；请人工处理或删除快照后重跑`);
  }
  for (let i = 0; i < partialRows.length; i += 1) {
    const record = partialRows[i];
    const targetRow = targets[i].row;
    if (Number(record.bgm_id) !== Number(targetRow.bgm_id) || String(record.anidb_id) !== String(targetRow.anidb_id)) {
      throw new Error(`断点快照第 ${i + 1} 条与当前题库不一致（${record.label_text}），题库可能已变更；请人工处理或删除快照后重跑`);
    }
  }
}

async function appendJsonl(filePath, row) {
  await fs.promises.appendFile(filePath, `${JSON.stringify(row)}\n`, "utf8");
}

// 流式逐行读取 JSONL，避免整文件读入内存（题库较大时降低内存占用）；行号与错误提示保持原格式
async function readJsonl(filePath) {
  const rows = [];
  const input = fs.createReadStream(filePath, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let lineNumber = 0;
  for await (const rawLine of lines) {
    lineNumber += 1;
    const line = rawLine.trim();
    if (!line) continue;
    try {
      rows.push(JSON.parse(line));
    } catch (error) {
      throw new Error(`${filePath} 第 ${lineNumber} 行 JSON 无效：${error.message}`);
    }
  }
  return rows;
}

// 流式逐行写入 JSONL，避免一次性拼接大字符串
async function writeJsonl(filePath, rows) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const file = fs.createWriteStream(filePath, { encoding: "utf8" });
  for (const row of rows) {
    if (!file.write(`${JSON.stringify(row)}\n`)) {
      await new Promise((resolve) => file.once("drain", resolve));
    }
  }
  await new Promise((resolve, reject) => file.end((error) => (error ? reject(error) : resolve())));
}

function assertFile(filePath, label) {
  if (!fs.existsSync(filePath)) throw new Error(`找不到${label}：${filePath}`);
}

function absoluteUrl(value, base) {
  try {
    return new URL(String(value || ""), base).toString();
  } catch {
    return "";
  }
}

// 校验并规范化用户手工指定的 FanCaps 番剧 show 页面链接。
// 只接受番剧页（/anime/showimages.php），单集页（episodeimages.php）或单张图片链接一律拒绝，
// 避免用户贴错链接导致只抓到一集/一张图。
function normalizeShowUrl(value) {
  const url = absoluteUrl(value, FANCAPS_BASE);
  if (!url) return "";
  try {
    const parsed = new URL(url);
    if (!/^(fancaps\.net|www\.fancaps\.net)$/i.test(parsed.hostname)) return "";
    if (!/\/anime\/showimages\.php$/i.test(parsed.pathname)) return "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return "";
  }
}

function titleFromUrl(value) {
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {}
  const match = decoded.match(/showimages\.php\?\d+-([^=&#]+)/i);
  return match ? match[1].replaceAll("__", ": ").replaceAll("_", " ").replace(/\s+/g, " ").trim() : "";
}

function isBadTitle(value) {
  const title = clean(value).toLowerCase();
  return (
    !title ||
    title === "anime" ||
    title === "images" ||
    title.includes("search") ||
    title.includes("privacy") ||
    title.includes("advert")
  );
}

function normalizeTitle(value) {
  return clean(value)
    .normalize("NFKC")
    .replace(/[×✕✖✗]/g, "x")
    .replace(/[‐‑‒–—―]/g, "-")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .toLowerCase();
}

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv) {
  const config = {
    file: DEFAULT_FILE,
    titlesFile: DEFAULT_TITLES_FILE,
    outDir: path.join("output"),
    limit: Number.POSITIVE_INFINITY,
    limitTail: 0,
    anidbIds: [],
    statusFilter: "",
    maxTitleCandidates: 6,
    dryRun: false,
    noReplace: false,
    resume: false,
    acceptFirstAmbiguous: false,
    overrides: new Map(),
    showUrl: "",
    delayMs: 3000,
    timeoutMs: 45000,
    retries: 2,
    maxShowPages: 30,
    userAgent: DEFAULT_UA,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const take = (name) => {
      const result = argv[i + 1];
      if (!result || result.startsWith("--")) throw new Error(`${name} 缺少参数值`);
      i += 1;
      return result;
    };
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else if (arg === "--file") config.file = take(arg);
    else if (arg === "--titles-file") config.titlesFile = take(arg);
    else if (arg === "--out-dir") config.outDir = take(arg);
    else if (arg === "--limit") config.limit = Number(take(arg));
    else if (arg === "--limit-tail") config.limitTail = Number(take(arg));
    else if (arg === "--anidb-ids") {
      config.anidbIds = take(arg).split(/[,，]/).map((item) => item.trim()).filter(Boolean)
        .map((id) => {
          if (!/^\d+$/.test(id)) throw new Error(`无效的 anidb_id：${id}`);
          return id;
        });
    }
    else if (arg === "--status") config.statusFilter = take(arg);
    else if (arg === "--max-title-candidates") config.maxTitleCandidates = Number(take(arg));
    else if (arg === "--delay-ms") config.delayMs = Number(take(arg));
    else if (arg === "--timeout-ms") config.timeoutMs = Number(take(arg));
    else if (arg === "--retries") config.retries = Number(take(arg));
    else if (arg === "--max-show-pages") config.maxShowPages = Number(take(arg));
    else if (arg === "--user-agent") config.userAgent = take(arg);
    else if (arg === "--dry-run") config.dryRun = true;
    else if (arg === "--no-replace") config.noReplace = true;
    else if (arg === "--resume") config.resume = true;
    else if (arg === "--accept-first-ambiguous") config.acceptFirstAmbiguous = true;
    else if (arg === "--override") {
      const pair = take(arg);
      const eq = pair.indexOf("=");
      const id = eq > 0 ? pair.slice(0, eq).trim() : "";
      const url = normalizeShowUrl(pair.slice(eq + 1).trim());
      if (!/^\d+$/.test(id) || !url) {
        throw new Error(`--override 格式应为 <anidb_id>=<show_url>，例如 --override 14291=https://fancaps.net/anime/showimages.php?14291-Some_Anime`);
      }
      if (config.overrides.has(id)) throw new Error(`--override 重复指定 anidb_id=${id}`);
      config.overrides.set(id, url);
    }
    else if (arg === "--show-url") {
      if (config.showUrl) throw new Error("--show-url 只能指定一次；多个条目请改用 --override <id>=<url>");
      config.showUrl = take(arg);
    }
    else throw new Error(`未知参数：${arg}`);
  }
  if (config.showUrl) {
    const url = normalizeShowUrl(config.showUrl);
    if (!url) throw new Error(`无效的 FanCaps show 页面链接：${config.showUrl}`);
    if (config.anidbIds.length !== 1) {
      throw new Error("--show-url 必须与恰好一个 --anidb-ids 配合使用；多个条目请改用 --override <id>=<url>");
    }
    config.overrides.set(config.anidbIds[0], url);
  }
  if (config.limit !== Number.POSITIVE_INFINITY && (!Number.isFinite(config.limit) || config.limit < 1)) {
    throw new Error("--limit 必须大于等于 1");
  }
  if (config.limitTail !== 0 && (!Number.isFinite(config.limitTail) || config.limitTail < 1)) {
    throw new Error("--limit-tail 必须大于等于 1");
  }
  if (!Number.isFinite(config.maxTitleCandidates) || config.maxTitleCandidates < 1) {
    throw new Error("--max-title-candidates 必须大于等于 1");
  }
  if (!Number.isFinite(config.delayMs) || config.delayMs < 500) throw new Error("--delay-ms 最小为 500");
  return config;
}

function printUsage() {
  console.log(`用法：
  node tools/retry-fancaps-missing.mjs [选项]

扫描题库中未找到图片（status!=ok 或 images 为空）的条目，重新在 FanCaps 查找并抓取图片。
查找顺序：先用 anidb_id 数字搜索；未找到时用 anidb_id 在 anime-titles.xml 中查标题，
依次用标题搜索（跳过中文标题）。歧义条目也可用 --override / --show-url 手工指定
番剧 show 页面链接直接抓取（跳过搜索）。成功补抓的条目会更新，仍未找到的条目保持原样；
结果自动替换回题库文件。每条处理结果都会写入断点快照，中断后加 --resume 可继续。

选项：
  --file <路径>       题库 JSONL，默认 resources/fancaps_anime_images.jsonl
  --titles-file <路径> AniDB 标题映射 XML，默认 resources/anime-titles.xml
  --max-title-candidates <数量> 每个条目最多尝试的标题数，默认 6
  --out-dir <目录>    输出根目录，默认 output/（本次目录为 output/YYYY-MM-DD-retry[-NN]）
  --limit <数量>      本次最多处理前 N 条（建议大批量时分批运行），默认全部
  --limit-tail <数量> 改为从待补抓列表尾部取 N 条（与 --limit 互斥）
  --anidb-ids <列表>  只补抓指定 AniDB ID 的条目，多个用英文逗号分隔，例如 14291,14785
  --status <状态>     只补抓指定 status 的条目，例如 --status error（默认不过滤）
  --dry-run           仅列出待补抓条目，不访问 FanCaps、不写任何文件
  --no-replace        不替换题库，仅输出更新内容到输出目录
  --resume            检测到断点快照（*.retry.partial.jsonl）时从上次中断处继续，否则全新开始
  --accept-first-ambiguous 多候选且无法精确确认时选择第一项
  --override <anidb_id>=<show_url> 手工指定该 AniDB ID 对应的 FanCaps 番剧 show 页面链接
                          （https://fancaps.net/anime/showimages.php?<id>-<标题>），跳过搜索直接
                          抓取该页图片，用于歧义条目人工复核时自主选择正确条目；可重复指定多个
  --show-url <show_url>   便捷形式：--anidb-ids <id> --show-url <链接> 等价于
                          --override <id>=<链接>（只支持单个 ID，URL 必须是番剧 show 页而非单集/单张图片页）
  --delay-ms <毫秒>   请求间隔，默认 3000（最小 500）
  --timeout-ms <毫秒> 单个请求超时，默认 45000
  --retries <次数>    重试次数，默认 2
  --max-show-pages <数量> 单个动漫最多翻页数，默认 30
  --help              显示本帮助

输出目录内容：
  fancaps_anime_images.retried.jsonl   本次成功补抓的条目（更新内容）
  fancaps_anime_images.retry.partial.jsonl  断点快照（处理过程中存在，完成或被中断后保留）
  retry-summary.json                   机器可读摘要（成功数/剩余数/时长/是否续跑等）
  retry.log                            逐条简化日志
  backup/fancaps_anime_images.before-retry.jsonl  替换前题库备份`);
}
