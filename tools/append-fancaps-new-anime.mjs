#!/usr/bin/env node

import fs from "node:fs";
import { execFile } from "node:child_process";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { promisify } from "node:util";
import zlib from "node:zlib";
import { load } from "cheerio";

const FANCAPS_BASE = "https://fancaps.net";
const FANCAPS_IMAGE_HOST = "cdni.fancaps.net";
const FANCAPS_IMAGE_PATH = "/file/fancaps-animeimages/";
// FanCaps 缩略图域名；缩略图与 cdni 原始大图共用同一数字 ID，可直接换算
const FANCAPS_THUMB_HOST = "ant.fancaps.net";
const DEFAULT_EXISTING = path.join("public", "fancaps_anime_images.jsonl");
const DEFAULT_MAPPING = path.join("public", "anime_map.json");
const DEFAULT_ANIDB_TITLES = path.join("public", "anime-titles.xml");
const DEFAULT_OUTPUT = path.join("public", "fancaps_anime_images.incremental.jsonl");
const execFileAsync = promisify(execFile);

let lastRequestAt = 0;

class HttpError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

class AmbiguousMatchError extends Error {}
class CliError extends Error {}

process.on("uncaughtException", (error) => {
  console.error(error instanceof CliError ? `错误：${error.message}` : (error?.stack || error));
  process.exitCode = 1;
});

const options = parseArgs(process.argv.slice(2));
const existingPath = path.resolve(options.existing);
const dumpPath = path.resolve(options.bangumiDump);
const mappingPath = path.resolve(options.mapping);
const anidbTitlesPath = path.resolve(options.anidbTitles);
const outputPath = path.resolve(options.inPlace ? options.existing : options.output);
const partialPath = `${outputPath}.new.partial`;
const unmappedPath = `${outputPath}.unmapped.jsonl`;
const errorLogPath = `${outputPath}.errors.jsonl`;

assertFile(existingPath, "现有 FanCaps JSONL");
assertFile(dumpPath, "最新 Bangumi subject.jsonlines");
assertFile(mappingPath, "anime_map.json");
assertFile(anidbTitlesPath, "AniDB 标题库");

const existingRows = await readJsonl(existingPath);
const existingIds = new Set(existingRows.map((row) => String(row.bgm_id)));
const cutoff = options.cutoff || inferCutoffDate(existingRows);
const toDate = options.toDate;

console.log(`现有记录：${existingRows.length}`);
console.log(`增量范围：${cutoff} 之后至 ${toDate}（按动画开播日期）`);
console.log(`最低 Bangumi 看过人数：${options.minDone}`);

const candidates = await readBangumiCandidates(dumpPath, {
  cutoff,
  toDate,
  minDone: options.minDone,
  existingIds,
});

console.log(`Bangumi 新番候选：${candidates.length}`);

const bgmToAniDb = await loadAnimeMap(mappingPath);
const needsTitleMatch = candidates.some((candidate) => !bgmToAniDb.has(candidate.bgmId));
const aniDbIndex = needsTitleMatch ? await loadAniDbTitleIndex(anidbTitlesPath) : null;

// 预载 AniDB 标题候选（aid -> 标题列表），anidb_id 搜索失败时按标题兜底（与 retry 脚本一致）
const anidbTitlesByAid = loadAnimeTitles(anidbTitlesPath).map;
console.log(`已加载 AniDB 标题候选：${anidbTitlesByAid.size} 个条目（anidb_id 搜索失败时按标题兜底）`);

const targets = [];
const unmapped = [];

for (const candidate of candidates) {
  const resolved = resolveAniDbId(candidate, bgmToAniDb, aniDbIndex);
  if (!resolved.anidbId) {
    unmapped.push({
      bgm_id: candidate.bgmId,
      label_text: candidate.labelText,
      name: candidate.name,
      name_cn: candidate.nameCn,
      date: candidate.date,
      done_count: candidate.doneCount,
      reason: resolved.reason,
      candidate_anidb_ids: resolved.candidateIds || [],
    });
    continue;
  }

  targets.push({ ...candidate, anidbId: resolved.anidbId });
}

