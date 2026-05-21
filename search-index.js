import { default as FlexSearchIndex } from "./vendor/flexsearch/index.js";
import { extractContextProfile, normalizeText } from "./context-pipeline.js";

let indexSignature = "";
let eventIndex = null;
let eventMap = new Map();

function buildSignature(events) {
  if (!Array.isArray(events) || !events.length) {
    return "empty";
  }

  const first = events[0];
  const last = events[events.length - 1];
  return [
    events.length,
    first?.id || first?.occurred_at || "",
    first?.occurred_at || "",
    last?.id || last?.occurred_at || "",
    last?.occurred_at || "",
  ].join("|");
}

function createIndex() {
  return new FlexSearchIndex({
    charset: "latin:advanced",
    tokenize: "forward",
    resolution: 9,
    cache: 128,
  });
}

function createSearchBlob(event) {
  const profile = extractContextProfile({
    url: event.url,
    application: event.application,
    pageTitle: event.window_title || event.title,
    snippet: event.content_text,
    fullText: event.full_text,
    keyphrases_json: event.keyphrases_json,
    context_profile_json: event.context_profile_json,
    selective_memory_json: event.selective_memory_json,
  });

  const derivativeText = Array.isArray(profile.derivativeItems)
    ? profile.derivativeItems.map((item) => `${item.label || ""} ${item.text || ""}`).join(" ")
    : "";

  return normalizeText(
    [
      event.window_title,
      event.url,
      event.searchable_text,
      event.content_text,
      event.full_text,
      event.application,
      profile.subject,
      profile.entities?.join(" "),
      profile.topics?.join(" "),
      profile.structuredSummary,
      profile.contextText,
      derivativeText,
    ]
      .filter(Boolean)
      .join(" "),
    0
  );
}

function ensureBuilt(events) {
  const signature = buildSignature(events);
  if (eventIndex && signature === indexSignature) {
    return;
  }

  eventIndex = createIndex();
  eventMap = new Map();
  indexSignature = signature;

  for (const event of events || []) {
    const identifier = String(event.id);
    const blob = createSearchBlob(event);
    eventMap.set(identifier, event);
    if (!blob) {
      continue;
    }
    eventIndex.add(identifier, blob);
  }
}

export function invalidateEventSearchIndex() {
  eventIndex = null;
  eventMap = new Map();
  indexSignature = "";
}

export function getIndexedSearchCandidates(events, query, limit = 240) {
  const normalizedQuery = normalizeText(query, 240);
  if (!normalizedQuery) {
    return Array.isArray(events) ? events.slice(0, limit) : [];
  }

  ensureBuilt(events);
  if (!eventIndex) {
    return Array.isArray(events) ? events.slice(0, limit) : [];
  }

  const matchedIds = eventIndex.search(normalizedQuery, Math.max(limit, 40));
  const selected = [];
  const seen = new Set();

  for (const id of matchedIds || []) {
    const event = eventMap.get(String(id));
    if (!event || seen.has(String(id))) {
      continue;
    }
    seen.add(String(id));
    selected.push(event);
    if (selected.length >= limit) {
      break;
    }
  }

  if (!selected.length) {
    return Array.isArray(events) ? events.slice(0, limit) : [];
  }

  if (selected.length < Math.min(limit, 80)) {
    for (const event of events || []) {
      const identifier = String(event.id);
      if (seen.has(identifier)) {
        continue;
      }
      selected.push(event);
      if (selected.length >= limit) {
        break;
      }
    }
  }

  return selected;
}
