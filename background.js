import {
  appendGraphPacket,
  appendEvent,
  clearBootstrapImportedEvents,
  clearAllData,
  cosineSimilarity,
  getContentUnitCount,
  getEventCount,
  getGraphPacketCount,
  getLatestEventTimestamp,
  getLatestGraphPacketTimestamp,
  getPendingMediaJobCount,
  getRecentEvents,
  getSessionCount,
  getStats,
  initDB,
} from "./db.js";
import {
  buildSuggestionQueries,
  extractContextProfile,
  shouldSkipCaptureProfile,
} from "./context-pipeline.js";
import { classifyLocalPage } from "./page-intelligence.js";
import { inferCaptureIntent } from "./capture-intent.js";
import { auditCapturedContent } from "./clutter-audit.js";
import { applySelectiveRetention, evaluateSelectiveMemory } from "./selective-memory.js";
import { extractKeyphrases } from "./keywords.js";
import { answerLocalQuery } from "./query-engine.js";
import { extractPdfTextFromUrl, looksLikePdfResource } from "./pdf-support.js";
import { getIndexedSearchCandidates, invalidateEventSearchIndex } from "./search-index.js";
import { buildCapturePacket } from "./capture-packet.js";
import { buildMultimediaGraphPacket } from "./multimedia-graph.js";
import { classifyCapturePrivacy, redactPrivateCapture } from "./privacy-boundary.js";
import {
  getActivities as getCaptureActivities,
  getCaptureSnapshot,
  getContentUnits as getCaptureContentUnits,
  getEvents as getCaptureEvents,
  getGraphPackets as getCaptureGraphPackets,
  getMediaJobs as getCaptureMediaJobs,
  getSessions as getCaptureSessions,
} from "./capture-api.js";
import {
  beginBootstrapImport,
  getBootstrapImportState,
  resetBootstrapImportState,
} from "./bootstrap-import.js";

const EXTENSION_VERSION = chrome.runtime.getManifest().version;
const MEMACT_SITE_URL = "https://www.memact.com";
const SNIPPET_MAX_LEN = 280;
const FULL_TEXT_MAX_LEN = 8000;
const EMBED_WORKER_URL = chrome.runtime.getURL("embed-worker.js");
const INTERACTION_CAPTURE_HINT_DELAY_MS = 1200;
const INTERACTION_CAPTURE_MIN_INTERVAL_MS = 12000;
const AUTO_CAPTURE_HEARTBEAT_MS = 90000;
const AUTO_CAPTURE_MUTATION_DELAY_MS = 2200;
const AUTO_CAPTURE_REASON_MAX_AGE_MS = 15000;
const CAPTURE_AUTHORIZED_ORIGINS_KEY = "capture_authorized_origins";
const DEVICE_HELPER_BASE_URL = "http://127.0.0.1:38489";
const DEVICE_HELPER_LAST_SEQ_KEY = "device_helper_last_seq";
const DEVICE_HELPER_STATUS_KEY = "device_helper_status";
const DEVICE_HELPER_ALARM_NAME = "memact_device_helper_poll";
const DEVICE_HELPER_POLL_MS = 15000;
const DEVICE_HELPER_ALARM_MINUTES = 1;

let embedWorker = null;
let embedWorkerReady = false;
let embedPending = new Map();
let snapshotTimer = null;
let memoryPulseTimer = null;
let deviceHelperPollTimer = null;
let deviceHelperPollInFlight = false;
let authorizedBridgeOrigins = new Set();
let snapshotInFlight = false;
let snapshotQueuedWhileRunning = false;
const readabilityInjectionState = new Map();
const SNAPSHOT_DEBOUNCE_MS = 450;

function normalizeHostname(hostname) {
  return String(hostname || "")
    .toLowerCase()
    .replace(/^\[/, "")
    .replace(/\]$/, "");
}

function isAllowedMemactOrigin(origin) {
  try {
    const url = new URL(origin);
    const hostname = normalizeHostname(url.hostname);
    if (/^https?:$/i.test(url.protocol) === false) {
      return false;
    }
    if (/(^|\.)memact\.com$/i.test(hostname)) {
      return true;
    }
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "0.0.0.0" ||
      hostname === "::1"
    );
  } catch {
    return false;
  }
}

function normalizeOrigin(value) {
  try {
    const url = new URL(value);
    return `${url.protocol}//${normalizeHostname(url.hostname)}${url.port ? `:${url.port}` : ""}`;
  } catch {
    return "";
  }
}

function isEligiblePageOrigin(origin) {
  try {
    const url = new URL(origin);
    return /^https?:$/i.test(url.protocol);
  } catch {
    return false;
  }
}

async function refreshAuthorizedBridgeOrigins() {
  try {
    const stored = await chrome.storage.local.get(CAPTURE_AUTHORIZED_ORIGINS_KEY);
    const origins = Array.isArray(stored?.[CAPTURE_AUTHORIZED_ORIGINS_KEY])
      ? stored[CAPTURE_AUTHORIZED_ORIGINS_KEY]
      : [];
    authorizedBridgeOrigins = new Set(
      origins
        .map((origin) => normalizeOrigin(origin))
        .filter(Boolean)
    );
  } catch {
    authorizedBridgeOrigins = new Set();
  }
}

async function buildMemoryStatus() {
  const [
    eventCount,
    sessionCount,
    lastEventAt,
    graphPacketCount,
    contentUnitCount,
    pendingMediaJobCount,
    lastGraphPacketAt,
    bootstrapState,
    storedDeviceHelperStatus,
  ] = await Promise.all([
    getEventCount(),
    getSessionCount(),
    getLatestEventTimestamp(),
    getGraphPacketCount(),
    getContentUnitCount(),
    getPendingMediaJobCount(),
    getLatestGraphPacketTimestamp(),
    getBootstrapImportState(),
    chrome.storage.local.get(DEVICE_HELPER_STATUS_KEY).catch(() => ({})),
  ]);
  const deviceHelperStatus = storedDeviceHelperStatus?.[DEVICE_HELPER_STATUS_KEY] || {
    connected: false,
    latest_seq: 0,
    last_seen_at: "",
  };

  const memorySignature = [
    eventCount,
    sessionCount,
    graphPacketCount,
    contentUnitCount,
    pendingMediaJobCount,
    normalizeText(lastEventAt, 80),
    normalizeText(lastGraphPacketAt, 80),
    normalizeText(bootstrapState?.status, 32),
    normalizeText(bootstrapState?.imported_at, 80),
    Number(bootstrapState?.imported_count || 0),
    Number(deviceHelperStatus.latest_seq || 0),
    deviceHelperStatus.connected ? "device_connected" : "device_disconnected",
  ].join("|");

  return {
    ready: true,
    eventCount,
    sessionCount,
    lastEventAt,
    graphPacketCount,
    contentUnitCount,
    pendingMediaJobCount,
    lastGraphPacketAt,
    modelReady: Boolean(embedWorkerReady),
    extensionVersion: EXTENSION_VERSION,
    captureSchemaVersion: 3,
    memorySignature,
    sync: {
      mode: "memory_pulse_bridge",
      automaticCapture: true,
      automaticDownloads: false,
      deviceHelper: deviceHelperStatus.connected ? "connected" : "not_connected",
    },
    device_helper: deviceHelperStatus,
    bootstrap: bootstrapState,
  };
}

function bridgePulseUrlPatterns() {
  const patterns = new Set([
    "https://memact.com/*",
    "https://www.memact.com/*",
    "http://localhost/*",
    "https://localhost/*",
    "http://127.0.0.1/*",
    "https://127.0.0.1/*",
    "http://0.0.0.0/*",
    "https://0.0.0.0/*",
  ]);

  for (const origin of authorizedBridgeOrigins) {
    if (/^https?:\/\//i.test(origin)) {
      patterns.add(`${origin}/*`);
    }
  }

  return [...patterns];
}

async function broadcastMemoryPulse(reason = "capture") {
  const pulse = await buildMemoryStatus();
  pulse.sync = {
    ...pulse.sync,
    reason: normalizeText(reason, 48) || "capture",
    emittedAt: new Date().toISOString(),
  };

  const tabs = await chrome.tabs.query({
    url: bridgePulseUrlPatterns(),
  });

  await Promise.all(
    tabs.map((tab) =>
      tab?.id
        ? chrome.tabs
            .sendMessage(tab.id, {
              type: "MEMACT_MEMORY_PULSE",
              pulse,
            })
            .catch(() => {})
        : Promise.resolve()
    )
  );
}

function scheduleMemoryPulse(reason = "capture") {
  clearTimeout(memoryPulseTimer);
  memoryPulseTimer = setTimeout(() => {
    broadcastMemoryPulse(reason).catch(() => {});
  }, 700);
}

function ensureAutoExportAlarm() {
  scheduleMemoryPulse("compat_auto_export_removed");
}

function scheduleDeviceHelperPoll(delayMs = DEVICE_HELPER_POLL_MS) {
  clearTimeout(deviceHelperPollTimer);
  deviceHelperPollTimer = setTimeout(() => {
    pollDeviceHelper().catch(() => {});
  }, Math.max(1000, Number(delayMs || DEVICE_HELPER_POLL_MS)));
}

function ensureDeviceHelperAlarm() {
  if (chrome.alarms?.create) {
    chrome.alarms.create(DEVICE_HELPER_ALARM_NAME, {
      delayInMinutes: 1,
      periodInMinutes: DEVICE_HELPER_ALARM_MINUTES,
    });
  }
  scheduleDeviceHelperPoll(2500);
}

async function getDeviceHelperCursor() {
  try {
    const stored = await chrome.storage.local.get(DEVICE_HELPER_LAST_SEQ_KEY);
    return Number(stored?.[DEVICE_HELPER_LAST_SEQ_KEY] || 0) || 0;
  } catch {
    return 0;
  }
}

async function rememberDeviceHelperState(status) {
  await chrome.storage.local.set({
    [DEVICE_HELPER_LAST_SEQ_KEY]: Number(status.latest_seq || 0) || 0,
    [DEVICE_HELPER_STATUS_KEY]: {
      connected: Boolean(status.connected),
      latest_seq: Number(status.latest_seq || 0) || 0,
      last_seen_at: status.last_seen_at || new Date().toISOString(),
      last_error: normalizeText(status.last_error, 180),
      platform: normalizeText(status.platform, 40),
      ocr_enabled: Boolean(status.ocr_enabled),
      raw_media_retained: Boolean(status.raw_media_retained),
      imported_count: Number(status.imported_count || 0),
    },
  });
}

