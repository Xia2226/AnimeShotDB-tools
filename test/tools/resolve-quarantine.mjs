#!/usr/bin/env node

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { promisify } from "node:util";
import { load } from "cheerio";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "..");
const FANCAPS_BASE = "https://fancaps.net";
const FANCAPS_IMAGE_HOST = "cdni.fancaps.net";
const FANCAPS_IMAGE_PATH = "/file/fancaps-animeimages/";
const FANCAPS_THUMB_HOST = "ant.fancaps.net";
const FANCAPS_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";

const FANCAPS_FILE = path.join(ROOT, "resources", "fancaps_anime_images.jsonl");
const SUBJECTS_FILE = path.join(ROOT, "resources", "subject.jsonlines");
const TITLES_FILE = path.join(ROOT, "resources", "anime-titles.xml");
const MAP_FILE = path.join(ROOT, "resources", "anime_map.json");
const QUARANTINE_FILE = path.join(ROOT, "resources", "generated", "anime-library-quarantine.json");
const LOG_FILE = path.join(ROOT, "logs", "resolution-log.jsonl");
const PROGRESS_FILE = path.join(ROOT, "logs", "resolution-progress.json");
const SUBJECT_ID_PATTERN = /^\s*\{\s*"id"\s*:\s*(\d+)(?:\s*,|\s*\})/;

const args = parseArgs(process.argv.slice(2));
const delayMs = args.delayMs;
let lastRequestAt = 0;
const searchCache = new Map();
const subjects = new Map();
let subjectsLoaded = false;

const rows = readJsonl(FANCAPS_FILE);
const quarantine = JSON.parse(fs.readFileSync(QUARANTINE_FILE, "utf8"));
const titles = loadAnimeTitles(TITLES_FILE);
const animeMap = loadAnimeMap(MAP_FILE);
const progress = loadProgress();

await main();

async function main() {
  fs.mkdirSync(path.join(ROOT, "logs"), { recursive: true });
  if (args.stage === "cross" || args.stage === "all") {
    await ensureSubjects();
    await processCrossGroups();
    saveRows();
    saveProgress();
  }
  if (args.stage === "dup" || args.stage === "all") {
    await ensureSubjects();
    await processDuplicateGroups();
    saveRows();
    saveProgress();
  }
  // Shared-image cleanup runs last because cross/dup may re-fetch FanCaps pages and reintroduce shared images.
  if (args.stage === "shared" || args.stage === "all") {
    await processSharedImages();
    saveRows();
    saveProgress();
  }
  saveProgress();
  console.log("done");
}

async function processSharedImages() {
  const shared = quarantine.quarantine.sharedImageIds || [];
  const batch = sliceBatch(shared, args.start, args.limit);
  for (const entry of batch) {
    const key = `shared:${entry.imageId}`;
    if (args.skipDone && progress.done.has(key)) continue;
    const imageId = entry.imageId;
    const hits = [];
    for (const row of rows) {
      if (!Array.isArray(row.images)) continue;
      const indexes = [];
      row.images.forEach((url, index) => {
        if (new RegExp(`/${imageId}\\.jpg(?:[?#].*)?$`, "i").test(url)) indexes.push(index);
      });
      if (indexes.length) hits.push({ line: rows.indexOf(row) + 1, indexes, imageCount: row.images.length });
    }
    const beforeCount = hits.reduce((sum, hit) => sum + hit.indexes.length, 0);
    for (const hit of hits) {
      const row = rows[hit.line - 1];
      row.images = row.images.filter((url) => !new RegExp(`/${imageId}\\.jpg(?:[?#].*)?$`, "i").test(url));
      row.image_count = row.images.length;
    }
    if (!args.dryRun) {
      appendLog({
        recordedAt: new Date().toISOString(),
        category: "sharedImageIds",
        groupId: `image:${imageId}`,
        members: hits.map((hit) => ({ line: hit.line, indexes: hit.indexes })),
        evidence: {
          sharedAnidbOwners: entry.anidbIds,
          occurrenceCount: beforeCount,
          affectedRows: hits.length,
        },
        judgement: "removed",
        actions: [{ field: "images", count: beforeCount }],
        result: "resolved",
        risk: "removed non-unique image IDs; no rows are expected to become empty",
      });
    }
    progress.done.add(key);
  }
}

