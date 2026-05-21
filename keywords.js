const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "that",
  "with",
  "from",
  "this",
  "what",
  "when",
  "where",
  "how",
  "why",
  "can",
  "you",
  "please",
  "any",
  "about",
  "into",
  "onto",
  "your",
  "have",
  "has",
  "had",
  "are",
  "was",
  "were",
  "been",
  "being",
  "will",
  "would",
  "could",
  "should",
  "maybe",
  "just",
  "want",
  "need",
  "find",
  "show",
  "give",
  "me",
  "it",
  "of",
  "to",
  "in",
  "on",
  "at",
  "by",
  "as",
  "is",
  "or",
  "if",
  "we",
  "i"
]);

function tokenize(text) {
  return String(text || "")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[^A-Za-z0-9@#./+-]+/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function isLikelyTerm(token) {
  if (!token || token.length < 3) {
    return false;
  }
  if (/^\d+$/.test(token)) {
    return false;
  }
  return !STOPWORDS.has(token.toLowerCase());
}

function phraseScore(tokens, stats, indexMap) {
  let score = 0;
  for (const token of tokens) {
    const normalized = token.toLowerCase();
    const term = stats.get(normalized);
    if (!term) continue;
    score += term.tf * 1.5;
    score += term.caseBonus;
    score += term.positionBonus;
    score += term.cooccurrenceBonus;
    score += 1 / Math.max(1, indexMap.get(normalized) || 1);
  }
  return score / Math.max(1, tokens.length);
}

export function extractKeyphrases(text, maxPhrases = 12) {
  try {
    const raw = String(text || "");
    if (raw.trim().length < 100) {
      return [];
    }

    const tokens = tokenize(raw);
    if (!tokens.length) {
      return [];
    }

    const stats = new Map();
    const firstPositions = new Map();
    const occurrenceCounts = new Map();

    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i];
      const normalized = token.toLowerCase();
      if (!isLikelyTerm(token)) {
        continue;
      }
      const existing = stats.get(normalized) || {
        tf: 0,
        caseBonus: 0,
        positionBonus: 0,
        cooccurrenceBonus: 0
      };
      existing.tf += 1;
      if (/^[A-Z]/.test(token)) {
        existing.caseBonus += 0.35;
      }
      if (!firstPositions.has(normalized)) {
        firstPositions.set(normalized, i);
        existing.positionBonus += Math.max(0, 1 - i / Math.max(1, tokens.length));
      }
      stats.set(normalized, existing);
      occurrenceCounts.set(normalized, (occurrenceCounts.get(normalized) || 0) + 1);
    }

    const terms = Array.from(stats.entries());
    for (const [term, details] of terms) {
      const nearTerms = new Set();
      for (let i = 0; i < tokens.length; i += 1) {
        if (tokens[i].toLowerCase() !== term) {
          continue;
        }
        for (let offset = -2; offset <= 2; offset += 1) {
          if (!offset) continue;
          const neighbor = tokens[i + offset];
          if (!neighbor || !isLikelyTerm(neighbor)) {
            continue;
          }
          nearTerms.add(neighbor.toLowerCase());
        }
      }
      details.cooccurrenceBonus += Math.min(1.2, nearTerms.size * 0.08);
      stats.set(term, details);
    }

    const rankedTerms = Array.from(stats.entries())
      .map(([term, details]) => ({
        term,
        score:
          details.tf * 1.8 +
          details.caseBonus +
          details.positionBonus +
          details.cooccurrenceBonus +
          Math.min(0.5, occurrenceCounts.get(term) / Math.max(10, tokens.length))
      }))
      .sort((left, right) => right.score - left.score);

    const topTerms = rankedTerms.slice(0, Math.max(16, maxPhrases * 2)).map((item) => item.term);
    const topTermSet = new Set(topTerms);
    const phrases = [];
    const seen = new Set();
    const indexMap = new Map(rankedTerms.map((item, index) => [item.term, index + 1]));

    const pushPhrase = (parts) => {
      const normalized = parts.join(" ").replace(/\s+/g, " ").trim();
      if (!normalized) return;
      const dedupKey = normalized.toLowerCase();
      if (seen.has(dedupKey)) return;
      seen.add(dedupKey);
      const phraseTokens = normalized.split(/\s+/);
      const score = phraseScore(phraseTokens, stats, indexMap);
      phrases.push({ phrase: normalized, score });
    };

    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i];
      const normalized = token.toLowerCase();
      if (!topTermSet.has(normalized)) {
        continue;
      }
      pushPhrase([token]);
      const next = tokens[i + 1];
      const next2 = tokens[i + 2];
      if (next && topTermSet.has(next.toLowerCase())) {
        pushPhrase([token, next]);
      }
      if (next && next2 && topTermSet.has(next.toLowerCase()) && topTermSet.has(next2.toLowerCase())) {
        pushPhrase([token, next, next2]);
      }
    }

    return phrases
      .sort((left, right) => right.score - left.score)
      .map((item) => item.phrase)
      .filter(Boolean)
      .slice(0, maxPhrases);
  } catch {
    return [];
  }
}