async function ingestDeviceHelperRecords(records = []) {
  let importedCount = 0;

  for (const record of records) {
    const event = record?.event && typeof record.event === "object" ? record.event : null;
    const graphPacket =
      record?.graph_packet && typeof record.graph_packet === "object" ? record.graph_packet : null;
    let eventId = null;

    if (event) {
      const result = await appendEvent(event).catch(() => null);
      if (result && !result.skipped && result.id) {
        eventId = result.id;
        importedCount += 1;
      }
    }

    if (graphPacket) {
      await appendGraphPacket({
        ...graphPacket,
        event_id: eventId || graphPacket.event_id || null,
      }).catch(() => null);
    }
  }

  if (importedCount > 0 || records.length > 0) {
    invalidateEventSearchIndex();
    scheduleMemoryPulse("device_helper_ingest");
  }

  return importedCount;
}

async function pollDeviceHelper() {
  if (deviceHelperPollInFlight) {
    return;
  }
  deviceHelperPollInFlight = true;
  let nextDelay = DEVICE_HELPER_POLL_MS;

  try {
    const afterSeq = await getDeviceHelperCursor();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3500);
    const response = await fetch(
      `${DEVICE_HELPER_BASE_URL}/capture/snapshot?after_seq=${encodeURIComponent(afterSeq)}&limit=80`,
      {
        cache: "no-store",
        signal: controller.signal,
      }
    );
    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(`device helper returned ${response.status}`);
    }

    const snapshot = await response.json();
    const records = Array.isArray(snapshot?.records) ? snapshot.records : [];
    const importedCount = await ingestDeviceHelperRecords(records);
    const latestSeq = Math.max(
      afterSeq,
      Number(snapshot?.latest_seq || 0) || 0,
      ...records.map((record) => Number(record?.seq || 0) || 0)
    );

    await rememberDeviceHelperState({
      connected: true,
      latest_seq: latestSeq,
      last_seen_at: new Date().toISOString(),
      last_error: "",
      platform: snapshot?.platform,
      ocr_enabled: snapshot?.ocr_enabled,
      raw_media_retained: snapshot?.raw_media_retained,
      imported_count: importedCount,
    });
  } catch (error) {
    nextDelay = DEVICE_HELPER_POLL_MS * 2;
    const previousSeq = await getDeviceHelperCursor();
    await rememberDeviceHelperState({
      connected: false,
      latest_seq: previousSeq,
      last_seen_at: new Date().toISOString(),
      last_error: String(error?.message || error || "device helper unavailable"),
    }).catch(() => {});
  } finally {
    deviceHelperPollInFlight = false;
    scheduleDeviceHelperPoll(nextDelay);
  }
}

async function authorizeOrigin(origin) {
  const normalizedOrigin = normalizeOrigin(origin);
  if (!normalizedOrigin || isAllowedMemactOrigin(normalizedOrigin)) {
    return normalizedOrigin;
  }
  const nextOrigins = [...new Set([...authorizedBridgeOrigins, normalizedOrigin])];
  await chrome.storage.local.set({
    [CAPTURE_AUTHORIZED_ORIGINS_KEY]: nextOrigins,
  });
  authorizedBridgeOrigins = new Set(nextOrigins);
  return normalizedOrigin;
}

function hasAuthorizedOrigin(origin) {
  const normalizedOrigin = normalizeOrigin(origin);
  if (!normalizedOrigin) {
    return false;
  }
  return isAllowedMemactOrigin(normalizedOrigin) || authorizedBridgeOrigins.has(normalizedOrigin);
}

function detectBrowserKey() {
  const userAgent = navigator.userAgent || "";
  if (userAgent.includes("Edg/")) return "edge";
  if (userAgent.includes("OPR/")) return "opera";
  if (userAgent.includes("Vivaldi/")) return "vivaldi";
  if (userAgent.includes("Brave/")) return "brave";
  return "chrome";
}

function normalizeText(value, maxLen) {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  return maxLen && text.length > maxLen ? `${text.slice(0, maxLen - 3)}...` : text;
}

