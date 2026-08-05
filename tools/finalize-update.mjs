import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import readline from "node:readline";

const args = parseArgs(process.argv.slice(2));
for (const name of ["existing", "updated", "incremental", "unmapped", "errors", "summary", "subject", "titles", "mapping"]) {
  if (!args[name]) throw new Error(`缺少参数 --${name}`);
}

const existingIds = new Set();
const existingIdCounts = new Map();
let existingCount = 0;
for await (const row of readJsonl(args.existing)) {
  existingCount += 1;
  const bgmId = String(row.bgm_id);
  existingIds.add(bgmId);
  existingIdCounts.set(bgmId, (existingIdCounts.get(bgmId) || 0) + 1);
}

await fs.promises.mkdir(path.dirname(args.incremental), { recursive: true });
const incrementalStream = fs.createWriteStream(args.incremental, { encoding: "utf8" });
let updatedCount = 0;
let addedCount = 0;
let addedImages = 0;
let usableAnime = 0;
const statusCounts = {};
const outputIdCounts = new Map();

for await (const row of readJsonl(args.updated)) {
  updatedCount += 1;
  const bgmId = String(row.bgm_id);
  const outputOccurrence = (outputIdCounts.get(bgmId) || 0) + 1;
  outputIdCounts.set(bgmId, outputOccurrence);
  if (existingIds.has(bgmId)) {
    const allowedOccurrences = existingIdCounts.get(bgmId);
    if (outputOccurrence > allowedOccurrences) {
      throw new Error(`合并题库为原有 bgm_id 增加了重复记录：${bgmId}`);
    }
    continue;
  }
  if (outputOccurrence > 1) throw new Error(`本次新增出现重复 bgm_id：${bgmId}`);

  addedCount += 1;
  const status = String(row.status || "unknown");
  statusCounts[status] = (statusCounts[status] || 0) + 1;
  const imageCount = Number(row.image_count ?? (Array.isArray(row.images) ? row.images.length : 0)) || 0;
  addedImages += imageCount;
  if (status === "ok" && imageCount > 0) usableAnime += 1;
  if (!incrementalStream.write(`${JSON.stringify(row)}\n`)) {
    await new Promise((resolve) => incrementalStream.once("drain", resolve));
  }
}
await new Promise((resolve, reject) => incrementalStream.end((error) => error ? reject(error) : resolve()));

for (const [bgmId, expectedCount] of existingIdCounts) {
  const actualCount = outputIdCounts.get(bgmId) || 0;
  if (actualCount !== expectedCount) {
    throw new Error(`合并题库的原有 bgm_id 数量变化：${bgmId}，原有 ${expectedCount}，当前 ${actualCount}`);
  }
}
if (updatedCount !== existingCount + addedCount) {
  throw new Error(`记录数不一致：${updatedCount} != ${existingCount} + ${addedCount}`);
}

const unmappedCount = await countJsonl(args.unmapped);
const errorReportCount = await countJsonl(args.errors);
const summary = {
  schema_version: 1,
  generated_at: new Date().toISOString(),
  range: {
    base_cutoff: args.cutoff || "",
    to_date: args.to || "",
    min_done: Number(args["min-done"] || 0),
  },
  result: {
    existing_records: existingCount,
    updated_records: updatedCount,
    added_records: addedCount,
    status_counts: statusCounts,
    usable_added_anime: usableAnime,
    added_image_urls: addedImages,
    unmapped_candidates: unmappedCount,
    error_report_records: errorReportCount,
  },
  inputs: {
    subject: await fileInfo(args.subject),
    anidb_titles: await fileInfo(args.titles),
    anime_map: await fileInfo(args.mapping),
    current_dataset: await fileInfo(args.existing),
  },
  outputs: {
    updated_dataset: await fileInfo(args.updated),
    incremental_only: await fileInfo(args.incremental),
    unmapped: await fileInfo(args.unmapped),
    errors: await fileInfo(args.errors),
  },
};

await fs.promises.writeFile(args.summary, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
console.log(JSON.stringify(summary.result, null, 2));

async function* readJsonl(filePath) {
  const input = fs.createReadStream(filePath, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let lineNumber = 0;
  for await (const rawLine of lines) {
    lineNumber += 1;
    const line = rawLine.trim();
    if (!line) continue;
    try {
      yield JSON.parse(line);
    } catch (error) {
      throw new Error(`${filePath} 第 ${lineNumber} 行不是有效 JSON：${error.message}`);
    }
  }
}

async function countJsonl(filePath) {
  let count = 0;
  for await (const _row of readJsonl(filePath)) count += 1;
  return count;
}

async function fileInfo(filePath) {
  const stat = await fs.promises.stat(filePath);
  return {
    path: path.resolve(filePath),
    bytes: stat.size,
    modified_at: stat.mtime.toISOString(),
    sha256: await sha256(filePath),
  };
}

async function sha256(filePath) {
  const hash = crypto.createHash("sha256");
  const input = fs.createReadStream(filePath);
  for await (const chunk of input) hash.update(chunk);
  return hash.digest("hex");
}

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const key = values[index];
    if (!key.startsWith("--")) throw new Error(`未知参数：${key}`);
    const value = values[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${key} 缺少参数值`);
    result[key.slice(2)] = value;
    index += 1;
  }
  return result;
}
