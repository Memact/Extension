const CAPTURE_AUTHORIZED_ORIGINS_KEY = "capture_authorized_origins";

let pageAccessEnabled = false;

function normalizeHostname(hostname) {
  return String(hostname || "")
    .toLowerCase()
    .replace(/^\[/, "")
    .replace(/\]$/, "");
}

function normalizeOrigin(value) {
  try {
    const url = new URL(value);
    return `${url.protocol}//${normalizeHostname(url.hostname)}${url.port ? `:${url.port}` : ""}`;
  } catch {
    return "";
  }
}

function isLocalMemactHost(hostname) {
  const normalized = normalizeHostname(hostname);
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "0.0.0.0" ||
    normalized === "::1"
  );
}

function isDefaultAllowedOrigin(origin) {
  try {
    const url = new URL(origin);
    const hostname = normalizeHostname(url.hostname);
    if (/^https?:$/i.test(url.protocol) === false) {
      return false;
    }
    return /(^|\.)memact\.com$/i.test(hostname) || isLocalMemactHost(hostname);
  } catch {
    return false;
  }
}

async function isCurrentOriginAuthorized() {
  const currentOrigin = normalizeOrigin(location.href);
  if (!currentOrigin) {
    return false;
  }
  if (isDefaultAllowedOrigin(currentOrigin)) {
    return true;
  }

  try {
    const stored = await chrome.storage.local.get(CAPTURE_AUTHORIZED_ORIGINS_KEY);
    const origins = Array.isArray(stored?.[CAPTURE_AUTHORIZED_ORIGINS_KEY])
      ? stored[CAPTURE_AUTHORIZED_ORIGINS_KEY]
      : [];
    return origins
      .map((origin) => normalizeOrigin(origin))
      .includes(currentOrigin);
  } catch {
    return false;
  }
}

function forwardToPage(message) {
  window.postMessage(message, window.location.origin);
}

function injectPageApi() {
  if (!pageAccessEnabled) {
    return;
  }
  if (document.documentElement?.dataset?.capturePageApi === "ready") {
    return;
  }

  try {
    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("page-api.js");
    script.async = false;
    script.dataset.capturePageApi = "true";
    script.addEventListener("load", () => {
      try {
        document.documentElement.dataset.capturePageApi = "ready";
      } catch (_) {
        // Ignore DOM marker failures.
      }
      script.remove();
    });
    script.addEventListener("error", () => {
      script.remove();
    });
    (document.head || document.documentElement).appendChild(script);
  } catch (_) {
    // Ignore injection failures and keep the bridge passive.
  }
}

function isBridgeRequestType(type) {
  return typeof type === "string" && (type.startsWith("MEMACT_") || type.startsWith("CAPTURE_"));
}

function announceReady() {
  if (!pageAccessEnabled) {
    return;
  }
  try {
    document.documentElement.dataset.memactBridge = "ready";
  } catch (_) {
    // Ignore DOM marker failures.
  }
  forwardToPage({ type: "MEMACT_EXTENSION_READY" });
}

chrome.runtime.onMessage.addListener((message) => {
  if (!pageAccessEnabled) {
    return false;
  }
  if (message?.type === "MEMACT_MEMORY_PULSE") {
    forwardToPage({
      type: "MEMACT_MEMORY_PULSE",
      pulse: message.pulse || null,
    });
  }
  return false;
});

async function refreshPageAccess({ announce = false } = {}) {
  pageAccessEnabled = await isCurrentOriginAuthorized();
  if (!pageAccessEnabled) {
    return false;
  }
  injectPageApi();
  if (announce) {
    announceReady();
  }
  return true;
}

