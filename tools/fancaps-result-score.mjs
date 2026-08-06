export class AmbiguousMatchError extends Error {}

const RESOLVED_SCORE = 90;

export function chooseFanCapsResult(results, target, config, titleCandidates = [], query = "") {
  const expectedKeys = [
    target.name,
    target.nameCn,
    target.labelText,
    ...titleCandidates,
  ].map(normalizeTitle).filter(Boolean);

  const scored = results
    .map((item) => ({ ...item, score: scoreFanCapsResult(item, expectedKeys, target, query) }))
    .sort((a, b) => b.score - a.score || normalizeTitle(a.title).localeCompare(normalizeTitle(b.title)));

  const best = scored[0];
  const second = scored[1];

  if (results.length === 1) {
    if (best && best.score >= RESOLVED_SCORE) {
      return best;
    }
    throw new AmbiguousMatchError(
      `FanCaps 仅返回 1 个候选，但未达到 resolved 匹配要求（${best?.score ?? 0} 分）：${best?.title || ""}；宁可跳过也不猜测`,
    );
  }

  if (best && best.score >= RESOLVED_SCORE && (!second || best.score > second.score)) {
    return best;
  }
  if (config.acceptFirstAmbiguous && best && best.score >= RESOLVED_SCORE) {
    return best;
  }
  if (!best || best.score < RESOLVED_SCORE) {
    throw new AmbiguousMatchError(
      `FanCaps 返回 ${results.length} 个候选，但没有达到 resolved 的候选（最高分 ${best?.score ?? 0}）；宁可跳过也不猜测`,
    );
  }
  throw new AmbiguousMatchError(
    `FanCaps 存在 resolved 候选但无法唯一确认（最高分 ${best.score}，次高分 ${second?.score ?? 0}）；可人工复核或使用 --accept-first-ambiguous`,
  );
}

export function scoreFanCapsResult(item, expectedKeys, target, query) {
  const itemKey = normalizeTitle(item.title);
  if (!itemKey) return 0;

  let score = 0;
  for (const expectedKey of expectedKeys) {
    if (!expectedKey) continue;
    if (expectedKey === itemKey) {
      score = Math.max(score, 100);
    } else if (itemKey.includes(expectedKey) || expectedKey.includes(itemKey)) {
      score = Math.max(score, 70);
    }
  }

  const queryKey = normalizeTitle(query);
  if (queryKey) {
    if (itemKey === queryKey) {
      score = Math.max(score, 90);
    } else if (itemKey.includes(queryKey) || queryKey.includes(itemKey)) {
      score = Math.max(score, 60);
    }
  }

  const rowYear = String(target.date || "").slice(0, 4);
  if (rowYear) {
    const years = [...new Set([...item.title.matchAll(/\((\d{4})\)/g)].map((match) => match[1]))];
    if (years.includes(rowYear)) {
      score += 10;
    } else if (years.some((year) => Math.abs(Number(year) - Number(rowYear)) > 2)) {
      score -= 200;
    }
  }

  return score;
}

function normalizeTitle(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .normalize("NFKC")
    .replace(/[‐‑‒–—―]/g, "-")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .toLowerCase();
}
