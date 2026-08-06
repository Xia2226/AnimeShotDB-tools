#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const FANCAPS_FILE = path.join(ROOT, "resources", "fancaps_anime_images.jsonl");
const BACKUP_FILE = path.join(ROOT, "backup", "fancaps_anime_images.before-fix.jsonl");
const REWORK_BACKUP_FILE = path.join(ROOT, "backup", "fancaps_anime_images.before-dup-rework.jsonl");
const QUARANTINE_FILE = path.join(ROOT, "resources", "generated", "anime-library-quarantine.json");
const LOG_FILE = path.join(ROOT, "logs", "resolution-log.jsonl");
const PROGRESS_FILE = path.join(ROOT, "logs", "resolution-progress.json");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readJsonl(filePath) {
  const rows = [];
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    if (line.trim()) rows.push(JSON.parse(line));
  }
  return rows;
}

function writeJsonl(filePath, rows) {
  fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
}

const quarantine = readJson(QUARANTINE_FILE);
const backupRows = readJsonl(BACKUP_FILE);
const currentRows = readJsonl(FANCAPS_FILE);
const duplicateLines = new Set();
for (const group of quarantine.quarantine.duplicateAnidbIds || []) {
  for (const member of group.rows || []) duplicateLines.add(member.lineNumber);
}

if (!fs.existsSync(REWORK_BACKUP_FILE)) {
  fs.copyFileSync(FANCAPS_FILE, REWORK_BACKUP_FILE);
}

let restored = 0;
for (const line of duplicateLines) {
  const backupRow = backupRows[line - 1];
  const currentRow = currentRows[line - 1];
  if (!backupRow || !currentRow) {
    throw new Error(`重置失败：第 ${line} 行在备份或当前题库中不存在`);
  }
  currentRows[line - 1] = JSON.parse(JSON.stringify(backupRow));
  restored += 1;
}

const sharedIds = new Set((quarantine.quarantine.sharedImageIds || []).map((entry) => String(entry.imageId)));
let removedImages = 0;
for (const row of currentRows) {
  if (!Array.isArray(row.images)) continue;
  const before = row.images.length;
  row.images = row.images.filter((url) => {
    const match = /\/(\d+)\.(?:avif|gif|jpe?g|png|webp)(?:[?#].*)?$/i.exec(new URL(url).pathname);
    return !match || !sharedIds.has(match[1]);
  });
  row.image_count = row.images.length;
  removedImages += Math.max(0, before - row.images.length);
}

writeJsonl(FANCAPS_FILE, currentRows);

if (fs.existsSync(LOG_FILE)) {
  const logLines = fs.readFileSync(LOG_FILE, "utf8").split(/\r?\n/).filter(Boolean);
  const kept = logLines.filter((line) => {
    try {
      return JSON.parse(line).category !== "duplicateAnidbIds";
    } catch {
      return true;
    }
  });
  fs.writeFileSync(LOG_FILE, kept.join("\n") + (kept.length ? "\n" : ""), "utf8");
}

if (fs.existsSync(PROGRESS_FILE)) {
  const progress = readJson(PROGRESS_FILE);
  progress.done = (progress.done || []).filter((key) => !String(key).startsWith("anidb:"));
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2), "utf8");
}

console.log(JSON.stringify({
  restoredRows: restored,
  sharedImageRemovals: removedImages,
  duplicateLogLinesRemoved: true,
  duplicateProgressRemoved: true,
  backup: path.relative(ROOT, REWORK_BACKUP_FILE),
}, null, 2));
