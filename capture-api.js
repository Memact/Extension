import {
  cosineSimilarity,
  getPendingMediaJobs,
  getRecentContentUnits,
  getRecentEvents,
  getRecentGraphPackets,
} from "./db.js";
import { createCaptureActivitySnapshot } from "./activity-model.js";

export async function getEvents(options = {}) {
  const limit = Math.max(1, Number(options.limit || 3000));
  const snapshot = createCaptureActivitySnapshot(await getRecentEvents(limit), {
    cosineSimilarity,
  });
  return snapshot.events;
}

export async function getSessions(options = {}) {
  const limit = Math.max(1, Number(options.limit || 3000));
  const snapshot = createCaptureActivitySnapshot(await getRecentEvents(limit), {
    cosineSimilarity,
  });
  return snapshot.sessions;
}

export async function getActivities(options = {}) {
  const limit = Math.max(1, Number(options.limit || 3000));
  const snapshot = createCaptureActivitySnapshot(await getRecentEvents(limit), {
    cosineSimilarity,
  });
  return snapshot.activities;
}

export async function getContentUnits(options = {}) {
  const limit = Math.max(1, Number(options.limit || 1200));
  if (Array.isArray(options.scopes) && !options.scopes.includes("memory:read_evidence") && !options.scopes.includes("memory:read_graph")) {
    return [];
  }
  return filterByCategories(await getRecentContentUnits(limit), options.categories);
}

export async function getGraphPackets(options = {}) {
  const limit = Math.max(1, Number(options.limit || 400));
  const packets = filterByCategories(await getRecentGraphPackets(limit), options.categories);
  if (Array.isArray(options.scopes) && !options.scopes.includes("memory:read_graph")) {
    return packets.map(redactGraphPacket);
  }
  return packets;
}

export async function getMediaJobs(options = {}) {
  const limit = Math.max(1, Number(options.limit || 200));
  if (Array.isArray(options.scopes) && !options.scopes.includes("capture:media")) {
    return [];
  }
  return getPendingMediaJobs(limit);
}

export async function getCaptureSnapshot(options = {}) {
  const limit = Math.max(1, Number(options.limit || 3000));
  const [events, contentUnits, graphPackets, mediaJobs] = await Promise.all([
    getRecentEvents(limit),
    getRecentContentUnits(Math.max(1200, limit)),
    getRecentGraphPackets(Math.max(400, Math.ceil(limit / 2))),
    getPendingMediaJobs(200),
  ]);
  const snapshot = createCaptureActivitySnapshot(events, {
    cosineSimilarity,
  });
  const snapshotResult = {
    system: "capture",
    snapshot_type: "capture-memory-export",
    schema_version: 2,
    generated_at: new Date().toISOString(),
    counts: {
      events: snapshot.events.length,
      sessions: snapshot.sessions.length,
      activities: snapshot.activities.length,
      content_units: contentUnits.length,
      graph_packets: graphPackets.length,
      pending_media_jobs: mediaJobs.length,
    },
    content_units: contentUnits,
    graph_packets: graphPackets,
    pending_media_jobs: mediaJobs,
    ...snapshot,
  };
  return filterCaptureSnapshotForScopes(snapshotResult, options);
}

export function filterCaptureSnapshotForScopes(snapshot, options = {}) {
  const scopes = Array.isArray(options.scopes) ? options.scopes : null;
  const trusted = options.trusted === true || options.accessContext?.trusted === true;
  if (trusted || !scopes) {
    return snapshot;
  }

  const scopeSet = new Set(scopes.map(String));
  const canReadEvidence = scopeSet.has("memory:read_evidence") || scopeSet.has("memory:read_graph");
  const canReadGraph = scopeSet.has("memory:read_graph");

  const filtered = {
    ...snapshot,
    events: canReadEvidence ? filterByCategories(snapshot.events, options.categories) : filterByCategories(snapshot.events, options.categories).map(redactEvent),
    sessions: canReadEvidence ? filterByCategories(snapshot.sessions, options.categories) : filterByCategories(snapshot.sessions, options.categories).map(redactSession),
    activities: canReadEvidence ? filterByCategories(snapshot.activities, options.categories) : filterByCategories(snapshot.activities, options.categories).map(redactActivity),
    content_units: canReadEvidence ? filterByCategories(snapshot.content_units, options.categories) : [],
    graph_packets: canReadGraph ? filterByCategories(snapshot.graph_packets, options.categories) : filterByCategories(snapshot.graph_packets, options.categories).map(redactGraphPacket),
    pending_media_jobs: [],
    access_filter: {
      scopes: [...scopeSet],
      categories: normalizeCategories(options.categories),
      understanding_strategy_id: options.understandingStrategy?.id || "",
      evidence_visible: canReadEvidence,
      graph_visible: canReadGraph,
      note: "Capture formed local evidence; this response only exposes data allowed by app consent scopes.",
    },
  };

  filtered.counts = {
    ...(snapshot.counts || {}),
    events: filtered.events.length,
    sessions: filtered.sessions.length,
    activities: filtered.activities.length,
    content_units: filtered.content_units.length,
    graph_packets: filtered.graph_packets.length,
    pending_media_jobs: 0,
  };
  return filtered;
}