async function processCrossGroups() {
  const groups = quarantine.quarantine.crossAnidbShowUrls || [];
  const batch = sliceBatch(groups, args.start, args.limit);
  for (const group of batch) {
    const groupId = `show:${group.showUrl}`;
    if (args.skipDone && progress.done.has(groupId)) continue;
    const members = [];
    const actions = [];
    const evidence = [];
    const networkErrorLines = new Set();
    for (const member of group.rows) {
      const row = rows[member.lineNumber - 1];
      if (!row || row.status !== "ok") {
        members.push({ line: member.lineNumber, judgement: "skipped", reason: "row missing or not ok" });
        continue;
      }
      const resolved = await resolveRow(row);
      members.push({
        line: member.lineNumber,
        bgmId: member.bgmId,
        anidbId: row.anidb_id,
        title: row.label_text,
        judgement: resolved.judgement,
        beforeShowUrl: member.showUrl,
        afterShowUrl: resolved.afterShowUrl || "",
        suggestedAid: resolved.suggestedAid || row.anidb_id,
      });
      evidence.push(...resolved.evidence);
      if (resolved.judgement === "network_error") {
        networkErrorLines.add(member.lineNumber);
        members[members.length - 1].judgement = "network_error";
        continue;
      }
      if (resolved.judgement === "resolved") {
        applyResolution(row, resolved);
        actions.push({ line: member.lineNumber, fields: resolved.actionFields });
      } else {
        members[members.length - 1].judgement = "unresolved";
        actions.push({ line: member.lineNumber, fields: [], action: "keep_pending_dedup" });
      }
    }
    const afterRows = group.rows
      .map((member) => ({
        member,
        row: rows[member.lineNumber - 1],
        judgement: members.find((entry) => entry.line === member.lineNumber)?.judgement || "",
      }))
      .filter(({ member, row }) => row && row.status === "ok" && !networkErrorLines.has(member.lineNumber));
    const byShow = new Map();
    for (const { member, row, judgement } of afterRows) {
      const key = normalizeShowUrl(row.fancaps?.show_url);
      if (!byShow.has(key)) byShow.set(key, []);
      byShow.get(key).push({ member, row, judgement });
    }
    for (const [showUrl, owners] of byShow) {
      if (owners.length > 1) {
        const pageTitle = owners[0].row.fancaps?.show_title || "";
        owners.sort(
          (a, b) =>
            Number(b.judgement === "resolved") - Number(a.judgement === "resolved")
            || expectedTitleScore(b.row, pageTitle) - expectedTitleScore(a.row, pageTitle)
            || (b.row.images?.length || 0) - (a.row.images?.length || 0),
        );
        const keep = owners[0];
        const isolated = keep.judgement === "resolved" ? owners.slice(1) : owners;
        for (const owner of isolated) {
          markUnresolved(owner.row, `no_distinct_fancaps_show:${showUrl}`);
          actions.push({ line: owner.member.lineNumber, fields: ["status", "images"], action: "not_found" });
        }
      }
    }
    for (const { member, row, judgement } of afterRows) {
      if (judgement === "unresolved" && row.status === "ok") {
        markUnresolved(row, "unresolved_fancaps_match");
        actions.push({ line: member.lineNumber, fields: ["status", "images"], action: "not_found" });
      }
    }
    if (!args.dryRun) {
      appendLog({
        recordedAt: new Date().toISOString(),
        category: "crossAnidbShowUrls",
        groupId,
        showUrl: group.showUrl,
        members,
        evidence,
        actions,
        judgement: "processed",
        result: "resolved",
        risk: "",
      });
    }
    progress.done.add(groupId);
  }
}

