const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "how",
  "i",
  "if",
  "in",
  "into",
  "is",
  "it",
  "me",
  "my",
  "of",
  "on",
  "or",
  "show",
  "site",
  "that",
  "the",
  "this",
  "to",
  "was",
  "what",
  "when",
  "where",
  "why",
  "with",
  "you",
  "your",
]);

const GENERIC_SUBJECTS = new Set([
  "home",
  "official site",
  "documentation",
  "docs",
  "search",
  "search results",
  "video",
  "article",
  "discussion",
  "question",
  "answer",
  "repository",
  "repo",
  "web page",
  "web",
]);

const GENERIC_UI_TOKENS = new Set([
  "about",
  "account",
  "advertising",
  "apply",
  "business",
  "continue",
  "discover",
  "explore",
  "gmail",
  "help",
  "home",
  "images",
  "learn",
  "login",
  "mode",
  "more",
  "new",
  "next",
  "open",
  "privacy",
  "results",
  "search",
  "settings",
  "show",
  "sign",
  "store",
  "terms",
  "view",
]);

const LOW_VALUE_CANDIDATE_PATTERNS = [
  /^about$/i,
  /^apply$/i,
  /^business$/i,
  /^gmail$/i,
  /^gmail images$/i,
  /^how search works$/i,
  /^images$/i,
  /^new$/i,
  /^official site$/i,
  /^privacy$/i,
  /^search results?$/i,
  /^settings$/i,
  /^show more$/i,
  /^sign in$/i,
  /^store$/i,
  /^terms$/i,
  /^view all$/i,
  /^web results$/i,
  /\boffered in\b/i,
  /\bai mode\b/i,
  /\bapply ai confidently\b/i,
];

const DOC_DOMAINS = new Set([
  "developer.mozilla.org",
  "docs.python.org",
  "learn.microsoft.com",
  "readthedocs.io",
  "stackoverflow.com",
]);

const SEARCH_ENGINE_DOMAINS = new Set([
  "google.com",
  "bing.com",
  "duckduckgo.com",
  "search.brave.com",
  "search.yahoo.com",
]);

const SOCIAL_DOMAINS = new Set([
  "facebook.com",
  "instagram.com",
  "linkedin.com",
  "threads.net",
  "twitter.com",
  "x.com",
]);

const COMMERCE_DOMAINS = new Set([
  "amazon.com",
  "ebay.com",
  "etsy.com",
  "flipkart.com",
]);

const DOCUMENT_EXTENSIONS = new Set([
  "pdf",
  "doc",
  "docx",
  "ppt",
  "pptx",
  "xls",
  "xlsx",
  "csv",
  "txt",
  "md",
]);

const SEARCH_HOME_NOISE_PATTERNS = [
  /\bgmail\s*images\b/i,
  /\bhow search works\b/i,
  /\bprivacy\b/i,
  /\bterms\b/i,
  /\badvertising\b/i,
  /\bbusiness\b/i,
  /\bstore\b/i,
  /\boffered in\b/i,
  /\bai mode\b/i,
  /\bapply ai confidently\b/i,
];

export const PAGE_TYPE_LABELS = {
  article: "Article",
  chat: "Chat",
  discussion: "Discussion",
  docs: "Documentation",
  lyrics: "Lyrics",
  product: "Product page",
  qa: "Q&A",
  repo: "Repository",
  search: "Search results",
  social: "Social page",
  video: "Video",
  web: "Web page",
};

export function normalizeText(value, maxLength = 0) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) {
    return "";
  }
  if (maxLength && text.length > maxLength) {
    return `${text.slice(0, maxLength - 3).trim()}...`;
  }
  return text;
}

export function normalizeRichText(value, maxLength = 0) {
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
  return maxLength && normalized.length > maxLength ? normalized.slice(0, maxLength) : normalized;
}