function filterByCategories(records = [], categories = []) {
  const cleanCategories = normalizeCategories(categories);
  if (!cleanCategories.length) return records || [];
  return (records || []).filter((record) => matchesAnyCategory(record, cleanCategories));
}

function normalizeCategories(categories = []) {
  return [...new Set((Array.isArray(categories) ? categories : []).map(String).filter(Boolean))];
}

function matchesAnyCategory(record = {}, categories = []) {
  return categories.some((category) => matchesCategory(record, category));
}

function matchesCategory(record = {}, category = "") {
  const haystack = [
    record.page_type,
    record.page_type_label,
    record.media_type,
    record.packet_type,
    record.application,
    record.domain,
    record.source,
    record.title,
    record.url,
    record.key,
  ].map((value) => String(value || "").toLowerCase()).join(" ");

  if (category === "web:news") return /news|article|publisher|newspaper|current|politic/.test(haystack);
  if (category === "web:research") return /research|paper|docs?|documentation|tutorial|learn|study|arxiv|scholar/.test(haystack);
  if (category === "web:commerce") return /product|shop|commerce|price|review|cart|store/.test(haystack);
  if (category === "web:social") return /social|post|feed|thread|reply|twitter|x\.com|reddit|linkedin|instagram|facebook/.test(haystack);
  if (category === "media:video") return /video|youtube|vimeo|caption|transcript/.test(haystack);
  if (category === "media:audio") return /audio|podcast|song|spotify|transcript/.test(haystack);
  if (category === "ai:assistant") return /assistant|chatgpt|claude|copilot|gemini|perplexity/.test(haystack);
  if (category === "dev:code") return /code|github|gitlab|repo|issue|pull request|terminal|vscode|cursor/.test(haystack);
  if (category === "work:docs") return /docs?|document|notes?|notion|slack|drive|office|word/.test(haystack);
  return false;
}

function redactEvent(event = {}) {
  return {
    id: event.id,
    occurred_at: event.occurred_at,
    domain: event.domain,
    application: event.application,
    interaction_type: event.interaction_type,
    page_type: event.page_type,
    retained: Boolean(event.retained ?? true),
  };
}

function redactSession(session = {}) {
  return {
    id: session.id,
    started_at: session.started_at,
    ended_at: session.ended_at,
    duration_ms: session.duration_ms,
    event_count: session.event_count,
    domains: session.domains,
    applications: session.applications,
  };
}

function redactActivity(activity = {}) {
  return {
    id: activity.id,
    key: activity.key,
    started_at: activity.started_at,
    ended_at: activity.ended_at,
    duration_ms: activity.duration_ms,
    event_count: activity.event_count,
    domains: activity.domains,
    applications: activity.applications,
    mode: activity.mode,
  };
}

function redactGraphPacket(packet = {}) {
  return {
    packet_id: packet.packet_id,
    packet_type: packet.packet_type,
    schema_version: packet.schema_version,
    source: packet.source,
    domain: packet.domain,
    media_type: packet.media_type,
    captured_at: packet.captured_at,
    content_unit_count: Array.isArray(packet.content_units) ? packet.content_units.length : 0,
    node_count: Array.isArray(packet.nodes) ? packet.nodes.length : 0,
    edge_count: Array.isArray(packet.edges) ? packet.edges.length : 0,
    evidence_link_count: Array.isArray(packet.evidence_links) ? packet.evidence_links.length : 0,
    schema_packet_count: Array.isArray(packet.schema_packets) ? packet.schema_packets.length : 0,
    nodes: [],
    edges: [],
    evidence_links: [],
    schema_packets: [],
    knowledge_graph: null,
    schema_memory: null,
    content_units: [],
    redacted: true,
  };
}
