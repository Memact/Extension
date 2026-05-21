import { appendEvent } from "./db.js";
import {
  buildSuggestionQueries,
  extractContextProfile,
  hostnameFromUrl,
  normalizeText,
} from "./context-pipeline.js";
import { extractKeyphrases } from "./keywords.js";

const CAPTURE_BOOTSTRAP_STATE_KEY = "capture_bootstrap_state";
const DEFAULT_HISTORY_DAYS = 21;
const DEFAULT_HISTORY_LIMIT = 320;
const BASE_PROGRESS = 8;
const IMPORT_PROGRESS_SPAN = 84;
const PROGRESS_UPDATE_INTERVAL = 8;

let importPromise = null;

function buildDefaultState() {
  return {
    status: "idle",
    stage: "idle",
    imported_at: "",
    imported_count: 0,
    skipped_count: 0,
    scanned_count: 0,
    processed_count: 0,
    total_count: 0,
    history_days: DEFAULT_HISTORY_DAYS,
    history_limit: DEFAULT_HISTORY_LIMIT,
    progress_percent: 0,
    note: "",
    source: "history-bootstrap",
    error: "",
  };
}

function readBootstrapState() {
  return chrome.storage.local
    .get(CAPTURE_BOOTSTRAP_STATE_KEY)
    .then((stored) => stored?.[CAPTURE_BOOTSTRAP_STATE_KEY] || null)
    .catch(() => null);
}

function writeBootstrapState(state) {
  return chrome.storage.local.set({
    [CAPTURE_BOOTSTRAP_STATE_KEY]: state,
  });
}

async function updateBootstrapState(patch = {}) {
  const current = (await readBootstrapState()) || buildDefaultState();
  const next = {
    ...current,
    ...patch,
  };
  await writeBootstrapState(next);
  return next;
}

function normalizeHistoryItems(items = []) {
  const seen = new Set();
  return (Array.isArray(items) ? items : [])
    .map((item) => {
      const url = normalizeText(item?.url, 400);
      const title = normalizeText(item?.title, 200);
      const lastVisitTime = Number(item?.lastVisitTime || 0);
      if (!url || !/^https?:/i.test(url) || !lastVisitTime) {
        return null;
      }
      const key = `${url.toLowerCase()}|${title.toLowerCase()}`;
      if (seen.has(key)) {
        return null;
      }
      seen.add(key);
      return {
        url,
        title,
        lastVisitTime,
      };
    })
    .filter(Boolean)
    .sort((left, right) => right.lastVisitTime - left.lastVisitTime);
}

function buildHistoryContext(item) {
  const browserName = "Browser history";
  const domain = hostnameFromUrl(item.url);
  const title = normalizeText(item.title, 200) || domain || "Visited page";
  const seedText = [title, domain, item.url].filter(Boolean).join(" ");
  const profile = extractContextProfile({
    url: item.url,
    title,
    pageTitle: title,
    window_title: title,
    application: browserName,
    snippet: title,
    content_text: title,
    full_text: title,
    description: domain ? `Visited page from ${domain}.` : "Visited page from browser history.",
    keyphrases: extractKeyphrases(seedText, 8),
    captureIntent: {
      shouldCapture: true,
      shouldKeepMetadataOnly: false,
      shouldPreferStructured: true,
      captureMode: "history_bootstrap",
      pagePurpose: "history_bootstrap",
      targetRegions: ["history entry"],
    },
    clutterAudit: {
      shouldSkip: false,
      shouldPreferStructured: true,
      organizationScore: 0.72,
      clutterScore: 0.18,
      summary: "Imported from browser history for first-use schema seeding.",
    },
    localJudge: {
      shouldSkip: false,
      qualityLabel: "history",
      confidence: 0.72,
    },
    selectiveMemory: {
      rememberScore: 0.66,
      shouldUseForSuggestions: true,
      shouldKeep: true,
      reason: "history_bootstrap",
    },
  });

  return {
    profile,
    keyphrases: extractKeyphrases(
      [title, profile.subject, profile.structuredSummary, ...profile.topics].filter(Boolean).join(" "),
      8
    ),
  };
}

function buildRunningState(existingState, startedAt, historyDays, historyLimit) {
  return {
    ...existingState,
    status: "running",
    stage: "reading_history",
    started_at: startedAt,
    imported_at: "",
    imported_count: 0,
    skipped_count: 0,
    scanned_count: 0,
    processed_count: 0,
    total_count: 0,
    history_days: historyDays,
    history_limit: historyLimit,
    progress_percent: BASE_PROGRESS,
    note: "Checking recent browser activity.",
    source: "history-bootstrap",
    error: "",
  };
}

