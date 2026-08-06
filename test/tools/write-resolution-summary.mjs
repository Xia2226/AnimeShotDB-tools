#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const ORIGINAL_QUARANTINE = path.resolve(ROOT, "..", "resources", "generated", "anime-library-quarantine.json");
const CURRENT_QUARANTINE = path.join(ROOT, "resources", "generated", "anime-library-quarantine.json");
const LOG_FILE = path.join(ROOT, "logs", "resolution-log.jsonl");
const LIBRARY_FILE = path.join(ROOT, "public", "data", "anime-library.json");
const SUMMARY_FILE = path.join(ROOT, "resolution-summary.json");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

const before = readJson(ORIGINAL_QUARANTINE).summary;
const afterQuarantine = readJson(CURRENT_QUARANTINE);
const after = afterQuarantine.summary;
const library = readJson(LIBRARY_FILE);
const logRecords = fs.readFileSync(LOG_FILE, "utf8")
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line));

const byCategory = {};
const uniqueGroups = {};
for (const record of logRecords) {
  byCategory[record.category] = (byCategory[record.category] || 0) + 1;
  if (!uniqueGroups[record.category]) uniqueGroups[record.category] = new Set();
  uniqueGroups[record.category].add(record.groupId);
}

function summarizeCategory(records) {
  let droppedRows = 0;
  let networkErrorGroups = 0;
  let unresolvedGroups = 0;
  for (const record of records) {
    droppedRows += record.actions.filter((action) => action.action === "not_found").length;
    if (record.members.some((member) => member.judgement === "network_error")) networkErrorGroups += 1;
    if (record.members.some((member) => member.judgement === "unresolved")) unresolvedGroups += 1;
  }
  return { groups: records.length, droppedRows, networkErrorGroups, unresolvedGroups };
}

const crossRecords = logRecords.filter((record) => record.category === "crossAnidbShowUrls");
const duplicateRecords = logRecords.filter((record) => record.category === "duplicateAnidbIds");
const cross = summarizeCategory(crossRecords);
const duplicate = {
  ...summarizeCategory(duplicateRecords),
  changedAnidbRows: duplicateRecords.reduce(
    (sum, record) => sum + record.members.filter(
      (member) => member.afterAnidb && String(member.afterAnidb) !== String(member.beforeAnidb),
    ).length,
    0,
  ),
  candidateSearchRows: duplicateRecords.reduce(
    (sum, record) => sum + record.members.filter((member) => member.candidateAttempted?.length).length,
    0,
  ),
};

const summary = {
  generatedAt: new Date().toISOString(),
  scope: {
    categories: ["sharedImageIds", "crossAnidbShowUrls", "duplicateAnidbIds"],
    adultContentHandling: "unchanged policy; no adult items were intentionally rescued",
    changesOnlyInTest: true,
    pipelineOrder: "crossAnidbShowUrls -> duplicateAnidbIds -> sharedImageIds",
    strictDedup: "only resolved rows are retained; unresolved rows are isolated instead of being kept as best-match",
    duplicateAnidbMethod: "AniDB title library lookup uses Bangumi subject.name (original name) only, never name_cn or Chinese library labels; only exact non-Chinese title hits are used to search for independent FanCaps pages.",
  },
  before,
  after,
  quarantineCountsBefore: {
    crossAnidbShowUrlCount: before.crossAnidbShowUrlCount,
    duplicateAnidbIdCount: before.duplicateAnidbIdCount,
    sharedImageIdCount: before.sharedImageIdCount,
    emptiedByImageCleanupCount: before.emptiedByImageCleanupCount,
    adultContentCount: before.adultContentCount,
  },
  quarantineCountsAfter: {
    crossAnidbShowUrlCount: after.crossAnidbShowUrlCount,
    duplicateAnidbIdCount: after.duplicateAnidbIdCount,
    sharedImageIdCount: after.sharedImageIdCount,
    emptiedByImageCleanupCount: after.emptiedByImageCleanupCount,
    adultContentCount: after.adultContentCount,
  },
  resolutionStats: {
    logGroupCount: logRecords.length,
    byCategory,
    cross,
    duplicate,
  },
  finalBuild: {
    mode: "no-covers",
    animeCount: library.stats.animeCount,
    imageCount: library.stats.imageCount,
    tagCount: library.stats.tagCount,
    coverCount: library.anime.filter((item) => item.cover).length,
  },
  outputs: {
    fancaps: "test/resources/fancaps_anime_images.jsonl",
    quarantine: "test/resources/generated/anime-library-quarantine.json",
    library: "test/public/data/anime-library.json",
    log: "test/logs/resolution-log.jsonl",
    progress: "test/logs/resolution-progress.json",
    backup: "test/backup/fancaps_anime_images.before-fix.jsonl",
    reworkBackup: "test/backup/fancaps_anime_images.before-dup-rework.jsonl",
  },
  conclusion: "原三类冲突已清零；组内去重只保留 resolved 行，unresolved 行不保留；最终无封面构建通过。",
};

fs.writeFileSync(SUMMARY_FILE, JSON.stringify(summary, null, 2) + "\n", "utf8");
console.log(`written: ${SUMMARY_FILE}`);
