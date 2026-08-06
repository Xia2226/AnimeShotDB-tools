import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import { gzipSync } from "node:zlib";

const ROOT = resolve(import.meta.dirname, "..");
const DEFAULTS = {
  fancaps: resolve(ROOT, "resources/fancaps_anime_images.jsonl"),
  subjects: resolve(ROOT, "resources/subject.jsonlines"),
  output: resolve(ROOT, "public/data/anime-library.json"),
  quarantine: resolve(ROOT, "resources/generated/anime-library-quarantine.json"),
};
const VERSION = 1;
const IMAGE_BASE = "https://cdni.fancaps.net/file/fancaps-animeimages/";
const IMAGE_PATTERN = /^https:\/\/cdni\.fancaps\.net\/file\/fancaps-animeimages\/(\d+)\.jpg(?:[?#].*)?$/i;
const SUBJECT_ID_PATTERN = /^\s*\{\s*"id"\s*:\s*(\d+)(?:\s*,|\s*\})/;
const MIN_ANIME = 50;
const BANGUMI_USER_AGENT = "AnimeFrameQuiz/1.0 (https://github.com/Xia2226/Anime-Frame-Quiz-Cloudflare)";
const COVER_CONCURRENCY = 12;
const COVER_HOST = "lain.bgm.tv";
const COVER_FETCH_RETRIES = 3;
const COVER_RETRY_DELAY_MS = [800, 2000, 4000];
const COVER_MAX_BYTES = 5 * 1024 * 1024;
const COVERS_DIR = resolve(ROOT, "public/data/covers");
const COVER_LOCAL_BASE = "/data/covers";
const DEFAULT_PROXY_URL = "http://127.0.0.1:10808";
const COVER_SKIP = process.env.NO_COVER_FETCH === "1";

// 封面下载的临时文件序号，保证并发写临时文件不冲突
let coverTempNonce = 0;

let proxyDispatcher = null;
let proxyDispatcherResolved = false;
const ADULT_EXACT_TAGS = new Set([
  "里番", "色情", "r18", "r-18", "r18+", "r-18+", "r18g", "r-18g",
  "18禁", "十八禁", "工口", "h", "hentai", "ecchi", "ero", "erotic",
  "adult", "nsfw", "r17", "r-17", "成人动画", "成人向", "限制级",
  "性爱", "性描写", "性行为", "本番", "擦边球",
]);
const ADULT_TAG_PATTERNS = [
  /里番|色情|工口|肉番|擦边/,
  /(?:^|[^a-z0-9])r-?18(?:g|\+)?(?:$|[^a-z0-9])/,
  /18禁|十八禁|hentai/,
  /成人(?:动画|向)|性爱|性描写|性行为|本番|露骨(?:性爱|色情)/,
];
const ANIME_KEYS = [
  "bgmId", "anidbId", "title", "originalTitle", "date", "score", "rank",
  "nsfw", "doneCount", "ratingCount", "tags", "metaTags", "imageIds", "cover",
];

const options = parseArguments(process.argv.slice(2));
if (options.check) await checkGenerated(options);
else await build(options);

async function build(paths) {
  const fancapsStats = {
    linesScanned: 0,
    blankLines: 0,
    ignoredStatusRows: 0,
    ignoredWithoutImagesRows: 0,
    invalidImageReferences: 0,
    duplicateImagesWithinRows: 0,
    eligibleRows: 0,
  };
  const candidates = [];

  await scanLines(paths.fancaps, (raw, lineNumber) => {
    fancapsStats.linesScanned += 1;
    if (!raw.trim()) {
      fancapsStats.blankLines += 1;
      return;
    }
    const value = parseJsonLine(raw, paths.fancaps, lineNumber);
    if (value?.status !== "ok") {
      fancapsStats.ignoredStatusRows += 1;
      return;
    }
    if (!Array.isArray(value.images) || value.images.length === 0) {
      fancapsStats.ignoredWithoutImagesRows += 1;
      return;
    }

    const bgmId = positiveInteger(value.bgm_id);
    const anidbId = positiveInteger(value.anidb_id);
    const showUrl = normalizeShowUrl(value?.fancaps?.show_url);
    if (!bgmId || !anidbId || !showUrl) {
      throw new Error(
        `${basename(paths.fancaps)} 第 ${lineNumber} 行的 status=ok 记录缺少有效 ID 或 show_url`,
      );
    }

    const imageIds = [];
    const seen = new Set();
    for (const image of value.images) {
      const imageId = normalizeImageId(image);
      if (!imageId) {
        fancapsStats.invalidImageReferences += 1;
      } else if (seen.has(imageId)) {
        fancapsStats.duplicateImagesWithinRows += 1;
      } else {
        seen.add(imageId);
        imageIds.push(imageId);
      }
    }
    if (imageIds.length === 0) {
      fancapsStats.ignoredWithoutImagesRows += 1;
      return;
    }

    imageIds.sort(numeric);
    candidates.push({
      lineNumber,
      bgmId,
      anidbId,
      title: text(value.label_text, 300),
      month: month(value.date),
      doneCount: nonNegativeInteger(value.done_count),
      ratingCount: nonNegativeInteger(value.rating_count),
      showUrl,
      imageIds,
    });
    fancapsStats.eligibleRows += 1;
  });

  const cleaned = cleanFancaps(candidates);
  assert(cleaned.rows.length >= MIN_ANIME, `清洗后仅有 ${cleaned.rows.length} 部番剧`);
  assertUnique(cleaned.rows, "anidbId", "AniDB ID");
  assertUnique(cleaned.rows, "bgmId", "Bangumi ID");
  assertUniqueImages(cleaned.rows);

  const wanted = new Set(cleaned.rows.map((row) => row.bgmId));
  const subjectStats = {
    linesScanned: 0,
    blankLines: 0,
    linesWithoutLeadingId: 0,
    jsonParsedRows: 0,
  };
  const subjects = await readWantedSubjects(paths.subjects, wanted, subjectStats);
  const missing = [...wanted].filter((id) => !subjects.has(id)).sort(numeric);
  assert(
    missing.length === 0,
    `Bangumi 数据未能 100% 连接，缺少 ${missing.length} 个 ID：${missing.slice(0, 20).join(", ")}`,
  );
  const wrongTypes = cleaned.rows
    .filter((row) => subjects.get(row.bgmId).type !== 2)
    .map((row) => row.bgmId)
    .sort(numeric);
  assert(
    wrongTypes.length === 0,
    `Bangumi type=2 断言失败，共 ${wrongTypes.length} 条：${wrongTypes.slice(0, 20).join(", ")}`,
  );
  assert(subjects.size === cleaned.rows.length, "Bangumi 连接条数与题库条数不一致");

  const covers = COVER_SKIP ? new Map() : await fetchBangumiCovers([...wanted]);
  const joinedAnime = cleaned.rows
    .map((row) => makeAnime(row, subjects.get(row.bgmId), covers.get(row.bgmId) || ""))
    .sort((a, b) => a.anidbId - b.anidbId || a.bgmId - b.bgmId);
  const adultContent = [];
  const anime = [];
  for (const item of joinedAnime) {
    const classification = classifyAdultContent(item);
    if (classification) adultContent.push(classification);
    else anime.push(item);
  }
  assert(anime.length >= MIN_ANIME, `成人内容过滤后仅有 ${anime.length} 部番剧`);
  if (!COVER_SKIP) await cleanOrphanCovers(new Set(anime.map((item) => item.bgmId)));
  const tags = buildTagCatalog(anime);
  const imageCount = anime.reduce((sum, item) => sum + item.imageIds.length, 0);
  const library = {
    version: VERSION,
    imageBase: IMAGE_BASE,
    stats: { animeCount: anime.length, imageCount, tagCount: tags.length },
    tags,
    anime,
  };
  validateLibrary(library);

  const [fancapsFile, subjectFile] = await Promise.all([
    stat(paths.fancaps),
    stat(paths.subjects),
  ]);
  const quarantine = {
    version: VERSION,
    generatedAt: new Date().toISOString(),
    sources: {
      fancaps: { path: projectPath(paths.fancaps), bytes: fancapsFile.size },
      subjects: { path: projectPath(paths.subjects), bytes: subjectFile.size },
    },
    policy: [
      "仅接收 status=ok 且至少含一个有效 FanCaps JPG 图片 ID 的记录",
      "隔离 show_url 被多个 AniDB ID 共同引用时涉及的全部冲突行",
      "在剩余记录中隔离同一 AniDB ID 对应多行的整个组",
      "从保留记录中删除跨 AniDB ID 共享的图片 ID，并隔离因此无图的记录",
      "要求每条保留记录都连接到唯一且 type=2 的 Bangumi subject",
      "剔除 nsfw 或带高置信成人标签的番剧；单独出现卖肉、肉、福利、杀必死时保留",
      "为每条番剧从 Bangumi 下载封面预览图到 public/data/covers，题库中写入本地路径；个别下载失败时回退为远程 URL，全部失败或跳过时留空",
    ],
    summary: {
      ...fancapsStats,
      crossAnidbShowUrlCount: cleaned.crossAnidbShowUrls.length,
      crossAnidbShowRowCount: rowCount(cleaned.crossAnidbShowUrls),
      duplicateAnidbIdCount: cleaned.duplicateAnidbIds.length,
      duplicateAnidbRowCount: rowCount(cleaned.duplicateAnidbIds),
      sharedImageIdCount: cleaned.sharedImageIds.length,
      emptiedByImageCleanupCount: cleaned.emptiedByImageCleanup.length,
      subjectLinesScanned: subjectStats.linesScanned,
      subjectLinesWithoutLeadingId: subjectStats.linesWithoutLeadingId,
      subjectJsonParsedRows: subjectStats.jsonParsedRows,
      wantedSubjectCount: wanted.size,
      joinedSubjectCount: subjects.size,
      type2SubjectCount: joinedAnime.length,
      adultContentCount: adultContent.length,
      adultContentImageCount: adultContent.reduce((sum, item) => sum + item.imageCount, 0),
      finalAnimeCount: anime.length,
      finalImageCount: imageCount,
      coverCount: anime.reduce((sum, item) => sum + (item.cover ? 1 : 0), 0),
    },
    quarantine: {
      crossAnidbShowUrls: cleaned.crossAnidbShowUrls,
      duplicateAnidbIds: cleaned.duplicateAnidbIds,
      sharedImageIds: cleaned.sharedImageIds,
      emptiedByImageCleanup: cleaned.emptiedByImageCleanup,
      adultContent,
    },
  };
  validateQuarantine(quarantine, library);
  await writeJsonFiles([
    { path: paths.quarantine, value: quarantine, pretty: true },
    { path: paths.output, value: library, pretty: false },
  ]);
  await report("build", paths, library);
}

async function checkGenerated(paths) {
  const [library, quarantine] = await Promise.all([
    readJson(paths.output),
    readJson(paths.quarantine),
  ]);
  validateLibrary(library);
  validateQuarantine(quarantine, library);
  await report("check", paths, library);
}

function cleanFancaps(candidates) {
  const byShow = groupBy(candidates, (row) => row.showUrl);
  const badShows = new Set();
  for (const [showUrl, rows] of byShow) {
    if (new Set(rows.map((row) => row.anidbId)).size > 1) badShows.add(showUrl);
  }

  const crossAnidbShowUrls = [...badShows]
    .sort(lexical)
    .map((showUrl) => {
      const rows = byShow.get(showUrl).sort(sourceOrder);
      return {
        showUrl,
        anidbIds: [...new Set(rows.map((row) => row.anidbId))].sort(numeric),
        rows: rows.map(sourceSummary),
      };
    });
  const afterShows = candidates.filter((row) => !badShows.has(row.showUrl));

  const byAnidb = groupBy(afterShows, (row) => row.anidbId);
  const duplicateAnidbIds = [...byAnidb]
    .filter(([, rows]) => rows.length > 1)
    .sort(([a], [b]) => a - b)
    .map(([anidbId, rows]) => ({
      anidbId,
      bgmIds: [...new Set(rows.map((row) => row.bgmId))].sort(numeric),
      rows: rows.sort(sourceOrder).map(sourceSummary),
    }));
  const duplicateIds = new Set(duplicateAnidbIds.map((item) => item.anidbId));
  const afterAnidb = afterShows.filter((row) => !duplicateIds.has(row.anidbId));

  const firstOwners = new Map();
  const sharedOwners = new Map();
  for (const row of afterAnidb) {
    for (const imageId of row.imageIds) {
      const first = firstOwners.get(imageId);
      if (!first) {
        firstOwners.set(imageId, row);
      } else if (first.anidbId !== row.anidbId) {
        let owners = sharedOwners.get(imageId);
        if (!owners) {
          owners = new Map([[first.anidbId, first]]);
          sharedOwners.set(imageId, owners);
        }
        owners.set(row.anidbId, row);
      }
    }
  }

  const sharedImageIds = [...sharedOwners]
    .sort(([a], [b]) => a - b)
    .map(([imageId, owners]) => {
      const rows = [...owners.values()].sort(sourceOrder);
      return {
        imageId,
        anidbIds: rows.map((row) => row.anidbId),
        bgmIds: rows.map((row) => row.bgmId),
      };
    });
  const sharedIds = new Set(sharedImageIds.map((item) => item.imageId));
  const emptiedByImageCleanup = [];
  const rows = [];
  for (const row of afterAnidb) {
    const imageIds = row.imageIds.filter((imageId) => !sharedIds.has(imageId));
    if (imageIds.length === 0) {
      emptiedByImageCleanup.push({
        ...sourceSummary(row),
        removedImageIds: row.imageIds,
      });
    } else {
      rows.push({ ...row, imageIds });
    }
  }

  return {
    rows,
    crossAnidbShowUrls,
    duplicateAnidbIds,
    sharedImageIds,
    emptiedByImageCleanup,
  };
}

async function readWantedSubjects(filePath, wanted, counters) {
  const subjects = new Map();
  await scanLines(filePath, (raw, lineNumber) => {
    counters.linesScanned += 1;
    if (!raw.trim()) {
      counters.blankLines += 1;
      return;
    }

    const match = SUBJECT_ID_PATTERN.exec(raw);
    if (!match) {
      counters.linesWithoutLeadingId += 1;
      return;
    }
    const leadingId = positiveInteger(match[1]);
    if (!leadingId || !wanted.has(leadingId)) return;

    const value = parseJsonLine(raw, filePath, lineNumber);
    counters.jsonParsedRows += 1;
    const actualId = positiveInteger(value?.id);
    assert(actualId === leadingId, `${basename(filePath)} 第 ${lineNumber} 行前缀 ID 与 JSON id 不一致`);
    assert(!subjects.has(actualId), `${basename(filePath)} 中 Bangumi ID ${actualId} 重复`);
    subjects.set(actualId, normalizeSubject(value));
  });
  return subjects;
}

function normalizeSubject(value) {
  return {
    type: Number(value?.type),
    title: text(value?.name_cn, 300) || text(value?.name, 300),
    originalTitle: text(value?.name, 300),
    date: date(value?.date),
    score: score(value?.score),
    rank: positiveInteger(value?.rank),
    nsfw: value?.nsfw === true,
    tags: weightedTags(value?.tags),
    metaTags: stringTags(value?.meta_tags),
  };
}

function makeAnime(row, subject, cover) {
  const title = row.title || subject.title || subject.originalTitle;
  assert(title, `Bangumi ID ${row.bgmId} 缺少可用标题`);
  return {
    bgmId: row.bgmId,
    anidbId: row.anidbId,
    title,
    originalTitle: subject.originalTitle,
    date: subject.date || (row.month ? `${row.month}-01` : ""),
    score: subject.score,
    rank: subject.rank,
    nsfw: subject.nsfw,
    doneCount: row.doneCount,
    ratingCount: row.ratingCount,
    tags: subject.tags,
    metaTags: subject.metaTags,
    imageIds: row.imageIds,
    cover,
  };
}

async function fetchBangumiCovers(bgmIds) {
  const covers = new Map();
  const uniqueIds = [...new Set(bgmIds)].filter(Number.isFinite).sort(numeric);
  if (uniqueIds.length === 0) return covers;

  console.error(`[cover] 正在从 Bangumi 下载封面预览图到本地（${uniqueIds.length} 部，并发 ${COVER_CONCURRENCY}）…`);
  if (options.forceCovers) {
    console.error(`[cover] 已启用 --force-covers：忽略本地已有封面，全部重新下载…`);
  }
  const dispatcher = await getProxyDispatcher();
  await mkdir(COVERS_DIR, { recursive: true });
  const existing = options.forceCovers
    ? new Set()
    : new Set(
        (await readdir(COVERS_DIR).catch(() => [])).filter((name) => /^\d+\.jpg$/i.test(name)),
      );

  let cursor = 0;
  let completed = 0;
  let fallbackRemote = 0;
  let firstFailureDetail = "";
  const failedIds = [];

  const worker = async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= uniqueIds.length) return;
      const id = uniqueIds[index];
      const result = await fetchSubjectCover(id, dispatcher);
      if (result.url) {
        const saved = await downloadCover(id, result.url, dispatcher, existing);
        if (saved.localPath) {
          covers.set(id, saved.localPath);
        } else if (saved.remoteUrl) {
          covers.set(id, saved.remoteUrl);
          fallbackRemote += 1;
        } else {
          if (!firstFailureDetail) firstFailureDetail = saved.error;
          failedIds.push(id);
        }
      } else if (result.error) {
        if (!firstFailureDetail) firstFailureDetail = result.error;
        failedIds.push(id);
      }
      completed += 1;
      if (completed % 200 === 0 || completed === uniqueIds.length) {
        console.error(
          `[cover] 进度 ${completed}/${uniqueIds.length}（本地封面 ${covers.size - fallbackRemote} 部，远程兜底 ${fallbackRemote} 部）`,
        );
      }
    }
  };

  await Promise.all(Array.from({ length: COVER_CONCURRENCY }, () => worker()));

  if (failedIds.length === 0) {
    console.error(`[cover] 封面下载完成：${covers.size}/${uniqueIds.length} 部`);
  } else {
    console.error(`[cover] ${failedIds.length} 部获取失败：${failedIds.slice(0, 10).join(", ")}${failedIds.length > 10 ? "…" : ""}`);
    console.error(`[cover] 失败原因示例：${firstFailureDetail}`);
    if (failedIds.length === uniqueIds.length) {
      console.error(
        "[cover] 提示：全部失败，多为网络/代理问题。若浏览器能访问 api.bgm.tv 而脚本失败，"
        + "请检查代理端口（HTTPS_PROXY=http://127.0.0.1:<端口>），或临时用 NO_COVER_FETCH=1 跳过封面。",
      );
    }
  }
  return covers;
}