await writeJsonl(unmappedPath, unmapped);
console.log(`可匹配 AniDB：${targets.length}`);
console.log(`无法可靠匹配 AniDB：${unmapped.length}（报告：${unmappedPath}）`);

if (options.dryRun) {
  console.log("预检完成；--dry-run 未访问 FanCaps，也未生成合并题库");
  process.exitCode = 0;
} else {
  await runCrawlAndMerge({
    existingRows,
    targets: targets.slice(0, options.limit),
    outputPath,
    partialPath,
    unmappedPath,
    errorLogPath,
    options,
    titleCandidatesByAid: anidbTitlesByAid,
  });
}

async function runCrawlAndMerge(context) {
  const { existingRows, targets, outputPath, partialPath, errorLogPath, options, titleCandidatesByAid } = context;
  let backupPath = "";

  if (options.inPlace) {
    backupPath = makeBackupPath(existingPath);
    await fs.promises.copyFile(existingPath, backupPath, fs.constants.COPYFILE_EXCL);
    console.log(`已先复制备份：${backupPath}`);
  }

  let resumeCount = 0;
  if (options.resume && fs.existsSync(partialPath)) {
    const partialRows = await readJsonl(partialPath);
    validateResumePrefix(targets, partialRows);
    resumeCount = partialRows.length;
    console.log(`从断点继续：${resumeCount}/${targets.length}`);
  } else {
    await fs.promises.writeFile(partialPath, "", "utf8");
    await fs.promises.writeFile(errorLogPath, "", "utf8");
  }

  let successCount = 0;
  let notFoundCount = 0;
  let errorCount = 0;

  for (let index = resumeCount; index < targets.length; index += 1) {
    const target = targets[index];
    console.log(`[${index + 1}/${targets.length}] ${target.labelText}（${target.date}，AniDB ${target.anidbId}）`);

    let record;
    try {
      record = await crawlFanCaps(target, options, titleCandidatesByAid.get(String(target.anidbId)) || []);
      if (record.status === "ok") successCount += 1;
      else notFoundCount += 1;
    } catch (error) {
      const message = error?.message || String(error);
      await appendJsonl(errorLogPath, {
        bgm_id: target.bgmId,
        anidb_id: target.anidbId,
        label_text: target.labelText,
        failed_at: new Date().toISOString(),
        error: message,
      });

      if (options.stopOnForbidden && /HTTP (401|403|429)\b/.test(message)) {
        throw new CliError(`FanCaps 拒绝请求，已停止并保留断点，原文件未修改：${partialPath}`);
      }

      record = makeErrorRecord(target, message);
      errorCount += 1;
    }

    await appendJsonl(partialPath, record);
  }

  const newRows = await readJsonl(partialPath);
  if (newRows.length !== targets.length) {
    throw new CliError(`断点结果不完整：应有 ${targets.length} 条，实际 ${newRows.length} 条`);
  }

  validateNewRows(newRows, new Set(existingRows.map((row) => String(row.bgm_id))));
  const mergedRows = [...existingRows, ...newRows];
  const finalTempPath = `${outputPath}.merge.tmp`;
  await writeJsonl(finalTempPath, mergedRows);

  if (!options.inPlace && fs.existsSync(outputPath) && !options.force) {
    throw new CliError(`输出文件已存在：${outputPath}。请使用 --force 或更换 --output`);
  }

  if (options.inPlace) {
    await fs.promises.copyFile(finalTempPath, outputPath);
    await fs.promises.unlink(finalTempPath);
  } else {
    if (fs.existsSync(outputPath)) await fs.promises.unlink(outputPath);
    await fs.promises.rename(finalTempPath, outputPath);
  }

  await fs.promises.unlink(partialPath);

  console.log("");
  console.log(`增量完成：${outputPath}`);
  if (backupPath) console.log(`原文件备份：${backupPath}`);
  console.log(`原有记录：${existingRows.length}`);
  console.log(`新增写入：${newRows.length}`);
  console.log(`找到截图：${successCount}`);
  console.log(`FanCaps 未找到：${notFoundCount}`);
  console.log(`其他错误：${errorCount}`);
  if (errorCount) console.log(`错误日志：${errorLogPath}`);
}

