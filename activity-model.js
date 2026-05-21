import { extractContextProfile, shouldSkipCaptureProfile } from "./context-pipeline.js";
import { evaluateSelectiveMemory } from "./selective-memory.js";

const SESSION_TIMEOUT_MS = 25 * 60 * 1000;
const SESSION_MAX_GAP_MS = 45 * 60 * 1000;
const SESSION_SEMANTIC_THRESHOLD = 0.18;
const TOP_ACTIVITY_KEYPHRASES = 6;

const EDITOR_APPS = new Set(["code", "cursor", "codex", "pycharm", "idea", "webstorm"]);

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
  const normalized = text
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
  if (!normalized) {
    return "";
  }
  return maxLength && normalized.length > maxLength
    ? normalized.slice(0, maxLength)
    : normalized;
}

function toTimestamp(value) {
  const timestamp = Date.parse(value || "");
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function hostnameFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
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
        .filter((token) => token.length >= 2)
    )
  );
}

function overlapCount(left, right) {
  if (!left?.length || !right?.length) {
    return 0;
  }
  const rightSet = new Set(right.map((value) => String(value).toLowerCase()));
  return left.reduce(
    (count, value) => count + (rightSet.has(String(value).toLowerCase()) ? 1 : 0),
    0
  );
}

function averageVector(vectors) {
  if (!vectors.length) {
    return [];
  }
  const dim = Math.max(...vectors.map((vector) => vector.length || 0), 0);
  if (!dim) {
    return [];
  }
  const total = new Array(dim).fill(0);
  for (const vector of vectors) {
    for (let index = 0; index < dim; index += 1) {
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

function compactText(value, maxLength = 180) {
  return normalizeText(value, maxLength);
}

function toTitleCase(value) {
  return String(value || "")
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function isInternalCaptureEvent(event) {
  try {
    const parsed = new URL(event.url || "");
    const hostname = parsed.hostname.replace(/^www\./i, "").toLowerCase();
    const title = normalizeText(event.title, 200).toLowerCase();
    const isLocalHost =
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "0.0.0.0" ||
      hostname === "::1";

    if (hostname === "memact.com") {
      return true;
    }

    return isLocalHost && (parsed.port === "5173" || parsed.port === "4173" || title.includes("memact"));
  } catch {
    return false;
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

function normalizeCapturePacket(rawEvent, contextProfile) {
  const directPacket = parseObjectValue(rawEvent.capture_packet_json || rawEvent.capturePacket);
  if (Object.keys(directPacket).length) {
    return directPacket;
  }
  return contextProfile.capturePacket && typeof contextProfile.capturePacket === "object"
    ? contextProfile.capturePacket
    : null;
}

export function normalizeCapturedEvent(rawEvent) {
  const application = normalizeText(rawEvent.application).replace(/\.exe$/i, "") || "browser";
  const keyphrases = parseKeyphrases(rawEvent);
  const embedding = parseEmbedding(rawEvent);
  const occurredAt = normalizeText(rawEvent.occurred_at || new Date().toISOString(), 80);
  const title = normalizeText(
    rawEvent.window_title || rawEvent.title || rawEvent.pageTitle,
    180
  );
  const snippet = normalizeText(
    rawEvent.content_text || rawEvent.snippet || rawEvent.searchable_text,
    320
  );
  const fullText = normalizeRichText(rawEvent.full_text || rawEvent.fullText, 0);

  const contextProfile = extractContextProfile({
    url: rawEvent.url,
    application,
    pageTitle: title,
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

  const capturePacket = normalizeCapturePacket(rawEvent, contextProfile);
  const normalized = {
    id: rawEvent.id,
    source: normalizeText(rawEvent.source || "extension", 40),
    occurred_at: occurredAt,
    timestamp: toTimestamp(occurredAt),
    url: normalizeText(rawEvent.url, 400),
    domain: hostnameFromUrl(rawEvent.url),
    application,
    interaction_type: normalizeText(rawEvent.interaction_type, 80),
    title: contextProfile.title || title || hostnameFromUrl(rawEvent.url) || "Local memory",
    snippet: contextProfile.snippet || snippet,
    full_text: contextProfile.fullText || fullText,
    display_full_text: contextProfile.displayFullText || contextProfile.fullText || fullText,
    raw_full_text: fullText,
    structured_summary: contextProfile.structuredSummary || "",
    display_excerpt: contextProfile.displayExcerpt || "",
    page_type: contextProfile.pageType || "",
    page_type_label: contextProfile.pageTypeLabel || "",
    context_subject: contextProfile.subject || "",
    context_entities: Array.isArray(contextProfile.entities) ? contextProfile.entities : [],
    context_topics: Array.isArray(contextProfile.topics) ? contextProfile.topics : [],
    fact_items: Array.isArray(contextProfile.factItems) ? contextProfile.factItems : [],
    keyphrases: contextProfile.keyphrases?.length ? contextProfile.keyphrases : keyphrases,
    embedding,
    title_tokens: meaningfulTokens(contextProfile.title || title),
    capture_intent: contextProfile.captureIntent || null,
    clutter_audit: contextProfile.clutterAudit || null,
    local_judge: contextProfile.localJudge || null,
    selective_memory: contextProfile.selectiveMemory || null,
    capture_packet: capturePacket,
    context_profile: contextProfile,
  };

  return normalized;
}

export function normalizeCapturedEvents(
  rawEvents,
  { includeSkipped = false, includeInternal = false } = {}
) {
  return (Array.isArray(rawEvents) ? rawEvents : [])
    .map(normalizeCapturedEvent)
    .filter((event) => event.timestamp)
    .filter((event) => (includeInternal ? true : !isInternalCaptureEvent(event)))
    .filter((event) => (includeSkipped ? true : !shouldSkipCaptureProfile(event.context_profile || event)))
    .sort((left, right) => left.timestamp - right.timestamp || Number(left.id || 0) - Number(right.id || 0));
}

function activityMode(events) {
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

function topKeyphrases(events, limit = TOP_ACTIVITY_KEYPHRASES) {
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
    .sort((left, right) => right[1] - left[1] || left[0].length - right[0].length)
    .slice(0, limit)
    .map(([phrase]) => phrase);
}

function dominantValue(values) {
  const counts = new Map();
  for (const value of values) {
    const normalized = normalizeText(value, 120);
    if (!normalized) {
      continue;
    }
    const key = normalized.toLowerCase();
    counts.set(key, {
      value: normalized,
      count: (counts.get(key)?.count || 0) + 1,
    });
  }
  return [...counts.values()].sort((left, right) => right.count - left.count)[0]?.value || "";
}

function buildActivityKey(events, keyphrases) {
  const dominantSubject = dominantValue(events.map((event) => event.context_subject));
  if (dominantSubject) {
    return dominantSubject;
  }
  if (keyphrases.length) {
    return keyphrases[0];
  }
  const dominantTopic = dominantValue(events.flatMap((event) => event.context_topics || []));
  if (dominantTopic) {
    return dominantTopic;
  }
  const dominantDomain = dominantValue(events.map((event) => event.domain));
  if (dominantDomain) {
    return dominantDomain;
  }
  return dominantValue(events.map((event) => event.application)) || "local memory";
}

function buildActivityLabel(events, keyphrases) {
  const mode = activityMode(events);
  const topic = buildActivityKey(events, keyphrases);
  if (topic) {
    if (mode === "coding") {
      return compactText(`Working on ${topic}`, 84);
    }
    if (mode === "reading") {
      return compactText(`Reading about ${topic}`, 84);
    }
    return compactText(`Exploring ${topic}`, 84);
  }

  const dominantDomain = dominantValue(events.map((event) => event.domain));
  if (dominantDomain) {
    return compactText(`Research in ${dominantDomain}`, 84);
  }

  const dominantApp = dominantValue(events.map((event) => event.application));
  return dominantApp ? compactText(`Using ${toTitleCase(dominantApp)}`, 84) : "Local memory activity";
}

function sessionContinuity(event, activity, cosineSimilarity) {
  const gap = event.timestamp - activity.endedTimestamp;
  if (gap < 0 || gap > SESSION_MAX_GAP_MS) {
    return false;
  }
  if (gap <= 8 * 60 * 1000) {
    return true;
  }

  const semantic = event.embedding.length && activity.embedding.length
    ? cosineSimilarity(event.embedding, activity.embedding)
    : 0;
  const sameDomain = event.domain && activity.domains.has(event.domain);
  const sameApp = event.application && activity.applications.has(event.application);
  const phraseOverlap = overlapCount(event.keyphrases, activity.keyphrases) > 0;
  const titleOverlap = overlapCount(event.title_tokens, [...activity.titleTokens]) > 0;

  if (gap > SESSION_TIMEOUT_MS) {
    return sameDomain && phraseOverlap;
  }

  return semantic >= SESSION_SEMANTIC_THRESHOLD || sameDomain || sameApp || phraseOverlap || titleOverlap;
}

function finalizeActivity(activity) {
  activity.keyphrases = topKeyphrases(activity.events);
  activity.mode = activityMode(activity.events);
  activity.key = buildActivityKey(activity.events, activity.keyphrases);
  activity.label = buildActivityLabel(activity.events, activity.keyphrases);
  activity.subject = dominantValue(activity.events.map((event) => event.context_subject)) || activity.key;
  activity.summary =
    dominantValue(activity.events.map((event) => event.structured_summary)) ||
    `${activity.label}.`;
  activity.event_ids = activity.events.map((event) => event.id);
  activity.event_count = activity.events.length;
  activity.started_at = activity.events[0]?.occurred_at || activity.started_at;
  activity.ended_at = activity.events[activity.events.length - 1]?.occurred_at || activity.ended_at;
  activity.duration_ms = Math.max(0, activity.endedTimestamp - activity.startedTimestamp);
  activity.domains = [...activity.domains];
  activity.applications = [...activity.applications];
  activity.events = activity.events.map((event) => ({
    id: event.id,
    occurred_at: event.occurred_at,
    url: event.url,
    domain: event.domain,
    application: event.application,
    title: event.title,
    context_subject: event.context_subject,
    page_type: event.page_type,
    structured_summary: event.structured_summary,
  }));
  delete activity.embedding;
  delete activity.titleTokens;
  delete activity.startedTimestamp;
  delete activity.endedTimestamp;
}

export function buildActivities(events, { cosineSimilarity }) {
  const ordered = [...(Array.isArray(events) ? events : [])].sort(
    (left, right) => left.timestamp - right.timestamp || Number(left.id || 0) - Number(right.id || 0)
  );
  const activities = [];
  const eventToActivity = new Map();
  let current = null;

  const pushCurrent = () => {
    if (!current || !current.events.length) {
      return;
    }
    finalizeActivity(current);
    activities.push(current);
  };

  for (const event of ordered) {
    if (!current) {
      current = {
        id: activities.length + 1,
        events: [event],
        started_at: event.occurred_at,
        ended_at: event.occurred_at,
        startedTimestamp: event.timestamp,
        endedTimestamp: event.timestamp,
        embedding: event.embedding,
        keyphrases: [...event.keyphrases],
        domains: new Set(event.domain ? [event.domain] : []),
        applications: new Set(event.application ? [event.application] : []),
        titleTokens: new Set(event.title_tokens || []),
      };
      eventToActivity.set(event.id, current.id);
      continue;
    }

    if (!sessionContinuity(event, current, cosineSimilarity)) {
      pushCurrent();
      current = {
        id: activities.length + 1,
        events: [event],
        started_at: event.occurred_at,
        ended_at: event.occurred_at,
        startedTimestamp: event.timestamp,
        endedTimestamp: event.timestamp,
        embedding: event.embedding,
        keyphrases: [...event.keyphrases],
        domains: new Set(event.domain ? [event.domain] : []),
        applications: new Set(event.application ? [event.application] : []),
        titleTokens: new Set(event.title_tokens || []),
      };
      eventToActivity.set(event.id, current.id);
      continue;
    }

    current.events.push(event);
    current.ended_at = event.occurred_at;
    current.endedTimestamp = event.timestamp;
    current.embedding = averageVector(current.events.map((item) => item.embedding));
    current.keyphrases = topKeyphrases(current.events);
    if (event.domain) {
      current.domains.add(event.domain);
    }
    if (event.application) {
      current.applications.add(event.application);
    }
    for (const token of event.title_tokens || []) {
      current.titleTokens.add(token);
    }
    eventToActivity.set(event.id, current.id);
  }

  pushCurrent();
  return {
    activities,
    eventToActivity,
  };
}

export function createCaptureActivitySnapshot(rawEvents, { cosineSimilarity }) {
  const events = normalizeCapturedEvents(rawEvents);
  const { activities } = buildActivities(events, { cosineSimilarity });
  return {
    events,
    sessions: activities.map((activity) => ({
      id: activity.id,
      label: activity.label,
      started_at: activity.started_at,
      ended_at: activity.ended_at,
      duration_ms: activity.duration_ms,
      event_count: activity.event_count,
      keyphrases: activity.keyphrases,
      domains: activity.domains,
      applications: activity.applications,
      mode: activity.mode,
    })),
    activities: activities.map((activity) => ({
      id: activity.id,
      key: normalizeText(activity.key, 120).toLowerCase(),
      label: activity.label,
      subject: activity.subject,
      summary: activity.summary,
      started_at: activity.started_at,
      ended_at: activity.ended_at,
      duration_ms: activity.duration_ms,
      event_count: activity.event_count,
      keyphrases: activity.keyphrases,
      domains: activity.domains,
      applications: activity.applications,
      mode: activity.mode,
      event_ids: activity.event_ids,
      events: activity.events,
    })),
  };
}