async function processDuplicateGroups() {
  const groups = quarantine.quarantine.duplicateAnidbIds || [];
  const batch = sliceBatch(groups, args.start, args.limit);
  for (const group of batch) {
    const groupId = `anidb:${group.anidbId}`;
    if (args.skipDone && progress.done.has(groupId)) continue;
    const members = [];
    const actions = [];
    const evidence = [];
    const networkErrorLines = new Set();
    for (const member of group.rows) {
      const row = rows[member.lineNumber - 1];
      if (!row || row.status !== "ok") {
        members.push({ line: member.lineNumber, judgement: "skipped", reason: "row missing or not ok" });
        continue;
      }
      const anidbLookup = findAnidbCandidates(row);
      evidence.push({
        source: "anidb_title_library",
        lookupField: "subject.name",
        usedChineseName: false,
        subjectName: anidbLookup.sourceName,
        candidates: anidbLookup.candidates.map((candidate) => ({
          anidbAid: candidate.aid,
          score: candidate.score,
          matchedTitle: candidate.matchedTitle,
          titleLang: candidate.lang,
          titleType: candidate.type,
        })),
      });
      const baseResolved = await resolveRow(row);
      const resolved = await resolveDuplicateRow(row, baseResolved, anidbLookup);
      members.push({
        line: member.lineNumber,
        bgmId: member.bgmId,
        title: row.label_text,
        judgement: resolved.judgement,
        beforeAnidb: group.anidbId,
        afterAnidb: resolved.suggestedAid || row.anidb_id,
        afterShowUrl: resolved.afterShowUrl || "",
        candidateAid: resolved.candidateAid || "",
        candidateAttempted: resolved.candidateAttempted || [],
      });
      evidence.push(...resolved.evidence);
      if (resolved.judgement === "network_error") {
        networkErrorLines.add(member.lineNumber);
        members[members.length - 1].judgement = "network_error";
        continue;
      }
      if (resolved.judgement === "resolved") {
        applyResolution(row, resolved, { changeAnidb: true });
        actions.push({ line: member.lineNumber, fields: resolved.actionFields });
      } else {
        members[members.length - 1].judgement = "unresolved";
        actions.push({ line: member.lineNumber, fields: [], action: "keep_pending_dedup" });
      }
    }
    const afterRows = group.rows
      .map((member) => ({
        member,
        row: rows[member.lineNumber - 1],
        judgement: members.find((entry) => entry.line === member.lineNumber)?.judgement || "",
      }))
      .filter(({ member, row }) => row && row.status === "ok" && !networkErrorLines.has(member.lineNumber));
    const byAid = new Map();
    for (const { member, row, judgement } of afterRows) {
      const key = String(row.anidb_id || "");
      if (!byAid.has(key)) byAid.set(key, []);
      byAid.get(key).push({ member, row, judgement });
    }
    for (const [anidbId, owners] of byAid) {
      if (owners.length > 1) {
        const pageTitle = owners[0].row.fancaps?.show_title || "";
        owners.sort(
          (a, b) =>
            Number(b.judgement === "resolved") - Number(a.judgement === "resolved")
            || expectedTitleScore(b.row, pageTitle) - expectedTitleScore(a.row, pageTitle)
            || (b.row.images?.length || 0) - (a.row.images?.length || 0),
        );
        const keep = owners[0];
        const isolated = keep.judgement === "resolved" ? owners.slice(1) : owners;
        for (const owner of isolated) {
          markUnresolved(owner.row, `duplicate_anidb_id:${anidbId}`);
          actions.push({ line: owner.member.lineNumber, fields: ["status", "images"], action: "not_found" });
        }
      }
    }
    for (const { member, row, judgement } of afterRows) {
      if (judgement === "unresolved" && row.status === "ok") {
        markUnresolved(row, "unresolved_fancaps_match");
        actions.push({ line: member.lineNumber, fields: ["status", "images"], action: "not_found" });
      }
    }
    if (!args.dryRun) {
      appendLog({
        recordedAt: new Date().toISOString(),
        category: "duplicateAnidbIds",
        groupId,
        anidbId: group.anidbId,
        members,
        evidence,
        actions,
        judgement: "processed",
        result: "resolved",
        risk: "",
      });
    }
    progress.done.add(groupId);
  }
}

