import { classifyCapturePrivacy } from "./privacy-boundary.js";

const SEARCH_ENGINE_DOMAINS = new Set([
  "google.com",
  "bing.com",
  "duckduckgo.com",
  "search.brave.com",
  "search.yahoo.com",
]);

const HIGH_VALUE_TYPES = new Set([
  "article",
  "docs",
  "discussion",
  "qa",
  "repo",
  "lyrics",
  "chat",
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

function hostnameFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
}

function pathFromUrl(url) {
  try {
    return new URL(url).pathname.toLowerCase();
  } catch {
    return "/";
  }
}

function queryFromUrl(url) {
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

function textLength(profile) {
  return normalizeText(profile?.fullText || profile?.displayFullText || profile?.snippet).length;
}

function detectPurpose(profile) {
  const pageType = normalizeText(profile?.pageType || profile?.page_type).toLowerCase();
  const title = normalizeText(profile?.title, 160).toLowerCase();
  const subject = normalizeText(profile?.subject, 160).toLowerCase();
  const domain = hostnameFromUrl(profile?.url || "") || normalizeText(profile?.domain).toLowerCase();
  const path = pathFromUrl(profile?.url || "");
  const query = queryFromUrl(profile?.url || "");
  const snippet = normalizeText(profile?.snippet, 280).toLowerCase();
  const fullText = normalizeText(profile?.fullText || profile?.displayFullText, 1200).toLowerCase();
  const length = textLength(profile);

  if (!profile?.url) {
    return "shell";
  }
  if (pageType === "search" || query) {
    return "search_results";
  }
  if (pageType) {
    return pageType;
  }
  if (/(login|sign in|sign-in|log in|auth|authentication|verify|two-factor|2fa)/i.test(`${title} ${path}`)) {
    return "auth";
  }
  if (/(settings|preferences|account|profile|notifications|billing|privacy)/i.test(`${title} ${path}`)) {
    return "settings";
  }
  if (SEARCH_ENGINE_DOMAINS.has(domain) && !query) {
    return "shell";
  }
  if (/(home|new tab|start page)/i.test(title) && length < 280) {
    return "shell";
  }
  if (/(feed|timeline|for you|discover)/i.test(`${title} ${subject} ${snippet}`) && length < 480) {
    return "feed";
  }
  if (length < 180 && !subject && !snippet) {
    return "shell";
  }
  return "web";
}

function regionPreset(purpose) {
  switch (purpose) {
    case "article":
    case "docs":
    case "discussion":
    case "qa":
      return ["title", "headings", "main_content", "code_blocks"];
    case "repo":
      return ["title", "repo_header", "readme", "issue_body", "file_view"];
    case "chat":
      return ["conversation_turns", "selected_text", "latest_answer"];
    case "lyrics":
      return ["title", "lyrics_body"];
    case "video":
      return ["title", "channel", "description", "transcript"];
    case "product":
      return ["title", "specs", "description", "price"];
    case "social":
    case "feed":
      return ["post_body", "thread", "author_context"];
    case "search_results":
      return ["search_query", "answer_box", "result_cards"];
    case "auth":
    case "settings":
      return ["title", "meta_description"];
    case "shell":
      return ["title", "url"];
    default:
      return ["title", "main_content", "meta_description"];
  }
}

function captureModeForPurpose(purpose, profile) {
  const length = textLength(profile);
  if (purpose === "shell") {
    return "skip";
  }
  if (purpose === "auth") {
    return "skip";
  }
  if (purpose === "settings") {
    return "metadata";
  }
  if (purpose === "search_results") {
    return "structured";
  }
  if (purpose === "video" || purpose === "product" || purpose === "social" || purpose === "feed") {
    return length >= 480 ? "full" : "structured";
  }
  if (HIGH_VALUE_TYPES.has(purpose)) {
    return "full";
  }
  if (length >= 520) {
    return "full";
  }
  if (length >= 180) {
    return "structured";
  }
  return "metadata";
}

function reasonForIntent(purpose, captureMode, profile) {
  const domain = hostnameFromUrl(profile?.url || "") || "this site";
  if (captureMode === "skip") {
    return purpose === "auth"
      ? "Authentication pages should not be stored as citation evidence."
      : `This looks like low-value browser chrome on ${domain}.`;
  }
  if (captureMode === "metadata") {
    return `Capture lightweight metadata only for this ${purpose.replace(/_/g, " ")} page.`;
  }
  if (captureMode === "structured") {
    return `Prefer structured extraction for this ${purpose.replace(/_/g, " ")} page.`;
  }
  return `Capture the full readable content for this ${purpose.replace(/_/g, " ")} page.`;
}

export function inferCaptureIntent(profile) {
  const privacy = classifyCapturePrivacy(profile);
  if (privacy.action === "block") {
    return {
      version: 1,
      pagePurpose: "sensitive",
      captureMode: "skip",
      targetRegions: [],
      shouldCapture: false,
      shouldSkip: true,
      shouldCaptureFullText: false,
      shouldPreferStructured: false,
      shouldKeepMetadataOnly: false,
      query: "",
      privacy,
      reason: privacy.reason,
    };
  }

  const purpose = detectPurpose(profile);
  const captureMode = captureModeForPurpose(purpose, profile);
  const query = queryFromUrl(profile?.url || "");
  const targetRegions = regionPreset(purpose);
  const shouldCapture = captureMode !== "skip";

  return {
    version: 1,
    pagePurpose: purpose,
    captureMode,
    targetRegions,
    shouldCapture,
    shouldSkip: !shouldCapture,
    shouldCaptureFullText: captureMode === "full",
    shouldPreferStructured: captureMode === "structured",
    shouldKeepMetadataOnly: captureMode === "metadata",
    query,
    privacy,
    reason: reasonForIntent(purpose, captureMode, profile),
  };
}
