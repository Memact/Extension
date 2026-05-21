import {
  hostnameFromUrl,
  normalizeText,
} from "./context-pipeline.js";

const QUALITY_PROTOTYPES = {
  meaningful: [
    "A meaningful browser memory with a clear topic, article text, documentation, a forum answer, a repository, or detailed page content worth revisiting.",
    "A useful captured page where the main content is the important part, not the site navigation, header, or footer.",
    "A content-rich page with a clear subject, readable text, and information the user may want to search later.",
  ],
  search_results: [
    "A search results page that shows a user query with multiple results and snippets from a search engine.",
    "A browser memory of search results for a specific query, with result cards or search snippets.",
    "A search engine results page for a typed query, not the generic home page.",
  ],
  shell: [
    "A low-value browser shell page with navigation links, account links, promo text, footer links, and no real page content.",
    "A search engine home page or site chrome with links like Gmail, Images, Privacy, Terms, and no useful memory content.",
    "A generic landing shell, browser chrome, or navigation-heavy page that should usually not be saved as a meaningful memory.",
  ],
};

const SEARCH_ENGINE_DOMAINS = new Set([
  "google.com",
  "bing.com",
  "duckduckgo.com",
  "search.brave.com",
  "search.yahoo.com",
]);

const prototypeEmbeddingCache = new Map();

function average(numbers) {
  if (!numbers.length) {
    return 0;
  }
  return numbers.reduce((total, value) => total + value, 0) / numbers.length;
}

function topScore(numbers) {
  return numbers.reduce((max, value) => Math.max(max, value), -1);
}

function buildClassifierText(profile) {
  const title = normalizeText(profile?.title, 160);
  const subject = normalizeText(profile?.subject, 160);
  const summary = normalizeText(profile?.structuredSummary, 220);
  const excerpt = normalizeText(profile?.displayExcerpt, 260);
  const snippet = normalizeText(profile?.snippet, 220);
  const domain = hostnameFromUrl(profile?.url || "") || normalizeText(profile?.domain, 120);
  const pageType = normalizeText(profile?.pageTypeLabel || profile?.pageType, 80);
  const searchResults = Array.isArray(profile?.searchResults) ? profile.searchResults.slice(0, 4) : [];

  return [
    title,
    subject,
    summary,
    excerpt,
    snippet,
    domain,
    pageType,
    searchResults.join(" "),
  ]
    .filter(Boolean)
    .join(" ");
}

function extractQuery(url) {
  try {
    const parsed = new URL(url);
    return normalizeText(
      parsed.searchParams.get("q") ||
        parsed.searchParams.get("p") ||
        parsed.searchParams.get("query") ||
        parsed.searchParams.get("text") ||
        parsed.searchParams.get("search_query")
    );
  } catch {
    return "";
  }
}

function shellNoiseHits(text) {
  const normalized = normalizeText(text, 1200).toLowerCase();
  if (!normalized) {
    return 0;
  }

  const patterns = [
    /\bgmail\s*images\b/,
    /\bhow search works\b/,
    /\bprivacy\b/,
    /\bterms\b/,
    /\badvertising\b/,
    /\bbusiness\b/,
    /\boffered in\b/,
    /\bai mode\b/,
    /\bstore\b/,
  ];

  return patterns.reduce((count, pattern) => count + (pattern.test(normalized) ? 1 : 0), 0);
}

async function getPrototypeEmbedding(text, embedText) {
  const key = String(text || "");
  if (!prototypeEmbeddingCache.has(key)) {
    prototypeEmbeddingCache.set(key, Promise.resolve(embedText(key)));
  }
  return prototypeEmbeddingCache.get(key);
}

async function scorePrototypeLabel(label, pageEmbedding, embedText, cosineSimilarity) {
  const prototypeTexts = QUALITY_PROTOTYPES[label] || [];
  if (!prototypeTexts.length) {
    return 0;
  }

  const similarities = [];
  for (const text of prototypeTexts) {
    const vector = await getPrototypeEmbedding(text, embedText);
    similarities.push(cosineSimilarity(pageEmbedding, vector));
  }

  return average(similarities) * 0.65 + topScore(similarities) * 0.35;
}

export async function classifyLocalPage(profile, { embedText, cosineSimilarity }) {
  const url = normalizeText(profile?.url);
  const domain = hostnameFromUrl(url) || normalizeText(profile?.domain).toLowerCase();
  const query = extractQuery(url);
  const searchResults = Array.isArray(profile?.searchResults) ? profile.searchResults : [];
  const classifierText = buildClassifierText(profile);
  const pageEmbedding = await embedText(classifierText || url || domain || "web page");

  const scores = {
    meaningful: await scorePrototypeLabel("meaningful", pageEmbedding, embedText, cosineSimilarity),
    search_results: await scorePrototypeLabel("search_results", pageEmbedding, embedText, cosineSimilarity),
    shell: await scorePrototypeLabel("shell", pageEmbedding, embedText, cosineSimilarity),
  };

  if (query) {
    scores.search_results += 0.2;
  }
  if (searchResults.length >= 3) {
    scores.search_results += 0.1;
  }
  if (profile?.pageType === "search" && query) {
    scores.search_results += 0.12;
  }
  if (profile?.pageType && ["article", "docs", "qa", "discussion", "repo", "video", "product", "lyrics", "chat", "social"].includes(profile.pageType)) {
    scores.meaningful += 0.1;
  }
  if (normalizeText(profile?.fullText || profile?.displayFullText, 0).length >= 600) {
    scores.meaningful += 0.08;
  }
  const noiseHits = shellNoiseHits(
    [profile?.snippet, profile?.displayExcerpt, profile?.fullText, profile?.structuredSummary]
      .filter(Boolean)
      .join(" ")
  );
  if (SEARCH_ENGINE_DOMAINS.has(domain) && !query) {
    scores.shell += 0.24;
  }
  if (noiseHits >= 2) {
    scores.shell += 0.18;
  }
  if (!query && !searchResults.length && !normalizeText(profile?.subject)) {
    scores.shell += 0.08;
  }

  const ranked = Object.entries(scores).sort((left, right) => right[1] - left[1]);
  const [label, bestScore] = ranked[0];
  const secondScore = ranked[1]?.[1] || 0;
  const confidence = Math.max(0, bestScore - secondScore);
  const isQuerySearchPage = Boolean(query) && (
    normalizeText(profile?.pageType).toLowerCase() === "search" ||
    SEARCH_ENGINE_DOMAINS.has(domain)
  );
  const shouldSkip =
    label === "shell" &&
    confidence >= 0.08 &&
    !isQuerySearchPage;

  return {
    qualityLabel: label,
    confidence: Number(confidence.toFixed(4)),
    scores: Object.fromEntries(
      Object.entries(scores).map(([key, value]) => [key, Number(value.toFixed(4))])
    ),
    shouldSkip,
  };
}