function toTitleCase(value) {
  return String(value || "")
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function normalizeRichText(value, maxLen) {
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
  if (!normalized) return "";
  return maxLen && normalized.length > maxLen ? normalized.slice(0, maxLen) : normalized;
}

function redactActiveContextForStorage(active = {}) {
  return {
    ...active,
    snippet: redactPrivateCapture(active.snippet),
    fullText: redactPrivateCapture(active.fullText),
    selection: redactPrivateCapture(active.selection),
    contentUnits: Array.isArray(active.contentUnits)
      ? active.contentUnits.map((unit) => ({
          ...unit,
          text: redactPrivateCapture(unit?.text),
          caption: redactPrivateCapture(unit?.caption),
          alt: redactPrivateCapture(unit?.alt),
          image: unit?.image
            ? {
                ...unit.image,
                alt: redactPrivateCapture(unit.image.alt),
                caption: redactPrivateCapture(unit.image.caption),
              }
            : unit?.image,
        }))
      : [],
  };
}

function hostnameFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function shouldIgnoreCapturedPage(url, pageTitle = "") {
  try {
    const parsed = new URL(url);
    const hostname = normalizeHostname(parsed.hostname);
    const title = normalizeText(pageTitle, 200).toLowerCase();
    const isLocalHost =
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "0.0.0.0" ||
      hostname === "::1";

    if (/(^|\.)memact\.com$/i.test(hostname)) {
      return true;
    }

    if (isLocalHost && (parsed.port === "5173" || parsed.port === "4173" || title.includes("memact"))) {
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

function buildSearchableText(tabData, contextProfile = null) {
  const active = tabData.activeContext || {};
  const capturePacket = contextProfile?.capturePacket || {};
  const retainedFullText =
    contextProfile?.displayFullText || contextProfile?.fullText || active.fullText || "";
  const retainedSnippet =
    contextProfile?.displayExcerpt || contextProfile?.snippet || active.snippet || "";
  const derivativeText = Array.isArray(contextProfile?.derivativeItems)
    ? contextProfile.derivativeItems.map((item) => `${item.label || ""} ${item.text || ""}`).join(" ")
    : "";
  return [
    tabData.browser,
    active.pageTitle,
    active.h1,
    active.description,
    active.selection,
    tabData.activeTab?.url || "",
    retainedSnippet,
    retainedFullText.slice(0, 1200),
    contextProfile?.subject || "",
    Array.isArray(contextProfile?.entities) ? contextProfile.entities.join(" ") : "",
    Array.isArray(contextProfile?.topics) ? contextProfile.topics.join(" ") : "",
    Array.isArray(contextProfile?.factItems)
      ? contextProfile.factItems.map((item) => `${item.label} ${item.value}`).join(" ")
      : "",
    derivativeText,
    Array.isArray(capturePacket?.points) ? capturePacket.points.join(" ") : "",
    Array.isArray(capturePacket?.searchTerms) ? capturePacket.searchTerms.join(" ") : "",
    Array.isArray(capturePacket?.blocks)
      ? capturePacket.blocks.map((block) => `${block.label || ""} ${block.text || ""}`).join(" ")
      : "",
    contextProfile?.structuredSummary || "",
    contextProfile?.contextText || "",
    contextProfile?.captureIntent?.pagePurpose || "",
    Array.isArray(contextProfile?.captureIntent?.targetRegions)
      ? contextProfile.captureIntent.targetRegions.join(" ")
      : "",
    contextProfile?.clutterAudit?.summary || ""
  ]
    .filter(Boolean)
    .join(" ");
}

function chooseStoredCaptureContent(active, initialProfile, captureIntent, clutterAudit) {
  const summarySnippet = normalizeText(
    initialProfile.structuredSummary || initialProfile.displayExcerpt || active.snippet,
    SNIPPET_MAX_LEN
  );
  const structuredFullText = normalizeRichText(
    initialProfile.displayFullText || initialProfile.displayExcerpt || summarySnippet,
    FULL_TEXT_MAX_LEN
  );
  const readableFullText = normalizeRichText(
    initialProfile.fullText || active.fullText || structuredFullText,
    FULL_TEXT_MAX_LEN
  );
  const searchFallbackFullText =
    captureIntent?.pagePurpose === "search_results" &&
    /No clean result cards were captured\./i.test(structuredFullText) &&
    readableFullText
      ? readableFullText
      : structuredFullText

  if (!captureIntent.shouldCapture || clutterAudit.shouldSkip) {
    return { snippet: "", fullText: "" };
  }

  if (captureIntent.shouldKeepMetadataOnly) {
    return {
      snippet: summarySnippet,
      fullText: "",
    };
  }

  if (captureIntent.shouldPreferStructured || clutterAudit.shouldPreferStructured) {
    return {
      snippet: summarySnippet,
      fullText: searchFallbackFullText,
    };
  }

  return {
    snippet: normalizeText(active.snippet || summarySnippet, SNIPPET_MAX_LEN) || summarySnippet,
    fullText: readableFullText,
  };
}

function mergeUniqueStrings(values, limit = 24) {
  const seen = new Set();
  const output = [];
  for (const value of values) {
    const normalized = normalizeText(value, 120);
    if (!normalized) {
      continue;
    }
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(normalized);
    if (output.length >= limit) {
      break;
    }
  }
  return output;
}

function normalizeVector(vector) {
  let norm = 0;
  for (const value of vector) {
    norm += value * value;
  }
  norm = Math.sqrt(norm) || 1;
  return vector.map((value) => value / norm);
}

function shouldPreferPdfExtraction(fullText = "") {
  const normalized = normalizeRichText(fullText, 0);
  if (!normalized) {
    return true;
  }
  if (normalized.length < 320) {
    return true;
  }
  const missingGlyphs = (normalized.match(/[□�]/g) || []).length;
  return missingGlyphs >= 4;
}

async function hashEmbedding(text, dim = 384) {
  const vector = new Array(dim).fill(0);
  const tokens = String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9@#./+-]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  for (const token of tokens) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
    const bytes = new Uint8Array(digest);
    for (let i = 0; i < bytes.length; i += 1) {
      const slot = (bytes[i] + i * 17) % dim;
      const sign = bytes[(i + 11) % bytes.length] % 2 === 0 ? 1 : -1;
      vector[slot] += sign * (1 + bytes[i] / 255);
    }
  }

  return normalizeVector(vector);
}

function ensureEmbedWorker() {
  if (embedWorker) {
    return embedWorker;
  }

  try {
    embedWorker = new Worker(EMBED_WORKER_URL);
    embedWorker.addEventListener("message", (event) => {
      const message = event.data || {};
      if (message.type === "loading_progress") {
        embedWorkerReady = false;
        return;
      }
      if (message.type === "status_result") {
        embedWorkerReady = Boolean(message.ready);
        return;
      }
      if (message.type === "embed_result") {
        embedWorkerReady = true;
        const pending = embedPending.get(message.id);
        if (pending) {
          embedPending.delete(message.id);
          pending.resolve(Array.isArray(message.embedding) ? message.embedding : []);
        }
        return;
      }
      if (message.type === "embed_error") {
        const pending = embedPending.get(message.id);
        if (pending) {
          embedPending.delete(message.id);
          pending.reject(new Error(message.error || "embedding failed"));
        }
      }
    });
    embedWorker.addEventListener("error", () => {
      embedWorkerReady = false;
    });
  } catch {
    embedWorker = null;
  }

  return embedWorker;
}

function isAllowedBridgeSender(sender) {
  if (!sender?.url) {
    return true;
  }

  return hasAuthorizedOrigin(sender.url);
}

function resolveInteractionType(active = {}) {
  const captureReason = normalizeText(active.captureReason, 48).toLowerCase();
  if (captureReason) {
    if (captureReason.includes("input") || captureReason.includes("type")) {
      return "type";
    }
    if (captureReason.includes("selection") || captureReason.includes("mouseup")) {
      return "select";
    }
    if (captureReason.includes("scroll")) {
      return "scroll";
    }
    if (captureReason.includes("media")) {
      return "media";
    }
    if (
      captureReason.includes("heartbeat") ||
      captureReason.includes("focus") ||
      captureReason.includes("visible") ||
      captureReason.includes("pageshow")
    ) {
      return "dwell";
    }
    if (captureReason.includes("content")) {
      return "content_change";
    }
    if (captureReason.includes("history") || captureReason.includes("route")) {
      return "navigate";
    }
  }

  if (active.typingActive) {
    return "type";
  }
  if (active.selectionActive) {
    return "select";
  }
  if (active.scrollingActive) {
    return "scroll";
  }
  if (active.mediaActive) {
    return "media";
  }
  if (active.passiveViewingActive) {
    return "dwell";
  }
  return "navigate";
}

async function embedText(text) {
  try {
    const worker = ensureEmbedWorker();
    if (!worker) {
      return hashEmbedding(text);
    }

    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const resultPromise = new Promise((resolve, reject) => {
      embedPending.set(id, { resolve, reject });
    });
    worker.postMessage({ type: "embed", text: String(text || ""), id });

    const timeout = new Promise((_, reject) => {
      setTimeout(() => reject(new Error("embedding timeout")), 3000);
    });

    return await Promise.race([resultPromise, timeout]).catch(() => hashEmbedding(text));
  } catch {
    return hashEmbedding(text);
  }
}

async function injectReadability(tabId) {
  if (!Number.isInteger(Number(tabId))) {
    return false;
  }

  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const tabUrl = normalizeText(tab?.url, 1000);
  if (!tabUrl) {
    return false;
  }
  const currentState = readabilityInjectionState.get(tabId);
  if (currentState?.url === tabUrl) {
    if (currentState.status === "ready") {
      return true;
    }
    if (currentState.status === "failed") {
      return false;
    }
  } else {
    readabilityInjectionState.delete(tabId);
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["Readability.js"]
    });
    readabilityInjectionState.set(tabId, {
      status: "ready",
      url: tabUrl,
    });
    return true;
  } catch {
    readabilityInjectionState.set(tabId, {
      status: "failed",
      url: tabUrl,
    });
    return false;
  }
}

async function captureActiveTabContext(tab) {
  if (!tab || !tab.id || !tab.url) {
    return null;
  }
  if (!/^https?:|^file:/i.test(tab.url)) {
    return null;
  }

  try {
    const readabilityReady = await injectReadability(tab.id);
    const [injected] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      args: [
        SNIPPET_MAX_LEN,
        FULL_TEXT_MAX_LEN,
        readabilityReady,
        INTERACTION_CAPTURE_HINT_DELAY_MS,
        INTERACTION_CAPTURE_MIN_INTERVAL_MS,
        AUTO_CAPTURE_HEARTBEAT_MS,
        AUTO_CAPTURE_MUTATION_DELAY_MS,
        AUTO_CAPTURE_REASON_MAX_AGE_MS,
      ],
      func: async (
        snippetMaxLen,
        fullTextMaxLen,
        canUseReadability,
        interactionCaptureHintDelayMs,
        interactionCaptureMinIntervalMs,
        autoCaptureHeartbeatMs,
        autoCaptureMutationDelayMs,
        autoCaptureReasonMaxAgeMs
      ) => {
        if (!window.__memactCaptureInstalled) {
          window.__memactCaptureInstalled = true;
          window.__memactLastInputAt = 0;
          window.__memactLastScrollAt = 0;
          window.__memactLastSelectionAt = 0;
          window.__memactLastVisibilityAt = 0;
          window.__memactLastMediaAt = 0;
          window.__memactLastContentChangeAt = 0;
          window.__memactLastCaptureReason = "navigate";
          window.__memactLastCaptureReasonAt = Date.now();
          window.__memactLastObservedUrl = location.href;
          window.__memactLastObservedTitle = document.title || "";
          window.__memactLastObservedSignature = "";
          window.__memactCaptureHintTimer = null;
          window.__memactMutationHintTimer = null;
          window.__memactLastCaptureHintAt = 0;
          const normalizeVisibleText = (value) =>
            String(value || "")
              .replace(/\s+/g, " ")
              .trim();
          const buildLightweightSignature = () => {
            const mainNode =
              document.querySelector("main, article, [role='main'], [role='article']") ||
              document.body;
            const excerpt = normalizeVisibleText(mainNode?.innerText || "").slice(0, 320);
            return [location.pathname, document.title || "", excerpt]
              .filter(Boolean)
              .join(" | ")
              .slice(0, 720);
          };
          const scheduleCaptureHint = (reason, delay = interactionCaptureHintDelayMs) => {
            const now = Date.now();
            if (now - (window.__memactLastCaptureHintAt || 0) < interactionCaptureMinIntervalMs) {
              return;
            }
            clearTimeout(window.__memactCaptureHintTimer);
            window.__memactCaptureHintTimer = setTimeout(() => {
              window.__memactLastCaptureHintAt = Date.now();
              window.__memactLastCaptureReason = String(reason || "interaction");
              window.__memactLastCaptureReasonAt = Date.now();
              try {
                chrome.runtime?.sendMessage?.({
                  type: "captureHint",
                  reason: String(reason || "interaction"),
                });
              } catch {
                // Keep capture local when the runtime bridge is unavailable.
              }
            }, delay);
          };
          window.addEventListener("input", () => {
            window.__memactLastInputAt = Date.now();
            scheduleCaptureHint("input", 900);
          }, true);
          window.addEventListener("scroll", () => {
            window.__memactLastScrollAt = Date.now();
            scheduleCaptureHint("scroll", 1600);
          }, true);
          document.addEventListener("selectionchange", () => {
            const selectionText = window.getSelection?.()?.toString?.() || "";
            if (!String(selectionText || "").trim()) {
              return;
            }
            window.__memactLastSelectionAt = Date.now();
            scheduleCaptureHint("selection", 700);
          }, true);
          window.addEventListener("mouseup", () => {
            const selectionText = window.getSelection?.()?.toString?.() || "";
            if (!String(selectionText || "").trim()) {
              return;
            }
            window.__memactLastSelectionAt = Date.now();
            scheduleCaptureHint("mouseup", 700);
          }, true);
          document.addEventListener("visibilitychange", () => {
            if (document.visibilityState === "visible") {
              window.__memactLastVisibilityAt = Date.now();
              scheduleCaptureHint("visible", 1100);
            }
          }, true);
          window.addEventListener("focus", () => {
            window.__memactLastVisibilityAt = Date.now();
            scheduleCaptureHint("focus", 1100);
          }, true);
          window.addEventListener("pageshow", () => {
            window.__memactLastVisibilityAt = Date.now();
            scheduleCaptureHint("pageshow", 900);
          }, true);
          window.addEventListener("play", (event) => {
            if (!(event.target instanceof HTMLMediaElement)) {
              return;
            }
            window.__memactLastMediaAt = Date.now();
            scheduleCaptureHint("media_play", 1800);
          }, true);
          const announceRouteChange = (reason = "history") => {
            const nextUrl = location.href;
            const nextTitle = document.title || "";
            if (
              nextUrl === window.__memactLastObservedUrl &&
              nextTitle === window.__memactLastObservedTitle
            ) {
              return;
            }
            window.__memactLastObservedUrl = nextUrl;
            window.__memactLastObservedTitle = nextTitle;
            window.__memactLastObservedSignature = buildLightweightSignature();
            scheduleCaptureHint(reason, 900);
          };
          const wrapHistoryMethod = (name) => {
            const original = history[name];
            if (typeof original !== "function") {
              return;
            }
            history[name] = function (...args) {
              const result = original.apply(this, args);
              setTimeout(() => announceRouteChange(name), 80);
              return result;
            };
          };
          wrapHistoryMethod("pushState");
          wrapHistoryMethod("replaceState");
          window.addEventListener("popstate", () => announceRouteChange("history"), true);
          window.addEventListener("hashchange", () => announceRouteChange("history"), true);
          window.__memactLastObservedSignature = buildLightweightSignature();
          const rootNode = document.documentElement || document.body;
          if (rootNode && typeof MutationObserver === "function") {
            const observer = new MutationObserver(() => {
              if (document.visibilityState !== "visible") {
                return;
              }
              clearTimeout(window.__memactMutationHintTimer);
              window.__memactMutationHintTimer = setTimeout(() => {
                const nextSignature = buildLightweightSignature();
                if (
                  !nextSignature ||
                  nextSignature === window.__memactLastObservedSignature
                ) {
                  return;
                }
                window.__memactLastObservedSignature = nextSignature;
                window.__memactLastContentChangeAt = Date.now();
                scheduleCaptureHint("content_change", 1000);
              }, autoCaptureMutationDelayMs);
            });
            observer.observe(rootNode, {
              childList: true,
              subtree: true,
              characterData: true,
            });
            window.__memactMutationObserver = observer;
          }
          window.__memactHeartbeatTimer = setInterval(() => {
            if (document.visibilityState !== "visible") {
              return;
            }
            if (typeof document.hasFocus === "function" && !document.hasFocus()) {
              return;
            }
            scheduleCaptureHint("heartbeat", 900);
          }, autoCaptureHeartbeatMs);
        }

        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const normalizeVisibleText = (value) =>
          String(value || "")
            .replace(/\s+/g, " ")
            .trim();
        const normalizeStructuredText = (value) =>
          String(value || "")
            .replace(/\r\n/g, "\n")
            .replace(/\r/g, "\n")
            .split(/\n{2,}/)
            .map((block) =>
              block
                .split(/\n+/)
                .map((line) => line.replace(/[ \t]+/g, " ").trim())
                .filter(Boolean)
                .join("\n")
            )
            .filter(Boolean)
            .join("\n\n")
            .trim();
        const isNoiseLineText = (line) => {
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
          if (/https?:\/\/\S+/i.test(line) && String(line).length < 180) {
            return true;
          }
          if (/@/.test(line) && lower.includes("contact")) {
            return true;
          }
          return false;
        };
        const cleanCapturedText = (value) => {
          const normalized = normalizeStructuredText(value);
          if (!normalized) {
            return "";
          }
          const lines = normalized
            .split(/\n+/)
            .map((line) => line.replace(/^lyrics\s*:\s*/i, "").trim())
            .filter((line) => line && !isNoiseLineText(line));
          const deduped = [];
          for (const line of lines) {
            if (deduped[deduped.length - 1]?.toLowerCase() === line.toLowerCase()) {
              continue;
            }
            deduped.push(line);
          }
          return deduped.join("\n").trim();
        };
        const hostname = location.hostname.replace(/^www\./, "");
        const isVisible = (node) => {
          if (!node || !(node instanceof Element)) {
            return false;
          }
          const style = window.getComputedStyle(node);
          if (style.display === "none" || style.visibility === "hidden") {
            return false;
          }
          const rect = node.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };
        const isNoiseNode = (node) => {
          if (!node || !(node instanceof Element)) {
            return false;
          }
          return Boolean(
            node.closest(
              "nav, header, footer, aside, [role='navigation'], [role='complementary'], [aria-label*='navigation' i], [class*='sidebar' i], [class*='nav' i], [class*='menu' i], [class*='footer' i], [class*='header' i], [class*='ad' i], [id*='ad' i]"
            )
          );
        };
        const collectRoots = () => {
          const roots = [document];
          const queue = [document.documentElement];
          const seen = new Set([document]);
          while (queue.length) {
            const node = queue.shift();
            if (!node || !(node instanceof Element)) {
              continue;
            }
            if (node.shadowRoot && !seen.has(node.shadowRoot)) {
              roots.push(node.shadowRoot);
              seen.add(node.shadowRoot);
              queue.push(node.shadowRoot);
            }
            for (const child of node.children || []) {
              queue.push(child);
            }
          }
          return roots;
        };
        const queryAllDeep = (selectors) => {
          const roots = collectRoots();
          const found = [];
          const seen = new Set();
          for (const root of roots) {
            for (const selector of selectors) {
              let nodes = [];
              try {
                nodes = Array.from(root.querySelectorAll(selector));
              } catch {
                nodes = [];
              }
              for (const node of nodes) {
                if (seen.has(node)) {
                  continue;
                }
                seen.add(node);
                found.push(node);
              }
            }
          }
          return found;
        };
        const nearestSectionHeading = (node) => {
          let current = node;
          for (let depth = 0; current && depth < 5; depth += 1) {
            const heading = current.querySelector?.("h1, h2, h3, [role='heading']");
            const headingText = normalizeVisibleText(heading?.innerText || heading?.textContent || "");
            if (headingText) {
              return headingText.slice(0, 140);
            }
            current = current.parentElement;
          }
          const previousHeading = node?.previousElementSibling?.matches?.("h1, h2, h3, [role='heading']")
            ? node.previousElementSibling
            : null;
          return normalizeVisibleText(previousHeading?.innerText || previousHeading?.textContent || "").slice(0, 140);
        };
        const pushContentUnit = (units, seen, unit) => {
          const text = normalizeVisibleText(unit?.text || "");
          if (!text || text.length < 8) {
            return;
          }
          const key = `${unit.unit_type || unit.location || "text"}|${text.slice(0, 180).toLowerCase()}`;
          if (seen.has(key)) {
            return;
          }
          seen.add(key);
          units.push({
            ...unit,
            text: text.slice(0, 1200),
          });
        };
        const collectTranscriptUnits = (units, seen) => {
          const transcriptSelectors = [
            "ytd-transcript-segment-renderer",
            "yt-formatted-string.segment-text",
            "[class*='transcript' i] [class*='segment' i]",
            "[class*='transcript' i] [class*='text' i]",
            "[data-testid*='transcript' i]",
            "[aria-label*='transcript' i]",
            "[class*='caption' i]",
            "[aria-label*='caption' i]",
            "track[kind='subtitles']",
            "track[kind='captions']"
          ];
          let index = 0;
          for (const node of queryAllDeep(transcriptSelectors)) {
            if (!(node instanceof Element) || isNoiseNode(node)) {
              continue;
            }
            const text =
              node.tagName === "TRACK"
                ? normalizeVisibleText(`${node.getAttribute("label") || ""} ${node.getAttribute("srclang") || ""} ${node.getAttribute("src") || ""}`)
                : normalizeVisibleText(node.innerText || node.textContent || "");
            if (!text || text.length < 8 || text.length > 900) {
              continue;
            }
            index += 1;
            pushContentUnit(units, seen, {
              unit_id: `transcript_${index}`,
              media_type: "video",
              unit_type: node.tagName === "TRACK" ? "caption_track" : "transcript_segment",
              text,
              location: "Transcript or captions",
              section: nearestSectionHeading(node),
              confidence: node.tagName === "TRACK" ? 0.54 : 0.82,
            });
            if (index >= 24) {
              break;
            }
          }
        };
        const collectDomTextUnits = (units, seen) => {
          const selectors = [
            "main h1",
            "main h2",
            "main h3",
            "article h1",
            "article h2",
            "article h3",
            "main p",
            "article p",
            "[role='main'] p",
            "[role='article'] p",
            "blockquote",
            "li"
          ];
          let index = 0;
          for (const node of queryAllDeep(selectors)) {
            if (!(node instanceof Element) || !isVisible(node) || isNoiseNode(node)) {
              continue;
            }
            const text = normalizeVisibleText(node.innerText || node.textContent || "");
            if (!text || text.length < 32 || text.length > 1600) {
              continue;
            }
            index += 1;
            const tag = node.tagName.toLowerCase();
            pushContentUnit(units, seen, {
              unit_id: `${tag}_${index}`,
              media_type: "article",
              unit_type: /^h[1-3]$/.test(tag) ? "heading" : tag === "li" ? "list_item" : "paragraph",
              text,
              location: /^h[1-3]$/.test(tag) ? "Heading" : "Page body",
              section: nearestSectionHeading(node),
              confidence: 0.72,
            });
            if (index >= 28) {
              break;
            }
          }
        };
        const collectImageUnits = (units, seen) => {
          let index = 0;
          for (const image of queryAllDeep(["figure img", "main img", "article img", "[role='main'] img", "img"])) {
            if (!(image instanceof HTMLImageElement) || !isVisible(image) || isNoiseNode(image)) {
              continue;
            }
            const rect = image.getBoundingClientRect();
            const width = Math.round(rect.width || image.naturalWidth || 0);
            const height = Math.round(rect.height || image.naturalHeight || 0);
            if (width < 140 || height < 80) {
              continue;
            }
            const figure = image.closest("figure");
            const caption = normalizeVisibleText(
              figure?.querySelector?.("figcaption")?.innerText ||
                image.closest("[aria-label]")?.getAttribute?.("aria-label") ||
                ""
            );
            const alt = normalizeVisibleText(image.alt || image.title || image.getAttribute("aria-label") || "");
            const filename = normalizeVisibleText((image.currentSrc || image.src || "").split("/").pop() || "");
            const text = normalizeVisibleText([alt, caption, filename].filter(Boolean).join(". "));
            const likelyText =
              /infographic|chart|diagram|slide|screenshot|meme|text|quote|poster|caption/i.test(`${alt} ${caption} ${filename}`) ||
              (width >= 420 && height >= 180 && text.length >= 16);
            if (!text && !likelyText) {
              continue;
            }
            index += 1;
            pushContentUnit(units, seen, {
              unit_id: `image_${index}`,
              media_type: "image",
              unit_type: text ? "image_context" : "image_ocr_candidate",
              text: text || "Image likely contains text; OCR pending.",
              location: "Image",
              section: nearestSectionHeading(image),
              confidence: text ? 0.58 : 0.34,
              image: {
                src: image.currentSrc || image.src || "",
                alt,
                caption,
                width,
                height,
                text_likelihood: likelyText ? "likely_text" : "context_only",
              },
            });
            if (index >= 12) {
              break;
            }
          }
        };
        const collectMediaElements = () =>
          queryAllDeep(["video", "audio"])
            .filter(
              (node) =>
                node instanceof HTMLMediaElement &&
                (node instanceof HTMLAudioElement || isVisible(node))
            )
            .slice(0, 6)
            .map((node, index) => ({
              id: `media_${index + 1}`,
              media_type: node instanceof HTMLVideoElement ? "video" : "audio",
              current_time: Number(node.currentTime || 0),
              duration: Number.isFinite(Number(node.duration)) ? Number(node.duration) : null,
              paused: Boolean(node.paused),
              muted: Boolean(node.muted),
              src: node.currentSrc || node.src || "",
            }));
        const collectContentUnits = () => {
          const units = [];
          const seen = new Set();
          collectTranscriptUnits(units, seen);
          collectDomTextUnits(units, seen);
          collectImageUnits(units, seen);
          const selectionText = normalizeVisibleText(window.getSelection?.()?.toString?.() || "");
          if (selectionText) {
            pushContentUnit(units, seen, {
              unit_id: "selection_1",
              media_type: "article",
              unit_type: "selected_text",
              text: selectionText,
              location: "User selection",
              confidence: 0.9,
            });
          }
          return units.slice(0, 48);
        };
        const scrapeNodeText = (node) => {
          if (!node || !isVisible(node) || isNoiseNode(node)) {
            return "";
          }
          return normalizeStructuredText(node.innerText || node.textContent || "");
        };
        const siteSelectors = [];
        if (hostname.includes("github.com")) siteSelectors.push(".markdown-body");
        if (hostname.includes("youtube.com")) siteSelectors.push("ytd-watch-metadata", "#description-inner");
        if (hostname.includes("twitter.com") || hostname.includes("x.com")) siteSelectors.push("[data-testid='tweetText']");
        if (hostname.includes("reddit.com")) siteSelectors.push("[data-testid='post-content']", ".md.feed-link-description");
        if (hostname.includes("discord.com")) siteSelectors.push("[class*='messageContent']");
        if (hostname.includes("google.com")) {
          siteSelectors.push("#search", "#rso", "#center_col", "[data-async-context*='query:']");
        }
        if (hostname.includes("bing.com")) {
          siteSelectors.push("#b_results", ".b_algo", "#results");
        }
        if (hostname.includes("duckduckgo.com")) {
          siteSelectors.push("[data-testid='mainline']", "[data-layout='organic']", "#links");
        }
        if (hostname.includes("search.brave.com")) {
          siteSelectors.push("#results", ".snippet", "[data-type='web']");
        }
        if (hostname.includes("search.yahoo.com")) {
          siteSelectors.push("#web", "#results", ".algo");
        }
        const generalSelectors = [
          "article",
          "main",
          "[role='main']",
          "[role='article']",
          ".content",
          ".post-body",
          ".article-body",
          "[class*='content']",
          "[class*='article']",
          "[class*='post-body']",
          "[class*='messageContent']",
          "[class*='message-content']",
          "[class*='messages']",
          "[class*='thread']",
          "[class*='conversation']",
          "[data-testid*='message']",
          "[data-testid*='conversation']",
          "[aria-live='polite']",
          "[aria-live='assertive']"
        ];
        const pickContentText = () => {
          const candidates = [];
          const seen = new Set();
          const isSearchEngineHost =
            hostname.includes("google.com") ||
            hostname.includes("bing.com") ||
            hostname.includes("duckduckgo.com") ||
            hostname.includes("search.brave.com") ||
            hostname.includes("search.yahoo.com");
          for (const node of queryAllDeep([...siteSelectors, ...generalSelectors])) {
            const text = scrapeNodeText(node);
            if (!text || text.length < (isSearchEngineHost ? 60 : 100)) {
              continue;
            }
            const key = text.slice(0, 800);
            if (seen.has(key)) {
              continue;
            }
            seen.add(key);
            candidates.push(text);
          }
          candidates.sort((left, right) => right.length - left.length);
          return isSearchEngineHost ? candidates.slice(0, 3).join("\n\n") : candidates[0] || "";
        };
        const visibleBodyText = () => {
          const text = normalizeStructuredText(document.body?.innerText || "");
          return text.length < 200 ? "" : text.slice(0, 3000);
        };
        const extractReadabilityText = async () => {
          if (!(canUseReadability && typeof Readability === "function")) {
            return "";
          }
          const parseArticle = () => {
            try {
              const articleData = new Readability(document.cloneNode(true)).parse();
              if (articleData?.content) {
                const container = document.createElement("div");
                container.innerHTML = articleData.content;
                const htmlText = normalizeStructuredText(
                  container.innerText || container.textContent || ""
                );
                if (htmlText) {
                  return htmlText;
                }
              }
              return normalizeStructuredText(articleData?.textContent || "");
            } catch {
              return "";
            }
          };
          let articleText = parseArticle();
          if (articleText) {
            return articleText.slice(0, fullTextMaxLen);
          }
          await wait(800);
          articleText = parseArticle();
          return articleText ? articleText.slice(0, fullTextMaxLen) : "";
        };
        const readMeta = (key, attr = "name") => {
          const selector = `meta[${attr}="${key}"]`;
          const el = document.querySelector(selector);
          return el ? el.getAttribute("content") || "" : "";
        };
        const ogTitle = readMeta("og:title", "property");
        const ogDescription = readMeta("og:description", "property");
        const description = readMeta("description") || ogDescription;
        const pageTitle = document.title || ogTitle || "";
        const h1 = document.querySelector("h1")?.innerText || "";
        const selection = window.getSelection()?.toString() || "";
        const pageContent = pickContentText();
        let fullText = await extractReadabilityText();
        if (!fullText || fullText.length < 100) {
          const scraped = pageContent;
          if (scraped && scraped.length >= 100) {
            fullText = scraped.slice(0, fullTextMaxLen);
          }
        }
        if (!fullText || fullText.length < 100) {
          const fallbackText = visibleBodyText();
          if (fallbackText) {
            fullText = fallbackText.slice(0, fullTextMaxLen);
          }
        }
        fullText = cleanCapturedText(fullText).slice(0, fullTextMaxLen);
        const snippetSource = fullText || pageContent || visibleBodyText() || "";
        const snippet = normalizeVisibleText(snippetSource).slice(0, snippetMaxLen);
        const now = Date.now();
        const activeEl = document.activeElement;
        const activeTag = activeEl?.tagName || "";
        const activeType = activeEl?.type || "";
        const isEditable = Boolean(activeEl?.isContentEditable);
        const typingActive =
          window.__memactLastInputAt &&
          now - window.__memactLastInputAt < 5000 &&
          (activeTag === "INPUT" || activeTag === "TEXTAREA" || isEditable);
        const scrollingActive =
          window.__memactLastScrollAt && now - window.__memactLastScrollAt < 4000;
        const selectionActive =
          window.__memactLastSelectionAt && now - window.__memactLastSelectionAt < 5000;
        const mediaActive = window.__memactLastMediaAt && now - window.__memactLastMediaAt < 15000;
        const passiveViewingActive =
          document.visibilityState === "visible" &&
          (typeof document.hasFocus !== "function" || document.hasFocus()) &&
          !typingActive &&
          !scrollingActive &&
          !selectionActive;
        const captureReason =
          window.__memactLastCaptureReason &&
          now - (window.__memactLastCaptureReasonAt || 0) < autoCaptureReasonMaxAgeMs
            ? String(window.__memactLastCaptureReason || "")
            : "";
        const contentUnits = collectContentUnits();
        const mediaElements = collectMediaElements();
        return {
          pageTitle,
          description,
          h1,
          selection,
          snippet,
          fullText,
          activeTag,
          activeType,
          typingActive,
          scrollingActive,
          selectionActive,
          mediaActive,
          passiveViewingActive,
          captureReason,
          contentUnits,
          mediaElements,
        };
      }
    });

    const result = injected && injected.result ? injected.result : null;
    if (!result) {
      return null;
    }

    const normalizedResult = {
      pageTitle: normalizeText(result.pageTitle, 140),
      description: normalizeText(result.description, 200),
      h1: normalizeText(result.h1, 120),
      selection: normalizeText(result.selection, 200),
      snippet: normalizeText(result.snippet, SNIPPET_MAX_LEN),
      fullText: normalizeRichText(result.fullText, FULL_TEXT_MAX_LEN),
      activeTag: normalizeText(result.activeTag, 40),
      activeType: normalizeText(result.activeType, 40),
      typingActive: Boolean(result.typingActive),
      scrollingActive: Boolean(result.scrollingActive),
      selectionActive: Boolean(result.selectionActive),
      mediaActive: Boolean(result.mediaActive),
      passiveViewingActive: Boolean(result.passiveViewingActive),
      captureReason: normalizeText(result.captureReason, 48),
      contentUnits: Array.isArray(result.contentUnits)
        ? result.contentUnits.slice(0, 48).map((unit) => ({
            unit_id: normalizeText(unit?.unit_id, 80),
            media_type: normalizeText(unit?.media_type, 40),
            unit_type: normalizeText(unit?.unit_type, 48),
            text: normalizeText(unit?.text, 1200),
            location: normalizeText(unit?.location, 80),
            section: normalizeText(unit?.section, 140),
            confidence: Number.isFinite(Number(unit?.confidence)) ? Number(unit.confidence) : 0.6,
            start: Number.isFinite(Number(unit?.start)) ? Number(unit.start) : undefined,
            end: Number.isFinite(Number(unit?.end)) ? Number(unit.end) : undefined,
            image: unit?.image && typeof unit.image === "object"
              ? {
                  src: normalizeText(unit.image.src, 400),
                  alt: normalizeText(unit.image.alt, 240),
                  caption: normalizeText(unit.image.caption, 320),
                  width: Number(unit.image.width || 0),
                  height: Number(unit.image.height || 0),
                  text_likelihood: normalizeText(unit.image.text_likelihood, 40),
                }
              : undefined,
          })).filter((unit) => unit.text)
        : [],
      mediaElements: Array.isArray(result.mediaElements)
        ? result.mediaElements.slice(0, 6).map((media) => ({
            id: normalizeText(media?.id, 80),
            media_type: normalizeText(media?.media_type, 32),
            current_time: Number(media?.current_time || 0),
            duration: Number.isFinite(Number(media?.duration)) ? Number(media.duration) : null,
            paused: Boolean(media?.paused),
            muted: Boolean(media?.muted),
            src: normalizeText(media?.src, 400),
          }))
        : [],
    };

    if (
      looksLikePdfResource(tab.url, normalizedResult.pageTitle) &&
      shouldPreferPdfExtraction(normalizedResult.fullText)
    ) {
      try {
        const pdfCapture = await extractPdfTextFromUrl(tab.url, normalizedResult.pageTitle, {
          maxPages: 10,
          maxChars: FULL_TEXT_MAX_LEN,
        });
        if (pdfCapture?.fullText) {
          normalizedResult.snippet =
            normalizeText(pdfCapture.snippet, SNIPPET_MAX_LEN) || normalizedResult.snippet;
          normalizedResult.fullText =
            normalizeRichText(pdfCapture.fullText, FULL_TEXT_MAX_LEN) || normalizedResult.fullText;
          const pdfUnit = {
            unit_id: "pdf_text_1",
            media_type: "pdf",
            unit_type: "pdf_text",
            text: normalizeText(pdfCapture.snippet || pdfCapture.fullText, 1200),
            location: "PDF text",
            section: normalizeText(normalizedResult.pageTitle, 140),
            confidence: 0.86,
          };
          normalizedResult.contentUnits = [
            pdfUnit,
            ...(Array.isArray(normalizedResult.contentUnits) ? normalizedResult.contentUnits : []),
          ].slice(0, 48);
        }
      } catch {
        // Fall back to the DOM capture when PDF extraction is unavailable.
      }
    }

    return normalizedResult;
  } catch {
    return null;
  }
}