async function readBangumiCandidates(filePath, filter) {
  const results = [];
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const reader = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of reader) {
    if (!line.trim()) continue;
    let raw;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }

    // 支持官方 subject.jsonlines，也支持项目生成的 bangumi_anime_subjects.jsonl。
    if (raw.type !== undefined && raw.type !== 2) continue;
    const bgmId = String(raw.id ?? raw.bgm_id ?? "").trim();
    if (!/^\d+$/.test(bgmId) || filter.existingIds.has(bgmId)) continue;

    const date = normalizeDate(raw.date);
    if (!date || date <= filter.cutoff || date > filter.toDate) continue;

    const doneCount = toNumber(raw.favorite?.done ?? raw.done_count);
    if (doneCount < filter.minDone) continue;

    const name = clean(raw.name);
    const nameCn = clean(raw.name_cn);
    results.push({
      bgmId,
      name,
      nameCn,
      labelText: clean(raw.label_text || nameCn || name || `Bangumi ${bgmId}`),
      date,
      doneCount,
      ratingCount: raw.rating_count !== undefined
        ? toNumber(raw.rating_count)
        : sumScoreDetails(raw.score_details),
    });
  }

  return results.sort((a, b) => a.date.localeCompare(b.date) || Number(a.bgmId) - Number(b.bgmId));
}

async function loadAnimeMap(filePath) {
  const raw = JSON.parse(await fs.promises.readFile(filePath, "utf8"));
  const rows = Array.isArray(raw) ? raw : (Array.isArray(raw?.items) ? raw.items : Object.values(raw || {}));
  const index = new Map();

  for (const row of rows) {
    const bgmId = String(row?.bgm_id ?? row?.bangumi_id ?? row?.bgmId ?? "").trim();
    const anidbId = String(row?.anidb_id ?? row?.anidbId ?? row?.aid ?? "").trim();
    if (/^\d+$/.test(bgmId) && /^\d+$/.test(anidbId)) index.set(bgmId, anidbId);
  }
  return index;
}

async function loadAniDbTitleIndex(filePath) {
  let bytes = await fs.promises.readFile(filePath);
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = zlib.gunzipSync(bytes);
  const $ = load(bytes.toString("utf8"), { xmlMode: true });
  const titleMap = new Map();

  $("anime").each((_, anime) => {
    const aid = String($(anime).attr("aid") || "").trim();
    if (!/^\d+$/.test(aid)) return;

    $(anime).find("title").each((__, titleNode) => {
      const title = clean($(titleNode).text());
      const key = normalizeTitle(title);
      if (!key) return;
      const hit = {
        aid,
        title,
        type: $(titleNode).attr("type") || "",
        lang: $(titleNode).attr("xml:lang") || $(titleNode).attr("lang") || "",
      };
      if (!titleMap.has(key)) titleMap.set(key, []);
      titleMap.get(key).push(hit);
    });
  });

  return titleMap;
}

// 从 AniDB 标题库构建 aid -> 标题候选列表（供 anidb_id 搜索失败后的标题兜底，逻辑同 retry 脚本）
function loadAnimeTitles(filePath) {
  let bytes = fs.readFileSync(filePath);
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = zlib.gunzipSync(bytes);
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
      if (/^zh/i.test(lang)) { skippedZh += 1; continue; }
      if (type === "short") { skippedShort += 1; continue; }
      if (!/[a-zA-Z]/.test(text)) { skippedNonLatin += 1; continue; }
      entries.push({ text, type, lang });
    }
    if (entries.length) map.set(aid, buildTitleCandidates(entries, options.maxTitleCandidates));
  }

  console.log(
    `AniDB 标题库：跳过中文 ${skippedZh} / 短名 ${skippedShort} / 无拉丁字母 ${skippedNonLatin}，为 ${map.size} 个条目生成标题候选`,
  );
  return { map, skippedZh, skippedShort, skippedNonLatin };
}