async function importHistoryItems(historyItems, baseState) {
  let importedCount = 0;
  let skippedCount = 0;
  const totalCount = historyItems.length;

  await updateBootstrapState({
    ...baseState,
    stage: "screening_activity",
    scanned_count: totalCount,
    total_count: totalCount,
    progress_percent: totalCount ? 14 : 92,
    note: "Calculating what to include and what to skip.",
  });

  for (let index = 0; index < historyItems.length; index += 1) {
    const item = historyItems[index];
    const { profile, keyphrases } = buildHistoryContext(item);
    const occurredAt = new Date(item.lastVisitTime).toISOString();
    const suggestionQueries = buildSuggestionQueries(profile, { limit: 5 });
    const event = {
      occurred_at: occurredAt,
      application: "Browser history",
      window_title: profile.title || item.title || hostnameFromUrl(item.url) || "Visited page",
      url: item.url,
      interaction_type: "history_import",
      content_text: profile.displayExcerpt || profile.structuredSummary || profile.title,
      full_text: profile.displayFullText || profile.rawFullText || profile.title,
      keyphrases_json: JSON.stringify(keyphrases),
      searchable_text: [
        profile.title,
        item.url,
        profile.domain,
        profile.subject,
        profile.structuredSummary,
        profile.displayExcerpt,
        profile.contextText,
        ...profile.topics,
        ...profile.entities,
        ...suggestionQueries.map((entry) => entry.query),
      ]
        .filter(Boolean)
        .join(" "),
      embedding_json: "[]",
      context_profile_json: JSON.stringify({
        ...profile,
        bootstrapImport: true,
        suggestionQueries,
      }),
      selective_memory_json: JSON.stringify({
        rememberScore: 0.66,
        shouldUseForSuggestions: true,
        shouldKeep: true,
        source: "history_bootstrap",
      }),
      capture_packet_json: JSON.stringify({
        points: [profile.structuredSummary || profile.title].filter(Boolean),
        searchTerms: suggestionQueries.map((entry) => entry.query),
        blocks: [
          {
            label: "History entry",
            text: [profile.title, profile.displayExcerpt].filter(Boolean).join(" - "),
          },
        ],
      }),
      capture_quality_json: JSON.stringify({
        source: "history_bootstrap",
        seeded: true,
      }),
      source: "history-bootstrap",
    };

    const result = await appendEvent(event);
    if (result?.skipped) {
      skippedCount += 1;
    } else {
      importedCount += 1;
    }

    const processedCount = index + 1;
    if (
      processedCount === totalCount ||
      processedCount === 1 ||
      processedCount % PROGRESS_UPDATE_INTERVAL === 0
    ) {
      const progressPercent = totalCount
        ? BASE_PROGRESS + Math.round((processedCount / totalCount) * IMPORT_PROGRESS_SPAN)
        : 96;
      await updateBootstrapState({
        ...baseState,
        stage: "writing_events",
        scanned_count: totalCount,
        processed_count: processedCount,
        imported_count: importedCount,
        skipped_count: skippedCount,
        total_count: totalCount,
        progress_percent: Math.min(96, progressPercent),
        note: "Saving useful activity for first-time suggestions.",
      });
    }
  }

  return {
    importedCount,
    skippedCount,
  };
}

export async function getBootstrapImportState() {
  const stored = await readBootstrapState();
  return stored || buildDefaultState();
}

export async function resetBootstrapImportState(patch = {}) {
  const next = {
    ...buildDefaultState(),
    ...patch,
  };
  await writeBootstrapState(next);
  return next;
}

export async function beginBootstrapImport(options = {}) {
  if (importPromise) {
    return getBootstrapImportState();
  }

  const force = Boolean(options.force);
  const historyDays = Math.max(1, Number(options.days || DEFAULT_HISTORY_DAYS));
  const historyLimit = Math.max(40, Number(options.limit || DEFAULT_HISTORY_LIMIT));
  const existingState = await getBootstrapImportState();

  if (!force && existingState.status === "complete" && Number(existingState.imported_count || 0) > 0) {
    return {
      ok: true,
      skipped: true,
      ...existingState,
    };
  }

  const startedAt = new Date().toISOString();
  const runningState = buildRunningState(existingState, startedAt, historyDays, historyLimit);
  await writeBootstrapState(runningState);

  importPromise = (async () => {
    try {
      const historyItems = await chrome.history.search({
        text: "",
        maxResults: historyLimit,
        startTime: Date.now() - historyDays * 24 * 60 * 60 * 1000,
      });
      const normalizedItems = normalizeHistoryItems(historyItems).slice(0, historyLimit);
      const importSummary = await importHistoryItems(normalizedItems, runningState);
      const completedState = {
        ...runningState,
        status: "complete",
        stage: "complete",
        imported_at: new Date().toISOString(),
        imported_count: importSummary.importedCount,
        skipped_count: importSummary.skippedCount,
        scanned_count: normalizedItems.length,
        processed_count: normalizedItems.length,
        total_count: normalizedItems.length,
        progress_percent: 100,
        note: "Initial activity seeding is complete.",
        error: "",
      };
      await writeBootstrapState(completedState);
      return {
        ok: true,
        skipped: false,
        ...completedState,
      };
    } catch (error) {
      const failedState = {
        ...runningState,
        status: "error",
        stage: "error",
        imported_at: "",
        imported_count: 0,
        skipped_count: 0,
        scanned_count: 0,
        processed_count: 0,
        total_count: 0,
        progress_percent: 0,
        note: "",
        error: String(error?.message || error || "history bootstrap failed"),
      };
      await writeBootstrapState(failedState);
      return {
        ok: false,
        skipped: false,
        ...failedState,
      };
    } finally {
      importPromise = null;
    }
  })();

  return {
    ok: true,
    skipped: false,
    ...runningState,
  };
}

export async function runBootstrapImport(options = {}) {
  const startedState = await beginBootstrapImport(options);
  if (startedState?.skipped || startedState?.status === "complete") {
    return startedState;
  }
  return importPromise || startedState;
}