async function processAndStore(tabData) {
  const active = tabData.activeContext || {};
  const initialFullText = active.fullText || "";
  const initialSnippet = active.snippet || "";
  const pageTitle = active.pageTitle || tabData.activeTab?.title || "";
  if (shouldIgnoreCapturedPage(tabData.activeTab?.url || "", pageTitle)) {
    return null;
  }
  const baseKeyphrases = extractKeyphrases(initialFullText || initialSnippet);
  const initialProfile = extractContextProfile({
    url: tabData.activeTab?.url || "",
    application: tabData.browser,
    pageTitle,
    description: active.description,
    h1: active.h1,
    selection: active.selection,
    snippet: initialSnippet,
    fullText: initialFullText,
    keyphrases: baseKeyphrases,
  });
  const privacyBoundary = classifyCapturePrivacy(initialProfile);
  if (privacyBoundary.action === "block") {
    return null;
  }
  const safeActive = redactActiveContextForStorage(active);
  const captureIntent = inferCaptureIntent(initialProfile);
  const initialClutterAudit = auditCapturedContent(initialProfile, captureIntent);
  if (!captureIntent.shouldCapture || initialClutterAudit.shouldSkip) {
    return null;
  }
  const storedContent = chooseStoredCaptureContent(
    safeActive,
    initialProfile,
    captureIntent,
    initialClutterAudit
  );
  const keyphrases = mergeUniqueStrings([
    ...extractKeyphrases(storedContent.fullText || storedContent.snippet),
    initialProfile.subject,
    ...(initialProfile.entities || []),
    ...(initialProfile.topics || []),
  ]);
  let contextProfile = extractContextProfile({
    url: tabData.activeTab?.url || "",
    application: tabData.browser,
    pageTitle,
    description: safeActive.description,
    h1: safeActive.h1,
    selection: safeActive.selection,
    snippet: storedContent.snippet,
    fullText: storedContent.fullText,
    keyphrases,
    contextProfile: initialProfile,
  });
  let clutterAudit = auditCapturedContent(contextProfile, captureIntent);
  if (clutterAudit.shouldPreferStructured && contextProfile.displayFullText) {
    contextProfile = extractContextProfile({
      url: tabData.activeTab?.url || "",
      application: tabData.browser,
      pageTitle,
      description: safeActive.description,
      h1: safeActive.h1,
      selection: safeActive.selection,
      snippet: normalizeText(
        contextProfile.structuredSummary || contextProfile.displayExcerpt || storedContent.snippet,
        SNIPPET_MAX_LEN
      ),
      fullText: normalizeRichText(contextProfile.displayFullText, FULL_TEXT_MAX_LEN),
      keyphrases,
      contextProfile: {
        ...initialProfile,
        captureIntent,
      },
    });
    clutterAudit = auditCapturedContent(contextProfile, captureIntent);
  }
  const localJudge = await classifyLocalPage(contextProfile, {
    embedText,
    cosineSimilarity,
  });
  contextProfile.captureIntent = captureIntent;
  contextProfile.clutterAudit = clutterAudit;
  contextProfile.localJudge = localJudge;
  contextProfile.privacyBoundary = privacyBoundary;
  const interactionType = resolveInteractionType(active);
  contextProfile.selectiveMemory = evaluateSelectiveMemory(contextProfile, {
    interactionType,
  });
  if (shouldSkipCaptureProfile(contextProfile)) {
    return null;
  }
  const retainedContent = applySelectiveRetention(
    contextProfile,
    {
      snippet: storedContent.snippet,
      fullText: contextProfile.fullText || storedContent.fullText,
    },
    contextProfile.selectiveMemory
  );
  const retainedProfile = {
    ...contextProfile,
    snippet: retainedContent.snippet,
    fullText: retainedContent.fullText,
    displayExcerpt: retainedContent.snippet || contextProfile.displayExcerpt,
    displayFullText: retainedContent.fullText || contextProfile.displayFullText,
  };
  const capturePacket = buildCapturePacket({
    tabData,
    activeContext: safeActive,
    profile: retainedProfile,
    interactionType,
  });
  retainedProfile.capturePacket = capturePacket;
  const searchableText = buildSearchableText(tabData, retainedProfile);
  const embedding = await embedText(`${searchableText} ${keyphrases.join(" ")}`.trim());
  const persistedContextProfile = {
    version: contextProfile.version,
    title: contextProfile.title,
    description: contextProfile.description,
    h1: contextProfile.h1,
    selection: contextProfile.selection,
    url: contextProfile.url,
    domain: contextProfile.domain,
    application: contextProfile.application,
    keyphrases: contextProfile.keyphrases,
    pageType: contextProfile.pageType,
    pageTypeLabel: contextProfile.pageTypeLabel,
    entities: contextProfile.entities,
    topics: contextProfile.topics,
    subject: contextProfile.subject,
    factItems: contextProfile.factItems,
    structuredSummary: contextProfile.structuredSummary,
    displayExcerpt: retainedProfile.displayExcerpt,
    fullText: retainedProfile.fullText,
    displayFullText: retainedProfile.displayFullText,
    derivativeItems: contextProfile.derivativeItems,
    contextText: contextProfile.contextText,
    captureIntent: contextProfile.captureIntent,
    clutterAudit: contextProfile.clutterAudit,
    localJudge: contextProfile.localJudge,
    selectiveMemory: contextProfile.selectiveMemory,
    privacyBoundary: contextProfile.privacyBoundary,
    capturePacket,
  };

  const event = {
    occurred_at: new Date().toISOString(),
    application: tabData.browser,
    window_title: pageTitle,
    url: tabData.activeTab?.url || "",
    interaction_type: interactionType,
    content_text: retainedContent.snippet,
    full_text: retainedContent.fullText,
    keyphrases_json: JSON.stringify(keyphrases),
    searchable_text: searchableText,
    embedding_json: JSON.stringify(embedding),
    context_profile_json: JSON.stringify(persistedContextProfile),
    selective_memory_json: JSON.stringify(contextProfile.selectiveMemory || null),
    capture_packet_json: JSON.stringify(capturePacket),
    capture_quality_json: JSON.stringify({
      version: 1,
      pageType: retainedProfile.pageType || "",
      qualityLabel: retainedProfile.localJudge?.qualityLabel || "",
      clutterScore: Number(retainedProfile.clutterAudit?.clutterScore || 0),
      organizationScore: Number(retainedProfile.clutterAudit?.organizationScore || 0),
      rememberScore: Number(retainedProfile.selectiveMemory?.rememberScore || 0),
    }),
    source: "extension"
  };

  const appendResult = await appendEvent(event);
  if (!appendResult?.skipped) {
    const graphPacket = buildMultimediaGraphPacket({
      tabData,
      activeContext: safeActive,
      profile: retainedProfile,
      capturePacket,
      eventId: appendResult.id,
    });
    await appendGraphPacket(graphPacket).catch(() => null);
    invalidateEventSearchIndex();
    scheduleMemoryPulse(interactionType);
  }
  return appendResult;
}

