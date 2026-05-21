const HIGH_VALUE_PAGE_TYPES = new Set([
  "article",
  "chat",
  "discussion",
  "docs",
  "lyrics",
  "product",
  "qa",
  "repo",
  "search",
  "video",
]);

const GENERIC_SUBJECTS = new Set([
  "browser",
  "home",
  "local memory",
  "memory",
  "new tab",
  "search",
  "search results",
  "web page",
]);

function normalizeText(value, maxLength = 0) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) {
    return "";
  }
  if (maxLength && text.length > maxLength) {
    return `${text.slice(0, maxLength - 3).trim()}...`;
  }
  return text;
}

function normalizeRichText(value, maxLength = 0) {
  const text = String(value || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const blocks = text
    .split(/\n{2,}/)
    .map((block) =>
      block
        .split(/\n+/)
        .map((line) => line.replace(/[ \t]+/g, " ").trim())
        .filter(Boolean)
        .join("\n")
    )
    .filter(Boolean);
  const normalized = blocks.join("\n\n").trim();
  if (!normalized) {
    return "";
  }
  if (maxLength && normalized.length > maxLength) {
    return normalized.slice(0, maxLength);
  }
  return normalized;
}

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function factValue(profile, label) {
  return normalizeText(
    (profile.factItems || []).find(
      (item) => normalizeText(item?.label).toLowerCase() === label
    )?.value
  );
}

function meaningfulSubject(subject) {
  const value = normalizeText(subject, 140).toLowerCase();
  return Boolean(value) && !GENERIC_SUBJECTS.has(value) && value.length >= 4;
}

function retentionModeForTier(tier, profile) {
  const clutterScore = Number(profile?.clutterAudit?.clutterScore || 0);
  if (tier === "core") {
    return clutterScore >= 0.58 ? "structured" : "full";
  }
  if (tier === "supporting") {
    return clutterScore >= 0.42 ? "structured" : "full";
  }
  if (tier === "background") {
    return "structured";
  }
  return "metadata";
}

function retentionLabel(mode) {
  if (mode === "full") {
    return "Keep full memory";
  }
  if (mode === "structured") {
    return "Keep structured memory";
  }
  return "Keep metadata only";
}

function memoryActionForTier(tier, profile) {
  if (profile?.captureIntent?.shouldSkip || profile?.clutterAudit?.shouldSkip || profile?.localJudge?.shouldSkip) {
    return "skip";
  }
  if (tier === "core" || tier === "supporting") {
    return "retain";
  }
  if (tier === "background") {
    return "compress";
  }
  return "demote";
}

function memoryActionLabel(action) {
  if (action === "retain") {
    return "Retain strongly";
  }
  if (action === "compress") {
    return "Compress memory";
  }
  if (action === "demote") {
    return "Demote to trace";
  }
  return "Skip capture";
}

export function evaluateSelectiveMemory(profile, options = {}) {
  const pageType = normalizeText(profile?.pageType).toLowerCase();
  const qualityLabel = normalizeText(profile?.localJudge?.qualityLabel).toLowerCase();
  const captureMode = normalizeText(profile?.captureIntent?.captureMode).toLowerCase();
  const interactionType = normalizeText(options?.interactionType).toLowerCase();
  const clutterScore = Number(profile?.clutterAudit?.clutterScore || 0);
  const organizationScore = Number(profile?.clutterAudit?.organizationScore || 0);
  const fullTextLength = normalizeRichText(
    profile?.displayFullText || profile?.fullText || "",
    0
  ).length;
  const excerptLength = normalizeText(
    profile?.displayExcerpt || profile?.snippet,
    0
  ).length;
  const subject = normalizeText(profile?.subject, 160);
  const entitiesCount = Array.isArray(profile?.entities) ? profile.entities.length : 0;
  const topicsCount = Array.isArray(profile?.topics) ? profile.topics.length : 0;
  const factCount = Array.isArray(profile?.factItems) ? profile.factItems.length : 0;
  const searchResultsCount = Array.isArray(profile?.searchResults) ? profile.searchResults.length : 0;
  const queryValue = factValue(profile, "query");

  let score = 0.36;
  const reasons = [];

  if (qualityLabel === "meaningful") {
    score += 0.2;
    reasons.push("meaningful page");
  } else if (qualityLabel === "search_results" && queryValue) {
    score += 0.12;
    reasons.push("real search memory");
  } else if (qualityLabel === "shell") {
    score -= 0.32;
    reasons.push("shell-like page");
  }

  if (HIGH_VALUE_PAGE_TYPES.has(pageType)) {
    score += 0.08;
    reasons.push(`${pageType} page`);
  }

  if (meaningfulSubject(subject)) {
    score += 0.1;
    reasons.push("clear subject");
  }

  if (factCount >= 3) {
    score += 0.08;
    reasons.push("rich facts");
  } else if (factCount > 0) {
    score += 0.04;
  }

  if (entitiesCount + topicsCount >= 4) {
    score += 0.07;
    reasons.push("good context");
  } else if (entitiesCount + topicsCount >= 2) {
    score += 0.04;
  }

  if (fullTextLength >= 1200) {
    score += 0.12;
    reasons.push("deep content");
  } else if (fullTextLength >= 420) {
    score += 0.08;
  } else if (fullTextLength >= 180) {
    score += 0.04;
  }

  if (pageType === "search" && queryValue) {
    score += 0.06;
    if (searchResultsCount >= 3) {
      score += 0.04;
      reasons.push("captured search results");
    }
  }

  if (interactionType === "type") {
    score += 0.08;
    reasons.push("active work");
  } else if (interactionType === "scroll" && fullTextLength >= 320) {
    score += 0.03;
  }

  if (captureMode === "metadata") {
    score -= 0.18;
    reasons.push("metadata-only capture");
  } else if (captureMode === "structured") {
    score -= 0.04;
  }

  if (clutterScore >= 0.8) {
    score -= 0.3;
    reasons.push("high clutter");
  } else if (clutterScore >= 0.62) {
    score -= 0.16;
  } else if (clutterScore >= 0.46) {
    score -= 0.08;
  }

  if (organizationScore >= 0.72) {
    score += 0.05;
    reasons.push("well organized");
  } else if (organizationScore <= 0.24) {
    score -= 0.12;
  }

  if (!meaningfulSubject(subject) && excerptLength < 120 && fullTextLength < 180) {
    score -= 0.12;
    reasons.push("thin memory");
  }

  if (profile?.captureIntent?.shouldSkip || profile?.clutterAudit?.shouldSkip || profile?.localJudge?.shouldSkip) {
    score = Math.min(score, 0.08);
  }

  const rememberScore = clamp01(score);
  const tier =
    rememberScore >= 0.78
      ? "core"
      : rememberScore >= 0.58
        ? "supporting"
        : rememberScore >= 0.35
          ? "background"
          : "fleeting";
  const retentionMode = retentionModeForTier(tier, profile);
  const memoryAction = memoryActionForTier(tier, profile);
  const recallWeight =
    tier === "core" ? 1.16 : tier === "supporting" ? 1.07 : tier === "background" ? 0.93 : 0.78;
  const shouldUseForSuggestions = rememberScore >= 0.44 && tier !== "fleeting";

  return {
    version: 1,
    rememberScore: Number(rememberScore.toFixed(4)),
    tier,
    tierLabel:
      tier === "core"
        ? "Core memory"
        : tier === "supporting"
          ? "Supporting memory"
          : tier === "background"
            ? "Background memory"
            : "Fleeting memory",
    retentionMode,
    retentionLabel: retentionLabel(retentionMode),
    recallWeight: Number(recallWeight.toFixed(4)),
    shouldUseForSuggestions,
    reasons: Array.from(new Set(reasons)).slice(0, 4),
    summary:
    tier === "core"
        ? "Memact should remember this strongly."
        : tier === "supporting"
          ? "Memact should keep this as supporting context."
          : tier === "background"
            ? "Memact should keep a lighter structured memory."
            : "Memact should keep only a light trace of this.",
    memoryAction,
    memoryActionLabel: memoryActionLabel(memoryAction),
  };
}

export function applySelectiveRetention(profile, storedContent, selectiveMemory) {
  const snippet = normalizeText(
    profile?.structuredSummary || profile?.displayExcerpt || storedContent?.snippet,
    320
  );
  const structuredFullText = normalizeRichText(
    profile?.displayFullText || storedContent?.fullText || storedContent?.snippet,
    8000
  );
  const fullText = normalizeRichText(
    storedContent?.fullText || profile?.fullText || structuredFullText,
    8000
  );

  if (selectiveMemory?.retentionMode === "metadata") {
    return {
      snippet,
      fullText: "",
    };
  }

  if (selectiveMemory?.retentionMode === "structured") {
    return {
      snippet,
      fullText: structuredFullText || fullText,
    };
  }

  return {
    snippet: normalizeText(storedContent?.snippet || snippet, 320) || snippet,
    fullText: fullText || structuredFullText,
  };
}