window.addEventListener("message", async (event) => {
  if (!pageAccessEnabled) {
    return;
  }
  if (event.source !== window) {
    return;
  }
  if (!isBridgeRequestType(event.data?.type)) {
    return;
  }

  const { type, payload, requestId } = event.data;

  try {
    if (type === "MEMACT_SEARCH") {
      const results = await chrome.runtime.sendMessage({
        type: "search",
        query: payload?.query || "",
        limit: payload?.limit || 20
      });
      forwardToPage({
        type: "MEMACT_SEARCH_RESULT",
        results,
        requestId
      });
    } else if (type === "MEMACT_SUGGESTIONS") {
      const results = await chrome.runtime.sendMessage({
        type: "suggestions",
        query: payload?.query || "",
        timeFilter: payload?.timeFilter || null,
        limit: payload?.limit || 6
      });
      forwardToPage({
        type: "MEMACT_SUGGESTIONS_RESULT",
        results,
        requestId
      });
    } else if (type === "MEMACT_STATUS") {
      const status = await chrome.runtime.sendMessage({ type: "status" });
      forwardToPage({
        type: "MEMACT_STATUS_RESULT",
        status,
        requestId
      });
    } else if (type === "CAPTURE_GET_EVENTS") {
      const response = await chrome.runtime.sendMessage({
        type: "captureGetEvents",
        limit: payload?.limit || 3000
      });
      forwardToPage({
        type: "CAPTURE_GET_EVENTS_RESULT",
        response,
        requestId
      });
    } else if (type === "CAPTURE_GET_SESSIONS") {
      const response = await chrome.runtime.sendMessage({
        type: "captureGetSessions",
        limit: payload?.limit || 3000
      });
      forwardToPage({
        type: "CAPTURE_GET_SESSIONS_RESULT",
        response,
        requestId
      });
    } else if (type === "CAPTURE_GET_ACTIVITIES") {
      const response = await chrome.runtime.sendMessage({
        type: "captureGetActivities",
        limit: payload?.limit || 3000
      });
      forwardToPage({
        type: "CAPTURE_GET_ACTIVITIES_RESULT",
        response,
        requestId
      });
    } else if (type === "CAPTURE_GET_CONTENT_UNITS") {
      const response = await chrome.runtime.sendMessage({
        type: "captureGetContentUnits",
        limit: payload?.limit || 1200,
        scopes: payload?.scopes || null
      });
      forwardToPage({
        type: "CAPTURE_GET_CONTENT_UNITS_RESULT",
        response,
        requestId
      });
    } else if (type === "CAPTURE_GET_GRAPH_PACKETS") {
      const response = await chrome.runtime.sendMessage({
        type: "captureGetGraphPackets",
        limit: payload?.limit || 400,
        scopes: payload?.scopes || null
      });
      forwardToPage({
        type: "CAPTURE_GET_GRAPH_PACKETS_RESULT",
        response,
        requestId
      });
    } else if (type === "CAPTURE_GET_MEDIA_JOBS") {
      const response = await chrome.runtime.sendMessage({
        type: "captureGetMediaJobs",
        limit: payload?.limit || 200,
        scopes: payload?.scopes || null
      });
      forwardToPage({
        type: "CAPTURE_GET_MEDIA_JOBS_RESULT",
        response,
        requestId
      });
    } else if (type === "CAPTURE_GET_SNAPSHOT") {
      const response = await chrome.runtime.sendMessage({
        type: "captureGetSnapshot",
        limit: payload?.limit || 3000,
        scopes: payload?.scopes || null,
        trusted: payload?.trusted === true
      });
      forwardToPage({
        type: "CAPTURE_GET_SNAPSHOT_RESULT",
        response,
        requestId
      });
    } else if (type === "CAPTURE_BOOTSTRAP_STATUS") {
      const response = await chrome.runtime.sendMessage({
        type: "captureBootstrapStatus"
      });
      forwardToPage({
        type: "CAPTURE_BOOTSTRAP_STATUS_RESULT",
        response,
        requestId
      });
    } else if (type === "CAPTURE_BOOTSTRAP_HISTORY") {
      const response = await chrome.runtime.sendMessage({
        type: "captureBootstrapHistory",
        force: Boolean(payload?.force),
        days: payload?.days || 21,
        limit: payload?.limit || 320
      });
      forwardToPage({
        type: "CAPTURE_BOOTSTRAP_HISTORY_RESULT",
        response,
        requestId
      });
    } else if (type === "CAPTURE_CLEAR_BOOTSTRAP_HISTORY") {
      const response = await chrome.runtime.sendMessage({
        type: "captureClearBootstrapHistory"
      });
      forwardToPage({
        type: "CAPTURE_CLEAR_BOOTSTRAP_HISTORY_RESULT",
        response,
        requestId
      });
    } else if (type === "MEMACT_STATS") {
      const stats = await chrome.runtime.sendMessage({ type: "stats" });
      forwardToPage({
        type: "MEMACT_STATS_RESULT",
        stats,
        requestId
      });
    } else if (type === "MEMACT_CLEAR_ALL_DATA") {
      const response = await chrome.runtime.sendMessage({ type: "clearAllData" });
      forwardToPage({
        type: "MEMACT_CLEAR_ALL_DATA_RESULT",
        response,
        requestId
      });
    }
  } catch (error) {
    forwardToPage({
      type: "MEMACT_ERROR",
      error: String(error?.message || error || "bridge failed"),
      requestId
    });
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "CAPTURE_SITE_ACCESS_CHANGED" && message.enabled) {
    pageAccessEnabled = true;
    injectPageApi();
    announceReady();
    forwardToPage({
      type: "CAPTURE_SITE_ACCESS_CHANGED",
      enabled: true,
      origin: message.origin || normalizeOrigin(location.href),
    });
    return;
  }

  return;
});

refreshPageAccess({ announce: true }).catch(() => {});
window.addEventListener(
  "DOMContentLoaded",
  () => {
    refreshPageAccess({ announce: true }).catch(() => {});
  },
  { once: true }
);
setTimeout(() => {
  refreshPageAccess({ announce: true }).catch(() => {});
}, 150);
setTimeout(() => {
  refreshPageAccess({ announce: true }).catch(() => {});
}, 500);
setTimeout(() => {
  refreshPageAccess({ announce: true }).catch(() => {});
}, 1200);
setTimeout(() => {
  refreshPageAccess({ announce: true }).catch(() => {});
}, 2500);