async function snapshotFocusedWindow() {
  if (snapshotInFlight) {
    snapshotQueuedWhileRunning = true;
    return;
  }

  snapshotInFlight = true;
  try {
    const currentWindow = await chrome.windows.getLastFocused({ populate: true });
    if (!currentWindow || !Array.isArray(currentWindow.tabs)) {
      return;
    }

    const browser = detectBrowserKey();
    const tabs = currentWindow.tabs
      .filter((tab) => tab && tab.url)
      .map((tab) => ({
        id: tab.id,
        title: tab.title || "",
        url: tab.url || "",
        active: Boolean(tab.active)
      }));
    const activeTab = currentWindow.tabs.find((tab) => tab && tab.active);
    if (
      !activeTab ||
      activeTab.discarded ||
      (activeTab.status && activeTab.status !== "complete")
    ) {
      return;
    }
    const activeContext = activeTab ? await captureActiveTabContext(activeTab) : null;

    if (activeTab) {
      await processAndStore({
        browser,
        activeTab,
        activeContext,
        tabs,
        windowId: currentWindow.id
      });
    }
  } catch {
    // Keep the extension silent when Memact is not running or the page is inaccessible.
  } finally {
    snapshotInFlight = false;
    if (snapshotQueuedWhileRunning) {
      snapshotQueuedWhileRunning = false;
      queueSnapshot();
    }
  }
}

