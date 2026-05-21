import {
  buildSuggestionQueries,
  extractContextProfile,
  shouldSkipCaptureProfile,
} from "./context-pipeline.js";
import { classifyLocalPage } from "./page-intelligence.js";
import { evaluateSelectiveMemory } from "./selective-memory.js";

const SESSION_TIMEOUT_MS = 25 * 60 * 1000;
const SESSION_MAX_GAP_MS = 45 * 60 * 1000;
const SESSION_SEMANTIC_THRESHOLD = 0.18;
const CHAIN_WINDOW_MS = 45 * 60 * 1000;
const CHAIN_THRESHOLD = 0.22;
const EVENT_GRAPH_WINDOW_MS = 45 * 60 * 1000;
const EVENT_GRAPH_THRESHOLD = 0.34;
const EVENT_GRAPH_MAX_NEIGHBORS = 6;
const TOP_KEYPHRASES = 6;

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "how", "i", "in",
  "is", "it", "me", "my", "of", "on", "or", "show", "that", "the", "this", "to", "was",
  "what", "when", "where", "why", "with", "you",
]);

const BROWSER_APPS = new Set(["chrome", "edge", "msedge", "brave", "opera", "vivaldi", "firefox"]);
const TERMINAL_APPS = new Set(["terminal", "windows terminal", "powershell", "pwsh", "cmd"]);
const EDITOR_APPS = new Set(["code", "cursor", "codex", "pycharm", "idea", "webstorm"]);
const DOC_DOMAINS = new Set([
  "docs.python.org",
  "developer.mozilla.org",
  "readthedocs.io",
  "learn.microsoft.com",
  "stackoverflow.com",
]);
const AI_DOMAINS = new Set(["chatgpt.com", "claude.ai"]);
const SEARCH_ENGINE_DOMAINS = new Set([
  "google.com",
  "bing.com",
  "duckduckgo.com",
  "search.brave.com",
  "search.yahoo.com",
]);
const SOCIAL_DOMAINS = new Set([
  "twitter.com",
  "x.com",
  "linkedin.com",
  "instagram.com",
  "facebook.com",
  "threads.net",
]);
const COMMERCE_DOMAINS = new Set([
  "amazon.com",
  "flipkart.com",
  "ebay.com",
  "etsy.com",
]);
const PAGE_TYPE_LABELS = {
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

function compactText(value, maxLength = 220) {
  return normalizeText(value, maxLength);
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

function cleanAppName(value) {
  const normalized = normalizeText(value).replace(/\.exe$/i, "");
  return normalized || "Browser";
}

function toTitleCase(value) {
  return String(value || "")
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function hostnameFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    return "";
  }
}

function urlDetails(url) {
  try {
    const parsed = new URL(url);
    return {
      hostname: parsed.hostname.replace(/^www\./i, "").toLowerCase(),
      port: parsed.port || "",
      pathname: parsed.pathname || "/",
    };
  } catch {
    return {
      hostname: "",
      port: "",
      pathname: "/",
    };
  }
}

function canonicalUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    parsed.search = "";
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`.toLowerCase();
  } catch {
    return normalizeText(url).toLowerCase();
  }
}

function parseArrayValue(raw) {
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

function parseKeyphrases(rawEvent) {
  return parseArrayValue(rawEvent.keyphrases_json || rawEvent.keyphrases)
    .map((value) => normalizeText(value, 80))
    .filter(Boolean);
}

function parseEmbedding(rawEvent) {
  return parseArrayValue(rawEvent.embedding_json)
    .map((value) => Number(value) || 0)
    .filter((value) => Number.isFinite(value));
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

function meaningfulTokens(text) {
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

function averageVector(vectors) {
  if (!vectors.length) {
    return [];
  }
  const maxLength = Math.max(...vectors.map((vector) => vector.length || 0), 0);
  if (!maxLength) {
    return [];
  }
  const total = new Array(maxLength).fill(0);
  for (const vector of vectors) {
    for (let index = 0; index < vector.length; index += 1) {
      total[index] += Number(vector[index] || 0);
    }
  }
  const averaged = total.map((value) => value / Math.max(vectors.length, 1));
  let norm = 0;
  for (const value of averaged) {
    norm += value * value;
  }
  norm = Math.sqrt(norm) || 1;
  return averaged.map((value) => value / norm);
}

function overlapCount(left, right) {
  if (!left?.length || !right?.length) {
    return 0;
  }
  const rightSet = new Set(right.map((value) => String(value).toLowerCase()));
  return left.reduce(
    (total, value) => total + (rightSet.has(String(value).toLowerCase()) ? 1 : 0),
    0
  );
}

function tokenCoverage(tokens, haystackText) {
  if (!tokens.length) {
    return 0;
  }
  const haystack = normalizeText(haystackText).toLowerCase();
  if (!haystack) {
    return 0;
  }
  let hits = 0;
  for (const token of tokens) {
    if (haystack.includes(token)) {
      hits += 1;
    }
  }
  return hits / Math.max(tokens.length, 1);
}

function shortLabel(value, maxLength = 48) {
  const text = normalizeText(value);
  if (!text) {
    return "this session";
  }
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 1).trim()}...`;
}

function overlapRatio(left, right) {
  if (!left?.length || !right?.length) {
    return 0;
  }
  const leftSet = new Set(left.map((value) => normalizeText(value).toLowerCase()).filter(Boolean));
  const rightSet = new Set(right.map((value) => normalizeText(value).toLowerCase()).filter(Boolean));
  if (!leftSet.size || !rightSet.size) {
    return 0;
  }
  let hits = 0;
  for (const value of leftSet) {
    if (rightSet.has(value)) {
      hits += 1;
    }
  }
  return hits / Math.max(1, Math.min(leftSet.size, rightSet.size));
}