export function parseArrayValue(raw) {
  if (Array.isArray(raw)) {
    return raw;
  }
  try {
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseObjectValue(raw) {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw;
  }
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function hostnameFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
}

function urlDetails(url) {
  try {
    const parsed = new URL(url);
    return {
      hostname: parsed.hostname.replace(/^www\./i, "").toLowerCase(),
      pathname: parsed.pathname || "/",
      port: parsed.port || "",
      searchParams: parsed.searchParams,
    };
  } catch {
    return {
      hostname: "",
      pathname: "/",
      port: "",
      searchParams: new URLSearchParams(),
    };
  }
}

function documentExtensionFromValue(value) {
  const match = String(value || "").match(/\.(pdf|docx?|pptx?|xlsx?|csv|txt|md)\b/i);
  const extension = match ? match[1].toLowerCase() : "";
  return DOCUMENT_EXTENSIONS.has(extension) ? extension : "";
}

function documentFormatLabel(raw) {
  const value =
    documentExtensionFromValue(raw?.url) ||
    documentExtensionFromValue(raw?.title) ||
    documentExtensionFromValue(raw?.pageTitle);
  return value ? value.toUpperCase() : "";
}

function looksLikeDocumentResource(raw) {
  const details = urlDetails(raw?.url || "");
  const title = normalizeText(raw?.title || raw?.pageTitle, 220).toLowerCase();
  const path = normalizeText(details.pathname, 220).toLowerCase();

  if (documentExtensionFromValue(path) || documentExtensionFromValue(title)) {
    return true;
  }

  if (details.hostname === "drive.google.com" && details.pathname.includes("/file/")) {
    return true;
  }

  if (details.hostname === "docs.google.com") {
    return true;
  }

  return false;
}

function normalizeDocumentTitle(title, url = "") {
  const value = normalizeText(title, 220)
    .replace(/\s*-\s*google drive$/i, "")
    .replace(/\s*-\s*google docs$/i, "")
    .replace(/\s*-\s*google sheets$/i, "")
    .replace(/\s*-\s*google slides$/i, "")
    .replace(/\s*-\s*google forms$/i, "")
    .replace(/\.(pdf|docx?|pptx?|xlsx?|csv|txt|md)\b/gi, "")
    .replace(/[_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (value) {
    return value;
  }

  const details = urlDetails(url);
  const fileName = normalizeText(
    String(details.pathname || "").split("/").filter(Boolean).pop() || "",
    220
  )
    .replace(/\.(pdf|docx?|pptx?|xlsx?|csv|txt|md)\b/gi, "")
    .replace(/[_]+/g, " ")
    .trim();

  return fileName;
}

function searchEngineName(value) {
  const hostname = hostnameFromUrl(value) || normalizeText(value).toLowerCase();
  if (hostname.includes("google.")) {
    return "Google";
  }
  if (hostname.includes("bing.")) {
    return "Bing";
  }
  if (hostname.includes("duckduckgo.")) {
    return "DuckDuckGo";
  }
  if (hostname.includes("brave.")) {
    return "Brave Search";
  }
  if (hostname.includes("yahoo.")) {
    return "Yahoo Search";
  }
  return "";
}

export function canonicalUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    parsed.search = "";
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`.toLowerCase();
  } catch {
    return normalizeText(url).toLowerCase();
  }
}

export function meaningfulTokens(text) {
  return Array.from(
    new Set(
      normalizeText(text)
        .toLowerCase()
        .replace(/[^a-z0-9@#./+-]+/g, " ")
        .split(/\s+/)
        .filter((token) => token.length >= 2 && !STOPWORDS.has(token))
    )
  );
}

function humanizeCollapsedText(value) {
  return String(value || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([.!?])([A-Z])/g, "$1 $2")
    .replace(/\b(View all)([A-Z])/g, "$1 $2")
    .replace(/([|])([A-Z])/g, "$1 $2")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function splitReadableLines(value) {
  return humanizeCollapsedText(value)
    .split(/\n+|(?<=[.!?])\s+(?=[A-Z])/)
    .map((line) => normalizeText(line, 220))
    .filter(Boolean);
}

function toTitleCase(value) {
  return String(value || "")
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function dedupeStrings(values, limit = 8) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const normalized = normalizeText(value, 120)
      .replace(/[|]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!normalized) {
      continue;
    }
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(normalized);
    if (result.length >= limit) {
      break;
    }
  }
  return result;
}

function cleanTopic(value) {
  return normalizeText(value, 140)
    .replace(/\s+/g, " ")
    .replace(/\.(pdf|docx?|pptx?|xlsx?|csv|txt|md)\b/gi, "")
    .replace(/[_]+/g, " ")
    .replace(/\b(home|official site|search results?)\b/gi, "")
    .replace(/\s+\|\s+.*$/, "")
    .replace(/[,:;.\- ]+$/g, "")
    .trim();
}

function candidateTokens(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9+#./-]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function looksLikeUiNoise(value) {
  const cleaned = normalizeText(value, 160);
  if (!cleaned) {
    return true;
  }
  if (GENERIC_SUBJECTS.has(cleaned.toLowerCase())) {
    return true;
  }
  if (LOW_VALUE_CANDIDATE_PATTERNS.some((pattern) => pattern.test(cleaned))) {
    return true;
  }

  const tokens = candidateTokens(cleaned);
  if (!tokens.length) {
    return true;
  }
  if (tokens.every((token) => GENERIC_UI_TOKENS.has(token))) {
    return true;
  }
  if (
    tokens.length <= 3 &&
    tokens.filter((token) => GENERIC_UI_TOKENS.has(token)).length >= Math.max(1, tokens.length - 1)
  ) {
    return true;
  }
  if (cleaned.length <= 10 && tokens.length === 1 && GENERIC_UI_TOKENS.has(tokens[0])) {
    return true;
  }
  return false;
}

function usefulCandidate(value) {
  const cleaned = cleanTopic(value);
  if (!cleaned) {
    return "";
  }
  if (looksLikeUiNoise(cleaned)) {
    return "";
  }
  return cleaned;
}

function splitHeadline(text) {
  return normalizeText(text)
    .split(/\s+[|:•]\s+|\s+-\s+/)
    .map((part) => usefulCandidate(part))
    .filter(Boolean);
}

function extractQuotedPhrases(text) {
  const matches = [];
  const source = String(text || "");
  for (const regex of [/["“](.{2,80}?)["”]/g, /'(.{2,80}?)'/g]) {
    let match;
    while ((match = regex.exec(source))) {
      const candidate = usefulCandidate(match[1]);
      if (candidate) {
        matches.push(candidate);
      }
    }
  }
  return matches;
}

function extractPatternCandidates(text) {
  const source = String(text || "");
  const matches = [];
  const patterns = [
    /\b[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\b/g,
    /\b[A-Z][A-Za-z0-9+#./-]+(?:\s+[A-Z][A-Za-z0-9+#./-]+){0,4}\b/g,
    /\b[A-Z]{2,}[A-Za-z0-9+#./-]*\b/g,
  ];

  for (const regex of patterns) {
    let match;
    while ((match = regex.exec(source))) {
      const candidate = usefulCandidate(match[0]);
      if (candidate) {
        matches.push(candidate);
      }
    }
  }

  return matches;
}

function splitHeadlineSafe(text) {
  return normalizeText(text)
    .split(/\s+[|:]\s+|\s+-\s+|\s+\u2022\s+/)
    .map((part) => usefulCandidate(part))
    .filter(Boolean);
}

function extractQuotedPhrasesSafe(text) {
  const matches = [];
  const source = String(text || "");
  for (const regex of [/["\u201c](.{2,80}?)["\u201d]/g, /'(.{2,80}?)'/g]) {
    let match;
    while ((match = regex.exec(source))) {
      const candidate = usefulCandidate(match[1]);
      if (candidate) {
        matches.push(candidate);
      }
    }
  }
  return matches;
}

function rankedNgrams(text, weight = 1, counts = new Map()) {
  const tokens = meaningfulTokens(text);
  if (!tokens.length) {
    return counts;
  }

  for (let size = 3; size >= 1; size -= 1) {
    for (let index = 0; index <= tokens.length - size; index += 1) {
      const phrase = tokens.slice(index, index + size).join(" ");
      if (!phrase || phrase.length < 3) {
        continue;
      }
      if (size === 1 && phrase.length < 4) {
        continue;
      }
      counts.set(phrase, (counts.get(phrase) || 0) + weight / size);
    }
  }

  return counts;
}

function buildTopics({ title, h1, selection, description, snippet, fullText, keyphrases, entities }) {
  const counts = new Map();
  rankedNgrams(selection, 6, counts);
  rankedNgrams(h1, 5, counts);
  rankedNgrams(title, 4, counts);
  rankedNgrams(description, 3, counts);
  rankedNgrams(snippet, 3, counts);
  rankedNgrams(String(fullText || "").slice(0, 1200), 1.5, counts);

  for (const phrase of keyphrases || []) {
    const cleaned = usefulCandidate(phrase);
    if (cleaned) {
      counts.set(cleaned.toLowerCase(), (counts.get(cleaned.toLowerCase()) || 0) + 8);
    }
  }

  for (const phrase of entities || []) {
    counts.set(phrase.toLowerCase(), (counts.get(phrase.toLowerCase()) || 0) + 6);
  }

  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].length - right[0].length)
    .map(([phrase]) => usefulCandidate(phrase))
    .filter(Boolean)
    .filter((phrase) => !GENERIC_SUBJECTS.has(phrase.toLowerCase()))
    .slice(0, 8);
}

function extractQueryValue(url) {
  const details = urlDetails(url);
  const candidates = [
    details.searchParams.get("q"),
    details.searchParams.get("p"),
    details.searchParams.get("query"),
    details.searchParams.get("text"),
    details.searchParams.get("search_query"),
  ];
  return usefulCandidate(candidates.find(Boolean) || "");
}

function isSearchResultsPage({ url, title, fullText }) {
  const details = urlDetails(url);
  const titleLower = normalizeText(title, 200).toLowerCase();
  const bodyLower = normalizeText(fullText, 500).toLowerCase();
  const hasQuery = Boolean(extractQueryValue(url));
  return (
    hasQuery ||
    details.pathname.includes("/search") ||
    titleLower.includes("search results") ||
    bodyLower.includes("search results")
  );
}

function isSearchEngineHomePage(raw) {
  const details = urlDetails(raw.url || "");
  if (!SEARCH_ENGINE_DOMAINS.has(details.hostname)) {
    return false;
  }
  if (extractQueryValue(raw.url || "")) {
    return false;
  }

  const normalizedPath = (details.pathname || "/").replace(/\/+$/, "") || "/";
  if (normalizedPath !== "/") {
    return false;
  }

  const titleLower = normalizeText(raw.title || raw.pageTitle, 120).toLowerCase();
  const shellText = normalizeText(
    [raw.snippet, raw.fullText || raw.full_text, raw.description].filter(Boolean).join(" "),
    1200
  ).toLowerCase();
  const engineName = searchEngineName(raw.url || details.hostname).toLowerCase();
  const titleLooksGeneric =
    !titleLower ||
    titleLower === engineName ||
    titleLower === details.hostname ||
    titleLower === details.hostname.replace(/^www\./, "");
  const noiseHits = SEARCH_HOME_NOISE_PATTERNS.filter((pattern) => pattern.test(shellText)).length;

  return titleLooksGeneric || noiseHits >= 2;
}

export function inferPageType(raw) {
  const details = urlDetails(raw.url || "");
  const titleLower = normalizeText(raw.title || raw.pageTitle, 200).toLowerCase();
  const descriptionLower = normalizeText(raw.description, 200).toLowerCase();
  const bodyLower = normalizeText(raw.fullText || raw.full_text, 4000).toLowerCase();

  if (isSearchResultsPage(raw)) {
    return "search";
  }
  if (isSearchEngineHomePage(raw)) {
    return "web";
  }
  if (looksLikeDocumentResource(raw)) {
    return "docs";
  }
  if (
    titleLower.includes("lyrics") ||
    bodyLower.includes("lyrics:") ||
    bodyLower.includes("official lyrics")
  ) {
    return "lyrics";
  }
  if (
    details.hostname === "youtube.com" ||
    details.hostname === "youtu.be" ||
    details.hostname === "vimeo.com"
  ) {
    return "video";
  }
  if (SOCIAL_DOMAINS.has(details.hostname)) {
    return "social";
  }
  if (
    details.hostname === "stackoverflow.com" ||
    details.hostname.endsWith(".stackexchange.com")
  ) {
    return "qa";
  }
  if (
    details.hostname === "github.com" ||
    details.hostname === "gitlab.com" ||
    details.hostname === "bitbucket.org"
  ) {
    return "repo";
  }
  if (
    details.hostname === "reddit.com" ||
    details.hostname === "news.ycombinator.com" ||
    details.hostname.includes("forum") ||
    details.pathname.includes("/thread") ||
    details.pathname.includes("/discussion") ||
    details.pathname.includes("/comments/")
  ) {
    return "discussion";
  }
  if (
    DOC_DOMAINS.has(details.hostname) ||
    details.hostname.startsWith("docs.") ||
    details.pathname.includes("/docs") ||
    titleLower.includes("documentation") ||
    descriptionLower.includes("documentation") ||
    bodyLower.includes("api reference")
  ) {
    return "docs";
  }
  if (
    details.hostname === "chatgpt.com" ||
    details.hostname === "claude.ai" ||
    titleLower.includes("chatgpt") ||
    titleLower.includes("claude")
  ) {
    return "chat";
  }
  if (
    COMMERCE_DOMAINS.has(details.hostname) ||
    bodyLower.includes("add to cart") ||
    bodyLower.includes("buy now")
  ) {
    return "product";
  }
  if (
    normalizeText(raw.fullText || raw.full_text, 0).length >= 700 ||
    titleLower.includes("how to") ||
    titleLower.includes("guide")
  ) {
    return "article";
  }
  return "web";
}

export function pageTypeLabel(pageType) {
  return PAGE_TYPE_LABELS[pageType] || PAGE_TYPE_LABELS.web;
}

function parseLyricsFacts(title) {
  const cleanedTitle = normalizeText(title, 160)
    .replace(/\((official )?lyrics?\)/gi, "")
    .replace(/\[(official )?lyrics?\]/gi, "")
    .trim();
  const parts = cleanedTitle
    .split(/\s+-\s+/)
    .map((part) => usefulCandidate(part))
    .filter(Boolean);
  return {
    song: parts[0] || "",
    artist: parts[1] || "",
  };
}

function primarySubject({ subject, entities, topics, domain }) {
  const entityList = Array.isArray(entities) ? entities : [];
  const topicList = Array.isArray(topics) ? topics : [];
  return usefulCandidate(subject) || entityList[0] || topicList[0] || domain || "";
}

export function buildStructuredFacts(raw, pageType = inferPageType(raw)) {
  const facts = [];
  const subject = primarySubject(raw);
  const domain = hostnameFromUrl(raw.url || "") || normalizeText(raw.domain);
  const documentLike = looksLikeDocumentResource(raw);
  const documentTitle = documentLike
    ? normalizeDocumentTitle(raw.title || raw.pageTitle || subject, raw.url)
    : "";
  const documentFormat = documentLike ? documentFormatLabel(raw) : "";

  if (pageType === "lyrics") {
    const { song, artist } = parseLyricsFacts(raw.title || raw.pageTitle || subject);
    if (song) facts.push({ label: "Song", value: song });
    if (artist) facts.push({ label: "Artist", value: artist });
  } else if (pageType === "search") {
    const query = extractQueryValue(raw.url || "");
    const engine = searchEngineName(raw.url || domain);
    const resultCount = extractSearchResultItems(raw).length;
    if (query) facts.push({ label: "Query", value: query });
    if (engine) facts.push({ label: "Engine", value: engine });
    if (resultCount) facts.push({ label: "Captured results", value: `${resultCount}` });
  } else if (pageType === "repo") {
    const repo = usefulCandidate((raw.entities || []).find((value) => value.includes("/")));
    if (repo) {
      facts.push({ label: "Repository", value: repo });
    }
  } else if (pageType === "video") {
    if (subject) {
      facts.push({ label: "Video", value: subject });
    }
  } else if (pageType === "product") {
    if (subject) {
      facts.push({ label: "Product", value: subject });
    }
  } else if (pageType === "qa") {
    if (subject) {
      facts.push({ label: "Question", value: subject });
    }
  } else if (pageType === "docs") {
    if (documentLike) {
      if (documentTitle) {
        facts.push({ label: "Document", value: documentTitle });
      }
      if (documentFormat) {
        facts.push({ label: "Format", value: documentFormat });
      }
    } else if (subject) {
      facts.push({ label: "Topic", value: subject });
    }
  } else if (pageType === "discussion" || pageType === "chat" || pageType === "social") {
    if (subject) {
      facts.push({ label: "Topic", value: subject });
    }
  } else if (subject) {
    facts.push({ label: "Topic", value: subject });
  }

  const focus = documentLike ? "" : usefulCandidate((raw.topics || [])[0]);
  if (focus && !facts.some((fact) => fact.value.toLowerCase() === focus.toLowerCase())) {
    facts.push({ label: "Focus", value: focus });
  }

  if (
    pageType !== "search" &&
    domain &&
    !facts.some((fact) => fact.value.toLowerCase() === domain.toLowerCase())
  ) {
    facts.push({ label: "Source", value: domain });
  }

  return facts.slice(0, 4);
}

export function isNoiseLine(line) {
  const lower = String(line || "").toLowerCase().trim();
  if (!lower) {
    return true;
  }
  if (/^[\-=*_#|.]{6,}$/.test(lower)) {
    return true;
  }
  if (
    /(click the bell|subscribe|background picture by|contact\/submissions|official site|follow us|stream now|sponsored|advertisement|loading public)/i.test(
      lower
    )
  ) {
    return true;
  }
  if (
    /(this summary was generated by ai|based on sources|learn more about bing search results)/i.test(
      lower
    )
  ) {
    return true;
  }
  if (/https?:\/\/\S+/i.test(lower) && lower.length < 180) {
    return true;
  }
  if (/@/.test(lower) && lower.includes("contact")) {
    return true;
  }
  return false;
}

function extractSearchResultItems(raw) {
  const query = extractQueryValue(raw.url || "");
  if (!query) {
    return [];
  }
  const lines = splitReadableLines(raw.fullText || raw.full_text || raw.snippet);
  const candidates = [];

  for (const line of lines) {
    const cleaned = normalizeText(line, 180)
      .replace(/^view all\s*/i, "")
      .replace(/^web results\s*/i, "")
      .trim();

    if (!cleaned || isNoiseLine(cleaned)) {
      continue;
    }
    if (looksLikeUiNoise(cleaned)) {
      continue;
    }
    if (query && cleaned.toLowerCase() === query.toLowerCase()) {
      continue;
    }
    if (
      /^(show more|read more|dive deeper in ai mode|ai can make mistakes|people also ask)$/i.test(
        cleaned
      )
    ) {
      continue;
    }
    if (cleaned.length < 12) {
      continue;
    }
    if (cleaned.split(/\s+/).length < 2 && !/[/.:-]/.test(cleaned)) {
      continue;
    }
    candidates.push(cleaned);
  }

  if (candidates.length) {
    return dedupeStrings(candidates, 6);
  }

  const fallbackCandidates = lines
    .map((line) => normalizeText(line, 180))
    .filter((line) => {
      if (!line || isNoiseLine(line)) {
        return false;
      }
      if (query && line.toLowerCase() === query.toLowerCase()) {
        return false;
      }
      return line.length >= 6;
    });

  return dedupeStrings(fallbackCandidates, 6);
}

export function buildDisplayExcerpt(raw, pageType = inferPageType(raw)) {
  const sourceText = normalizeRichText(raw.fullText || raw.full_text || raw.snippet, 0);
  if (!sourceText) {
    return "";
  }

  if (pageType === "search") {
    const query = extractQueryValue(raw.url || "");
    const engine = searchEngineName(raw.url || raw.domain) || "Search";
    const items = extractSearchResultItems(raw).slice(0, 2);
    const lead = query ? `${engine} results for "${query}".` : `${engine} results page.`;
    const details = items.length ? `Top captured results: ${items.join("; ")}.` : "";
    return normalizeText(`${lead} ${details}`.trim(), 340);
  }

  const cleanedLines = [];
  for (const rawLine of splitReadableLines(sourceText)) {
    const line = normalizeText(rawLine, 280).replace(/^lyrics\s*:\s*/i, "").trim();
    if (!line || isNoiseLine(line)) {
      continue;
    }
    if (looksLikeUiNoise(line)) {
      continue;
    }
    if (cleanedLines[cleanedLines.length - 1]?.toLowerCase() === line.toLowerCase()) {
      continue;
    }
    cleanedLines.push(line);
  }

  const excerpt = pageType === "lyrics"
    ? cleanedLines.slice(0, 4).join(" ")
    : cleanedLines.slice(0, 3).join(" ");
  return normalizeText(excerpt || raw.snippet, 340);
}

export function buildStructuredSummary(raw, pageType = inferPageType(raw), facts = buildStructuredFacts(raw, pageType)) {
  const site = hostnameFromUrl(raw.url || "") || normalizeText(raw.domain) || "this site";
  const primaryFact = facts[0]?.value || primarySubject(raw);
  const documentLike = looksLikeDocumentResource(raw);
  const documentFormat = documentLike ? documentFormatLabel(raw) : "";
  const documentTitle = documentLike
    ? normalizeDocumentTitle(raw.title || raw.pageTitle || primaryFact, raw.url)
    : "";

  if (pageType === "lyrics") {
    const song = facts.find((fact) => fact.label === "Song")?.value || primaryFact;
    const artist = facts.find((fact) => fact.label === "Artist")?.value || "";
    if (song && artist) {
      return `Lyrics page for "${song}" by ${artist}.`;
    }
    if (song) {
      return `Lyrics page for "${song}".`;
    }
    return `Lyrics page on ${site}.`;
  }

  if (pageType === "search") {
    const query = facts.find((fact) => fact.label === "Query")?.value || "";
    const engine = facts.find((fact) => fact.label === "Engine")?.value || searchEngineName(site) || "Search";
    return query ? `${engine} search results for "${query}".` : `${engine} search results on ${site}.`;
  }

  if (pageType === "docs") {
    if (documentLike && documentTitle && documentFormat) {
      return `${documentFormat} document: ${documentTitle}.`;
    }
    if (documentLike && documentTitle) {
      return `Document: ${documentTitle}.`;
    }
    return primaryFact ? `Documentation page about ${primaryFact}.` : `Documentation page on ${site}.`;
  }

  if (pageType === "qa") {
    return primaryFact ? `Question and answer page about ${primaryFact}.` : `Question and answer page on ${site}.`;
  }

  if (pageType === "discussion") {
    return primaryFact ? `Discussion page about ${primaryFact}.` : `Discussion page on ${site}.`;
  }

  if (pageType === "video") {
    return primaryFact ? `Video page about ${primaryFact}.` : `Video page on ${site}.`;
  }

  if (pageType === "repo") {
    return primaryFact ? `Repository page for ${primaryFact}.` : `Repository page on ${site}.`;
  }

  if (pageType === "product") {
    return primaryFact ? `Product page for ${primaryFact}.` : `Product page on ${site}.`;
  }

  if (pageType === "chat") {
    return primaryFact ? `Chat page about ${primaryFact}.` : `Chat page on ${site}.`;
  }

  if (pageType === "social") {
    return primaryFact ? `Social page about ${primaryFact}.` : `Social page on ${site}.`;
  }

  if (pageType === "article") {
    return primaryFact ? `Article about ${primaryFact}.` : `Article on ${site}.`;
  }

  return primaryFact ? `Saved page about ${primaryFact}.` : `Saved page on ${site}.`;
}

function buildDisplayUrl(url, pageType = inferPageType({ url })) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./i, "");
    if (pageType === "search") {
      const query = extractQueryValue(url);
      return query ? `${host}${parsed.pathname}?q=${query}` : `${host}${parsed.pathname}`;
    }
    return `${host}${parsed.pathname}${parsed.hash || ""}`;
  } catch {
    return normalizeText(url, 180);
  }
}

function buildDisplayFullText(raw, pageType = inferPageType(raw)) {
  const fullText = normalizeRichText(raw.fullText || raw.full_text || raw.snippet, 0);
  if (!fullText) {
    return "";
  }

  if (pageType === "search") {
    const query = extractQueryValue(raw.url || "");
    const engine = searchEngineName(raw.url || raw.domain);
    const items = extractSearchResultItems(raw);
    const lines = [];

    if (query) {
      lines.push(`Query: ${query}`);
    }
    if (engine) {
      lines.push(`Search engine: ${engine}`);
    }
    if (items.length) {
      lines.push("Captured results:");
      items.forEach((item, index) => {
        lines.push(`${index + 1}. ${item}`);
      });
    } else {
      const fallbackLines = splitReadableLines(fullText)
        .filter((line) => !isNoiseLine(line))
        .slice(0, 6);
      if (fallbackLines.length) {
        lines.push("Captured page text:");
        fallbackLines.forEach((line, index) => {
          lines.push(`${index + 1}. ${line}`);
        });
      } else {
        lines.push("No clean result cards were captured.");
      }
    }
    return lines.join("\n");
  }

  return splitReadableLines(fullText).join("\n");
}

function chooseSubject({ selection, entities, topics, h1, title, domain, pageType, url }) {
  const preferred = [
    usefulCandidate(selection),
    entities[0],
    topics[0],
    usefulCandidate(h1),
    splitHeadlineSafe(title)[0],
    domain,
  ].filter(Boolean);
  const subject = preferred[0] || "";
  if (pageType === "search") {
    return extractQueryValue(url) || subject;
  }
  if (isSearchEngineHomePage({ url, title, pageTitle: title })) {
    return "";
  }
  return subject;
}

function buildEntities({ title, h1, selection, description, keyphrases }) {
  return dedupeStrings(
    [
      ...extractQuotedPhrasesSafe(selection),
      ...extractQuotedPhrasesSafe(title),
      ...splitHeadlineSafe(selection),
      ...splitHeadlineSafe(h1),
      ...splitHeadlineSafe(title),
      ...extractPatternCandidates(selection),
      ...extractPatternCandidates(h1),
      ...extractPatternCandidates(title),
      ...extractPatternCandidates(description),
      ...(keyphrases || []).map((phrase) => usefulCandidate(phrase)),
    ].filter(Boolean),
    8
  );
}

function buildContextText({ subject, entities, topics, factItems, structuredSummary, pageTypeLabelValue }) {
  return [
    subject,
    entities.join(" "),
    topics.join(" "),
    factItems.map((item) => `${item.label} ${item.value}`).join(" "),
    structuredSummary,
    pageTypeLabelValue,
  ]
    .filter(Boolean)
    .join(" ")
    .trim();
}

function quoteForQuestion(value) {
  const text = normalizeText(value, 120);
  if (!text) {
    return "";
  }
  if (/^".+"$/.test(text)) {
    return text;
  }
  return `"${text}"`;
}

export function buildSuggestionQueries(raw, options = {}) {
  const profile = raw?.pageType ? raw : extractContextProfile(raw);
  const suggestions = [];
  const add = (query, category) => {
    const normalized = normalizeText(query, 180);
    if (!normalized) {
      return;
    }
    if (!suggestions.some((item) => item.query.toLowerCase() === normalized.toLowerCase())) {
      suggestions.push({ query: normalized, category });
    }
  };

  const quotedTitle = profile.title ? quoteForQuestion(profile.title) : "";
  const quotedSubject = profile.subject ? quoteForQuestion(profile.subject) : "";
  const allowTopicSuggestions =
    profile.captureIntent?.captureMode !== "metadata" &&
    !profile.clutterAudit?.shouldSkip &&
    (profile.clutterAudit?.organizationScore ?? 1) >= 0.34;

  if (quotedTitle && profile.title.length <= 120) {
    add(profile.title, "Recent page");
  }

  if (allowTopicSuggestions && quotedSubject && quotedSubject.toLowerCase() !== quotedTitle.toLowerCase()) {
    add(profile.subject, "Recent topic");
  }

  const entity = profile.entities.find(
    (value) =>
      value &&
      quoteForQuestion(value).toLowerCase() !== quotedSubject.toLowerCase() &&
      quoteForQuestion(value).toLowerCase() !== quotedTitle.toLowerCase()
  );
  if (allowTopicSuggestions && entity) {
    add(entity, "Recent topic");
  }

  if (profile.domain) {
    add(profile.domain, "Recent site");
  }

  if (profile.application) {
    add(toTitleCase(profile.application), "Recent app");
  }

  return suggestions.slice(0, options.limit || 6);
}

export function extractContextProfile(raw) {
  const stored = parseObjectValue(raw?.context_profile_json || raw?.contextProfile);
  const rawTitle = normalizeText(
    stored.title || raw?.title || raw?.pageTitle || raw?.window_title,
    160
  );
  const description = normalizeText(stored.description || raw?.description, 220);
  const h1 = normalizeText(stored.h1 || raw?.h1, 140);
  const selection = normalizeText(stored.selection || raw?.selection, 180);
  const snippet = normalizeText(stored.snippet || raw?.snippet || raw?.content_text, 320);
  const fullText = normalizeRichText(stored.fullText || raw?.fullText || raw?.full_text, 0);
  const url = normalizeText(stored.url || raw?.url);
  const documentLike = looksLikeDocumentResource({ title: rawTitle, pageTitle: rawTitle, url, description });
  const title = documentLike ? normalizeDocumentTitle(rawTitle, url) || rawTitle : rawTitle;
  const domain = hostnameFromUrl(url) || normalizeText(stored.domain || raw?.domain);
  const application = normalizeText(stored.application || raw?.application);
  const seededKeyphrases = dedupeStrings(
    [
      ...parseArrayValue(stored.keyphrases || []),
      ...parseArrayValue(raw?.keyphrases_json || raw?.keyphrases),
    ],
    12
  );

  const queryValue = extractQueryValue(url);
  const pageType = stored.pageType || inferPageType({ title, pageTitle: title, description, fullText, url, snippet });
  const skipShell = isSearchEngineHomePage({ url, title, pageTitle: title, description, snippet, fullText });
  const seededEntities =
    pageType === "search"
      ? queryValue
        ? [queryValue]
        : []
      : documentLike
        ? []
      : [...parseArrayValue(stored.entities || []), ...buildEntities({ title, h1, selection, description, keyphrases: seededKeyphrases })];
  const entities = skipShell ? [] : dedupeStrings(seededEntities, 8);
  const seededTopics =
    pageType === "search"
      ? queryValue
        ? [queryValue]
        : []
      : documentLike
        ? []
      : [...parseArrayValue(stored.topics || []), ...buildTopics({ title, h1, selection, description, snippet, fullText, keyphrases: seededKeyphrases, entities })];
  const topics = skipShell ? [] : dedupeStrings(seededTopics, 8);
  const subject = skipShell
    ? ""
    : usefulCandidate(
        (documentLike ? title : "") ||
          stored.subject ||
          chooseSubject({ selection, entities, topics, h1, title, domain, pageType, url })
      );
  const pageTypeLabelValue = pageTypeLabel(pageType);
  const factItems = buildStructuredFacts({ title, url, domain, subject, entities, topics, fullText }, pageType);
  const structuredSummary = buildStructuredSummary({ title, url, domain, subject, entities, topics, fullText }, pageType, factItems);
  const displayExcerpt = buildDisplayExcerpt({ url, domain, fullText, snippet }, pageType);
  const displayUrl = buildDisplayUrl(url, pageType);
  const displayFullText = buildDisplayFullText({ url, domain, snippet, fullText }, pageType);
  const searchResults = pageType === "search" ? extractSearchResultItems({ url, snippet, fullText }) : [];
  const captureIntent =
    stored.captureIntent && typeof stored.captureIntent === "object"
      ? stored.captureIntent
      : raw?.captureIntent && typeof raw.captureIntent === "object"
        ? raw.captureIntent
        : null;
  const clutterAudit =
    stored.clutterAudit && typeof stored.clutterAudit === "object"
      ? stored.clutterAudit
      : raw?.clutterAudit && typeof raw.clutterAudit === "object"
        ? raw.clutterAudit
        : null;
  const contextText = buildContextText({
    subject,
    entities,
    topics,
    factItems,
    structuredSummary,
    pageTypeLabelValue,
  });

  return {
    version: 1,
    title,
    description,
    h1,
    selection,
    snippet,
    fullText,
    url,
    domain,
    application,
    keyphrases: seededKeyphrases,
    pageType,
    pageTypeLabel: pageTypeLabelValue,
    entities,
    topics,
    subject,
    factItems,
    structuredSummary,
    displayExcerpt,
    displayUrl,
    displayFullText,
    rawFullText: fullText,
    searchResults,
    contextText,
    captureIntent,
    clutterAudit,
    localJudge: stored.localJudge || raw?.localJudge || null,
  };
}

export function shouldSkipCaptureProfile(profileOrRaw) {
  const profile =
    profileOrRaw && typeof profileOrRaw === "object" && "pageType" in profileOrRaw
      ? profileOrRaw
      : extractContextProfile(profileOrRaw);

  if (!profile.url) {
    return true;
  }

  if (profile.localJudge?.shouldSkip) {
    return true;
  }

  if (profile.captureIntent?.shouldSkip) {
    return true;
  }

  if (profile.clutterAudit?.shouldSkip) {
    return true;
  }

  if (isSearchEngineHomePage(profile)) {
    return true;
  }

  const lowValueText = normalizeText(
    [profile.subject, profile.displayExcerpt, profile.snippet].filter(Boolean).join(" "),
    400
  ).toLowerCase();

  if (
    SEARCH_ENGINE_DOMAINS.has(profile.domain) &&
    !extractQueryValue(profile.url) &&
    (!lowValueText || SEARCH_HOME_NOISE_PATTERNS.some((pattern) => pattern.test(lowValueText)))
    ) {
    return true;
  }

  if (
    profile.captureIntent?.captureMode === "metadata" &&
    profile.clutterAudit?.clutterScore >= 0.78 &&
    !extractQueryValue(profile.url)
  ) {
    return true;
  }

  return false;
}