async function resolveRow(row) {
  const expected = buildExpectedTitles(row);
  const queries = buildQueries(row, expected);
  const evidence = [];
  const results = new Map();
  for (const query of queries) {
    let found;
    try {
      found = await searchFanCaps(query);
    } catch (error) {
      evidence.push({ query, error: String(error?.message || error) });
      continue;
    }
    evidence.push({
      query,
      resultCount: found.length,
      results: found.slice(0, 8).map((item) => ({ title: item.title, url: item.url })),
    });
    for (const item of found) {
      const key = normalizeShowUrl(item.url);
      if (!results.has(key)) results.set(key, { ...item, score: 0, matchedExpected: [] });
    }
  }
  const scored = [...results.values()].map((item) => {
    const itemKey = titleKey(item.title);
    let best = 0;
    const matched = [];
    for (const exp of expected) {
      const expKey = titleKey(exp);
      if (!expKey || !itemKey) continue;
      if (expKey === itemKey) {
        best = Math.max(best, 100);
        matched.push(exp);
      } else if (itemKey.includes(expKey) || expKey.includes(itemKey)) {
        best = Math.max(best, 80);
        matched.push(exp);
      }
    }
    if (normalizeShowUrl(item.url) === normalizeShowUrl(row.fancaps?.show_url)) best += 5;
    return { ...item, score: best, matchedExpected: matched };
  });
  scored.sort((a, b) => b.score - a.score || b.matchedExpected.length - a.matchedExpected.length);
  if (!evidence.some((entry) => !entry.error)) {
    return {
      judgement: "network_error",
      afterShowUrl: "",
      suggestedAid: "",
      actionFields: [],
      chosen: null,
      evidence,
      reason: "fancaps_unreachable",
    };
  }
  const best = scored[0];
  const second = scored[1];
  if (
    best &&
    best.score >= 90 &&
    (!second || second.score < best.score - 20)
  ) {
    const afterShow = normalizeShowUrl(best.url);
    let images = [];
    let showPagesRead = 1;
    if (afterShow && (afterShow !== normalizeShowUrl(row.fancaps?.show_url) || !row.images?.length)) {
      const fetched = await collectShowImages(afterShow);
      images = fetched.images;
      showPagesRead = fetched.pagesRead;
    }
    return {
      judgement: "resolved",
      afterShowUrl: afterShow,
      suggestedAid: "",
      actionFields: ["fancaps.show_url", "fancaps.show_title", "images", "image_count", "crawled_at"],
      chosen: { ...best, images, showPagesRead },
      evidence,
      reason: "",
    };
  }
  const fallbackCurrent = scored.find((item) => normalizeShowUrl(item.url) === normalizeShowUrl(row.fancaps?.show_url));
  if (fallbackCurrent && fallbackCurrent.score >= 50 && (!best || best.score < 100)) {
    let images = [];
    let showPagesRead = 1;
    if (!row.images?.length) {
      const fetched = await collectShowImages(normalizeShowUrl(fallbackCurrent.url));
      images = fetched.images;
      showPagesRead = fetched.pagesRead;
    }
    return {
      judgement: "resolved",
      afterShowUrl: normalizeShowUrl(fallbackCurrent.url),
      suggestedAid: "",
      actionFields: ["fancaps.show_url", "fancaps.show_title"],
      chosen: { ...fallbackCurrent, images, showPagesRead },
      evidence,
      reason: "",
    };
  }
  return {
    judgement: "unresolved",
    afterShowUrl: "",
    suggestedAid: "",
    actionFields: [],
    chosen: null,
    evidence,
    reason: "no_reliable_fancaps_match",
  };
}