function buildTitleCandidates(entries, max) {
  const TYPE_PRI = { main: 0, official: 1, synonym: 2, short: 3 };
  const LANG_PRI = { "x-jat": 0, en: 0, ja: 1 };
  const scored = entries.map((entry) => ({
    ...entry,
    score: (LANG_PRI[entry.lang] ?? 2) * 100 + (TYPE_PRI[entry.type] ?? 3),
  }));
  scored.sort((a, b) => a.score - b.score || a.text.length - b.text.length);
  const candidates = [];
  for (const entry of scored) {
    const stripped = entry.text.replace(/\s*\(\s*\d{4}(?:[-–]\d{1,4})?\s*\)\s*$/i, "").trim();
    if (stripped && !candidates.includes(stripped)) candidates.push(stripped);
    if (stripped !== entry.text && !candidates.includes(entry.text)) candidates.push(entry.text);
    if (candidates.length >= max) break;
  }
  return candidates.slice(0, max);
}

function resolveAniDbId(candidate, mapIndex, titleIndex) {
  const mapped = mapIndex.get(candidate.bgmId);
  if (mapped) return { anidbId: mapped, reason: "anime_map" };
  if (!titleIndex) return { anidbId: "", reason: "anime_map 中无记录，标题库未加载" };

  const grouped = new Map();
  for (const title of [candidate.name, candidate.nameCn]) {
    const key = normalizeTitle(title);
    if (!key) continue;
    for (const hit of titleIndex.get(key) || []) {
      const score = scoreAniDbHit(hit, title);
      grouped.set(hit.aid, Math.max(grouped.get(hit.aid) || 0, score));
    }
  }

  const ranked = [...grouped.entries()].sort((a, b) => b[1] - a[1] || Number(a[0]) - Number(b[0]));
  if (!ranked.length) return { anidbId: "", reason: "AniDB 标题库无精确标题命中", candidateIds: [] };
  if (ranked.length > 1 && ranked[0][1] === ranked[1][1]) {
    return { anidbId: "", reason: "AniDB 标题精确匹配存在并列候选", candidateIds: ranked.map(([aid]) => aid) };
  }
  return { anidbId: ranked[0][0], reason: "anidb_exact_title" };
}

function scoreAniDbHit(hit, queryTitle) {
  let score = 0;
  if (hit.type === "main") score += 10;
  if (hit.type === "official") score += 7;
  if (hit.type === "synonym" || hit.type === "short") score += 4;
  if (["ja", "zh-Hans", "zh-Hant", "zh", "x-jat", "en"].includes(hit.lang)) score += 2;
  if (hit.title === queryTitle) score += 3;
  return score;
}

async function crawlFanCaps(target, config, titleCandidates = []) {
  // 查询队列：先用 anidb_id 数字，失败后用 anime-titles.xml 的标题候选兜底（与 retry 脚本一致）
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

  const selected = chooseFanCapsResult(results, target, config);
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

function chooseFanCapsResult(results, target, config) {
  if (results.length === 1) return results[0];

  const titleKeys = new Set([target.name, target.nameCn, target.labelText].map(normalizeTitle).filter(Boolean));
  const exact = results.filter((item) => titleKeys.has(normalizeTitle(item.title)));
  if (exact.length === 1) return exact[0];
  if (config.acceptFirstAmbiguous) return results[0];
  throw new AmbiguousMatchError(`FanCaps 返回 ${results.length} 个候选，无法唯一确认；可人工复核或使用 --accept-first-ambiguous`);
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
    if (url.hostname === FANCAPS_IMAGE_HOST && url.pathname.startsWith(FANCAPS_IMAGE_PATH)) {
      // cdni 原始大图：直接收录
    } else if (url.hostname === FANCAPS_THUMB_HOST) {
      // ant 缩略图：与 cdni 原始大图共用同一数字 ID，直接换算（参考项目 originalToFanCapsThumbnailUrl）
      const id = url.pathname.match(/\/([0-9]{4,})\.(?:avif|gif|jpe?g|png|webp)$/i)?.[1];
      if (!id) return;
      url.hostname = FANCAPS_IMAGE_HOST;
      url.pathname = `${FANCAPS_IMAGE_PATH}${id}.jpg`;
    } else {
      return;
    }
    if (!/\.(avif|gif|jpe?g|png|webp)$/i.test(url.pathname)) return;
    url.hash = "";
    set.add(url.toString());
  } catch {}
}