function quoteLabel(value) {
  const text = normalizeText(value, 120).replace(/^["']|["']$/g, "");
  return text ? `"${text}"` : `"this session"`;
}

function pluralize(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function ensureSentence(value) {
  const text = normalizeText(value, 320).replace(/\s+/g, " ").trim();
  if (!text) {
    return "";
  }
  if (/[.!?]$/.test(text)) {
    return text;
  }
  return `${text}.`;
}

function countTokenHits(tokens, haystackText) {
  if (!tokens.length) {
    return 0;
  }
  const haystack = normalizeText(haystackText).toLowerCase();
  if (!haystack) {
    return 0;
  }
  let hits = 0;
  for (const token of tokens) {
    if (haystack.includes(token)) {
      hits += 1;
    }
  }
  return hits;
}

function genericPageTitle(title, domain = "") {
  const normalizedTitle = normalizeText(title, 160).toLowerCase();
  const normalizedDomain = normalizeText(domain, 160).toLowerCase();
  if (!normalizedTitle) {
    return true;
  }
  if (normalizedDomain && (normalizedTitle === normalizedDomain || normalizedTitle === normalizedDomain.replace(/^www\./, ""))) {
    return true;
  }
  return [
    "google",
    "bing",
    "duckduckgo",
    "search",
    "search results",
    "home",
    "new tab",
    "untitled",
  ].includes(normalizedTitle);
}

function factText(event) {
  return [
    ...(event.fact_items || []).map((item) => `${item.label} ${item.value}`),
    ...((event.capture_packet?.points || []).map((item) => String(item || ""))),
  ]
    .filter(Boolean)
    .join(" ");
}

function derivativeText(event) {
  return [
    ...(event.derivative_items || []).map((item) => `${item.label || ""} ${item.text || ""}`),
    ...((event.capture_packet?.blocks || []).map((block) => `${block.label || ""} ${block.text || ""}`)),
  ]
    .filter(Boolean)
    .join(" ");
}

function exactFactMatch(event, anchor) {
  return (
    exactIncludes(factText(event), anchor) ||
    (event.fact_items || []).some((item) => exactIncludes(item.value, anchor))
  );
}

function exactSearchQueryMatch(event, anchor) {
  return exactIncludes(eventSearchQuery(event), anchor);
}

function hasStrongExactSignal(event, anchor) {
  return (
    exactIncludes(event.context_subject, anchor) ||
    exactIncludes(event.title, anchor) ||
    exactFactMatch(event, anchor) ||
    exactIncludes(derivativeText(event), anchor) ||
    exactSearchQueryMatch(event, anchor)
  );
}

function isLowValueEvent(event) {
  const qualityLabel = normalizeText(event.local_judge?.qualityLabel).toLowerCase();
  const captureMode = normalizeText(event.capture_intent?.captureMode).toLowerCase();
  const pageType = normalizeText(event.page_type).toLowerCase();
  const clutterScore = Number(event.clutter_audit?.clutterScore || 0);
  const organizationScore = Number(event.clutter_audit?.organizationScore || 0);
  const subject = normalizeText(event.context_subject, 140);
  const excerptLength = normalizeText(event.display_excerpt || event.snippet, 0).length;
  const fullTextLength = normalizeRichText(event.display_full_text || event.full_text || "", 0).length;

  if (qualityLabel === "shell") {
    return true;
  }
  if (clutterScore >= 0.84) {
    return true;
  }
  if (captureMode === "metadata" && clutterScore >= 0.42) {
    return true;
  }
  if (pageType === "web" && !subject && excerptLength < 140 && fullTextLength < 260) {
    return true;
  }
  if (pageType === "web" && genericPageTitle(event.title, event.domain) && fullTextLength < 420) {
    return true;
  }
  if (organizationScore <= 0.18 && excerptLength < 120 && fullTextLength < 220) {
    return true;
  }
  return false;
}

function isMeaningfulDirectEvent(event) {
  if (isSearchResultsPage(event) || isLowValueEvent(event)) {
    return false;
  }
  if (normalizeText(event.local_judge?.qualityLabel).toLowerCase() === "meaningful") {
    return true;
  }
  if ([
    "article",
    "docs",
    "discussion",
    "qa",
    "repo",
    "video",
    "product",
    "chat",
    "social",
    "lyrics",
  ].includes(normalizeText(event.page_type).toLowerCase())) {
    return true;
  }
  return Boolean(
    normalizeText(event.context_subject) ||
      (event.fact_items || []).length >= 2 ||
      normalizeRichText(event.display_full_text || event.full_text || "", 0).length >= 320
  );
}

function normalizeEvent(rawEvent) {
  const application = cleanAppName(rawEvent.application);
  const domain = hostnameFromUrl(rawEvent.url);
  const title =
    normalizeText(rawEvent.window_title || rawEvent.title || rawEvent.pageTitle, 160) ||
    domain ||
    "Local memory";
  const snippet = compactText(
    rawEvent.content_text || rawEvent.snippet || rawEvent.searchable_text || rawEvent.full_text,
    320
  );
  const fullText = normalizeRichText(rawEvent.full_text, 0);
  const keyphrases = parseKeyphrases(rawEvent);
  const embedding = parseEmbedding(rawEvent);
  const occurredAt = String(rawEvent.occurred_at || "");
  const timestamp = Date.parse(occurredAt);
  const contextProfile = extractContextProfile({
    url: rawEvent.url,
    application,
    pageTitle: title,
    description: rawEvent.description,
    h1: rawEvent.h1,
    selection: rawEvent.selection,
    snippet,
    fullText,
    keyphrases,
    context_profile_json: rawEvent.context_profile_json,
    selective_memory_json: rawEvent.selective_memory_json,
  });
  if (!contextProfile.selectiveMemory) {
    contextProfile.selectiveMemory = evaluateSelectiveMemory(contextProfile, {
      interactionType: rawEvent.interaction_type,
    });
  }
  const capturePacket = parseObjectValue(rawEvent.capture_packet_json || rawEvent.capturePacket);
  if (capturePacket && Object.keys(capturePacket).length) {
    contextProfile.capturePacket = capturePacket;
  }

  return {
    ...rawEvent,
    application,
    domain,
    title: contextProfile.title || title,
    snippet: contextProfile.snippet || snippet,
    full_text: contextProfile.fullText || fullText,
    display_url: contextProfile.displayUrl || canonicalUrl(rawEvent.url || ""),
    display_full_text: contextProfile.displayFullText || contextProfile.fullText || fullText,
    raw_full_text: fullText,
    search_results: contextProfile.searchResults || [],
    derivative_items: contextProfile.derivativeItems || [],
    keyphrases: contextProfile.keyphrases?.length ? contextProfile.keyphrases : keyphrases,
    embedding,
    occurred_at: occurredAt,
    timestamp: Number.isFinite(timestamp) ? timestamp : 0,
    titleTokens: meaningfulTokens(contextProfile.title || title),
    page_type: contextProfile.pageType,
    page_type_label: contextProfile.pageTypeLabel,
    structured_summary: contextProfile.structuredSummary,
    display_excerpt: contextProfile.displayExcerpt,
    fact_items: contextProfile.factItems || [],
    context_subject: contextProfile.subject || "",
    context_entities: contextProfile.entities || [],
    context_topics: contextProfile.topics || [],
    context_text: contextProfile.contextText || "",
    context_profile: contextProfile,
    capture_packet: capturePacket && Object.keys(capturePacket).length ? capturePacket : contextProfile.capturePacket || null,
    capture_intent: contextProfile.captureIntent || null,
    clutter_audit: contextProfile.clutterAudit || null,
    local_judge: contextProfile.localJudge || null,
    selective_memory: contextProfile.selectiveMemory || null,
    canonicalFingerprint: [
      canonicalUrl(rawEvent.url || ""),
      (contextProfile.title || title).toLowerCase(),
      (contextProfile.displayExcerpt || contextProfile.snippet || snippet).slice(0, 120).toLowerCase(),
    ].filter(Boolean).join("|"),
  };
}

function isInternalMemactEvent(event) {
  const details = urlDetails(event.url || "");
  const title = normalizeText(event.title || event.window_title || "", 200).toLowerCase();
  const isLocalHost =
    details.hostname === "localhost" ||
    details.hostname === "127.0.0.1" ||
    details.hostname === "0.0.0.0" ||
    details.hostname === "::1";

  if (details.hostname === "memact.com") {
    return true;
  }

  if (isLocalHost && (details.port === "5173" || details.port === "4173" || title.includes("memact"))) {
    return true;
  }

  return false;
}

function isSearchResultsPage(event) {
  const domain = String(event.domain || "").toLowerCase();
  if (!SEARCH_ENGINE_DOMAINS.has(domain)) {
    return false;
  }

  const url = String(event.url || "").toLowerCase();
  return (
    url.includes("/search") ||
    url.includes("?q=") ||
    url.includes("&q=") ||
    url.includes("?p=") ||
    url.includes("&p=")
  );
}

function pageTypeLabel(pageType) {
  return PAGE_TYPE_LABELS[pageType] || PAGE_TYPE_LABELS.web;
}

function cleanTopic(value) {
  return normalizeText(value, 140)
    .replace(/\s+/g, " ")
    .replace(/\b(home|official site)\b/gi, "")
    .replace(/\s+\|\s+.*$/, "")
    .trim();
}

function extractQueryFromEvent(event) {
  try {
    const parsed = new URL(event.url || "");
    const candidates = [
      parsed.searchParams.get("q"),
      parsed.searchParams.get("p"),
      parsed.searchParams.get("query"),
      parsed.searchParams.get("text"),
      parsed.searchParams.get("search_query"),
    ]
      .map((value) => normalizeText(value, 120))
      .filter(Boolean);
    return candidates[0] || "";
  } catch {
    return "";
  }
}

function inferPageType(event) {
  const details = urlDetails(event.url || "");
  const titleLower = normalizeText(event.title, 200).toLowerCase();
  const bodyLower = normalizeText(event.full_text, 4000).toLowerCase();

  if (isSearchResultsPage(event)) {
    return "search";
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
    bodyLower.includes("api reference")
  ) {
    return "docs";
  }
  if (
    AI_DOMAINS.has(details.hostname) ||
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
  if (event.full_text.length >= 700 || titleLower.includes("how to") || titleLower.includes("guide")) {
    return "article";
  }
  return "web";
}

function parseLyricsFacts(event) {
  const cleanedTitle = normalizeText(event.title, 160)
    .replace(/\((official )?lyrics?\)/gi, "")
    .replace(/\[(official )?lyrics?\]/gi, "")
    .trim();
  const parts = cleanedTitle.split(/\s+-\s+/).map((part) => normalizeText(part, 100)).filter(Boolean);
  const song = parts[0] || "";
  const artist = parts[1] || "";
  return { song, artist };
}

function primaryTopic(event) {
  const title = cleanTopic(event.title);
  if (title && title.length <= 120) {
    return title;
  }
  const phrase = normalizeText(event.keyphrases?.[0], 100);
  if (phrase) {
    return phrase;
  }
  return cleanTopic(event.domain || "");
}

function buildStructuredFacts(event, pageType) {
  const facts = [];

  if (pageType === "lyrics") {
    const { song, artist } = parseLyricsFacts(event);
    if (song) facts.push({ label: "Song", value: song });
    if (artist) facts.push({ label: "Artist", value: artist });
  } else if (pageType === "search") {
    const query = extractQueryFromEvent(event);
    if (query) facts.push({ label: "Query", value: query });
  } else if (pageType === "docs") {
    const topic = primaryTopic(event);
    if (topic) facts.push({ label: "Topic", value: topic });
  } else if (pageType === "qa") {
    const topic = primaryTopic(event);
    if (topic) facts.push({ label: "Question", value: topic });
  } else if (pageType === "discussion") {
    const topic = primaryTopic(event);
    if (topic) facts.push({ label: "Topic", value: topic });
  } else if (pageType === "video") {
    const topic = primaryTopic(event);
    if (topic) facts.push({ label: "Video", value: topic });
  } else if (pageType === "product") {
    const topic = primaryTopic(event);
    if (topic) facts.push({ label: "Product", value: topic });
  } else if (pageType === "chat") {
    const topic = primaryTopic(event);
    if (topic) facts.push({ label: "Topic", value: topic });
  } else {
    const topic = primaryTopic(event);
    if (topic) facts.push({ label: "Topic", value: topic });
  }

  const focus = normalizeText(event.keyphrases?.[0], 80);
  if (focus && !facts.some((fact) => fact.value.toLowerCase() === focus.toLowerCase())) {
    facts.push({ label: "Focus", value: focus });
  }

  return facts.slice(0, 3);
}

function buildStructuredSummary(event, pageType, facts) {
  const site = event.domain || "this site";
  const firstFact = facts[0]?.value || "";

  if (pageType === "lyrics") {
    const song = facts.find((fact) => fact.label === "Song")?.value || firstFact;
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
    return query ? `Search results page for "${query}".` : `Search results page on ${site}.`;
  }

  if (pageType === "docs") {
    return firstFact ? `Documentation page about ${firstFact}.` : `Documentation page on ${site}.`;
  }

  if (pageType === "qa") {
    return firstFact ? `Question and answer page about ${firstFact}.` : `Question and answer page on ${site}.`;
  }

  if (pageType === "discussion") {
    return firstFact ? `Discussion page about ${firstFact}.` : `Discussion page on ${site}.`;
  }

  if (pageType === "video") {
    return firstFact ? `Video page for ${firstFact}.` : `Video page on ${site}.`;
  }

  if (pageType === "repo") {
    return firstFact ? `Repository page about ${firstFact}.` : `Repository page on ${site}.`;
  }

  if (pageType === "product") {
    return firstFact ? `Product page for ${firstFact}.` : `Product page on ${site}.`;
  }

  if (pageType === "chat") {
    return firstFact ? `Chat page about ${firstFact}.` : `Chat page on ${site}.`;
  }

  if (pageType === "social") {
    return firstFact ? `Social page about ${firstFact}.` : `Social page on ${site}.`;
  }

  return firstFact ? `Saved page about ${firstFact}.` : `Saved page on ${site}.`;
}

function isNoiseLine(line) {
  const lower = line.toLowerCase();
  if (!lower) {
    return true;
  }
  if (/^[\-=*_#|.]{6,}$/.test(line)) {
    return true;
  }
  if (/(click the bell|subscribe|background picture by|contact\/submissions|official site|follow us|stream now|sponsored|advertisement|loading public)/i.test(lower)) {
    return true;
  }
  if (/(this summary was generated by ai|based on sources|learn more about bing search results)/i.test(lower)) {
    return true;
  }
  if (/https?:\/\/\S+/i.test(line) && line.length < 180) {
    return true;
  }
  if (/@/.test(line) && lower.includes("contact")) {
    return true;
  }
  return false;
}

function buildDisplayExcerpt(event, pageType) {
  const sourceText = normalizeRichText(event.full_text || event.snippet, 0);
  if (!sourceText) {
    return "";
  }

  const cleanedLines = [];
  for (const rawLine of sourceText.split(/\n+/)) {
    let line = normalizeText(rawLine, 280);
    if (!line) {
      continue;
    }
    line = line.replace(/^lyrics\s*:\s*/i, "").trim();
    if (!line || isNoiseLine(line)) {
      continue;
    }
    if (cleanedLines[cleanedLines.length - 1]?.toLowerCase() === line.toLowerCase()) {
      continue;
    }
    cleanedLines.push(line);
  }

  if (!cleanedLines.length) {
    return compactText(event.snippet, 320);
  }

  const excerpt = pageType === "lyrics"
    ? cleanedLines.slice(0, 4).join(" ")
    : cleanedLines.slice(0, 3).join(" ");
  return compactText(excerpt, 340);
}

function sessionMode(events) {
  const browserish = events.filter((event) => event.domain).length;
  const codingish = events.filter((event) => EDITOR_APPS.has(event.application.toLowerCase())).length;
  if (codingish >= Math.max(1, Math.floor(events.length / 3))) {
    return "coding";
  }
  if (browserish >= Math.max(1, Math.floor(events.length / 2))) {
    return "reading";
  }
  return "memory";
}

function topKeyphrases(events, limit = TOP_KEYPHRASES) {
  const counts = new Map();
  for (const event of events) {
    for (const phrase of event.keyphrases || []) {
      const normalized = normalizeText(phrase, 80);
      if (!normalized) {
        continue;
      }
      counts.set(normalized, (counts.get(normalized) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit)
    .map(([phrase]) => phrase);
}

function buildSessionLabel(events, keyphrases) {
  const mode = sessionMode(events);
  if (keyphrases.length) {
    const lead = keyphrases[0];
    if (mode === "coding") {
      return compactText(`Working on ${lead}`, 64);
    }
    if (mode === "reading") {
      return compactText(`Reading about ${lead}`, 64);
    }
    return compactText(`Exploring ${lead}`, 64);
  }

  const domainCounts = new Map();
  const appCounts = new Map();
  for (const event of events) {
    if (event.domain) {
      domainCounts.set(event.domain, (domainCounts.get(event.domain) || 0) + 1);
    }
    if (event.application) {
      appCounts.set(event.application, (appCounts.get(event.application) || 0) + 1);
    }
  }
  const topDomain = [...domainCounts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] || "";
  const topApp = [...appCounts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] || "";

  if (topDomain && mode === "coding") {
    return compactText(`Coding from ${topDomain}`, 64);
  }
  if (topDomain) {
    return compactText(`Research in ${topDomain}`, 64);
  }
  if (topApp) {
    return compactText(`Using ${toTitleCase(topApp)}`, 64);
  }
  return "Local memory session";
}

function sessionContinuity(event, session, cosineSimilarity) {
  const gap = event.timestamp - session.endedTimestamp;
  if (gap < 0 || gap > SESSION_MAX_GAP_MS) {
    return false;
  }
  if (gap <= 8 * 60 * 1000) {
    return true;
  }

  const semantic = event.embedding.length && session.embedding.length
    ? cosineSimilarity(event.embedding, session.embedding)
    : 0;
  const sameDomain = event.domain && session.domains.has(event.domain);
  const sameApp = event.application && session.applications.has(event.application);
  const phraseOverlap = overlapCount(event.keyphrases, session.keyphrases) > 0;
  const titleOverlap = overlapCount(event.titleTokens, [...session.titleTokens]) > 0;

  if (gap > SESSION_TIMEOUT_MS) {
    return sameDomain && phraseOverlap;
  }
  return semantic >= SESSION_SEMANTIC_THRESHOLD || sameDomain || sameApp || phraseOverlap || titleOverlap;
}

function buildSessions(events, cosineSimilarity) {
  const ordered = [...events].sort((left, right) => left.timestamp - right.timestamp || left.id - right.id);
  const sessions = [];
  const eventToSession = new Map();
  let current = null;

  const finalizeCurrent = () => {
    if (!current || !current.events.length) {
      return;
    }
    current.keyphrases = topKeyphrases(current.events);
    current.label = buildSessionLabel(current.events, current.keyphrases);
    current.mode = sessionMode(current.events);
    current.foundationalEvents = [...current.events]
      .sort((left, right) => left.timestamp - right.timestamp)
      .slice(0, Math.min(2, current.events.length));
    sessions.push(current);
  };

  for (const event of ordered) {
    if (!current) {
      current = {
        id: sessions.length + 1,
        events: [event],
        started_at: event.occurred_at,
        ended_at: event.occurred_at,
        startedTimestamp: event.timestamp,
        endedTimestamp: event.timestamp,
        embedding: event.embedding,
        keyphrases: [...event.keyphrases],
        applications: new Set(event.application ? [event.application] : []),
        domains: new Set(event.domain ? [event.domain] : []),
        titleTokens: new Set(event.titleTokens || []),
      };
      eventToSession.set(event.id, current.id);
      continue;
    }

    if (!sessionContinuity(event, current, cosineSimilarity)) {
      finalizeCurrent();
      current = {
        id: sessions.length + 1,
        events: [event],
        started_at: event.occurred_at,
        ended_at: event.occurred_at,
        startedTimestamp: event.timestamp,
        endedTimestamp: event.timestamp,
        embedding: event.embedding,
        keyphrases: [...event.keyphrases],
        applications: new Set(event.application ? [event.application] : []),
        domains: new Set(event.domain ? [event.domain] : []),
        titleTokens: new Set(event.titleTokens || []),
      };
      eventToSession.set(event.id, current.id);
      continue;
    }

    current.events.push(event);
    current.ended_at = event.occurred_at;
    current.endedTimestamp = event.timestamp;
    current.embedding = averageVector(current.events.map((item) => item.embedding));
    current.keyphrases = topKeyphrases(current.events);
    if (event.application) {
      current.applications.add(event.application);
    }
    if (event.domain) {
      current.domains.add(event.domain);
    }
    for (const token of event.titleTokens || []) {
      current.titleTokens.add(token);
    }
    eventToSession.set(event.id, current.id);
  }

  finalizeCurrent();
  return { sessions, eventToSession };
}

function isDocsSession(session) {
  if ([...session.domains].some((domain) => DOC_DOMAINS.has(domain))) {
    return true;
  }
  return [...session.domains].some(
    (domain) => domain.startsWith("docs.") || domain.includes("readthedocs") || domain.startsWith("developer.")
  );
}

function transitionPrior(source, target) {
  const sourceApps = [...source.applications].map((value) => value.toLowerCase());
  const sourceDomains = [...source.domains];
  const targetApps = [...target.applications].map((value) => value.toLowerCase());

  if (sourceDomains.some((domain) => AI_DOMAINS.has(domain)) && targetApps.some((app) => EDITOR_APPS.has(app))) {
    return { value: 0.3, type: "possible_transition" };
  }
  if (sourceDomains.includes("github.com") && targetApps.some((app) => EDITOR_APPS.has(app) || TERMINAL_APPS.has(app))) {
    return { value: 0.28, type: "possible_transition" };
  }
  if (sourceApps.some((app) => BROWSER_APPS.has(app)) && targetApps.some((app) => EDITOR_APPS.has(app) || TERMINAL_APPS.has(app))) {
    return { value: 0.22, type: "possible_transition" };
  }
  if (isDocsSession(source) && targetApps.some((app) => EDITOR_APPS.has(app))) {
    return { value: 0.24, type: "possible_transition" };
  }
  return { value: 0, type: "semantic" };
}

function buildSessionGraph(sessions, cosineSimilarity) {
  const ordered = [...sessions].sort((left, right) => left.startedTimestamp - right.startedTimestamp);
  const byId = new Map(ordered.map((session) => [session.id, session]));

  for (const session of ordered) {
    session.upstream = [];
    session.downstream = [];
    session.connected = [];
  }

  for (let index = 0; index < ordered.length; index += 1) {
    const source = ordered[index];
    for (let targetIndex = index + 1; targetIndex < ordered.length; targetIndex += 1) {
      const target = ordered[targetIndex];
      const gap = target.startedTimestamp - source.endedTimestamp;
      if (gap < 0) {
        continue;
      }
      if (gap > CHAIN_WINDOW_MS) {
        break;
      }

      const semantic = source.embedding.length && target.embedding.length
        ? cosineSimilarity(source.embedding, target.embedding)
        : 0;
      const phraseOverlap = overlapCount(source.keyphrases, target.keyphrases);
      const temporalBonus = gap <= 10 * 60 * 1000 && phraseOverlap > 0 ? 0.1 : 0;
      const prior = transitionPrior(source, target);
      const strength = Math.min(1, Math.max(0, semantic) + prior.value + temporalBonus + phraseOverlap * 0.04);

      if (!(semantic >= CHAIN_THRESHOLD || prior.value > 0 || temporalBonus > 0)) {
        continue;
      }

      source.downstream.push({
        session_id: target.id,
        label: target.label,
        started_at: target.started_at,
        strength,
        link_type: prior.type,
      });
      target.upstream.push({
        session_id: source.id,
        label: source.label,
        started_at: source.started_at,
        strength,
        link_type: prior.type,
      });
    }
  }

  for (const session of ordered) {
    session.upstream.sort((left, right) => right.strength - left.strength);
    session.downstream.sort((left, right) => right.strength - left.strength);
    session.connected = [...session.upstream, ...session.downstream]
      .sort((left, right) => right.strength - left.strength)
      .slice(0, 6);
  }

  return byId;
}

function eventGraphLabel(event) {
  return shortLabel(
    event.context_subject ||
      event.title ||
      event.domain ||
      event.application ||
      "Related memory",
    84
  );
}

function relationshipTypeLabel(type) {
  return toTitleCase(String(type || "").replace(/_/g, " "));
}

function lowerSet(values) {
  return new Set(
    (values || [])
      .map((value) => normalizeText(value, 120).toLowerCase())
      .filter(Boolean)
  );
}

function buildRelationshipReasonSummary(reasons) {
  return normalizeText(reasons.join(" - "), 220);
}

function classifyEventRelationship(source, target, semanticScore, gapMs) {
  const sameSession = Boolean(source.session_id && source.session_id === target.session_id);
  const sameDomain = Boolean(source.domain && target.domain && source.domain === target.domain);
  const sameApp = Boolean(
    source.application &&
      target.application &&
      source.application.toLowerCase() === target.application.toLowerCase()
  );
  const entityOverlap = overlapRatio(source.context_entities, target.context_entities);
  const topicOverlap = Math.max(
    overlapRatio(source.context_topics, target.context_topics),
    overlapRatio(source.keyphrases, target.keyphrases)
  );
  const temporalScore = Math.max(0, 1 - gapMs / EVENT_GRAPH_WINDOW_MS);
  const appDomainScore = sameDomain ? 1 : sameApp ? 0.72 : 0;

  let type = "task_continuation";
  let typedBonus = 0;
  const reasons = [];

  if (sameSession) {
    reasons.push("same session");
  }
  if (gapMs <= 8 * 60 * 1000) {
    reasons.push("close in time");
  }
  if (sameDomain) {
    reasons.push(`same site ${source.domain}`);
  }
  if (sameApp) {
    reasons.push(`same app ${toTitleCase(source.application)}`);
  }
  if (entityOverlap >= 0.5) {
    reasons.push("same entities");
  }
  if (topicOverlap >= 0.45) {
    reasons.push("same topics");
  }

  const sourceApp = (source.application || "").toLowerCase();
  const targetApp = (target.application || "").toLowerCase();
  const sourcePageType = normalizeText(source.page_type).toLowerCase();

  if (
    sourcePageType === "search" &&
    !isSearchResultsPage(target) &&
    gapMs <= 20 * 60 * 1000 &&
    (sameDomain || entityOverlap > 0 || topicOverlap > 0 || semanticScore >= 0.22)
  ) {
    type = "search_to_open";
    typedBonus = 0.18;
    reasons.push("search led to an opened page");
  } else if (
    ["docs", "qa"].includes(sourcePageType) &&
    (TERMINAL_APPS.has(targetApp) || EDITOR_APPS.has(targetApp)) &&
    gapMs <= 25 * 60 * 1000
  ) {
    type = "docs_to_command";
    typedBonus = 0.2;
    reasons.push("documentation led to action");
  } else if (
    ["article", "discussion", "qa", "docs"].includes(sourcePageType) &&
    (TERMINAL_APPS.has(targetApp) || EDITOR_APPS.has(targetApp)) &&
    gapMs <= 25 * 60 * 1000
  ) {
    type = "read_to_action";
    typedBonus = 0.18;
    reasons.push("reading led to action");
  } else if (
    TERMINAL_APPS.has(sourceApp) &&
    TERMINAL_APPS.has(targetApp) &&
    gapMs <= 12 * 60 * 1000
  ) {
    type = "task_continuation";
    typedBonus = 0.16;
    reasons.push("terminal task continued");
  } else if (sameSession && (sameApp || sameDomain || entityOverlap > 0 || topicOverlap > 0)) {
    type = "task_continuation";
    typedBonus = 0.14;
  } else if (entityOverlap >= 0.55) {
    type = "same_entity";
    typedBonus = 0.08;
  } else if (topicOverlap >= 0.5) {
    type = "same_topic";
    typedBonus = 0.07;
  } else if (sameDomain) {
    type = "same_domain";
    typedBonus = 0.06;
  } else if (sameApp) {
    type = "same_app";
    typedBonus = 0.05;
  } else if (gapMs <= 6 * 60 * 1000) {
    type = "temporal_near";
    typedBonus = 0.04;
  }

  const score = Math.min(
    1,
    0.22 * temporalScore +
      0.24 * (sameSession ? 1 : 0) +
      0.16 * entityOverlap +
      0.14 * topicOverlap +
      0.12 * appDomainScore +
      0.12 * Math.max(0, semanticScore) +
      typedBonus
  );

  if (
    !(
      sameSession ||
      sameDomain ||
      sameApp ||
      entityOverlap > 0 ||
      topicOverlap > 0 ||
      semanticScore >= 0.26 ||
      typedBonus > 0
    )
  ) {
    return null;
  }

  if (score < EVENT_GRAPH_THRESHOLD) {
    return null;
  }

  return {
    type,
    score,
    reasons,
    reasonSummary: buildRelationshipReasonSummary(reasons),
  };
}

function pushSparseGraphEdge(list, edge) {
  list.push(edge);
  list.sort((left, right) => right.relationship_score - left.relationship_score);
  if (list.length > EVENT_GRAPH_MAX_NEIGHBORS) {
    list.length = EVENT_GRAPH_MAX_NEIGHBORS;
  }
}

function buildConnectedEdges(incoming, outgoing) {
  const bestByEventId = new Map();
  for (const edge of [...incoming, ...outgoing]) {
    const existing = bestByEventId.get(edge.event_id);
    if (!existing || edge.relationship_score > existing.relationship_score) {
      bestByEventId.set(edge.event_id, edge);
    }
  }
  return [...bestByEventId.values()]
    .sort((left, right) => right.relationship_score - left.relationship_score)
    .slice(0, EVENT_GRAPH_MAX_NEIGHBORS);
}

function buildEpisodicGraph(events, cosineSimilarity) {
  const ordered = [...events].sort((left, right) => left.timestamp - right.timestamp || left.id - right.id);
  const graphByEventId = new Map(
    ordered.map((event) => [
      event.id,
      {
        event_id: event.id,
        incoming: [],
        outgoing: [],
        connected: [],
      },
    ])
  );

  for (let index = 0; index < ordered.length; index += 1) {
    const source = ordered[index];
    for (let targetIndex = index + 1; targetIndex < ordered.length; targetIndex += 1) {
      const target = ordered[targetIndex];
      const gapMs = target.timestamp - source.timestamp;

      if (gapMs < 0) {
        continue;
      }
      if (gapMs > EVENT_GRAPH_WINDOW_MS && source.session_id !== target.session_id) {
        break;
      }

      const semanticScore =
        source.embedding.length && target.embedding.length
          ? cosineSimilarity(source.embedding, target.embedding)
          : 0;
      const relationship = classifyEventRelationship(source, target, semanticScore, gapMs);
      if (!relationship) {
        continue;
      }

      const outgoingEdge = {
        event_id: target.id,
        title: eventGraphLabel(target),
        url: target.url || "",
        domain: target.domain || "",
        application: target.application || "",
        occurred_at: target.occurred_at || "",
        page_type: target.page_type || "",
        relationship_type: relationship.type,
        relationship_label: relationshipTypeLabel(relationship.type),
        relationship_score: relationship.score,
        relationship_reason: relationship.reasonSummary,
        relationship_reasons: relationship.reasons,
        direction: "after",
      };

      const incomingEdge = {
        event_id: source.id,
        title: eventGraphLabel(source),
        url: source.url || "",
        domain: source.domain || "",
        application: source.application || "",
        occurred_at: source.occurred_at || "",
        page_type: source.page_type || "",
        relationship_type: relationship.type,
        relationship_label: relationshipTypeLabel(relationship.type),
        relationship_score: relationship.score,
        relationship_reason: relationship.reasonSummary,
        relationship_reasons: relationship.reasons,
        direction: "before",
      };

      pushSparseGraphEdge(graphByEventId.get(source.id).outgoing, outgoingEdge);
      pushSparseGraphEdge(graphByEventId.get(target.id).incoming, incomingEdge);
    }
  }

  for (const node of graphByEventId.values()) {
    node.connected = buildConnectedEdges(node.incoming, node.outgoing);
  }

  return graphByEventId;
}

const MONTH_LOOKUP = new Map([
  ["january", "01"],
  ["jan", "01"],
  ["february", "02"],
  ["feb", "02"],
  ["march", "03"],
  ["mar", "03"],
  ["april", "04"],
  ["apr", "04"],
  ["may", "05"],
  ["june", "06"],
  ["jun", "06"],
  ["july", "07"],
  ["jul", "07"],
  ["august", "08"],
  ["aug", "08"],
  ["september", "09"],
  ["sep", "09"],
  ["sept", "09"],
  ["october", "10"],
  ["oct", "10"],
  ["november", "11"],
  ["nov", "11"],
  ["december", "12"],
  ["dec", "12"],
]);

function normalizeComparable(value) {
  return normalizeText(value).toLowerCase();
}

function exactIncludes(haystack, needle) {
  const left = normalizeComparable(haystack);
  const right = normalizeComparable(needle);
  return Boolean(left && right && left.includes(right));
}

function eventMonthKey(event) {
  if (!event?.timestamp) {
    return "";
  }
  const date = new Date(event.timestamp);
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}`;
}

function formatMonthKey(monthKey) {
  const match = String(monthKey || "").match(/^(\d{4})-(\d{2})$/);
  if (!match) {
    return monthKey || "";
  }
  const [, year, month] = match;
  const date = new Date(Number(year), Number(month) - 1, 1);
  return new Intl.DateTimeFormat(undefined, {
    month: "long",
    year: "numeric",
  }).format(date);
}

function extractMonthKey(text) {
  const normalized = normalizeText(text).toLowerCase();
  const direct = normalized.match(/\b(20\d{2})[-/](0[1-9]|1[0-2])\b/);
  if (direct) {
    return `${direct[1]}-${direct[2]}`;
  }

  const named = normalized.match(
    /\b(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sep|sept|october|oct|november|nov|december|dec)\s+(20\d{2})\b/
  );
  if (!named) {
    return "";
  }

  const month = MONTH_LOOKUP.get(named[1]);
  return month ? `${named[2]}-${month}` : "";
}

function eventSearchQuery(event) {
  if (!event) {
    return "";
  }
  const queryFact = (event.fact_items || []).find(
    (item) => normalizeComparable(item.label) === "query"
  )?.value;
  return normalizeText(queryFact || (event.page_type === "search" ? event.context_subject : ""));
}

function eventSubjectHaystack(event) {
  return [
    event.title,
    event.context_subject,
    ...(event.context_entities || []),
    ...(event.context_topics || []),
    ...(event.keyphrases || []),
    ...(event.fact_items || []).map((item) => item.value),
  ]
    .filter(Boolean)
    .join(" ");
}

function detectOperator(query) {
  const text = normalizeText(query).replace(/[?]+$/, "");
  const monthKey = extractMonthKey(text);
  if (monthKey) {
    return {
      name: "month",
      anchor: monthKey,
      label: formatMonthKey(monthKey),
    };
  }
  const patterns = [
    { name: "before", regex: /^(?:what led to|what happened before)\s+(.+)$/i },
    { name: "after", regex: /^(?:what happened after|what came after)\s+(.+)$/i },
    { name: "connected", regex: /^(?:show everything connected to|show everything related to)\s+(.+)$/i },
    { name: "domain", regex: /^(?:show activity from|what was i reading on|what do i remember from|what was i looking at on|what did i read on)\s+(.+)$/i },
    { name: "app", regex: /^(?:what was i doing in|what was i working in|how have i been using)\s+(.+)$/i },
    { name: "search_query", regex: /^(?:show searches for|find searches for|where did i search for|what was i searching about|what did i search about)\s+(.+)$/i },
    { name: "topic", regex: /^(?:what did i read about|show pages about|find pages about|what do i remember about|what did i learn about|what did i watch about|what can you tell me about|tell me about)\s+(.+)$/i },
    { name: "seen", regex: /^(?:where did i see|find)\s+(.+)$/i },
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern.regex);
    if (match) {
      return {
        name: pattern.name,
        anchor: normalizeText(match[1]).replace(/^["']|["']$/g, ""),
      };
    }
  }
  return { name: "match", anchor: text };
}

function classifyQueryIntent(query) {
  const normalized = normalizeText(query, 260).toLowerCase();
  return {
    reflective: /\b(revisit|review|resume|continue|important|priority|prioritize|focus|worth|remember best|what matters|what stands out|key|main things|catch me up|summary|summarize|understand|progress|enough|prepared|prep|doing enough|am i|should i|compare|how am i|what should i)\b/.test(
      normalized
    ),
    broadQuestion: /^(what|how|why|am i|should i|could i|can i|do i|did i|have i|is there)\b/.test(
      normalized
    ),
  };
}

function buildSemanticQueryFrames(query, queryIntent) {
  const normalized = normalizeText(query, 400);
  if (!normalized) {
    return [];
  }

  const frames = [normalized];
  const lower = normalized.toLowerCase();
  const looksReflective =
    queryIntent?.reflective ||
    queryIntent?.broadQuestion ||
    /\b(feel|think|believe|keep thinking|why do i|should i|need to|behind|prove myself|worried|anxious|stuck)\b/i.test(
      lower
    );

  if (looksReflective) {
    frames.push(`sources that may have shaped this thought: ${normalized}`);
    frames.push(`activity, pages, videos, searches, and posts related to: ${normalized}`);
    frames.push(`evidence connected to the feeling or belief: ${normalized}`);
  } else {
    frames.push(`web activity related to: ${normalized}`);
    frames.push(`saved source about: ${normalized}`);
  }

  return Array.from(new Set(frames));
}

function maxCosineSimilarity(vectors, eventEmbedding, cosineSimilarity) {
  if (!eventEmbedding?.length) {
    return 0;
  }
  return (vectors || []).reduce((best, vector) => {
    if (!vector?.length) {
      return best;
    }
    return Math.max(best, cosineSimilarity(vector, eventEmbedding));
  }, 0);
}

function exactScoreForOperator(event, operator) {
  let score = 0.28;
  if (event.timestamp) {
    const recencyDays = (Date.now() - event.timestamp) / (1000 * 60 * 60 * 24);
    score += Math.exp((-Math.log(2) * recencyDays) / 7) * 0.12;
  }

  if (operator.name === "domain") {
    if (exactIncludes(event.domain, operator.anchor)) score += 0.45;
    if (exactIncludes(event.url, operator.anchor)) score += 0.16;
    return score;
  }

  if (operator.name === "app") {
    if (exactIncludes(event.application, operator.anchor)) score += 0.45;
    return score;
  }

  if (operator.name === "month") {
    if (eventMonthKey(event) === operator.anchor) score += 0.5;
    return score;
  }

  if (operator.name === "search_query") {
    if (event.page_type === "search") score += 0.22;
    if (exactSearchQueryMatch(event, operator.anchor)) score += 0.52;
    if (exactIncludes(event.title, operator.anchor)) score += 0.12;
    return score;
  }

  const haystack = eventSubjectHaystack(event);
  if (exactIncludes(event.context_subject, operator.anchor)) score += 0.52;
  if (exactIncludes(event.title, operator.anchor)) score += 0.42;
  if (exactFactMatch(event, operator.anchor)) score += 0.28;
  if (exactSearchQueryMatch(event, operator.anchor)) score += 0.34;
  if (exactIncludes(haystack, operator.anchor)) score += 0.12;
  return score;
}

function exactRetrieve(operator, events) {
  const matches = events.filter((event) => {
    switch (operator.name) {
      case "domain":
        return (
          exactIncludes(event.domain, operator.anchor) ||
          exactIncludes(event.url, operator.anchor)
        );
      case "app":
        return exactIncludes(event.application, operator.anchor);
      case "month":
        return eventMonthKey(event) === operator.anchor;
      case "search_query":
        return (
          event.page_type === "search" &&
          (exactSearchQueryMatch(event, operator.anchor) ||
            exactIncludes(event.title, operator.anchor))
        );
      case "topic":
      case "seen":
      case "match":
        if (isLowValueEvent(event) && !hasStrongExactSignal(event, operator.anchor)) {
          return false;
        }
        if (isSearchResultsPage(event)) {
          return exactSearchQueryMatch(event, operator.anchor);
        }
        return hasStrongExactSignal(event, operator.anchor) ||
          (!isLowValueEvent(event) && exactIncludes(eventSubjectHaystack(event), operator.anchor));
      default:
        return false;
    }
  });

  return matches
    .map((event) => {
      const score = exactScoreForOperator(event, operator);
      return {
        ...event,
        exact_score: score,
        score,
      };
    })
    .sort((left, right) => right.score - left.score || right.timestamp - left.timestamp);
}

async function rankEvents(text, events, embedText, cosineSimilarity, options = {}) {
  const normalizedText = normalizeText(text, 400);
  if (!normalizedText) {
    return [];
  }

  const tokens = meaningfulTokens(normalizedText);
  const queryIntent = classifyQueryIntent(normalizedText);
  const queryEmbeddings = await Promise.all(
    buildSemanticQueryFrames(normalizedText, queryIntent).map((frame) => embedText(frame))
  );
  const domainHint = hostnameFromUrl(normalizedText) || "";
  const appHint = normalizeText(options.appHint).toLowerCase();
  const operatorName = normalizeText(options.operatorName || "match").toLowerCase();
  const normalizedQueryLower = normalizedText.toLowerCase();
  const now = Date.now();

  const scored = events.map((event) => {
      const semantic = maxCosineSimilarity(queryEmbeddings, event.embedding, cosineSimilarity);
      const titleLower = String(event.title || "").toLowerCase();
      const snippetLower = String(event.snippet || "").toLowerCase();
      const urlLower = canonicalUrl(event.url || "");
      const fullTextLower = String(event.full_text || "").toLowerCase();
      const contextLower = String(event.context_text || "").toLowerCase();
      const factsLower = factText(event).toLowerCase();
      const derivativesLower = derivativeText(event).toLowerCase();
      const searchQueryLower = eventSearchQuery(event).toLowerCase();
      const lexical = tokenCoverage(tokens, [
        event.title,
        event.snippet,
        event.full_text,
        event.url,
        event.domain,
        event.application,
        event.keyphrases.join(" "),
        event.context_text,
        derivativeText(event),
      ].join(" "));
      const titleBoost = tokenCoverage(tokens, event.title);
      const keyphraseBoost = tokenCoverage(tokens, event.keyphrases.join(" "));
      const fullTextBoost = tokenCoverage(tokens, event.full_text);
      const subjectBoost = tokenCoverage(tokens, event.context_subject);
      const entityBoost = tokenCoverage(tokens, event.context_entities.join(" "));
      const topicBoost = tokenCoverage(tokens, event.context_topics.join(" "));
      const factBoost = tokenCoverage(tokens, factText(event));
      const derivativeBoost = tokenCoverage(tokens, derivativeText(event));
      const searchQueryBoost = tokenCoverage(tokens, eventSearchQuery(event));
      const contextBoost = tokenCoverage(tokens, event.context_text);
      const tokenHitCount = countTokenHits(tokens, [
        event.title,
        event.context_subject,
        factText(event),
        event.context_entities.join(" "),
        event.context_topics.join(" "),
        eventSearchQuery(event),
      ].join(" "));
      const exactTitleMatch = normalizedQueryLower && titleLower.includes(normalizedQueryLower) ? 1 : 0;
      const exactUrlMatch = normalizedQueryLower && urlLower.includes(normalizedQueryLower) ? 1 : 0;
      const exactSnippetMatch = normalizedQueryLower && snippetLower.includes(normalizedQueryLower) ? 1 : 0;
      const exactBodyMatch = normalizedQueryLower && fullTextLower.includes(normalizedQueryLower) ? 1 : 0;
      const exactSubjectMatch =
        normalizedQueryLower && contextLower.includes(normalizedQueryLower) ? 1 : 0;
      const exactFactValueMatch = normalizedQueryLower && factsLower.includes(normalizedQueryLower) ? 1 : 0;
      const exactDerivativeMatch =
        normalizedQueryLower && derivativesLower.includes(normalizedQueryLower) ? 1 : 0;
      const exactSearchQueryValueMatch =
        normalizedQueryLower && searchQueryLower.includes(normalizedQueryLower) ? 1 : 0;
      const domainBoost = domainHint && event.domain === domainHint ? 1 : 0;
      const appBoost = appHint && event.application.toLowerCase().includes(appHint) ? 1 : 0;
      const recencyDays = event.timestamp ? (now - event.timestamp) / (1000 * 60 * 60 * 24) : 999;
      const recencyBoost = event.timestamp ? Math.exp((-Math.log(2) * recencyDays) / 3) : 0;
      const clutterScore = Number(event.clutter_audit?.clutterScore || 0);
      const organizationScore = Number(event.clutter_audit?.organizationScore || 0);
      const captureMode = normalizeText(event.capture_intent?.captureMode).toLowerCase();
      const qualityLabel = normalizeText(event.local_judge?.qualityLabel).toLowerCase();
      const rememberScore = Number(event.selective_memory?.rememberScore || 0);
      const recallWeight = Number(event.selective_memory?.recallWeight || 1);
      const memoryAction = normalizeText(event.selective_memory?.memoryAction).toLowerCase();
      const pageType = normalizeText(event.page_type || event.pageType).toLowerCase();
      const strongExactSignal =
        exactTitleMatch ||
        exactSubjectMatch ||
        exactFactValueMatch ||
        exactDerivativeMatch ||
        exactSearchQueryValueMatch;
      const reflectiveUtilityBonus =
        queryIntent.reflective && !strongExactSignal
          ? pageType === "docs" || pageType === "article" || pageType === "repo" || pageType === "qa"
            ? 0.08
            : pageType === "search"
              ? 0.03
              : 0
          : 0;
      const reflectiveUtilityPenalty =
        queryIntent.reflective && !strongExactSignal
          ? pageType === "lyrics" || pageType === "social"
            ? 0.16
            : pageType === "video"
              ? 0.08
              : 0
          : 0;
      const searchResultsPenalty =
        isSearchResultsPage(event) && operatorName !== "search_query" ? 0.42 : isSearchResultsPage(event) ? 0.08 : 0;
      const metadataPenalty = captureMode === "metadata" ? 0.18 : 0;
      const shellPenalty = qualityLabel === "shell" ? 0.4 : 0;
      const genericWebPenalty =
        normalizeText(event.page_type).toLowerCase() === "web" &&
        !strongExactSignal &&
        lexical < 0.28 &&
        semantic < 0.42
          ? 0.12
          : 0;
      const clutterPenalty =
        clutterScore >= 0.78 ? 0.3 : clutterScore >= 0.6 ? 0.16 : clutterScore >= 0.46 ? 0.08 : 0;
      const organizationBonus = organizationScore >= 0.74 ? 0.04 : 0;
      const meaningfulBonus = qualityLabel === "meaningful" ? 0.06 : 0;
      const captureBonus =
        captureMode === "full" ? 0.05 : captureMode === "structured" ? 0.01 : 0;
      const capturePacketDepthBonus =
        Array.isArray(event.capture_packet?.blocks) && event.capture_packet.blocks.length >= 4 ? 0.04 : 0;
      const capturePacketPointBonus =
        Array.isArray(event.capture_packet?.points) && event.capture_packet.points.length >= 3 ? 0.03 : 0;
      const lowValuePenalty = isLowValueEvent(event) && !strongExactSignal ? 0.24 : 0;
      const selectiveWeightBonus = (recallWeight - 1) * 0.18;
      const selectiveScoreBonus =
        rememberScore >= 0.78
          ? 0.06
          : rememberScore >= 0.58
            ? 0.03
            : rememberScore >= 0.35
              ? 0
              : -0.05;
      const memoryActionPenalty =
        memoryAction === "demote" && !strongExactSignal
          ? 0.08
          : memoryAction === "compress" && !strongExactSignal
            ? 0.02
            : 0;
      const recencyWeight =
        strongExactSignal || lexical >= 0.28 || semantic >= 0.45 || tokenHitCount >= Math.max(2, tokens.length - 1)
          ? 0.16
          : 0.06;
      const score =
        semantic * 0.28 +
        lexical * 0.16 +
        titleBoost * 0.18 +
        keyphraseBoost * 0.04 +
        fullTextBoost * 0.04 +
        subjectBoost * 0.14 +
        entityBoost * 0.07 +
        topicBoost * 0.06 +
        factBoost * 0.08 +
        derivativeBoost * 0.08 +
        searchQueryBoost * 0.1 +
        contextBoost * 0.08 +
        exactTitleMatch * 0.16 +
        exactSubjectMatch * 0.14 +
        exactFactValueMatch * 0.12 +
        exactDerivativeMatch * 0.08 +
        exactSearchQueryValueMatch * 0.14 +
        exactUrlMatch * 0.02 +
        exactSnippetMatch * 0.03 +
        exactBodyMatch * 0.02 +
        domainBoost * 0.06 +
        appBoost * 0.04 +
        recencyBoost * recencyWeight +
        meaningfulBonus +
        captureBonus +
        reflectiveUtilityBonus +
        capturePacketDepthBonus +
        capturePacketPointBonus +
        selectiveWeightBonus +
        selectiveScoreBonus +
        organizationBonus -
        searchResultsPenalty -
        metadataPenalty -
        shellPenalty -
        genericWebPenalty -
        clutterPenalty -
        memoryActionPenalty -
        lowValuePenalty -
        reflectiveUtilityPenalty;
      return {
        ...event,
        similarity: semantic,
        lexical_score: lexical,
        recency_score: recencyBoost,
        exact_title_match: exactTitleMatch,
        exact_subject_match: exactSubjectMatch,
        exact_fact_match: exactFactValueMatch,
        exact_derivative_match: exactDerivativeMatch,
        exact_search_query_match: exactSearchQueryValueMatch,
        exact_url_match: exactUrlMatch,
        context_score: contextBoost,
        token_hit_count: tokenHitCount,
        score,
      };
    });

  const strongestDirectScore = scored.reduce((max, event) => {
    return isMeaningfulDirectEvent(event) ? Math.max(max, event.score) : max;
  }, 0);

  return scored
    .map((event) => {
      if (!isSearchResultsPage(event)) {
        return event;
      }
      const demotion =
        operatorName !== "search_query" &&
        strongestDirectScore &&
        strongestDirectScore >= event.score - 0.04
          ? 0.22
          : 0;
      return {
        ...event,
        score: event.score - demotion,
        search_page_demotion: demotion,
      };
    })
    .filter(
      (event) =>
        event.score >= 0.18 ||
        event.lexical_score >= 0.22 ||
        event.exact_title_match > 0 ||
        event.exact_subject_match > 0 ||
        event.exact_fact_match > 0 ||
        event.exact_derivative_match > 0 ||
        event.exact_search_query_match > 0 ||
        event.exact_url_match > 0 ||
        event.context_score >= 0.26 ||
        (event.similarity >= 0.52 && event.token_hit_count >= Math.max(1, Math.floor(tokens.length / 2)))
    )
    .filter((event) => !isLowValueEvent(event) || hasStrongExactSignal(event, normalizedText))
    .sort((left, right) => right.score - left.score || right.timestamp - left.timestamp);
}

function rerankWithSessionContext(events) {
  const sessionSignals = new Map();
  for (const event of events) {
    if (!event.session_id) {
      continue;
    }
    const current = sessionSignals.get(event.session_id) || { count: 0, topScore: 0, topRecency: 0 };
    current.count += 1;
    current.topScore = Math.max(current.topScore, event.score);
    current.topRecency = Math.max(current.topRecency, event.recency_score || 0);
    sessionSignals.set(event.session_id, current);
  }

  return events
    .map((event) => {
      const signal = sessionSignals.get(event.session_id);
      if (!signal) {
        return event;
      }
      const sessionBonus = Math.min(
        0.12,
        Math.max(0, signal.count - 1) * 0.028 +
          Math.max(0, signal.topScore - 0.2) * 0.08 +
          signal.topRecency * 0.02
      );
      return {
        ...event,
        session_context_bonus: sessionBonus,
        score: event.score + sessionBonus,
      };
    })
    .sort((left, right) => right.score - left.score || right.timestamp - left.timestamp);
}

function rerankWithEpisodicGraphContext(events, graphByEventId) {
  const eventScoreById = new Map(events.map((event) => [event.id, event.score]));

  return events
    .map((event) => {
      const graphNode = graphByEventId.get(event.id);
      if (!graphNode?.connected?.length) {
        return event;
      }

      const supportingEdges = graphNode.connected
        .filter((edge) => eventScoreById.has(edge.event_id))
        .sort((left, right) => right.relationship_score - left.relationship_score)
        .slice(0, 3);

      if (!supportingEdges.length) {
        return event;
      }

      const graphBonus = Math.min(
        0.16,
        supportingEdges.reduce((total, edge) => {
          const neighborScore = Math.max(0, eventScoreById.get(edge.event_id) || 0);
          return (
            total +
            edge.relationship_score * 0.05 +
            Math.max(0, neighborScore - 0.18) * 0.04
          );
        }, 0)
      );

      return {
        ...event,
        episodic_graph_bonus: graphBonus,
        score: event.score + graphBonus,
      };
    })
    .sort((left, right) => right.score - left.score || right.timestamp - left.timestamp);
}

async function rerankWithLocalJudge(events, embedText, cosineSimilarity, limit = 48) {
  const leading = events.slice(0, limit);
  const trailing = events.slice(limit);

  const judged = await Promise.all(
    leading.map(async (event) => {
      const localJudge =
        event.local_judge ||
        (await classifyLocalPage(event.context_profile || event, {
          embedText,
          cosineSimilarity,
        }));

      let adjustment = 0;
      if (localJudge?.qualityLabel === "shell") {
        adjustment = -0.34;
      } else if (localJudge?.qualityLabel === "search_results") {
        adjustment = -0.08;
      } else if (localJudge?.qualityLabel === "meaningful") {
        adjustment = 0.05;
      }

      if (event.capture_intent?.captureMode === "metadata") {
        adjustment -= 0.14;
      } else if (event.capture_intent?.captureMode === "structured") {
        adjustment += 0.02;
      } else if (event.capture_intent?.captureMode === "full") {
        adjustment += 0.04;
      }

      const clutterScore = Number(event.clutter_audit?.clutterScore || 0);
      const organizationScore = Number(event.clutter_audit?.organizationScore || 0);
      if (clutterScore >= 0.78) {
        adjustment -= 0.28;
      } else if (clutterScore >= 0.58) {
        adjustment -= 0.14;
      } else if (organizationScore >= 0.72) {
        adjustment += 0.04;
      }

      return {
        ...event,
        local_judge: localJudge,
        local_quality_adjustment: adjustment,
        score: event.score + adjustment,
      };
    })
  );

  return [...judged, ...trailing]
    .filter(
      (event) =>
        !event.local_judge?.shouldSkip &&
        !event.capture_intent?.shouldSkip &&
        !event.clutter_audit?.shouldSkip
    )
    .sort((left, right) => right.score - left.score || right.timestamp - left.timestamp);
}

function dedupeRankedEvents(events) {
  const buckets = new Map();
  for (const event of events) {
    const key = event.canonicalFingerprint || `${event.domain}|${event.title.toLowerCase()}`;
    const existing = buckets.get(key);
    if (!existing) {
      buckets.set(key, {
        representative: event,
        duplicate_count: 1,
        timestamps: [event.timestamp],
      });
      continue;
    }

    existing.duplicate_count += 1;
    existing.timestamps.push(event.timestamp);
    if (event.score > existing.representative.score) {
      existing.representative = event;
    }
  }

  return [...buckets.values()]
    .map((bucket) => ({
      ...bucket.representative,
      duplicate_count: bucket.duplicate_count,
      first_seen_at: new Date(Math.min(...bucket.timestamps.filter(Boolean))).toISOString(),
      last_seen_at: new Date(Math.max(...bucket.timestamps.filter(Boolean))).toISOString(),
    }))
    .sort((left, right) => right.score - left.score || right.timestamp - left.timestamp);
}

function sessionStory(session) {
  if (!session) {
    return "local memory";
  }
  const domain = [...session.domains][0] || "";
  const app = [...session.applications][0] || "";
  if (session.mode === "coding" && domain) {
    return `working from ${domain}`;
  }
  if (session.mode === "coding") {
    return `working in ${toTitleCase(app)}`;
  }
  if (session.mode === "reading" && domain) {
    return `reading on ${domain}`;
  }
  if (domain) {
    return `using ${domain}`;
  }
  if (app) {
    return `using ${toTitleCase(app)}`;
  }
  return "local memory";
}

function buildSessionSummary(session) {
  if (!session) {
    return "";
  }
  const parts = [`From session: ${session.label}`];
  if (session.events.length) {
    parts.push(pluralize(session.events.length, "event"));
  }
  if (session.upstream?.length) {
    parts.push(pluralize(session.upstream.length, "earlier link"));
  }
  if (session.downstream?.length) {
    parts.push(pluralize(session.downstream.length, "later link"));
  }
  if (session.foundationalEvents?.length) {
    parts.push(pluralize(session.foundationalEvents.length, "foundational memory"));
  }
  return parts.join(" - ");
}

function buildSessionPrompts(session) {
  if (!session) {
    return [];
  }
  const label = quoteLabel(shortLabel(session.label));
  const prompts = [];
  if (session.upstream?.length) {
    prompts.push(`What led to ${label}?`);
  }
  if (session.downstream?.length) {
    prompts.push(`What happened after ${label}?`);
  }
  if (!prompts.length) {
    prompts.push(`Show everything connected to ${label}`);
  }
  return prompts.slice(0, 2);
}

function buildRelatedQueries(primaryEvent, primarySession, operator) {
  const queries = buildSuggestionQueries({
    title: primaryEvent?.title,
    url: primaryEvent?.url,
    application: primaryEvent?.application,
    pageType: primaryEvent?.page_type,
    entities: primaryEvent?.context_entities || [],
    topics: primaryEvent?.context_topics || [],
    subject: primaryEvent?.context_subject || "",
    keyphrases: primaryEvent?.keyphrases || [],
  }).map((item) => item.query);
  if (primarySession && operator === "match") {
    queries.push(...buildSessionPrompts(primarySession));
  }
  return Array.from(new Set(queries.map((query) => normalizeText(query)).filter(Boolean))).slice(0, 3);
}

function graphSummary(graphNode) {
  if (!graphNode?.connected?.length) {
    return "";
  }
  const strongest = graphNode.connected[0];
  return `Connected to ${pluralize(graphNode.connected.length, "related memory")} with strongest ${strongest.relationship_label.toLowerCase()} link.`;
}

function decorateEvent(event, session, graphByEventId) {
  const pageType = event.page_type || inferPageType(event);
  const factItems = Array.isArray(event.fact_items) && event.fact_items.length
    ? event.fact_items
    : buildStructuredFacts(event, pageType);
  const graphNode = graphByEventId?.get(event.id) || null;
  return {
    ...event,
    page_type: pageType,
    page_type_label: event.page_type_label || pageTypeLabel(pageType),
    structured_summary: event.structured_summary || buildStructuredSummary(event, pageType, factItems),
    fact_items: factItems,
    display_excerpt: event.display_excerpt || buildDisplayExcerpt(event, pageType),
    display_url: event.display_url || canonicalUrl(event.url || ""),
    display_full_text: event.display_full_text || event.full_text || "",
    raw_full_text: event.raw_full_text || event.full_text || "",
    search_results: Array.isArray(event.search_results) ? event.search_results : [],
    derivative_items: Array.isArray(event.derivative_items) ? event.derivative_items : [],
    capture_packet: event.capture_packet || null,
    session: session
      ? {
          id: session.id,
          label: session.label,
          event_count: session.events.length,
          started_at: session.started_at,
          ended_at: session.ended_at,
        }
      : null,
    before_context: graphNode?.incoming?.[0]?.title || session?.upstream?.[0]?.label || "",
    after_context: graphNode?.outgoing?.[0]?.title || session?.downstream?.[0]?.label || "",
    moment_summary: session ? `${session.label}.` : "",
    graph_summary: graphSummary(graphNode),
    connected_events: Array.isArray(graphNode?.connected) ? graphNode.connected : [],
    selective_memory: event.selective_memory || null,
  };
}

function selectRepresentativeEvents(dedupedEvents, sessionsById, graphByEventId, limit = 10) {
  const selected = [];
  const perSession = new Map();

  for (const event of dedupedEvents) {
    const sessionId = event.session_id || 0;
    const sessionCount = perSession.get(sessionId) || 0;
    if (sessionId && sessionCount >= 2) {
      continue;
    }
    selected.push(decorateEvent(event, sessionsById.get(sessionId) || null, graphByEventId));
    perSession.set(sessionId, sessionCount + 1);
    if (selected.length >= limit) {
      break;
    }
  }

  return selected.slice(0, limit);
}

function buildMatchAnswer(query, results, primarySession) {
  const primary = results[0];
  if (!primary) {
    return {
      results: [],
      answer: {
        overview: `What I found about "${query}"`,
        answer: "No strong local result",
        summary: "Try a more specific phrase, app, site, or date.",
        detailItems: [],
        signals: [],
        sessionSummary: "",
        sessionPrompts: [],
        relatedQueries: [],
        detailsLabel: "",
      },
    };
  }

  const evidenceCount = results.reduce((total, event) => total + Math.max(1, Number(event.duplicate_count || 1)), 0);
  const detailItems = [
    primary.application ? { label: "App", value: toTitleCase(primary.application) } : null,
    primary.domain ? { label: "Site", value: primary.domain } : null,
    primary.occurred_at ? { label: "Captured", value: primary.occurred_at } : null,
    primary.connected_events?.length
      ? { label: "Connected", value: `${primary.connected_events.length} linked memories` }
      : null,
    { label: "Evidence", value: `${evidenceCount} matching captures` },
  ].filter(Boolean);

  const summaryParts = [
    `Showing ${pluralize(results.length, "strong local match")}.`,
    ensureSentence(
    primary.structured_summary ||
      (primary.domain ? `Saved page from ${primary.domain}` : "") ||
      "This is a strong local match"
    ),
  ];
  if (primary.duplicate_count > 1) {
    summaryParts.push(`This page was captured ${primary.duplicate_count} times.`);
  }
  if (primary.graph_summary) {
    summaryParts.push(primary.graph_summary);
  }
  if (primarySession) {
    summaryParts.push(`Most relevant session: ${quoteLabel(primarySession.label)}.`);
  }
  const summary = compactText(summaryParts.join(" "), 280);

  return {
    results,
    answer: {
      overview: `What I found about "${query}"`,
      answer: primary.title,
      summary,
      detailItems,
      signals: primary.keyphrases.slice(0, 5),
      sessionSummary: buildSessionSummary(primarySession),
      sessionPrompts: buildSessionPrompts(primarySession),
      relatedQueries: buildRelatedQueries(primary, primarySession, "match"),
      detailsLabel: "Matching memories",
    },
  };
}

function buildSessionResults(sessionIds, sessionsById, graphByEventId, rankedEvents, limit) {
  const rankedBySession = new Map();
  for (const event of rankedEvents) {
    if (!rankedBySession.has(event.session_id)) {
      rankedBySession.set(event.session_id, []);
    }
    rankedBySession.get(event.session_id).push(event);
  }

  const selected = [];
  const seenEventIds = new Set();
  for (const sessionId of sessionIds) {
    const session = sessionsById.get(sessionId) || null;
    const best = rankedBySession.get(sessionId)?.[0] || session?.events?.[0];
    if (!best || seenEventIds.has(best.id)) {
      continue;
    }
    selected.push(decorateEvent(best, session, graphByEventId));
    seenEventIds.add(best.id);
    if (selected.length >= limit) {
      break;
    }
  }
  return selected;
}

function buildOperatorAnswer(
  operator,
  anchorLabel,
  anchorSession,
  relatedSessions,
  graphByEventId,
  rankedEvents,
  limit
) {
  const sessionsById = new Map([
    ...(anchorSession ? [[anchorSession.id, anchorSession]] : []),
    ...relatedSessions.map((session) => [session.id, session]),
  ]);
  const results = buildSessionResults(
    relatedSessions.map((session) => session.id),
    sessionsById,
    graphByEventId,
    rankedEvents,
    limit
  );
  const quotedAnchor = quoteLabel(anchorLabel);

  const summaries = {
    before: relatedSessions.length
      ? `Found ${pluralize(relatedSessions.length, "related earlier session")} before ${quotedAnchor}.`
      : `No clear earlier session was found before ${quotedAnchor}.`,
    after: relatedSessions.length
      ? `Found ${pluralize(relatedSessions.length, "related session")} after ${quotedAnchor}.`
      : `No clear follow-up session was found after ${quotedAnchor}.`,
    connected: relatedSessions.length
      ? `Found ${pluralize(relatedSessions.length, "related session")} connected to ${quotedAnchor}.`
      : `No strong connected session was found for ${quotedAnchor}.`,
  };

  return {
    results,
    answer: {
      overview:
        operator === "before"
          ? `What led to ${quotedAnchor}`
          : operator === "after"
            ? `What happened after ${quotedAnchor}`
            : `Everything connected to ${quotedAnchor}`,
      answer: relatedSessions[0]?.label || anchorSession?.label || anchorLabel,
      summary: ensureSentence(summaries[operator]),
      detailItems: [
        { label: "Anchor", value: anchorLabel },
        {
          label: operator === "before" ? "Before" : operator === "after" ? "After" : "Connected",
          value: relatedSessions.length ? `${relatedSessions.length} linked sessions` : "No strong lead",
        },
        anchorSession?.started_at ? { label: "Captured", value: anchorSession.started_at } : null,
      ].filter(Boolean),
      signals: anchorSession?.keyphrases?.slice(0, 5) || [],
      sessionSummary: buildSessionSummary(anchorSession),
      sessionPrompts: buildSessionPrompts(anchorSession),
      relatedQueries: [],
      detailsLabel: "Matching memories",
    },
  };
}

function buildAggregateAnswer(queryLabel, label, sessions, graphByEventId, rankedEvents, limit, kind) {
  const sessionsById = new Map(sessions.map((session) => [session.id, session]));
  const results = buildSessionResults(
    sessions.map((session) => session.id),
    sessionsById,
    graphByEventId,
    rankedEvents,
    limit
  );
  const primary = sessions[0] || null;
  const totalEvents = sessions.reduce((total, session) => total + session.events.length, 0);

  return {
    results,
    answer: {
      overview: kind === "domain" ? `What you remember from "${queryLabel}"` : `How you used "${queryLabel}"`,
      answer: label,
      summary: primary
        ? `Found ${pluralize(sessions.length, "related session")} and ${pluralize(totalEvents, "captured moment")} connected to ${label}. Most recent session: ${quoteLabel(primary.label)}.`
        : `Found local memories connected to ${label}.`,
      detailItems: [
        { label: kind === "domain" ? "Site" : "App", value: label },
        { label: "Sessions", value: `${sessions.length}` },
        { label: "Evidence", value: `${totalEvents} captured moments` },
        primary?.ended_at ? { label: "Last seen", value: primary.ended_at } : null,
      ].filter(Boolean),
      signals: primary?.keyphrases?.slice(0, 5) || [],
      sessionSummary: buildSessionSummary(primary),
      sessionPrompts: buildSessionPrompts(primary),
      relatedQueries: primary && results[0] ? buildRelatedQueries(results[0], primary, "match") : [],
      detailsLabel: "Matching memories",
    },
  };
}

function buildExactListAnswer(operator, results, sessionsById, graphByEventId) {
  const label =
    operator.name === "month"
      ? operator.label || formatMonthKey(operator.anchor)
      : operator.anchor;
  const decorated = selectRepresentativeEvents(
    results,
    sessionsById,
    graphByEventId,
    Math.min(results.length, 12)
  );

  const overview =
    operator.name === "month"
      ? `Memories from "${label}"`
      : operator.name === "search_query"
        ? `Searches for "${label}"`
        : operator.name === "topic"
          ? `Pages about "${label}"`
          : operator.name === "seen"
            ? `Where you saw "${label}"`
            : `Local matches for "${label}"`;

  const summary =
    operator.name === "month"
      ? `Found ${pluralize(decorated.length, "captured memory")} from ${label}.`
      : operator.name === "search_query"
        ? `Found ${pluralize(decorated.length, "captured search")} for ${quoteLabel(label)}.`
        : `Found ${pluralize(decorated.length, "exact local match")} for ${quoteLabel(label)}.`;

  return {
    results: decorated,
    answer: {
      overview,
      answer: label,
      summary,
      detailItems: [
        operator.name === "month"
          ? { label: "Month", value: label }
          : { label: "Filter", value: label },
        { label: "Matches", value: `${decorated.length}` },
      ],
      signals: [],
      sessionSummary: "",
      sessionPrompts: [],
      relatedQueries: [],
      detailsLabel: "Matching memories",
    },
  };
}

export async function answerLocalQuery({ query, limit = 20, rawEvents, embedText, cosineSimilarity }) {
  const normalizedQuery = normalizeText(query, 400);
  if (!normalizedQuery) {
    return { results: [], answer: null };
  }

  const events = rawEvents
    .map(normalizeEvent)
    .filter(
      (event) =>
        event.timestamp &&
        !isInternalMemactEvent(event) &&
        !shouldSkipCaptureProfile(event.context_profile || event)
    );
  if (!events.length) {
    return { results: [], answer: null };
  }

  const { sessions, eventToSession } = buildSessions(events, cosineSimilarity);
  for (const event of events) {
    event.session_id = eventToSession.get(event.id) || 0;
  }
  const sessionsById = buildSessionGraph(sessions, cosineSimilarity);
  const episodicGraphByEventId = buildEpisodicGraph(events, cosineSimilarity);

  const operator = detectOperator(normalizedQuery);
  const exactRankedEvents = dedupeRankedEvents(exactRetrieve(operator, events)).map((event) => ({
    ...event,
    session_id: event.session_id || eventToSession.get(event.id) || 0,
  }));
  const initiallyRankedEvents = rerankWithSessionContext(
    await rankEvents(operator.anchor || normalizedQuery, events, embedText, cosineSimilarity, {
      appHint: operator.name === "app" ? operator.anchor : "",
      operatorName: operator.name,
    })
  );
  const graphRankedEvents = rerankWithEpisodicGraphContext(
    initiallyRankedEvents,
    episodicGraphByEventId
  );

  const qualityRankedEvents = await rerankWithLocalJudge(
    graphRankedEvents,
    embedText,
    cosineSimilarity
  );

  const rankedEventsAll = dedupeRankedEvents(qualityRankedEvents).map((event) => ({
    ...event,
    session_id: event.session_id || eventToSession.get(event.id) || 0,
  }));

  const combinedRankedEvents = dedupeRankedEvents([
    ...exactRankedEvents,
    ...rankedEventsAll,
  ]).map((event) => ({
    ...event,
    session_id: event.session_id || eventToSession.get(event.id) || 0,
  }));

  const meaningfulDirectEvents = combinedRankedEvents.filter((event) => isMeaningfulDirectEvent(event));
  const directEvents = combinedRankedEvents.filter(
    (event) => !isSearchResultsPage(event) && !isLowValueEvent(event)
  );
  const viableFallbackEvents = combinedRankedEvents.filter(
    (event) => !isLowValueEvent(event) || hasStrongExactSignal(event, operator.anchor || normalizedQuery)
  );
  const rankedEvents = meaningfulDirectEvents.length
    ? meaningfulDirectEvents
    : directEvents.length
      ? directEvents
      : viableFallbackEvents;

  if (!rankedEvents.length) {
    return buildMatchAnswer(normalizedQuery, [], null);
  }

  const primaryEvent = rankedEvents[0];
  const primarySession = sessionsById.get(primaryEvent.session_id) || null;

  if (operator.name === "before" || operator.name === "after" || operator.name === "connected") {
    const relatedLinks = operator.name === "before"
      ? primarySession?.upstream || []
      : operator.name === "after"
        ? primarySession?.downstream || []
        : primarySession?.connected || [];
    const relatedSessions = relatedLinks
      .map((link) => sessionsById.get(link.session_id))
      .filter(Boolean);
    return buildOperatorAnswer(
      operator.name,
      shortLabel(primarySession?.label || primaryEvent.title || operator.anchor),
      primarySession,
      relatedSessions,
      episodicGraphByEventId,
      rankedEvents,
      Math.min(limit, 10)
    );
  }

  if (operator.name === "domain") {
    const target = normalizeText(operator.anchor).toLowerCase();
    const matchedSessions = sessions
      .filter((session) => [...session.domains].some((domain) => domain.includes(target)))
      .sort((left, right) => right.endedTimestamp - left.endedTimestamp);
    if (matchedSessions.length) {
      return buildAggregateAnswer(
        operator.anchor,
        operator.anchor,
        matchedSessions,
        episodicGraphByEventId,
        rankedEvents,
        Math.min(limit, 10),
        "domain"
      );
    }
  }

  if (operator.name === "app") {
    const target = normalizeText(operator.anchor).toLowerCase();
    const matchedSessions = sessions
      .filter((session) => [...session.applications].some((application) => application.toLowerCase().includes(target)))
      .sort((left, right) => right.endedTimestamp - left.endedTimestamp);
    if (matchedSessions.length) {
      return buildAggregateAnswer(
        operator.anchor,
        toTitleCase(operator.anchor),
        matchedSessions,
        episodicGraphByEventId,
        rankedEvents,
        Math.min(limit, 10),
        "app"
      );
    }
  }

  if (["month", "search_query", "topic", "seen"].includes(operator.name) && exactRankedEvents.length) {
    return buildExactListAnswer(operator, exactRankedEvents, sessionsById, episodicGraphByEventId);
  }

  const results = selectRepresentativeEvents(
    rankedEvents,
    sessionsById,
    episodicGraphByEventId,
    Math.min(limit, 12)
  );
  return buildMatchAnswer(normalizedQuery, results, primarySession);
}