async function fetchSubjectCover(subjectId, dispatcher) {
  const schemes = ["https:", "http:"];
  let lastDetail = "";
  for (let attempt = 0; attempt < COVER_FETCH_RETRIES; attempt += 1) {
    for (const scheme of schemes) {
      const url = `${scheme}//api.bgm.tv/v0/subjects/${subjectId}`;
      try {
        const response = await fetch(url, {
          headers: { "User-Agent": BANGUMI_USER_AGENT },
          ...(dispatcher ? { dispatcher } : {}),
        });
        if (!response.ok) {
          if (response.status === 404) return { url: "", error: "" };
          const snippet = (await response.text()).slice(0, 150);
          throw new Error(`HTTP ${response.status}${snippet ? `: ${snippet}` : ""}`);
        }
        const raw = await response.text();
        let body;
        try {
          body = JSON.parse(raw);
        } catch {
          throw new Error(`响应不是 JSON: ${raw.slice(0, 150)}`);
        }
        const cover = normalizeCover(body?.images?.small) || normalizeCover(body?.images?.medium);
        return cover ? { url: cover, error: "" } : { url: "", error: "" };
      } catch (error) {
        lastDetail = describeFetchError(error);
      }
    }
    if (attempt < COVER_FETCH_RETRIES - 1) await sleep(COVER_RETRY_DELAY_MS[attempt] ?? 2000);
  }
  return { url: "", error: lastDetail };
}