function queueSnapshot() {
  clearTimeout(snapshotTimer);
  snapshotTimer = setTimeout(() => {
    snapshotFocusedWindow();
  }, SNAPSHOT_DEBOUNCE_MS);
}

async function openMemactSite() {
  const matchingTabs = await chrome.tabs.query({
    url: ["https://www.memact.com/*", "https://www.memact.com/"]
  });

  const existingTab = matchingTabs[0];
  if (existingTab?.id) {
    if (existingTab.windowId) {
      await chrome.windows.update(existingTab.windowId, { focused: true }).catch(() => {});
    }
    await chrome.tabs.update(existingTab.id, { active: true, url: MEMACT_SITE_URL }).catch(() => {});
    return;
  }

  await chrome.tabs.create({ url: MEMACT_SITE_URL });
}

async function enableCaptureOnTab(tab) {
  const tabId = Number(tab?.id || 0);
  const normalizedOrigin = normalizeOrigin(tab?.url || "");
  if (!tabId || !normalizedOrigin || !isEligiblePageOrigin(normalizedOrigin)) {
    return false;
  }

  await authorizeOrigin(normalizedOrigin);
  await chrome.tabs.sendMessage(tabId, {
    type: "CAPTURE_SITE_ACCESS_CHANGED",
    enabled: true,
    origin: normalizedOrigin,
  }).catch(() => {});
  queueSnapshot();
  scheduleMemoryPulse("site_access");
  return true;
}

