#!/usr/bin/env node

// FanCaps 搜索连通性测试脚本
// 从题库 fancaps_anime_images.jsonl 随机抽选若干条 status=ok 的记录，
// 用记录的 anidb_id 走与主工具完全相同的搜索流程（curl + 浏览器请求头），
// 验证：1) 能否在 FanCaps 搜索到动漫条目；2) 命中页面是否与题库中的 show_url 一致；
//       3) 命中页面能否解析出可收集的图片（cdni 原始大图或 ant 缩略图，与 retry 脚本同一套规则）。

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomInt } from "node:crypto";
import { load } from "cheerio";

const FANCAPS_BASE = "https://fancaps.net";
const DEFAULT_FILE = path.join("resources", "fancaps_anime_images.jsonl");
const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";

const execFileAsync = promisify(execFile);
let lastRequestAt = 0;

const args = parseArgs(process.argv.slice(2));

const filePath = path.resolve(args.file);
if (!fs.existsSync(filePath)) {
  console.error(`找不到题库文件：${filePath}`);
  process.exit(2);
}

const rows = readJsonl(filePath);
const okRows = rows.filter(
  (row) => row.status === "ok" && row.anidb_id && row.fancaps?.show_url,
);
if (!okRows.length) {
  console.error("题库中没有 status=ok 且带 fancaps.show_url 的记录");
  process.exit(2);
}
if (okRows.length < args.count) {
  console.warn(`可用记录 ${okRows.length} 条，少于抽选数量 ${args.count}，将全部测试`);
}

const picked = shuffle(okRows).slice(0, Math.min(args.count, okRows.length));

console.log(`题库文件：${filePath}`);
console.log(`可用记录（status=ok）：${okRows.length}，随机抽选 ${picked.length} 条`);
if (args.seed !== undefined) console.log(`随机种子：${args.seed}`);
console.log("");

const results = [];
for (let i = 0; i < picked.length; i += 1) {
  results.push(await testOne(picked[i], i, args));
}

const total = results.length;
const hit = results.filter((r) => r.hit).length;
const exact = results.filter((r) => r.exactMatch).length;
const slug = results.filter((r) => r.slugMatch).length;
const imageHit = results.filter((r) => r.hit && r.imageCount > 0).length;
console.log("------------------------------------------");
console.log(
  `汇总：${hit}/${total} 搜索命中 | ${exact}/${total} 与题库 URL 完全一致 | ${slug}/${total} slug 一致 | ${imageHit}/${total} 可收集图片`,
);
if (args.showUrl) {
  console.log("------------------------------------------");
  for (const r of results) {
    if (r.firstUrl) console.log(`${r.anidbId}\t${r.labelText}\t${r.firstUrl}\t图片=${r.imageCount}`);
  }
}
process.exitCode = hit === total && slug === total && imageHit === total ? 0 : 1;