async function fetchText(targetUrl, config) {
  let lastError;
  for (let attempt = 1; attempt <= config.retries + 1; attempt += 1) {
    await politeDelay(config.delayMs);
    try {
      const requestUrl = config.proxyPrefix ? `${config.proxyPrefix}${encodeURIComponent(targetUrl)}` : targetUrl;
      const text = config.httpTransport === "curl"
        ? await fetchTextWithCurl(requestUrl, targetUrl, config)
        : await fetchTextWithNode(requestUrl, targetUrl, config);
      if (!text.trim()) throw new Error(`上游返回空页面：${targetUrl}`);
      return text;
    } catch (error) {
      lastError = error?.name === "AbortError" ? new Error(`请求超时：${targetUrl}`) : error;
      const status = error instanceof HttpError ? error.status : 0;
      const retryable = !status || status === 408 || status === 425 || status === 429 || status >= 500;
      if (!retryable || attempt > config.retries) break;
      await sleep(Math.min(5000, config.delayMs * attempt));
    }
  }
  throw lastError || new Error(`请求失败：${targetUrl}`);
}

async function fetchTextWithNode(requestUrl, targetUrl, config) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetch(requestUrl, {
      redirect: "follow",
      signal: controller.signal,
      headers: fanCapsHeaders(config),
    });
    if (!response.ok) throw new HttpError(`HTTP ${response.status}：${targetUrl}`, response.status);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchTextWithCurl(requestUrl, targetUrl, config) {
  const marker = "\n__FANCAPS_HTTP_STATUS__";
  const headers = fanCapsHeaders(config);
  let result;
  try {
    result = await execFileAsync("curl.exe", [
      "--location", "--silent", "--show-error",
      "--max-time", String(Math.max(1, Math.ceil(config.timeoutMs / 1000))),
      "-A", headers["User-Agent"],
      "-H", `Accept: ${headers.Accept}`,
      "-H", `Accept-Language: ${headers["Accept-Language"]}`,
      "-e", headers.Referer,
      "-w", `${marker}%{http_code}`,
      requestUrl,
    ], { windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  } catch (error) {
    throw new Error(`curl 请求失败：${error?.stderr?.trim() || error?.message || targetUrl}`);
  }
  const statusAt = result.stdout.lastIndexOf(marker);
  if (statusAt < 0) throw new Error(`curl 未返回 HTTP 状态：${targetUrl}`);
  const text = result.stdout.slice(0, statusAt);
  const status = Number(result.stdout.slice(statusAt + marker.length).trim());
  if (!Number.isInteger(status)) throw new Error(`curl 返回无效 HTTP 状态：${targetUrl}`);
  if (status < 200 || status >= 300) throw new HttpError(`HTTP ${status}：${targetUrl}`, status);
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
    date: target.date.slice(0, 7),
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
  return makeRecord(target, {
    images: [],
    status: "error",
    fancaps: { search_url: `${FANCAPS_BASE}/search.php?q=${encodeURIComponent(target.anidbId)}&animeCB=Anime&submit=Submit` },
    error,
  });
}

function validateResumePrefix(targets, rows) {
  if (rows.length > targets.length) throw new CliError("断点文件比本次候选列表更长，不能继续");
  for (let i = 0; i < rows.length; i += 1) {
    if (`${rows[i].bgm_id}:${rows[i].anidb_id}` !== `${targets[i].bgmId}:${targets[i].anidbId}`) {
      throw new CliError(`断点文件第 ${i + 1} 行与本次候选不一致；请移走 ${partialPath} 后重试`);
    }
  }
}

function validateNewRows(rows, existingIds) {
  const seen = new Set(existingIds);
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const id = String(row.bgm_id);
    if (seen.has(id)) throw new CliError(`输出出现重复 bgm_id：${id}`);
    seen.add(id);
    if (!Array.isArray(row.images) || row.image_count !== row.images.length) {
      throw new CliError(`新增结果第 ${i + 1} 行图片字段不一致`);
    }
  }
}

function inferCutoffDate(rows) {
  const times = rows.map((row) => Date.parse(row.crawled_at || "")).filter(Number.isFinite);
  if (!times.length) throw new CliError("无法从现有 JSONL 推断截止时间，请使用 --cutoff YYYY-MM-DD");
  return new Date(Math.max(...times)).toISOString().slice(0, 10);
}

function parseArgs(args) {
  const config = {
    existing: DEFAULT_EXISTING,
    bangumiDump: "",
    mapping: DEFAULT_MAPPING,
    anidbTitles: DEFAULT_ANIDB_TITLES,
    output: DEFAULT_OUTPUT,
    cutoff: "",
    toDate: localDate(),
    minDone: 100,
    limit: Number.POSITIVE_INFINITY,
    dryRun: false,
    inPlace: false,
    force: false,
    resume: true,
    delayMs: 1200,
    timeoutMs: 30_000,
    retries: 2,
    maxShowPages: 30,
    maxTitleCandidates: 6,
    proxyPrefix: process.env.FANCAPS_PROXY_PREFIX || "",
    httpTransport: process.env.FANCAPS_HTTP_TRANSPORT || "fetch",
    userAgent: process.env.FANCAPS_USER_AGENT || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
    acceptFirstAmbiguous: false,
    stopOnForbidden: true,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") { printUsage(); process.exit(0); }
    else if (arg === "--existing") config.existing = value(args, ++i, arg);
    else if (arg === "--bangumi-dump") config.bangumiDump = value(args, ++i, arg);
    else if (arg === "--mapping") config.mapping = value(args, ++i, arg);
    else if (arg === "--anidb-titles") config.anidbTitles = value(args, ++i, arg);
    else if (arg === "--output") config.output = value(args, ++i, arg);
    else if (arg === "--cutoff") config.cutoff = value(args, ++i, arg);
    else if (arg === "--to") config.toDate = value(args, ++i, arg);
    else if (arg === "--min-done") config.minDone = Number(value(args, ++i, arg));
    else if (arg === "--limit") config.limit = Number(value(args, ++i, arg));
    else if (arg === "--delay-ms") config.delayMs = Number(value(args, ++i, arg));
    else if (arg === "--timeout-ms") config.timeoutMs = Number(value(args, ++i, arg));
    else if (arg === "--retries") config.retries = Number(value(args, ++i, arg));
    else if (arg === "--max-show-pages") config.maxShowPages = Number(value(args, ++i, arg));
    else if (arg === "--max-title-candidates") config.maxTitleCandidates = Number(value(args, ++i, arg));
    else if (arg === "--proxy-prefix") config.proxyPrefix = value(args, ++i, arg);
    else if (arg === "--http-transport") config.httpTransport = value(args, ++i, arg);
    else if (arg === "--dry-run") config.dryRun = true;
    else if (arg === "--in-place") config.inPlace = true;
    else if (arg === "--force") config.force = true;
    else if (arg === "--no-resume") config.resume = false;
    else if (arg === "--accept-first-ambiguous") config.acceptFirstAmbiguous = true;
    else if (arg === "--continue-on-forbidden") config.stopOnForbidden = false;
    else throw new CliError(`未知参数：${arg}`);
  }

  if (!config.bangumiDump) throw new CliError("必须提供最新 Bangumi dump：--bangumi-dump <subject.jsonlines>");
  for (const [name, date] of [["--cutoff", config.cutoff], ["--to", config.toDate]]) {
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new CliError(`${name} 必须是 YYYY-MM-DD`);
  }
  if (!Number.isFinite(config.minDone) || config.minDone < 0) throw new CliError("--min-done 必须大于等于 0");
  if (config.limit !== Number.POSITIVE_INFINITY && (!Number.isFinite(config.limit) || config.limit < 1)) {
    throw new CliError("--limit 必须大于等于 1");
  }
  if (!Number.isFinite(config.delayMs) || config.delayMs < 500) throw new CliError("--delay-ms 最小为 500");
  if (config.proxyPrefix && !/^https?:\/\//i.test(config.proxyPrefix)) throw new CliError("--proxy-prefix 必须是 HTTP(S) URL 前缀");
  if (!['fetch', 'curl'].includes(config.httpTransport)) throw new CliError("--http-transport 只能是 fetch 或 curl");
  return config;
}

function printUsage() {
  console.log(`用法：
  npm run append-fancaps -- --bangumi-dump <最新 subject.jsonlines> [选项]

默认规则：
  1. 从现有 fancaps_anime_images.jsonl 的最大 crawled_at 推断截止日期
  2. 只选择截止日期之后、--to 日期之前开播的 type=2 动画
  3. 排除现有 JSONL 已包含的 bgm_id
  4. 默认要求 Bangumi 看过人数 >= 100
  5. 先用 anime_map.json 找 AniDB ID，缺失时用 AniDB 标题库精确匹配
  6. 抓取 FanCaps：先用 anidb_id 数字搜索，未命中时用 anime-titles.xml 标题候选依次搜索
  7. 图片收集兼容 cdni 原始大图与 ant 缩略图，保持原 JSONL 字段格式

安全选项：
  --dry-run                  只查看新增候选和无法映射报告，不访问 FanCaps
  --output <文件>            默认输出新文件，不覆盖原文件
  --in-place                 原地追加；运行前自动复制时间戳备份
  --limit <数量>             只处理前 N 个可映射的新番
  --no-resume                忽略旧断点重新开始

筛选/连接选项：
  --cutoff YYYY-MM-DD        手动指定截止日；默认取现有数据最大 crawled_at
  --to YYYY-MM-DD            截止到哪一天；默认今天
  --min-done <数量>          默认 100
  --proxy-prefix <URL前缀>   例如 http://127.0.0.1:8788/proxy?url=
  --http-transport <方式>    fetch（默认）或 curl；Windows 本地抓取建议 curl
  --delay-ms <毫秒>          默认 1200，最小 500
  --max-title-candidates <n> 标题兜底最多尝试几个标题；默认 6
  --accept-first-ambiguous   FanCaps 多候选且无法精确确认时选择第一项

推荐先预检：
  npm run append-fancaps -- --bangumi-dump "D:\\dump\\subject.jsonlines" --dry-run

确认候选后输出新文件：
  npm run append-fancaps -- --bangumi-dump "D:\\dump\\subject.jsonlines"

确认新文件后再原地追加：
  npm run append-fancaps -- --bangumi-dump "D:\\dump\\subject.jsonlines" --in-place
`);
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
      throw new CliError(`${filePath} 第 ${lineNumber} 行 JSON 无效：${error.message}`);
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

async function appendJsonl(filePath, row) {
  await fs.promises.appendFile(filePath, `${JSON.stringify(row)}\n`, "utf8");
}

function makeBackupPath(filePath) {
  const parsed = path.parse(filePath);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(parsed.dir, `${parsed.name}.backup-${stamp}${parsed.ext || ".jsonl"}`);
}

function assertFile(filePath, label) {
  if (!fs.existsSync(filePath)) throw new CliError(`找不到${label}：${filePath}`);
}

function normalizeDate(value) {
  const match = String(value || "").match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : "";
}

// 本地日期（与更新脚本 update-fancaps.mjs 保持一致），用于 --to 的默认值
function pad(n) {
  return String(n).padStart(2, "0");
}

function localDate() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function normalizeTitle(value) {
  return clean(value)
    .normalize("NFKC")
    .replace(/[‐‑‒–—―]/g, "-")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .toLowerCase();
}

function sumScoreDetails(details) {
  if (!details || typeof details !== "object") return 0;
  return Object.values(details).reduce((sum, item) => sum + toNumber(item), 0);
}

function toNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

function absoluteUrl(value, base) {
  try { return new URL(String(value || ""), base).toString(); }
  catch { return ""; }
}

function titleFromUrl(value) {
  let decoded = value;
  try { decoded = decodeURIComponent(value); } catch {}
  const match = decoded.match(/showimages\.php\?\d+-([^=&#]+)/i);
  return match ? match[1].replaceAll("__", ": ").replaceAll("_", " ").replace(/\s+/g, " ").trim() : "";
}

function isBadTitle(value) {
  const title = clean(value).toLowerCase();
  return !title || title === "anime" || title === "images" || title.includes("search") || title.includes("privacy") || title.includes("advert");
}

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function value(args, index, name) {
  const result = args[index];
  if (!result || result.startsWith("--")) throw new CliError(`${name} 缺少参数值`);
  return result;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