refreshAuthorizedBridgeOrigins().catch(() => {});

function lexicalOverlapScore(query, event) {
  const tokens = String(query || "")
    .toLowerCase()
    .replace(/[^a-z0-9@#./+-]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 3);
  if (!tokens.length) {
    return 0;
  }
  const haystack = [
    event.window_title,
    event.url,
    event.searchable_text,
    JSON.parse(event.keyphrases_json || "[]").join(" ")
  ]
    .join(" ")
    .toLowerCase();
  let hits = 0;
  for (const token of new Set(tokens)) {
    if (haystack.includes(token)) {
      hits += 1;
    }
  }
  return hits / Math.max(1, new Set(tokens).size);
}

function parseKeyphrases(event) {
  try {
    const parsed = JSON.parse(event.keyphrases_json || "[]");
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch {
    return [];
  }
}

function parseContextProfile(event) {
  const profile = extractContextProfile({
    url: event.url,
    application: event.application,
    pageTitle: event.window_title,
    snippet: event.content_text,
    fullText: event.full_text,
    keyphrases: parseKeyphrases(event),
    context_profile_json: event.context_profile_json,
    selective_memory_json: event.selective_memory_json,
  });
  try {
    const packet = JSON.parse(event.capture_packet_json || "null");
    if (packet && typeof packet === "object") {
      profile.capturePacket = packet;
    }
  } catch {
    // Ignore invalid capture packet payloads.
  }
  if (!profile.selectiveMemory) {
    profile.selectiveMemory = evaluateSelectiveMemory(profile, {
      interactionType: event.interaction_type,
    });
  }
  return profile;
}

function suggestionTimeLabel(occurredAt) {
  if (!occurredAt) {
    return "";
  }
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit"
    })
      .format(new Date(occurredAt))
      .replace(",", " |");
  } catch {
    return "";
  }
}

function startOfDay() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function startOfWeek(offsetWeeks = 0) {
  const today = startOfDay();
  const day = today.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  const monday = new Date(today);
  monday.setDate(today.getDate() + diff + offsetWeeks * 7);
  return monday;
}

function matchesTimeFilter(event, timeFilter) {
  if (!timeFilter) {
    return true;
  }

  const eventAt = new Date(event.occurred_at || 0);
  if (Number.isNaN(eventAt.getTime())) {
    return true;
  }

  const today = startOfDay();
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const thisWeek = startOfWeek(0);
  const nextWeek = startOfWeek(1);
  const lastWeek = startOfWeek(-1);

  switch (String(timeFilter || "").toLowerCase()) {
    case "today":
      return eventAt >= today && eventAt < tomorrow;
    case "yesterday":
      return eventAt >= yesterday && eventAt < today;
    case "this week":
      return eventAt >= thisWeek && eventAt < nextWeek;
    case "last week":
      return eventAt >= lastWeek && eventAt < thisWeek;
    default:
      return true;
  }
}

function buildSuggestionSubtitle(event) {
  const app = normalizeText(event.application, 48);
  const domain = hostnameFromUrl(event.url);
  const when = suggestionTimeLabel(event.occurred_at);
  return [app, domain, when].filter(Boolean).join("  |  ");
}