async function downloadCover(subjectId, coverUrl, dispatcher, existing) {
  const fileName = `${subjectId}.jpg`;
  const filePath = resolve(COVERS_DIR, fileName);
  if (existing.has(fileName)) return { localPath: `${COVER_LOCAL_BASE}/${fileName}`, error: "" };

  const schemes = ["https:", "http:"];
  let lastDetail = "";
  for (let attempt = 0; attempt < COVER_FETCH_RETRIES; attempt += 1) {
    for (const scheme of schemes) {
      const url = coverUrl.replace(/^https?:/, scheme);
      try {
        const response = await fetch(url, {
          headers: { "User-Agent": BANGUMI_USER_AGENT },
          ...(dispatcher ? { dispatcher } : {}),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const contentType = response.headers.get("content-type") || "";
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length === 0) throw new Error("空响应");
        if (buffer.length > COVER_MAX_BYTES) throw new Error(`图片过大（${buffer.length} 字节）`);
        if (contentType && !contentType.startsWith("image/")) throw new Error(`Content-Type 非图片：${contentType}`);
        // 原子写入：先写同目录临时文件再改名，避免中断留下半截图片，
        // 也避免下次构建把损坏文件误当作已有封面直接复用
        const tempPath = `${filePath}.${process.pid}.${(coverTempNonce += 1)}.tmp`;
        try {
          await writeFile(tempPath, buffer, { flag: "wx" });
          await rename(tempPath, filePath);
          return { localPath: `${COVER_LOCAL_BASE}/${fileName}`, error: "" };
        } catch (error) {
          await rm(tempPath, { force: true }).catch(() => {});
          lastDetail = describeFetchError(error);
        }
      } catch (error) {
        lastDetail = describeFetchError(error);
      }
    }
    if (attempt < COVER_FETCH_RETRIES - 1) await sleep(COVER_RETRY_DELAY_MS[attempt] ?? 2000);
  }
  return { remoteUrl: coverUrl, error: lastDetail };
}

async function cleanOrphanCovers(liveIds) {
  const names = await readdir(COVERS_DIR).catch(() => []);
  const orphans = names.filter((name) => {
    const id = Number(/^(\d+)\.jpg$/i.exec(name)?.[1]);
    return Number.isFinite(id) && !liveIds.has(id);
  });
  if (orphans.length === 0) return;
  await Promise.all(orphans.map((name) => rm(resolve(COVERS_DIR, name), { force: true }).catch(() => {})));
  console.error(`[cover] 已清理 ${orphans.length} 个失效封面文件`);
}

function describeFetchError(error) {
  const cause = error?.cause;
  const code = cause?.code || "";
  const syscall = cause?.syscall || "";
  const host = cause?.host || "";
  const extra = [code, syscall, host].filter(Boolean).join(" · ");
  return extra ? `${error?.message ?? error}（${extra}）` : String(error?.message ?? error);
}

async function getProxyDispatcher() {
  if (proxyDispatcherResolved) return proxyDispatcher;
  proxyDispatcherResolved = true;
  const fromEnv = process.env.HTTPS_PROXY || process.env.https_proxy
    || process.env.HTTP_PROXY || process.env.http_proxy
    || process.env.ALL_PROXY || process.env.all_proxy;
  const proxyUrl = fromEnv || DEFAULT_PROXY_URL;
  try {
    const { ProxyAgent } = await import("undici");
    proxyDispatcher = new ProxyAgent(proxyUrl);
    console.error(
      `[cover] 封面请求将经代理访问：${proxyUrl}${fromEnv ? "" : "（默认值）"}`,
    );
    return proxyDispatcher;
  } catch (error) {
    console.error(`[cover] 代理配置不可用（${proxyUrl}），将直连访问：${error.message}`);
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeCover(value) {
  const raw = text(value, 500);
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.hostname.toLowerCase() !== COVER_HOST) {
      return "";
    }
    url.protocol = "https:";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

function isLocalCoverPath(value) {
  return /^\/data\/covers\/\d+\.(?:jpe?g|png|webp)$/i.test(value);
}

function classifyAdultContent(item) {
  const matchedTags = [...new Set([...item.tags, ...item.metaTags])]
    .filter(isAdultTag)
    .sort(lexical);
  if (!item.nsfw && matchedTags.length === 0) return null;
  return {
    bgmId: item.bgmId,
    anidbId: item.anidbId,
    title: item.title,
    nsfw: item.nsfw,
    matchedTags,
    imageCount: item.imageIds.length,
  };
}

function isAdultTag(value) {
  const normalized = String(value || "").normalize("NFKC").trim().toLocaleLowerCase("zh-CN");
  if (!normalized || normalized === "卖肉") return false;
  return ADULT_EXACT_TAGS.has(normalized)
    || ADULT_TAG_PATTERNS.some((pattern) => pattern.test(normalized));
}

function weightedTags(values) {
  if (!Array.isArray(values)) return [];
  const weights = new Map();
  for (const value of values) {
    const name = text(value?.name, 100);
    if (!name) continue;
    weights.set(name, Math.max(weights.get(name) ?? 0, nonNegativeInteger(value?.count)));
  }
  return [...weights]
    .sort((a, b) => b[1] - a[1] || lexical(a[0], b[0]))
    .map(([name]) => name);
}

function stringTags(values) {
  if (!Array.isArray(values)) return [];
  const names = new Set();
  for (const value of values) {
    const name = text(value, 100);
    if (name) names.add(name);
  }
  return [...names].sort(lexical);
}

function buildTagCatalog(anime) {
  const counts = new Map();
  for (const item of anime) {
    for (const name of new Set([...item.tags, ...item.metaTags])) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  return [...counts]
    .map(([name, animeCount]) => ({ name, animeCount }))
    .sort((a, b) => b.animeCount - a.animeCount || lexical(a.name, b.name));
}

function validateLibrary(value) {
  plainObject(value, "题库顶层");
  exactKeys(value, ["version", "imageBase", "stats", "tags", "anime"], "题库顶层");
  assert(value.version === VERSION, "题库版本不兼容");
  assert(value.imageBase === IMAGE_BASE, "imageBase 不符合固定 schema");
  plainObject(value.stats, "stats");
  exactKeys(value.stats, ["animeCount", "imageCount", "tagCount"], "stats");
  assert(Array.isArray(value.anime), "anime 必须是数组");
  assert(value.anime.length >= MIN_ANIME, `anime 至少需要 ${MIN_ANIME} 条`);

  const bgmIds = new Set();
  const anidbIds = new Set();
  const imageOwners = new Map();
  const tagCounts = new Map();
  let imageCount = 0;
  let previousAnidbId = 0;

  value.anime.forEach((item, index) => {
    const label = `anime[${index}]`;
    plainObject(item, label);
    exactKeys(item, ANIME_KEYS, label);
    positive(item.bgmId, `${label}.bgmId`);
    positive(item.anidbId, `${label}.anidbId`);
    assert(!bgmIds.has(item.bgmId), `${label}.bgmId 重复`);
    assert(!anidbIds.has(item.anidbId), `${label}.anidbId 重复`);
    bgmIds.add(item.bgmId);
    anidbIds.add(item.anidbId);
    assert(item.anidbId >= previousAnidbId, "anime 未按 anidbId 升序排列");
    previousAnidbId = item.anidbId;

    normalizedText(item.title, 300, `${label}.title`, false);
    normalizedText(item.originalTitle, 300, `${label}.originalTitle`, true);
    assert(
      item.date === "" || /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/.test(item.date),
      `${label}.date 格式无效`,
    );
    assert(
      item.score === null || (Number.isFinite(item.score) && item.score >= 0 && item.score <= 10),
      `${label}.score 无效`,
    );
    if (item.rank !== null) positive(item.rank, `${label}.rank`);
    assert(typeof item.nsfw === "boolean", `${label}.nsfw 必须为布尔值`);
    nonNegative(item.doneCount, `${label}.doneCount`);
    nonNegative(item.ratingCount, `${label}.ratingCount`);
    tagNames(item.tags, `${label}.tags`);
    tagNames(item.metaTags, `${label}.metaTags`);
    assert(
      item.cover === "" || isLocalCoverPath(item.cover) || normalizeCover(item.cover) === item.cover,
      `${label}.cover 未规范化（应为本地封面路径或有效的 lain.bgm.tv URL）`,
    );
    const adultClassification = classifyAdultContent(item);
    assert(!adultClassification, `${label} 命中成人内容规则：${adultClassification?.matchedTags.join("、") || "nsfw"}`);

    assert(Array.isArray(item.imageIds) && item.imageIds.length > 0, `${label}.imageIds 不能为空`);
    let previousImageId = 0;
    for (const imageId of item.imageIds) {
      positive(imageId, `${label}.imageIds`);
      assert(imageId > previousImageId, `${label}.imageIds 必须严格递增`);
      previousImageId = imageId;
      const owner = imageOwners.get(imageId);
      assert(!owner, `图片 ID ${imageId} 被 AniDB ${owner} 和 ${item.anidbId} 共同拥有`);
      imageOwners.set(imageId, item.anidbId);
    }
    imageCount += item.imageIds.length;
    for (const name of new Set([...item.tags, ...item.metaTags])) {
      tagCounts.set(name, (tagCounts.get(name) ?? 0) + 1);
    }
  });

  assert(Array.isArray(value.tags), "tags 必须是数组");
  const expectedTags = [...tagCounts]
    .map(([name, animeCount]) => ({ name, animeCount }))
    .sort((a, b) => b.animeCount - a.animeCount || lexical(a.name, b.name));
  assert(value.tags.length === expectedTags.length, "标签目录长度不一致");
  value.tags.forEach((tag, index) => {
    plainObject(tag, `tags[${index}]`);
    exactKeys(tag, ["name", "animeCount"], `tags[${index}]`);
    assert(tag.name === expectedTags[index].name, `tags[${index}].name 不一致`);
    assert(tag.animeCount === expectedTags[index].animeCount, `tags[${index}].animeCount 不一致`);
  });

  assert(value.stats.animeCount === value.anime.length, "stats.animeCount 不一致");
  assert(value.stats.imageCount === imageCount, "stats.imageCount 不一致");
  assert(value.stats.tagCount === value.tags.length, "stats.tagCount 不一致");
}

function validateQuarantine(value, library) {
  plainObject(value, "隔离报告顶层");
  exactKeys(
    value,
    ["version", "generatedAt", "sources", "policy", "summary", "quarantine"],
    "隔离报告顶层",
  );
  assert(value.version === VERSION, "隔离报告版本不兼容");
  assert(typeof value.generatedAt === "string" && Number.isFinite(Date.parse(value.generatedAt)), "generatedAt 无效");
  plainObject(value.sources, "sources");
  plainObject(value.summary, "summary");
  assert(Array.isArray(value.policy) && value.policy.every((item) => typeof item === "string" && item), "policy 无效");
  plainObject(value.quarantine, "quarantine");
  const names = [
    "crossAnidbShowUrls", "duplicateAnidbIds", "sharedImageIds", "emptiedByImageCleanup", "adultContent",
  ];
  exactKeys(value.quarantine, names, "quarantine");
  for (const name of names) assert(Array.isArray(value.quarantine[name]), `quarantine.${name} 必须是数组`);

  const count = library.stats.animeCount;
  assert(value.summary.wantedSubjectCount === value.summary.joinedSubjectCount, "wantedSubjectCount 不一致");
  assert(value.summary.type2SubjectCount === value.summary.joinedSubjectCount, "type2SubjectCount 不一致");
  assert(
    value.summary.joinedSubjectCount - value.summary.adultContentCount === count,
    "成人内容过滤后的番剧数量不一致",
  );
  assert(value.summary.finalAnimeCount === count, "finalAnimeCount 不一致");
  assert(value.summary.finalImageCount === library.stats.imageCount, "finalImageCount 不一致");
  assert(
    value.summary.coverCount === library.anime.reduce((sum, item) => sum + (item.cover ? 1 : 0), 0),
    "coverCount 不一致",
  );

  assert(
    value.summary.crossAnidbShowUrlCount === value.quarantine.crossAnidbShowUrls.length,
    "crossAnidbShowUrlCount 不一致",
  );
  assert(
    value.summary.duplicateAnidbIdCount === value.quarantine.duplicateAnidbIds.length,
    "duplicateAnidbIdCount 不一致",
  );
  assert(
    value.summary.sharedImageIdCount === value.quarantine.sharedImageIds.length,
    "sharedImageIdCount 不一致",
  );
  assert(
    value.summary.emptiedByImageCleanupCount === value.quarantine.emptiedByImageCleanup.length,
    "emptiedByImageCleanupCount 不一致",
  );
  assert(
    value.summary.adultContentCount === value.quarantine.adultContent.length,
    "adultContentCount 不一致",
  );
  assert(
    value.summary.adultContentImageCount
      === value.quarantine.adultContent.reduce((sum, item) => sum + item.imageCount, 0),
    "adultContentImageCount 不一致",
  );

  const liveImages = new Set(library.anime.flatMap((item) => item.imageIds));
  const reportedShared = new Set();
  for (const entry of value.quarantine.sharedImageIds) {
    plainObject(entry, "sharedImageIds 项");
    positive(entry.imageId, "sharedImageIds.imageId");
    assert(!reportedShared.has(entry.imageId), `共享图片 ID ${entry.imageId} 重复报告`);
    assert(!liveImages.has(entry.imageId), `共享图片 ID ${entry.imageId} 仍在正式题库`);
    assert(
      Array.isArray(entry.anidbIds) && new Set(entry.anidbIds).size >= 2,
      `共享图片 ID ${entry.imageId} 的所有者不足两个`,
    );
    reportedShared.add(entry.imageId);
  }
  for (const entry of value.quarantine.crossAnidbShowUrls) {
    assert(
      Array.isArray(entry.anidbIds) && new Set(entry.anidbIds).size >= 2,
      `冲突 show_url ${entry.showUrl ?? ""} 的 AniDB ID 不足两个`,
    );
  }
  for (const entry of value.quarantine.duplicateAnidbIds) {
    assert(Array.isArray(entry.rows) && entry.rows.length >= 2, "重复 AniDB 组不足两行");
  }
  const liveAnidbIds = new Set(library.anime.map((item) => item.anidbId));
  for (const entry of value.quarantine.adultContent) {
    plainObject(entry, "adultContent 项");
    exactKeys(entry, ["bgmId", "anidbId", "title", "nsfw", "matchedTags", "imageCount"], "adultContent 项");
    positive(entry.bgmId, "adultContent.bgmId");
    positive(entry.anidbId, "adultContent.anidbId");
    positive(entry.imageCount, "adultContent.imageCount");
    assert(!liveAnidbIds.has(entry.anidbId), `成人内容 AniDB ${entry.anidbId} 仍在正式题库`);
    assert(entry.nsfw === true || entry.matchedTags.length > 0, `成人内容 AniDB ${entry.anidbId} 缺少过滤依据`);
    tagNames(entry.matchedTags, `adultContent AniDB ${entry.anidbId}.matchedTags`);
  }
}

function parseArguments(args) {
  const result = { check: false, forceCovers: false, ...DEFAULTS };
  const paths = new Map([
    ["--fancaps", "fancaps"],
    ["--subjects", "subjects"],
    ["--output", "output"],
    ["--quarantine", "quarantine"],
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--check") {
      assert(!result.check, "--check 不能重复指定");
      result.check = true;
      continue;
    }
    if (flag === "--force-covers") {
      assert(!result.forceCovers, "--force-covers 不能重复指定");
      result.forceCovers = true;
      continue;
    }
    const key = paths.get(flag);
    assert(key, `未知参数：${flag}`);
    const value = args[index + 1];
    assert(value && !value.startsWith("--"), `${flag} 缺少路径`);
    result[key] = resolve(ROOT, value);
    index += 1;
  }
  return result;
}

async function scanLines(filePath, onLine) {
  const input = createReadStream(filePath, {
    encoding: "utf8",
    highWaterMark: 1024 * 1024,
  });
  let buffer = "";
  let lineNumber = 0;
  for await (const chunk of input) {
    buffer += chunk;
    let start = 0;
    let end = buffer.indexOf("\n", start);
    while (end !== -1) {
      lineNumber += 1;
      const hasCarriageReturn = end > start && buffer.charCodeAt(end - 1) === 13;
      onLine(buffer.slice(start, hasCarriageReturn ? end - 1 : end), lineNumber);
      start = end + 1;
      end = buffer.indexOf("\n", start);
    }
    buffer = buffer.slice(start);
  }
  if (buffer.length > 0) {
    lineNumber += 1;
    onLine(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer, lineNumber);
  }
}

function parseJsonLine(raw, filePath, lineNumber) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${basename(filePath)} 第 ${lineNumber} 行 JSON 解析失败：${error.message}`);
  }
}

function normalizeShowUrl(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "fancaps.net") return "";
    if (url.pathname !== "/anime/showimages.php" || !url.search) return "";
    const showId = /^\?(\d+)(?:-|$)/.exec(url.search)?.[1];
    return showId ? `https://fancaps.net/anime/showimages.php?${showId}` : "";
  } catch {
    return "";
  }
}

function normalizeImageId(value) {
  if (typeof value !== "string") return null;
  const match = IMAGE_PATTERN.exec(value.trim());
  return match ? positiveInteger(match[1]) : null;
}

function text(value, limit) {
  return typeof value === "string"
    ? value.trim().normalize("NFKC").replace(/\s+/g, " ").slice(0, limit)
    : "";
}

function month(value) {
  const normalized = text(value, 7);
  return /^\d{4}-(?:0[1-9]|1[0-2])$/.test(normalized) ? normalized : "";
}

function date(value) {
  const normalized = text(value, 10);
  return /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/.test(normalized)
    ? normalized
    : "";
}

function score(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 10
    ? Math.round(number * 10) / 10
    : null;
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function groupBy(values, keyFor) {
  const groups = new Map();
  for (const value of values) {
    const key = keyFor(value);
    if (groups.has(key)) groups.get(key).push(value);
    else groups.set(key, [value]);
  }
  return groups;
}

function sourceSummary(row) {
  return {
    lineNumber: row.lineNumber,
    bgmId: row.bgmId,
    anidbId: row.anidbId,
    title: row.title,
    showUrl: row.showUrl,
    imageCount: row.imageIds.length,
  };
}

function rowCount(groups) {
  return groups.reduce((sum, group) => sum + group.rows.length, 0);
}

function sourceOrder(a, b) {
  return a.anidbId - b.anidbId || a.bgmId - b.bgmId || a.lineNumber - b.lineNumber;
}

function numeric(a, b) {
  return a - b;
}

function lexical(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function assertUnique(rows, key, label) {
  const seen = new Set();
  for (const row of rows) {
    assert(!seen.has(row[key]), `${label} 唯一性断言失败：${row[key]}`);
    seen.add(row[key]);
  }
}

function assertUniqueImages(rows) {
  const owners = new Map();
  for (const row of rows) {
    for (const imageId of row.imageIds) {
      const owner = owners.get(imageId);
      assert(!owner || owner === row.anidbId, `图片 ID ${imageId} 存在多个 AniDB 所有者`);
      owners.set(imageId, row.anidbId);
    }
  }
}

function tagNames(values, label) {
  assert(Array.isArray(values), `${label} 必须是数组`);
  const seen = new Set();
  for (const value of values) {
    normalizedText(value, 100, label, false);
    assert(!seen.has(value), `${label} 包含重复标签：${value}`);
    seen.add(value);
  }
}

function normalizedText(value, limit, label, allowEmpty) {
  assert(typeof value === "string" && (allowEmpty || value), `${label} 必须是字符串`);
  assert(text(value, limit) === value, `${label} 未规范化或过长`);
}

function plainObject(value, label) {
  assert(value && typeof value === "object" && !Array.isArray(value), `${label} 必须是对象`);
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(value).sort(lexical);
  const wanted = [...expected].sort(lexical);
  assert(
    actual.length === wanted.length && actual.every((key, index) => key === wanted[index]),
    `${label} 字段不匹配：应为 ${wanted.join(", ")}，实际为 ${actual.join(", ")}`,
  );
}

function positive(value, label) {
  assert(Number.isSafeInteger(value) && value > 0, `${label} 必须是正安全整数`);
}

function nonNegative(value, label) {
  assert(Number.isSafeInteger(value) && value >= 0, `${label} 必须是非负安全整数`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function readJson(filePath) {
  let raw;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    throw new Error(`无法读取 ${projectPath(filePath)}：${error.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${projectPath(filePath)} 不是有效 JSON：${error.message}`);
  }
}

async function writeJsonFiles(entries) {
  const nonce = `${process.pid}.${Date.now()}`;
  const temporary = [];
  try {
    for (const [index, entry] of entries.entries()) {
      await mkdir(dirname(entry.path), { recursive: true });
      const temporaryPath = `${entry.path}.${nonce}.${index}.tmp`;
      const raw = entry.pretty
        ? `${JSON.stringify(entry.value, null, 2)}\n`
        : `${JSON.stringify(entry.value)}\n`;
      await writeFile(temporaryPath, raw, { encoding: "utf8", flag: "wx" });
      temporary.push({ temporaryPath, outputPath: entry.path });
    }
    for (const entry of temporary) await rename(entry.temporaryPath, entry.outputPath);
  } catch (error) {
    await Promise.all(temporary.map((entry) => rm(entry.temporaryPath, { force: true })));
    throw error;
  }
}

async function report(mode, paths, library) {
  const [output, quarantine] = await Promise.all([
    metrics(paths.output),
    metrics(paths.quarantine),
  ]);
  console.log(JSON.stringify({
    mode,
    animeCount: library.stats.animeCount,
    imageCount: library.stats.imageCount,
    tagCount: library.stats.tagCount,
    coverCount: library.anime.reduce((sum, item) => sum + (item.cover ? 1 : 0), 0),
    output: { path: projectPath(paths.output), ...output },
    quarantine: { path: projectPath(paths.quarantine), ...quarantine },
  }, null, 2));
}

async function metrics(filePath) {
  const raw = await readFile(filePath);
  return {
    bytes: raw.length,
    gzipBytes: gzipSync(raw, { level: 9 }).length,
  };
}

function projectPath(filePath) {
  return relative(ROOT, filePath).replaceAll(String.fromCharCode(92), "/");
}