async function resolveDuplicateRow(row, baseResolved, anidbLookup = {}) {
  if (baseResolved.judgement !== "resolved") return baseResolved;
  const currentAid = String(row.anidb_id || "");
  const candidates = (anidbLookup.candidates || [])
    .filter((candidate) => String(candidate.aid) !== currentAid)
    .slice(0, 5);
  if (!candidates.length) {
    return { ...baseResolved, candidateAid: "", candidateAttempted: [], evidence: baseResolved.evidence };
  }

  const evidence = [];
  const candidateAttempted = [];
  for (const candidate of candidates) {
    candidateAttempted.push(candidate.aid);
    const entries = titles.byId.get(String(candidate.aid)) || [];
    const preferredTitles = entries
      .filter((entry) => ["main", "official", "syn"].includes(entry.type) && ["en", "ja", "x-jat"].includes(entry.lang))
      .map((entry) => entry.text)
      .filter(Boolean);
    const queries = [candidate.aid, ...preferredTitles]
      .filter((value, index, array) => array.indexOf(value) === index)
      .slice(0, 6);
    const results = new Map();
    for (const query of queries) {
      let found;
      try {
        found = await searchFanCaps(query);
      } catch (error) {
        evidence.push({
          source: "fancaps_candidate_search",
          anidbAid: candidate.aid,
          query,
          error: String(error?.message || error),
        });
        continue;
      }
      evidence.push({
        source: "fancaps_candidate_search",
        anidbAid: candidate.aid,
        query,
        resultCount: found.length,
        results: found.slice(0, 8).map((item) => ({ title: item.title, url: item.url })),
      });
      for (const item of found) {
        const key = normalizeShowUrl(item.url);
        if (key && key !== normalizeShowUrl(row.fancaps?.show_url) && !results.has(key)) {
          results.set(key, item);
        }
      }
    }

    const exact = [...results.values()].filter((item) =>
      entries.some((entry) => titleKey(entry.text) === titleKey(item.title)),
    );
    if (exact.length) {
      const chosen = exact[0];
      const afterShow = normalizeShowUrl(chosen.url);
      const fetched = await collectShowImages(afterShow);
      if (fetched.images.length) {
        return {
          ...baseResolved,
          candidateAid: candidate.aid,
          candidateAttempted,
          suggestedAid: candidate.aid,
          afterShowUrl: afterShow,
          actionFields: [...new Set([...baseResolved.actionFields, "anidb_id"])],
          chosen: { ...chosen, images: fetched.images, showPagesRead: fetched.pagesRead },
          evidence: [...baseResolved.evidence, ...evidence],
        };
      }
      evidence.push({
        source: "fancaps_candidate_page_empty",
        anidbAid: candidate.aid,
        afterShow,
      });
    }
  }
  return {
    ...baseResolved,
    candidateAid: "",
    candidateAttempted,
    evidence: [...baseResolved.evidence, ...evidence],
  };
}

function findAnidbCandidates(row) {
  const subject = subjects.get(String(row.bgm_id || ""));
  const sourceName = clean(subject?.name || "");
  if (!sourceName) return { sourceName: "", candidates: [] };
  const sourceKey = titleKey(sourceName);
  if (!sourceKey) return { sourceName, candidates: [] };
  const grouped = new Map();
  const addCandidate = (hit, baseScore) => {
    if (!hit?.text || isZhLang(hit.lang)) return;
    const score = baseScore + anidbTitleScore(hit, row.date);
    const existing = grouped.get(hit.aid);
    if (!existing || score > existing.score) {
      const years = aidYears(hit.aid);
      grouped.set(hit.aid, {
        aid: hit.aid,
        score,
        matchedTitle: hit.text,
        lang: hit.lang,
        type: hit.type,
        year: extractYear(hit.text),
        years,
      });
    }
  };

  const exactHits = titles.byKey.get(sourceKey) || [];
  for (const hit of exactHits) addCandidate(hit, 100);
  const rowYear = Number(String(row.date || "").slice(0, 4));
  const currentAid = String(row.anidb_id || "");
  const currentYears = currentAid ? aidYears(currentAid) : [];
  const candidates = [...grouped.values()]
    .filter((candidate) => {
      if (!rowYear) return true;
      if (candidate.years.length && !candidate.years.includes(rowYear)) return false;
      if (currentYears.includes(rowYear) && candidate.years.length === 0) return false;
      return true;
    })
    .sort((a, b) => b.score - a.score || Number(a.aid) - Number(b.aid))
    .slice(0, 12);
  return { sourceName, candidates };
}

function buildExpectedTitles(row) {
  const expected = new Set();
  if (row.label_text) expected.add(row.label_text);
  const subject = subjects.get(String(row.bgm_id || ""));
  if (subject?.name) expected.add(subject.name);
  if (subject?.nameCn) expected.add(subject.nameCn);
  const addEntries = (entries) => {
    for (const entry of entries) {
      if (!["main", "official", "syn"].includes(entry.type)) continue;
      if (!["en", "ja", "x-jat", "zh-Hans", "zh-Hant"].includes(entry.lang)) continue;
      if (entry.text.length <= 180) expected.add(entry.text);
    }
  };
  const currentEntries = titles.byId.get(String(row.anidb_id || "")) || [];
  addEntries(currentEntries);
  const mappedAid = animeMap.get(String(row.bgm_id || ""));
  if (mappedAid && mappedAid !== String(row.anidb_id || "")) {
    addEntries(titles.byId.get(mappedAid) || []);
  }
  for (const hit of findTitleHitsByLabel(row.label_text)) {
    addEntries(titles.byId.get(hit.aid) || []);
  }
  return [...expected].filter(Boolean).slice(0, 20);
}