function monthKeyFromDate(value) {
  const date = new Date(value || 0);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}`;
}

function formatMonthLabel(monthKey) {
  const match = String(monthKey || "").match(/^(\d{4})-(\d{2})$/);
  if (!match) {
    return "";
  }
  const [, year, month] = match;
  return new Intl.DateTimeFormat(undefined, {
    month: "long",
    year: "numeric",
  }).format(new Date(Number(year), Number(month) - 1, 1));
}

function readFactValue(profile, label) {
  return normalizeText(
    (profile.factItems || []).find((item) => normalizeText(item.label).toLowerCase() === label)?.value
  );
}

function candidateMatchesQuery(text, query) {
  const normalizedQuery = normalizeText(query, 240).toLowerCase();
  if (!normalizedQuery) {
    return true;
  }
  const haystack = normalizeText(text, 240).toLowerCase();
  const tokens = normalizedQuery.split(/\s+/).filter((token) => token.length >= 2);
  return tokens.every((token) => haystack.includes(token));
}

function buildAggregateSubtitle(candidate) {
  const parts = [
    `${candidate.count} captures`,
    candidate.subtitle || "",
    candidate.latestAt ? suggestionTimeLabel(candidate.latestAt) : "",
  ].filter(Boolean);
  return parts.join("  |  ");
}

function createAggregateSuggestion(candidate) {
  const text = normalizeText(candidate.completion, 180);
  if (!text) {
    return null;
  }

  return {
    id: candidate.id,
    category: candidate.category,
    title: text,
    subtitle: buildAggregateSubtitle(candidate),
    completion: text,
  };
}

function isGenericBrowserApp(app) {
  const normalized = normalizeText(app, 64).toLowerCase();
  return [
    "browser",
    "chrome",
    "edge",
    "msedge",
    "brave",
    "opera",
    "vivaldi",
    "firefox",
  ].includes(normalized);
}

function isSuggestionWorthyProfile(profile) {
  const pageType = normalizeText(profile?.pageType, 40).toLowerCase();
  const rememberScore = Number(profile?.selectiveMemory?.rememberScore || 0);
  const qualityLabel = normalizeText(profile?.localJudge?.qualityLabel, 40).toLowerCase();
  const organizationScore = Number(profile?.clutterAudit?.organizationScore || 0);

  if (qualityLabel === "shell") {
    return false;
  }
  if (rememberScore < 0.46) {
    return false;
  }
  if (organizationScore < 0.28) {
    return false;
  }
  if ((pageType === "lyrics" || pageType === "social") && rememberScore < 0.84) {
    return false;
  }
  if (pageType === "video" && rememberScore < 0.72) {
    return false;
  }
  return true;
}

function addSuggestionCandidate(map, key, category, completion, subtitle, occurredAt, weight = 0) {
  const normalizedCompletion = normalizeText(completion, 180);
  if (!normalizedCompletion) {
    return;
  }

  const existing = map.get(key);
  if (!existing) {
    map.set(key, {
      id: key,
      category,
      completion: normalizedCompletion,
      subtitle: normalizeText(subtitle, 80),
      latestAt: occurredAt,
      count: 1,
      weight: Number(weight || 0),
    });
    return;
  }

  existing.count += 1;
  existing.weight = Math.max(Number(existing.weight || 0), Number(weight || 0));
  if (!existing.latestAt || new Date(occurredAt || 0) > new Date(existing.latestAt || 0)) {
    existing.latestAt = occurredAt;
    existing.subtitle = normalizeText(subtitle, 80) || existing.subtitle;
  }
}

async function handleSuggestions(query, timeFilter, limit = 6) {
  const recentEvents = await getRecentEvents(400);
  const filteredEvents = recentEvents.filter(
    (event) =>
      matchesTimeFilter(event, timeFilter) &&
      !shouldIgnoreCapturedPage(event.url, event.window_title)
  );
  const indexedEvents = normalizeText(query, 240)
    ? getIndexedSearchCandidates(filteredEvents, query, Math.max(limit * 80, 240))
    : filteredEvents;
  const candidates = new Map();

  for (const event of indexedEvents) {
    const profile = parseContextProfile(event);
    if (shouldSkipCaptureProfile(profile)) {
      continue;
    }
    if (profile.localJudge?.qualityLabel === "shell") {
      continue;
    }
    if (profile.captureIntent?.captureMode === "metadata") {
      continue;
    }
    if (profile.clutterAudit?.clutterScore >= 0.82) {
      continue;
    }
    if (profile.selectiveMemory?.shouldUseForSuggestions === false) {
      continue;
    }
    if (!isSuggestionWorthyProfile(profile)) {
      continue;
    }

    const domain = normalizeText(profile.domain || hostnameFromUrl(event.url), 64).toLowerCase();
    const app = normalizeText(event.application, 40);
    const subject = normalizeText(profile.subject, 96);
    const searchQuery = readFactValue(profile, "query");
    const monthKey = monthKeyFromDate(event.occurred_at);
    const monthLabel = formatMonthLabel(monthKey);
    const suggestionWeight = Number(profile.selectiveMemory?.rememberScore || 0);

    if (domain && profile.pageType !== "search") {
      addSuggestionCandidate(
        candidates,
        `site:${domain}`,
        "Recent site",
        domain,
        domain,
        event.occurred_at,
        suggestionWeight
      );
    }

    if (app && !isGenericBrowserApp(app)) {
      addSuggestionCandidate(
        candidates,
        `app:${app.toLowerCase()}`,
        "Recent app",
        toTitleCase(app),
        toTitleCase(app),
        event.occurred_at,
        suggestionWeight
      );
    }

    if (searchQuery) {
      addSuggestionCandidate(
        candidates,
        `search:${searchQuery.toLowerCase()}`,
        "Recent search",
        searchQuery,
        domain || "Captured search",
        event.occurred_at,
        suggestionWeight
      );
    } else if (
      subject &&
      profile.pageType !== "search" &&
      profile.pageType !== "web" &&
      subject.toLowerCase() !== domain &&
      profile.captureIntent?.captureMode !== "metadata" &&
      profile.clutterAudit?.organizationScore >= 0.34
    ) {
      addSuggestionCandidate(
        candidates,
        `topic:${subject.toLowerCase()}`,
        "Recent topic",
        subject,
        profile.pageTypeLabel || domain,
        event.occurred_at,
        suggestionWeight
      );
    }

    if (monthLabel) {
      addSuggestionCandidate(
        candidates,
        `month:${monthKey}`,
        "Recent month",
        monthLabel,
        monthLabel,
        event.occurred_at,
        suggestionWeight
      );
    }
  }

  return [...candidates.values()]
    .filter((candidate) => candidateMatchesQuery(candidate.completion, query))
    .sort((left, right) => {
      const categoryScore = (category) => {
        switch (category) {
          case "Recent topic":
            return 4;
          case "Recent search":
            return 3;
          case "Recent month":
            return 2;
          case "Recent app":
            return 1.5;
          case "Recent site":
            return 1;
          default:
            return 0;
        }
      };
      const leftQuality = categoryScore(left.category);
      const rightQuality = categoryScore(right.category);
      if (rightQuality !== leftQuality) {
        return rightQuality - leftQuality;
      }
      if (right.count !== left.count) {
        return right.count - left.count;
      }
      if (Number(right.weight || 0) !== Number(left.weight || 0)) {
        return Number(right.weight || 0) - Number(left.weight || 0);
      }
      return new Date(right.latestAt || 0) - new Date(left.latestAt || 0);
    })
    .slice(0, limit)
    .map(createAggregateSuggestion)
    .filter(Boolean);
}

async function handleSearch(query, limit = 20) {
  const normalizedQuery = normalizeText(query, 1000);
  if (!normalizedQuery) {
    return { results: [], answer: null };
  }
  const recentEvents = await getRecentEvents(3000);
  const candidateEvents = getIndexedSearchCandidates(
    recentEvents,
    normalizedQuery,
    Math.max(limit * 40, 320)
  );
  const primaryResponse = await answerLocalQuery({
    query: normalizedQuery,
    limit,
    rawEvents: candidateEvents,
    embedText,
    cosineSimilarity
  });
  if (
    (!primaryResponse?.results || !primaryResponse.results.length) &&
    candidateEvents.length < recentEvents.length
  ) {
    return answerLocalQuery({
      query: normalizedQuery,
      limit,
      rawEvents: recentEvents,
      embedText,
      cosineSimilarity
    });
  }
  return primaryResponse;
}

chrome.runtime.onInstalled.addListener(() => {
  refreshAuthorizedBridgeOrigins().catch(() => {});
  initDB().catch(() => {});
  ensureDeviceHelperAlarm();
  queueSnapshot();
});

chrome.runtime.onStartup.addListener(() => {
  refreshAuthorizedBridgeOrigins().catch(() => {});
  initDB().catch(() => {});
  ensureDeviceHelperAlarm();
  queueSnapshot();
});

if (chrome.alarms?.onAlarm) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm?.name === DEVICE_HELPER_ALARM_NAME) {
      pollDeviceHelper().catch(() => {});
    }
  });
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes?.[CAPTURE_AUTHORIZED_ORIGINS_KEY]) {
    return;
  }
  refreshAuthorizedBridgeOrigins().catch(() => {});
});

chrome.tabs.onActivated.addListener(queueSnapshot);
chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (changeInfo?.status === "loading" || changeInfo?.url) {
    readabilityInjectionState.delete(_tabId);
  }
  if (changeInfo?.status !== "complete") {
    return;
  }
  if (!tab?.url || !/^https?:/i.test(tab.url)) {
    return;
  }
  queueSnapshot();
});
chrome.tabs.onCreated.addListener(queueSnapshot);
chrome.tabs.onRemoved.addListener((tabId) => {
  readabilityInjectionState.delete(tabId);
  queueSnapshot();
});
chrome.windows.onFocusChanged.addListener(queueSnapshot);
chrome.action.onClicked.addListener((tab) => {
  const normalizedOrigin = normalizeOrigin(tab?.url || "");
  if (normalizedOrigin && !isAllowedMemactOrigin(normalizedOrigin) && isEligiblePageOrigin(normalizedOrigin)) {
    enableCaptureOnTab(tab).catch(() => {});
    return;
  }
  openMemactSite().catch(() => {});
});
chrome.webNavigation.onCompleted.addListener(
  ({ frameId, url }) => {
    if (frameId !== 0) {
      return;
    }
    if (!url || !/^https?:/i.test(url)) {
      return;
    }
    queueSnapshot();
  },
  { url: [{ schemes: ["http", "https"] }] }
);
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message?.type) {
    return false;
  }

  if (message.type === "captureHint") {
    if (sender?.tab?.id && /^https?:|^file:/i.test(sender.tab.url || "")) {
      queueSnapshot();
      sendResponse({
        ok: true,
      });
      return false;
    }

    sendResponse({
      ok: false,
      error: "missing_tab_context",
    });
    return false;
  }

  if (!isAllowedBridgeSender(sender)) {
    sendResponse({
      error: "unauthorized_sender"
    });
    return false;
  }

  if (message.type === "search") {
    handleSearch(message.query, message.limit)
      .then((results) => sendResponse(results))
      .catch((error) =>
        sendResponse({
          error: String(error?.message || error || "search failed"),
          results: []
        })
      );
    return true;
  }

  if (message.type === "suggestions") {
    handleSuggestions(message.query, message.timeFilter, message.limit)
      .then((results) => sendResponse(results))
      .catch((error) =>
        sendResponse({
          error: String(error?.message || error || "suggestions failed"),
          results: []
        })
      );
    return true;
  }

  if (message.type === "status") {
    buildMemoryStatus()
      .then((status) => sendResponse(status))
      .catch((error) =>
        sendResponse({
          ready: false,
          eventCount: 0,
          sessionCount: 0,
          lastEventAt: "",
          memorySignature: "error",
          modelReady: Boolean(embedWorkerReady),
          captureSchemaVersion: 3,
          error: String(error?.message || error || "status failed"),
          sync: {
            mode: "memory_pulse_bridge",
            automaticCapture: true,
            automaticDownloads: false,
          },
          bootstrap: {
            status: "error",
            error: String(error?.message || error || "status failed"),
          },
        })
      );
    return true;
  }

  if (message.type === "captureClearBootstrapHistory") {
    Promise.all([
      clearBootstrapImportedEvents(),
      resetBootstrapImportState({
        status: "idle",
        stage: "cleared",
        note: "Browser activity import was cleared.",
      }),
    ])
      .then(([result, bootstrap]) => {
        invalidateEventSearchIndex();
        scheduleMemoryPulse("clear_bootstrap_import");
        sendResponse({
          ok: true,
          deletedCount: Number(result?.deletedCount || 0),
          bootstrap,
        });
      })
      .catch((error) =>
        sendResponse({
          ok: false,
          deletedCount: 0,
          error: String(error?.message || error || "clear browser import failed"),
          bootstrap: null,
        })
      );
    return true;
  }

  if (message.type === "captureBootstrapStatus") {
    getBootstrapImportState()
      .then((bootstrap) =>
        sendResponse({
          ok: true,
          bootstrap,
        })
      )
      .catch((error) =>
        sendResponse({
          ok: false,
          error: String(error?.message || error || "capture bootstrap status failed"),
          bootstrap: null,
        })
      );
    return true;
  }

  if (message.type === "captureBootstrapHistory") {
    beginBootstrapImport({
      force: Boolean(message.force),
      days: message.days,
      limit: message.limit,
    })
      .then((bootstrap) => {
        scheduleMemoryPulse("bootstrap_import");
        sendResponse({
          ok: Boolean(bootstrap?.ok),
          bootstrap,
        });
      })
      .catch((error) =>
        sendResponse({
          ok: false,
          error: String(error?.message || error || "capture bootstrap failed"),
          bootstrap: null,
        })
      );
    return true;
  }

  if (message.type === "captureGetEvents") {
    getCaptureEvents({ limit: message.limit })
      .then((events) =>
        sendResponse({
          ok: true,
          events,
        })
      )
      .catch((error) =>
        sendResponse({
          ok: false,
          error: String(error?.message || error || "capture events failed"),
          events: [],
        })
      );
    return true;
  }

  if (message.type === "captureGetSessions") {
    getCaptureSessions({ limit: message.limit })
      .then((sessions) =>
        sendResponse({
          ok: true,
          sessions,
        })
      )
      .catch((error) =>
        sendResponse({
          ok: false,
          error: String(error?.message || error || "capture sessions failed"),
          sessions: [],
        })
      );
    return true;
  }

  if (message.type === "captureGetActivities") {
    getCaptureActivities({ limit: message.limit })
      .then((activities) =>
        sendResponse({
          ok: true,
          activities,
        })
      )
      .catch((error) =>
        sendResponse({
          ok: false,
          error: String(error?.message || error || "capture activities failed"),
          activities: [],
        })
      );
    return true;
  }

  if (message.type === "captureGetContentUnits") {
    getCaptureContentUnits({ limit: message.limit, scopes: message.scopes })
      .then((contentUnits) =>
        sendResponse({
          ok: true,
          content_units: contentUnits,
        })
      )
      .catch((error) =>
        sendResponse({
          ok: false,
          error: String(error?.message || error || "capture content units failed"),
          content_units: [],
        })
      );
    return true;
  }

  if (message.type === "captureGetGraphPackets") {
    getCaptureGraphPackets({ limit: message.limit, scopes: message.scopes })
      .then((graphPackets) =>
        sendResponse({
          ok: true,
          graph_packets: graphPackets,
        })
      )
      .catch((error) =>
        sendResponse({
          ok: false,
          error: String(error?.message || error || "capture graph packets failed"),
          graph_packets: [],
        })
      );
    return true;
  }

  if (message.type === "captureGetMediaJobs") {
    getCaptureMediaJobs({ limit: message.limit, scopes: message.scopes })
      .then((mediaJobs) =>
        sendResponse({
          ok: true,
          media_jobs: mediaJobs,
        })
      )
      .catch((error) =>
        sendResponse({
          ok: false,
          error: String(error?.message || error || "capture media jobs failed"),
          media_jobs: [],
        })
      );
    return true;
  }

  if (message.type === "captureGetSnapshot") {
    getCaptureSnapshot({ limit: message.limit, scopes: message.scopes, trusted: message.trusted === true })
      .then((snapshot) =>
        sendResponse({
          ok: true,
          snapshot,
        })
      )
      .catch((error) =>
        sendResponse({
          ok: false,
          error: String(error?.message || error || "capture snapshot failed"),
          snapshot: null,
        })
      );
    return true;
  }

  if (message.type === "stats") {
    getStats()
      .then((stats) => sendResponse(stats))
      .catch((error) =>
        sendResponse({
          error: String(error?.message || error || "stats failed")
        })
      );
    return true;
  }

  if (message.type === "clearAllData") {
    clearAllData()
      .then(() => {
        invalidateEventSearchIndex();
        scheduleMemoryPulse("clear_all_data");
        sendResponse({ ok: true });
      })
      .catch((error) =>
        sendResponse({
          ok: false,
          error: String(error?.message || error || "clear failed")
        })
      );
    return true;
  }

  return false;
});

refreshAuthorizedBridgeOrigins().catch(() => {});
initDB().catch(() => {});
ensureDeviceHelperAlarm();