async function testOne(row, index, config) {
  const { anidb_id: anidbId, label_text: labelText, fancaps } = row;
  const searchUrl = `${FANCAPS_BASE}/search.php?q=${encodeURIComponent(anidbId)}&animeCB=Anime&submit=Submit`;
  const recordUrl = fancaps.show_url;

  console.log(`[${index + 1}/${config.count}] anidb_id=${anidbId} ${labelText}`);
  console.log(`  搜索：${searchUrl}`);

  let hit = false;
  let exactMatch = false;
  let slugMatch = false;
  let firstUrl = "";
  let resultCount = 0;
  let imageCount = 0;
  let imageSample = "";
  let error = "";

  try {
    const html = await fetchText(searchUrl, config);
    const results = parseSearchResults(html, searchUrl);
    resultCount = results.length;
    if (resultCount === 0) {
      console.log(`  结果：未搜索到任何动漫条目（HTTP 正常但无 anime/showimages.php 链接）`);
    } else {
      hit = true;
      firstUrl = results[0].url;
      exactMatch = firstUrl === recordUrl;
      slugMatch = titleFromUrl(firstUrl) === titleFromUrl(recordUrl);
      console.log(`  结果：命中 ${resultCount} 个候选`);
      console.log(`    首个：${firstUrl}`);
      console.log(`    题库：${recordUrl}`);
      if (resultCount > 1) {
        console.log(`  注意：多候选，主工具需按标题精确匹配或 --accept-first-ambiguous`);
      }
      if (exactMatch) console.log(`  判定：与题库 URL 完全一致 ✓`);
      else if (slugMatch) console.log(`  判定：URL 不同但 slug 一致 ✓（站点 URL 细节可能有变化）`);
      else console.log(`  判定：与题库不一致 ✗（FanCaps 可能已改版或匹配错误）`);

      const showHtml = await fetchText(firstUrl, config);
      const collectible = parseCollectibleImages(showHtml, firstUrl);
      imageCount = collectible.length;
      imageSample = collectible[0] || "";
      if (imageCount > 0) {
        console.log(`  图片：可收集 ${imageCount} 张（示例：${imageSample}）`);
      } else {
        console.log(`  图片：未解析到可收集图片 ✗（页面无 cdni 大图或 ant 缩略图，retry 将无法补抓）`);
      }
    }
  } catch (err) {
    error = err?.message || String(err);
    console.log(`  失败：${error}`);
  }

  return { anidbId, labelText, hit, exactMatch, slugMatch, firstUrl, resultCount, imageCount, imageSample, error };
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

// 与 tools/retry-fancaps-missing.mjs 的 addImage 相同的收集规则：
// 只接受 cdni 原始大图，以及可换算为 cdni 大图的 ant 缩略图。
function parseCollectibleImages(html, baseUrl) {
  const $ = load(html);
  const images = new Set();
  const collect = (raw) => {
    const absolute = absoluteUrl(raw, baseUrl);
    if (!absolute) return;
    try {
      const url = new URL(absolute);
      if (!/\.(avif|gif|jpe?g|png|webp)$/i.test(url.pathname)) return;
      if (url.hostname === "cdni.fancaps.net" && url.pathname.startsWith("/file/fancaps-animeimages/")) {
        url.hash = "";
        images.add(url.toString());
      } else if (url.hostname === "ant.fancaps.net") {
        const id = url.pathname.match(/\/(\d{4,})\.(?:avif|gif|jpe?g|png|webp)$/i)?.[1];
        if (id) images.add(`https://cdni.fancaps.net/file/fancaps-animeimages/${id}.jpg`);
      }
    } catch {}
  };
  $("img").each((_, image) => {
    const src = $(image).attr("data-src") || $(image).attr("data-original") || $(image).attr("data-lazy-src") || $(image).attr("src") || "";
    collect(src);
  });
  $("a[href]").each((_, anchor) => collect($(anchor).attr("href") || ""));
  return [...images];
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
      lastError = error;
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readJsonl(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  const rows = [];
  for (const [index, source] of text.split(/\r?\n/).entries()) {
    const line = source.trim();
    if (!line) continue;
    try {
      rows.push(JSON.parse(line));
    } catch (error) {
      throw new Error(`${filePath} 第 ${index + 1} 行 JSON 无效：${error.message}`);
    }
  }
  return rows;
}

function shuffle(list) {
  const arr = [...list];
  if (args.seed === undefined) {
    for (let i = arr.length - 1; i > 0; i -= 1) {
      const j = randomInt(i + 1);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
  } else {
    let s = args.seed >>> 0;
    const rnd = () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
    for (let i = arr.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rnd() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
  }
  return arr;
}

function absoluteUrl(value, base) {
  try {
    return new URL(String(value || ""), base).toString();
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

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function parseArgs(argv) {
  const config = {
    file: DEFAULT_FILE,
    count: 3,
    seed: undefined,
    delayMs: 3000,
    timeoutMs: 45000,
    retries: 2,
    showUrl: false,
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
    else if (arg === "--count") config.count = Number(take(arg));
    else if (arg === "--seed") config.seed = Number(take(arg));
    else if (arg === "--delay-ms") config.delayMs = Number(take(arg));
    else if (arg === "--timeout-ms") config.timeoutMs = Number(take(arg));
    else if (arg === "--retries") config.retries = Number(take(arg));
    else if (arg === "--user-agent") config.userAgent = take(arg);
    else if (arg === "--show-url") config.showUrl = true;
    else throw new Error(`未知参数：${arg}`);
  }
  if (!Number.isFinite(config.count) || config.count < 1) throw new Error("--count 必须大于等于 1");
  if (!Number.isFinite(config.delayMs) || config.delayMs < 500) throw new Error("--delay-ms 最小为 500");
  return config;
}

function printUsage() {
  console.log(`用法：
  node tools/test-fancaps-search.mjs [选项]

从题库随机抽选若干条 status=ok 记录，用记录的 anidb_id 在 FanCaps 执行
与主工具相同的搜索请求，验证搜索命中、页面一致性，以及命中页面能否
解析出可收集的图片（cdni 大图 / ant 缩略图，规则与 retry 脚本一致）。

选项：
  --file <路径>        题库 JSONL，默认 resources/fancaps_anime_images.jsonl
  --count <数量>       随机抽选条数，默认 3
  --seed <数字>        固定随机种子（可复现抽选结果）；省略则每次随机
  --delay-ms <毫秒>    请求间隔，默认 3000（最小 500）
  --timeout-ms <毫秒>  单个请求超时，默认 45000
  --retries <次数>     重试次数，默认 2
  --show-url           汇总后额外打印每条命中的首个 URL
  --help               显示本帮助

退出码：全部命中、slug 一致且每页均可收集图片为 0，否则为 1。`);
}