function buildQueries(row, expected) {
  const queries = [];
  const seen = new Set();
  const push = (value) => {
    const normalized = String(value || "").replace(/\s+/g, " ").trim();
    const key = titleKey(normalized);
    if (normalized && key.length >= 2 && !seen.has(key)) {
      seen.add(key);
      queries.push(normalized);
    }
  };
  if (row.anidb_id) push(String(row.anidb_id));
  if (row.fancaps?.show_title) push(row.fancaps.show_title);
  if (row.label_text && !isChineseOnly(row.label_text)) push(row.label_text);
  for (const title of expected) {
    if (/^[\p{L}\p{N}][\p{L}\p{N} _\-&:/'’!.()+~,]+$/u.test(title) && !isChineseOnly(title)) push(title);
  }
  return queries.slice(0, 8);
}

function findTitleHitsByLabel(label) {
  if (!label) return [];
  const key = titleKey(label);
  const exact = titles.byKey.get(key) || [];
  if (exact.length) return exact;
  const hits = [];
  for (const [candidateKey, entries] of titles.byKey) {
    if (key.length >= 4 && (candidateKey.includes(key) || key.includes(candidateKey))) {
      hits.push(...entries);
    }
  }
  return hits.slice(0, 30);
}

function findUniqueAidForTitle(title) {
  const key = titleKey(title);
  const hits = titles.byKey.get(key) || [];
  const aids = [...new Set(hits.map((hit) => hit.aid))];
  return aids.length === 1 ? aids[0] : "";
}

async function ensureSubjects() {
  if (subjectsLoaded) return;
  const needed = new Set();
  for (const group of quarantine.quarantine.crossAnidbShowUrls || []) {
    for (const row of group.rows) needed.add(Number(row.bgmId));
  }
  for (const group of quarantine.quarantine.duplicateAnidbIds || []) {
    for (const row of group.rows) needed.add(Number(row.bgmId));
  }
  const reader = readline.createInterface({
    input: fs.createReadStream(SUBJECTS_FILE, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of reader) {
    if (!line.trim()) continue;
    const match = SUBJECT_ID_PATTERN.exec(line);
    if (!match) continue;
    const id = Number(match[1]);
    if (!needed.has(id)) continue;
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    subjects.set(String(id), {
      name: clean(value?.name),
      nameCn: clean(value?.name_cn),
    });
  }
  subjectsLoaded = true;
}

function expectedTitleScore(row, pageTitle) {
  const pageKey = titleKey(pageTitle);
  if (!pageKey) return 0;
  let best = 0;
  for (const title of buildExpectedTitles(row)) {
    const titleKeyValue = titleKey(title);
    if (!titleKeyValue) continue;
    if (titleKeyValue === pageKey) return 100;
    if (titleKeyValue.includes(pageKey) || pageKey.includes(titleKeyValue)) best = Math.max(best, 60);
  }
  return best;
}

function applyResolution(row, resolved, options = {}) {
  const chosen = resolved.chosen;
  if (!chosen) return;
  const beforeShow = normalizeShowUrl(row.fancaps?.show_url);
  const afterShow = normalizeShowUrl(chosen.url);
  row.fancaps = {
    ...(row.fancaps || {}),
    search_url: chosen.searchUrl || row.fancaps?.search_url || "",
    search_query: chosen.searchQuery || row.fancaps?.search_query || "",
    show_url: afterShow || beforeShow,
    show_title: chosen.title || row.fancaps?.show_title || "",
    result_count: chosen.resultCount || row.fancaps?.result_count || 1,
    show_pages_read: chosen.showPagesRead || row.fancaps?.show_pages_read || 1,
  };
  if (afterShow && afterShow !== beforeShow) {
    row.images = chosen.images || [];
    row.image_count = row.images.length;
  }
  if (options.changeAnidb && resolved.suggestedAid && String(resolved.suggestedAid) !== String(row.anidb_id || "")) {
    row.anidb_id = String(resolved.suggestedAid);
    row.anidb_source = "manual_resolution";
  }
  row.status = "ok";
  row.crawled_at = new Date().toISOString();
}

function markUnresolved(row, reason) {
  row.status = "not_found";
  row.images = [];
  row.image_count = 0;
  row.error = reason;
  row.crawled_at = new Date().toISOString();
}

async function searchFanCaps(query) {
  const cacheKey = titleKey(query);
  if (searchCache.has(cacheKey)) return searchCache.get(cacheKey);
  const url = `${FANCAPS_BASE}/search.php?q=${encodeURIComponent(query)}&animeCB=Anime&submit=Submit`;
  const html = await fetchText(url);
  const $ = load(html);
  const results = new Map();
  $("a[href]").each((_, anchor) => {
    const href = $(anchor).attr("href") || "";
    if (!href.toLowerCase().includes("anime/showimages.php")) return;
    if (href.toLowerCase().includes("episodeimages.php")) return;
    const absolute = absoluteUrl(href, FANCAPS_BASE);
    if (!absolute) return;
    const title = clean($(anchor).text()) || titleFromUrl(absolute) || "Anime Result";
    if (isBadTitle(title)) return;
    const showUrl = normalizeShowUrl(absolute);
    if (showUrl && !results.has(showUrl)) {
      results.set(showUrl, {
        title,
        url: showUrl,
        showId: showUrl.split("?").pop(),
        searchUrl: url,
        searchQuery: query,
        resultCount: 1,
      });
    }
  });
  const result = [...results.values()];
  searchCache.set(cacheKey, result);
  return result;
}

async function collectShowImages(showUrl) {
  const images = new Set();
  const visited = new Set();
  let currentUrl = showUrl;
  let pagesRead = 0;
  while (currentUrl && !visited.has(currentUrl) && visited.size < 30) {
    visited.add(currentUrl);
    pagesRead += 1;
    const html = await fetchText(currentUrl);
    const $ = load(html);
    $("img").each((_, image) => {
      const src = $(image).attr("data-src") || $(image).attr("data-original") || $(image).attr("data-lazy-src") || $(image).attr("src") || "";
      addImage(images, src, currentUrl);
    });
    $("a[href]").each((_, anchor) => addImage(images, $(anchor).attr("href") || "", currentUrl));
    currentUrl = findNextShowPage($, currentUrl);
  }
  return { images: [...images], pagesRead };
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
    if (url.hostname === FANCAPS_IMAGE_HOST && url.pathname.startsWith(FANCAPS_IMAGE_PATH)) {
      url.hash = "";
      set.add(url.toString());
      return;
    }
    if (url.hostname === FANCAPS_THUMB_HOST) {
      const id = url.pathname.match(/\/(\d{4,})\.(?:avif|gif|jpe?g|png|webp)$/i)?.[1];
      if (id) set.add(`https://${FANCAPS_IMAGE_HOST}${FANCAPS_IMAGE_PATH}${id}.jpg`);
    }
  } catch {}
}

async function fetchText(targetUrl) {
  const marker = "\n__FANCAPS_HTTP_STATUS__";
  const headers = {
    "User-Agent": FANCAPS_UA,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7",
    Referer: FANCAPS_BASE,
  };
  const wait = Math.max(0, lastRequestAt + delayMs - Date.now());
  if (wait) await sleep(wait);
  lastRequestAt = Date.now();
  const result = await execFileAsync(
    "curl.exe",
    [
      "--location",
      "--silent",
      "--show-error",
      "--compressed",
      "--max-time",
      "30",
      "-A",
      headers["User-Agent"],
      "-H",
      `Accept: ${headers.Accept}`,
      "-H",
      `Accept-Language: ${headers["Accept-Language"]}`,
      "-e",
      headers.Referer,
      "-w",
      `${marker}%{http_code}`,
      targetUrl,
    ],
    { windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
  );
  const statusAt = result.stdout.lastIndexOf(marker);
  if (statusAt < 0) throw new Error(`curl 未返回 HTTP 状态：${targetUrl}`);
  const text = result.stdout.slice(0, statusAt);
  const status = Number(result.stdout.slice(statusAt + marker.length).trim());
  if (!Number.isInteger(status)) throw new Error(`curl 返回无效 HTTP 状态：${targetUrl}`);
  if (status < 200 || status >= 300) throw new Error(`HTTP ${status}：${targetUrl}`);
  return text;
}

function loadAnimeTitles(filePath) {
  const xml = fs.readFileSync(filePath, "utf8");
  const byId = new Map();
  const byKey = new Map();
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
      const text = clean(title[2].replace(/<[^>]+>/g, ""));
      if (!text) continue;
      const entry = { aid, lang, type, text };
      entries.push(entry);
      const key = titleKey(text);
      if (key && key.length >= 2) {
        if (!byKey.has(key)) byKey.set(key, []);
        byKey.get(key).push(entry);
      }
    }
    if (entries.length) byId.set(aid, entries);
  }
  return { byId, byKey };
}

function loadAnimeMap(filePath) {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const rows = Array.isArray(raw) ? raw : Array.isArray(raw?.items) ? raw.items : Object.values(raw || {});
  const index = new Map();
  for (const row of rows) {
    const bgmId = String(row?.bgm_id ?? row?.bangumi_id ?? row?.bgmId ?? "").trim();
    const anidbId = String(row?.anidb_id ?? row?.anidbId ?? row?.aid ?? "").trim();
    if (/^\d+$/.test(bgmId) && /^\d+$/.test(anidbId)) index.set(bgmId, anidbId);
  }
  return index;
}

function readJsonl(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    rows.push(JSON.parse(line));
  }
  return rows;
}

function saveRows() {
  if (args.dryRun) return;
  const tmpPath = `${FANCAPS_FILE}.fix.tmp`;
  fs.writeFileSync(tmpPath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
  fs.renameSync(tmpPath, FANCAPS_FILE);
}

function appendLog(record) {
  fs.appendFileSync(LOG_FILE, `${JSON.stringify(record)}\n`, "utf8");
}

function loadProgress() {
  if (fs.existsSync(PROGRESS_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf8"));
      return { done: new Set(data.done || []) };
    } catch {}
  }
  return { done: new Set() };
}

function saveProgress() {
  if (args.dryRun) return;
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify({ done: [...progress.done] }, null, 2), "utf8");
}

function sliceBatch(list, start, limit) {
  return list.slice(start, limit ? start + limit : undefined);
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

function isZhLang(value) {
  return /^zh/i.test(value || "");
}

function isChineseOnly(value) {
  const text = String(value || "").trim();
  if (!text) return true;
  return !/[^\p{Script=Han}\s\p{Punctuation}\p{Symbol}\d]/u.test(text);
}

function extractYear(value) {
  const match = String(value || "").match(/\((\d{4})\)/);
  return match ? Number(match[1]) : 0;
}

function aidYears(aid) {
  const years = new Set();
  for (const entry of titles.byId.get(String(aid || "")) || []) {
    const year = extractYear(entry.text);
    if (year) years.add(year);
  }
  return [...years];
}

function anidbTitleScore(hit, rowDate) {
  let score = 0;
  if (hit.type === "main") score += 20;
  else if (hit.type === "official") score += 12;
  else if (hit.type === "synonym") score += 6;
  if (["x-jat", "en"].includes(hit.lang)) score += 20;
  else if (hit.lang === "ja") score += 8;
  const year = extractYear(hit.text);
  const rowYear = Number(String(rowDate || "").slice(0, 4));
  if (rowYear && year) {
    if (year === rowYear) score += 60;
    else if (Math.abs(year - rowYear) <= 1) score += 30;
  }
  return score;
}

function titleKey(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv) {
  const result = {
    stage: "all",
    start: 0,
    limit: 0,
    dryRun: false,
    skipDone: true,
    delayMs: 1200,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--stage") result.stage = argv[++index];
    else if (arg === "--start") result.start = Number(argv[++index]);
    else if (arg === "--limit") result.limit = Number(argv[++index]);
    else if (arg === "--dry-run") result.dryRun = true;
    else if (arg === "--no-skip-done") result.skipDone = false;
    else if (arg === "--delay-ms") result.delayMs = Number(argv[++index]);
  }
  return result;
}
