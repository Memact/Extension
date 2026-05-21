const DB_NAME = "memact-browser-memory";
const DB_VERSION = 3;

let dbPromise = null;

function openRequest(request) {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });
}

function txDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("error", () => reject(transaction.error));
    transaction.addEventListener("abort", () => reject(transaction.error));
  });
}

export async function initDB() {
  if (dbPromise) {
    return dbPromise;
  }

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.addEventListener("upgradeneeded", () => {
      const db = request.result;
      const transaction = request.transaction;

      if (!db.objectStoreNames.contains("events")) {
        const events = db.createObjectStore("events", {
          keyPath: "id",
          autoIncrement: true
        });
        events.createIndex("occurred_at", "occurred_at", { unique: false });
        events.createIndex("url", "url", { unique: false });
        events.createIndex("application", "application", { unique: false });
        events.createIndex("source", "source", { unique: false });
      } else if (transaction) {
        const events = transaction.objectStore("events");
        if (!events.indexNames.contains("source")) {
          events.createIndex("source", "source", { unique: false });
        }
      }

      if (!db.objectStoreNames.contains("sessions")) {
        const sessions = db.createObjectStore("sessions", {
          keyPath: "id",
          autoIncrement: true
        });
        sessions.createIndex("label", "label", { unique: false });
        sessions.createIndex("started_at", "started_at", { unique: false });
        sessions.createIndex("updated_at", "updated_at", { unique: false });
      }

      if (!db.objectStoreNames.contains("settings")) {
        db.createObjectStore("settings", { keyPath: "key" });
      }

      if (!db.objectStoreNames.contains("content_units")) {
        const contentUnits = db.createObjectStore("content_units", {
          keyPath: "id"
        });
        contentUnits.createIndex("packet_id", "packet_id", { unique: false });
        contentUnits.createIndex("event_id", "event_id", { unique: false });
        contentUnits.createIndex("captured_at", "captured_at", { unique: false });
        contentUnits.createIndex("media_type", "media_type", { unique: false });
        contentUnits.createIndex("url", "url", { unique: false });
      }

      if (!db.objectStoreNames.contains("graph_packets")) {
        const graphPackets = db.createObjectStore("graph_packets", {
          keyPath: "packet_id"
        });
        graphPackets.createIndex("event_id", "event_id", { unique: false });
        graphPackets.createIndex("captured_at", "captured_at", { unique: false });
        graphPackets.createIndex("media_type", "media_type", { unique: false });
        graphPackets.createIndex("url", "url", { unique: false });
      }

      if (!db.objectStoreNames.contains("media_jobs")) {
        const mediaJobs = db.createObjectStore("media_jobs", {
          keyPath: "id"
        });
        mediaJobs.createIndex("status", "status", { unique: false });
        mediaJobs.createIndex("job_type", "job_type", { unique: false });
        mediaJobs.createIndex("created_at", "created_at", { unique: false });
        mediaJobs.createIndex("packet_id", "packet_id", { unique: false });
        mediaJobs.createIndex("event_id", "event_id", { unique: false });
      }
    });

    request.addEventListener("success", () => {
      const db = request.result;
      db.addEventListener("versionchange", () => {
        db.close();
      });
      resolve(db);
    });

    request.addEventListener("error", () => {
      reject(request.error);
    });
  });

  return dbPromise;
}

async function getDb() {
  return initDB();
}

function normalizeString(value) {
  return String(value || "").trim();
}

function toDateMs(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function averageVectors(vectors) {
  if (!vectors.length) {
    return [];
  }
  const dim = vectors[0].length || 0;
  if (!dim) {
    return [];
  }
  const output = new Array(dim).fill(0);
  for (const vector of vectors) {
    for (let i = 0; i < dim; i += 1) {
      output[i] += Number(vector[i] || 0);
    }
  }
  for (let i = 0; i < dim; i += 1) {
    output[i] /= vectors.length;
  }
  return output;
}

export function cosineSimilarity(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const length = Math.min(a?.length || 0, b?.length || 0);
  for (let i = 0; i < length; i += 1) {
    const av = Number(a[i] || 0);
    const bv = Number(b[i] || 0);
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
}

async function getSettingValue(key) {
  const db = await getDb();
  const tx = db.transaction("settings", "readonly");
  const store = tx.objectStore("settings");
  const request = store.get(key);
  const record = await openRequest(request);
  await txDone(tx).catch(() => {});
  return record ? record.value : undefined;
}

async function setSettingValue(key, value) {
  const db = await getDb();
  const tx = db.transaction("settings", "readwrite");
  tx.objectStore("settings").put({ key, value });
  await txDone(tx);
}

function deriveHostname(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function buildSessionLabel(event) {
  const application = normalizeString(event.application) || "browser";
  const host = deriveHostname(event.url);
  const hourBucket = new Date(event.occurred_at || Date.now()).toISOString().slice(0, 13);
  const labelBase = [application, host].filter(Boolean).join(" · ");
  return `${labelBase || application} · ${hourBucket}h`;
}

function buildSessionLabelText(event) {
  const application = normalizeString(event.application) || "browser";
  const host = deriveHostname(event.url);
  const hourBucket = new Date(event.occurred_at || Date.now()).toISOString().slice(0, 13);
  const labelBase = [application, host].filter(Boolean).join(" - ");
  return `${labelBase || application} - ${hourBucket}h`;
}

async function upsertSessionFromEvent(event) {
  const db = await getDb();
  const label = buildSessionLabelText(event);
  const keyphrases = JSON.parse(event.keyphrases_json || "[]");
  const embedding = JSON.parse(event.embedding_json || "[]");

  const tx = db.transaction(["sessions"], "readwrite");
  const store = tx.objectStore("sessions");
  const labelIndex = store.index("label");
  const existing = await openRequest(labelIndex.getAll(label));
  const now = normalizeString(event.occurred_at) || new Date().toISOString();

  if (existing.length) {
    const session = existing[0];
    const previousEmbedding = JSON.parse(session.embedding_json || "[]");
    const previousKeyphrases = JSON.parse(session.keyphrases_json || "[]");
    const mergedKeyphrases = Array.from(
      new Set([...previousKeyphrases, ...keyphrases].filter(Boolean))
    ).slice(0, 24);
    const count = Number(session.event_count || 0) + 1;
    const totalScore = Number(session.total_score || 0) + Math.min(1, (keyphrases.length || 0) / 12);
    const mergedEmbedding = previousEmbedding.length
      ? averageVectors([previousEmbedding, embedding])
      : embedding;
    store.put({
      ...session,
      label,
      ended_at: now,
      event_count: count,
      embedding_json: JSON.stringify(mergedEmbedding),
      keyphrases_json: JSON.stringify(mergedKeyphrases),
      total_score: totalScore,
      updated_at: now
    });
    await txDone(tx);
    return;
  }

  store.add({
    label,
    started_at: now,
    ended_at: now,
    event_count: 1,
    embedding_json: JSON.stringify(embedding),
    keyphrases_json: JSON.stringify(keyphrases.slice(0, 24)),
    total_score: Math.min(1, (keyphrases.length || 0) / 12),
    updated_at: now
  });
  await txDone(tx);
}

const DUPLICATE_HARD_THROTTLE_MS = 20000;
const DUPLICATE_FINGERPRINT_WINDOW_MS = 120000;
const DUPLICATE_URL_FALLBACK_WINDOW_MS = 60000;

function buildCaptureFingerprint(eventData = {}) {
  return [
    normalizeString(eventData.window_title).toLowerCase(),
    normalizeString(eventData.interaction_type).toLowerCase(),
    normalizeString(eventData.content_text).toLowerCase().slice(0, 240),
    normalizeString(eventData.full_text).toLowerCase().slice(0, 320),
  ]
    .filter(Boolean)
    .join(" | ");
}

function readCaptureMemoryEntry(value) {
  if (!value) {
    return { occurredAt: 0, fingerprint: "" };
  }
  if (typeof value === "number") {
    return {
      occurredAt: Number(value) || 0,
      fingerprint: "",
    };
  }
  return {
    occurredAt: Number(value.occurredAt || 0),
    fingerprint: normalizeString(value.fingerprint).toLowerCase(),
  };
}

async function shouldSkipDuplicate(url, occurredAt, fingerprint = "") {
  if (!url) {
    return false;
  }
  const map = (await getSettingValue("last_capture_by_url")) || {};
  const entry = readCaptureMemoryEntry(map[url]);
  const last = entry.occurredAt;
  const now = toDateMs(occurredAt);
  if (!last || !now) {
    return false;
  }

  const elapsedMs = now - last;
  if (elapsedMs < DUPLICATE_HARD_THROTTLE_MS) {
    return true;
  }

  const normalizedFingerprint = normalizeString(fingerprint).toLowerCase();
  if (normalizedFingerprint && normalizedFingerprint === entry.fingerprint) {
    return elapsedMs < DUPLICATE_FINGERPRINT_WINDOW_MS;
  }

  if (!normalizedFingerprint || !entry.fingerprint) {
    return elapsedMs < DUPLICATE_URL_FALLBACK_WINDOW_MS;
  }

  return false;
}

async function rememberCapture(url, occurredAt, fingerprint = "") {
  if (!url) {
    return;
  }
  const map = (await getSettingValue("last_capture_by_url")) || {};
  map[url] = {
    occurredAt: toDateMs(occurredAt) || Date.now(),
    fingerprint: normalizeString(fingerprint).toLowerCase(),
  };
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [key, value] of Object.entries(map)) {
    const entry = readCaptureMemoryEntry(value);
    if (entry.occurredAt < cutoff) {
      delete map[key];
    }
  }
  await setSettingValue("last_capture_by_url", map);
}

export async function appendEvent(eventData) {
  const db = await getDb();
  const occurredAt = normalizeString(eventData.occurred_at) || new Date().toISOString();
  const url = normalizeString(eventData.url);
  const fingerprint = buildCaptureFingerprint(eventData);

  if (await shouldSkipDuplicate(url, occurredAt, fingerprint)) {
    return { skipped: true, reason: "duplicate_url_window" };
  }

  const event = {
    occurred_at: occurredAt,
    application: normalizeString(eventData.application),
    window_title: normalizeString(eventData.window_title),
    url,
    interaction_type: normalizeString(eventData.interaction_type),
    content_text: normalizeString(eventData.content_text),
    full_text: normalizeString(eventData.full_text),
    keyphrases_json: normalizeString(eventData.keyphrases_json) || "[]",
    searchable_text: normalizeString(eventData.searchable_text),
    embedding_json: normalizeString(eventData.embedding_json) || "[]",
    context_profile_json: normalizeString(eventData.context_profile_json) || "",
    selective_memory_json: normalizeString(eventData.selective_memory_json) || "",
    capture_packet_json: normalizeString(eventData.capture_packet_json) || "",
    capture_quality_json: normalizeString(eventData.capture_quality_json) || "",
    source: normalizeString(eventData.source) || "extension"
  };

  const tx = db.transaction(["events"], "readwrite");
  const store = tx.objectStore("events");
  const id = await openRequest(store.add(event));
  await txDone(tx);

  await rememberCapture(url, occurredAt, fingerprint);
  await upsertSessionFromEvent({ ...event, id }).catch(() => {});

  return { skipped: false, id };
}

function normalizeJson(value, fallback = "[]") {
  if (typeof value === "string") {
    return value || fallback;
  }
  try {
    return JSON.stringify(value ?? JSON.parse(fallback));
  } catch {
    return fallback;
  }
}

function cloneJson(value, fallback) {
  try {
    return JSON.parse(JSON.stringify(value ?? fallback));
  } catch {
    return fallback;
  }
}

export async function appendGraphPacket(packet) {
  if (!packet?.packet_id || !Array.isArray(packet.content_units) || !packet.content_units.length) {
    return { skipped: true, reason: "empty_graph_packet" };
  }

  const db = await getDb();
  const tx = db.transaction(["graph_packets", "content_units", "media_jobs"], "readwrite");
  const graphStore = tx.objectStore("graph_packets");
  const unitStore = tx.objectStore("content_units");
  const jobStore = tx.objectStore("media_jobs");
  const packetId = normalizeString(packet.packet_id);
  const eventId = Number(packet.event_id || 0) || null;
  const capturedAt = normalizeString(packet.captured_at) || new Date().toISOString();
  const url = normalizeString(packet.url);
  const title = normalizeString(packet.title);
  const mediaType = normalizeString(packet.media_type) || "webpage";
  const contentUnits = cloneJson(packet.content_units, []);
  const nodes = cloneJson(packet.nodes, []);
  const edges = cloneJson(packet.edges, []);
  const evidenceLinks = cloneJson(packet.evidence_links || packet.schema_memory?.evidence_links, []);
  const knowledgeGraph = cloneJson(packet.knowledge_graph || packet.schema_memory?.knowledge_graph, null);
  const schemaPackets = cloneJson(packet.schema_packets || packet.schema_memory?.schema_packets, []);
  const schemaMemory = cloneJson(packet.schema_memory, null);
  const processingJobs = cloneJson(packet.processing_jobs, []);

  await openRequest(graphStore.put({
    packet_id: packetId,
    packet_type: normalizeString(packet.packet_type) || "multimedia_graph_capture",
    schema_version: Number(packet.schema_version || 1),
    source: normalizeString(packet.source) || "browser_extension",
    event_id: eventId,
    captured_at: capturedAt,
    url,
    domain: normalizeString(packet.domain) || deriveHostname(url),
    title,
    media_type: mediaType,
    content_unit_count: contentUnits.length,
    node_count: nodes.length,
    edge_count: edges.length,
    pending_job_count: processingJobs.length,
    content_units_json: normalizeJson(contentUnits),
    nodes_json: normalizeJson(nodes),
    edges_json: normalizeJson(edges),
    evidence_links_json: normalizeJson(evidenceLinks),
    knowledge_graph_json: normalizeJson(knowledgeGraph, "null"),
    schema_packets_json: normalizeJson(schemaPackets),
    schema_memory_json: normalizeJson(schemaMemory, "null"),
    processing_jobs_json: normalizeJson(processingJobs),
    packet_json: normalizeJson(packet, "{}"),
  }));

  for (const unit of contentUnits) {
    const unitId = normalizeString(unit.unit_id);
    if (!unitId || !normalizeString(unit.text)) {
      continue;
    }
    await openRequest(unitStore.put({
      id: `${packetId}:${unitId}`,
      packet_id: packetId,
      event_id: eventId,
      captured_at: capturedAt,
      url,
      title,
      media_type: normalizeString(unit.media_type) || mediaType,
      unit_type: normalizeString(unit.unit_type) || "text",
      unit_id: unitId,
      section: normalizeString(unit.section),
      location: normalizeString(unit.location),
      start: Number.isFinite(Number(unit.start)) ? Number(unit.start) : null,
      end: Number.isFinite(Number(unit.end)) ? Number(unit.end) : null,
      text: normalizeString(unit.text),
      unit_json: normalizeJson(unit, "{}"),
    }));
  }

  for (const job of processingJobs) {
    const id = normalizeString(job.id);
    if (!id) {
      continue;
    }
    await openRequest(jobStore.put({
      ...job,
      id,
      packet_id: normalizeString(job.packet_id) || packetId,
      event_id: Number(job.event_id || eventId || 0) || null,
      status: normalizeString(job.status) || "pending",
      job_type: normalizeString(job.job_type) || "media_processing",
      created_at: normalizeString(job.created_at) || capturedAt,
    }));
  }

  await txDone(tx);
  return {
    skipped: false,
    packetId,
    contentUnitCount: contentUnits.length,
    nodeCount: nodes.length,
    edgeCount: edges.length,
    pendingJobCount: processingJobs.length,
  };
}

export async function getRecentEvents(limit = 400) {
  const db = await getDb();
  const tx = db.transaction("events", "readonly");
  const store = tx.objectStore("events");
  const index = store.index("occurred_at");
  const results = [];

  await new Promise((resolve, reject) => {
    const request = index.openCursor(null, "prev");
    request.addEventListener("success", () => {
      const cursor = request.result;
      if (!cursor || results.length >= limit) {
        resolve();
        return;
      }
      results.push(cursor.value);
      cursor.continue();
    });
    request.addEventListener("error", () => reject(request.error));
  });

  await txDone(tx).catch(() => {});
  return results;
}

export async function getEventsByTimeRange(startAt, endAt, limit = 1200) {
  const db = await getDb();
  const tx = db.transaction("events", "readonly");
  const store = tx.objectStore("events");
  const index = store.index("occurred_at");
  const range = IDBKeyRange.bound(startAt, endAt);
  const results = [];

  await new Promise((resolve, reject) => {
    const request = index.openCursor(range, "prev");
    request.addEventListener("success", () => {
      const cursor = request.result;
      if (!cursor || results.length >= limit) {
        resolve();
        return;
      }
      results.push(cursor.value);
      cursor.continue();
    });
    request.addEventListener("error", () => reject(request.error));
  });

  await txDone(tx).catch(() => {});
  return results;
}

export async function getEventCount() {
  const db = await getDb();
  const tx = db.transaction("events", "readonly");
  const count = await openRequest(tx.objectStore("events").count());
  await txDone(tx).catch(() => {});
  return count || 0;
}

function parseStoredJson(value, fallback) {
  try {
    return JSON.parse(value || "");
  } catch {
    return fallback;
  }
}

export async function getRecentGraphPackets(limit = 400) {
  const db = await getDb();
  const tx = db.transaction("graph_packets", "readonly");
  const store = tx.objectStore("graph_packets");
  const index = store.index("captured_at");
  const results = [];

  await new Promise((resolve, reject) => {
    const request = index.openCursor(null, "prev");
    request.addEventListener("success", () => {
      const cursor = request.result;
      if (!cursor || results.length >= limit) {
        resolve();
        return;
      }
      const record = cursor.value;
      const packetJson = parseStoredJson(record.packet_json, {});
      const evidenceLinks = parseStoredJson(
        record.evidence_links_json,
        packetJson.evidence_links || packetJson.schema_memory?.evidence_links || []
      );
      const knowledgeGraph = parseStoredJson(
        record.knowledge_graph_json,
        packetJson.knowledge_graph || packetJson.schema_memory?.knowledge_graph || null
      );
      const schemaPackets = parseStoredJson(
        record.schema_packets_json,
        packetJson.schema_packets || packetJson.schema_memory?.schema_packets || []
      );
      const schemaMemory = parseStoredJson(
        record.schema_memory_json,
        packetJson.schema_memory || null
      );
      results.push({
        packet_id: record.packet_id,
        packet_type: record.packet_type,
        schema_version: record.schema_version,
        source: record.source,
        event_id: record.event_id,
        captured_at: record.captured_at,
        url: record.url,
        domain: record.domain,
        title: record.title,
        media_type: record.media_type,
        content_units: parseStoredJson(record.content_units_json, []),
        nodes: parseStoredJson(record.nodes_json, []),
        edges: parseStoredJson(record.edges_json, []),
        evidence_links: evidenceLinks,
        knowledge_graph: knowledgeGraph,
        schema_packets: schemaPackets,
        schema_memory: schemaMemory,
        processing_jobs: parseStoredJson(record.processing_jobs_json, []),
        stats: {
          content_unit_count: Number(record.content_unit_count || 0),
          node_count: Number(record.node_count || 0),
          edge_count: Number(record.edge_count || 0),
          evidence_link_count: evidenceLinks.length,
          schema_packet_count: schemaPackets.length,
          pending_job_count: Number(record.pending_job_count || 0),
        },
      });
      cursor.continue();
    });
    request.addEventListener("error", () => reject(request.error));
  });

  await txDone(tx).catch(() => {});
  return results;
}

export async function getRecentContentUnits(limit = 1200) {
  const db = await getDb();
  const tx = db.transaction("content_units", "readonly");
  const store = tx.objectStore("content_units");
  const index = store.index("captured_at");
  const results = [];

  await new Promise((resolve, reject) => {
    const request = index.openCursor(null, "prev");
    request.addEventListener("success", () => {
      const cursor = request.result;
      if (!cursor || results.length >= limit) {
        resolve();
        return;
      }
      const record = cursor.value;
      results.push({
        id: record.id,
        packet_id: record.packet_id,
        event_id: record.event_id,
        captured_at: record.captured_at,
        url: record.url,
        title: record.title,
        media_type: record.media_type,
        unit_type: record.unit_type,
        unit_id: record.unit_id,
        section: record.section,
        location: record.location,
        start: record.start,
        end: record.end,
        text: record.text,
        unit: parseStoredJson(record.unit_json, null),
      });
      cursor.continue();
    });
    request.addEventListener("error", () => reject(request.error));
  });

  await txDone(tx).catch(() => {});
  return results;
}

export async function getPendingMediaJobs(limit = 200) {
  const db = await getDb();
  const tx = db.transaction("media_jobs", "readonly");
  const store = tx.objectStore("media_jobs");
  const index = store.index("status");
  const results = [];

  await new Promise((resolve, reject) => {
    const request = index.openCursor(IDBKeyRange.only("pending"), "next");
    request.addEventListener("success", () => {
      const cursor = request.result;
      if (!cursor || results.length >= limit) {
        resolve();
        return;
      }
      results.push(cursor.value);
      cursor.continue();
    });
    request.addEventListener("error", () => reject(request.error));
  });

  await txDone(tx).catch(() => {});
  return results;
}

export async function getGraphPacketCount() {
  const db = await getDb();
  const tx = db.transaction("graph_packets", "readonly");
  const count = await openRequest(tx.objectStore("graph_packets").count());
  await txDone(tx).catch(() => {});
  return count || 0;
}

export async function getContentUnitCount() {
  const db = await getDb();
  const tx = db.transaction("content_units", "readonly");
  const count = await openRequest(tx.objectStore("content_units").count());
  await txDone(tx).catch(() => {});
  return count || 0;
}

export async function getPendingMediaJobCount() {
  const db = await getDb();
  const tx = db.transaction("media_jobs", "readonly");
  const index = tx.objectStore("media_jobs").index("status");
  const count = await openRequest(index.count(IDBKeyRange.only("pending")));
  await txDone(tx).catch(() => {});
  return count || 0;
}

export async function getLatestGraphPacketTimestamp() {
  const db = await getDb();
  const tx = db.transaction("graph_packets", "readonly");
  const index = tx.objectStore("graph_packets").index("captured_at");
  const cursor = await openRequest(index.openCursor(null, "prev"));
  await txDone(tx).catch(() => {});
  return cursor?.value?.captured_at || "";
}

export async function getLatestEventTimestamp() {
  const db = await getDb();
  const tx = db.transaction("events", "readonly");
  const index = tx.objectStore("events").index("occurred_at");
  const cursor = await openRequest(index.openCursor(null, "prev"));
  await txDone(tx).catch(() => {});
  return cursor?.value?.occurred_at || "";
}

export async function getSessionCount() {
  const db = await getDb();
  const tx = db.transaction("sessions", "readonly");
  const count = await openRequest(tx.objectStore("sessions").count());
  await txDone(tx).catch(() => {});
  return count || 0;
}

export async function searchEventsByEmbedding(queryEmbedding, limit = 50) {
  const db = await getDb();
  const tx = db.transaction("events", "readonly");
  const store = tx.objectStore("events");
  const allEvents = await openRequest(store.getAll());
  await txDone(tx).catch(() => {});

  const scored = [];
  for (const event of allEvents || []) {
    const embedding = JSON.parse(event.embedding_json || "[]");
    if (!Array.isArray(embedding) || !embedding.length) {
      continue;
    }
    const similarity = cosineSimilarity(queryEmbedding, embedding);
    scored.push({ ...event, similarity });
  }
  scored.sort((left, right) => right.similarity - left.similarity);
  return scored.slice(0, limit);
}

export async function clearAllData() {
  const db = await getDb();
  const tx = db.transaction(["events", "sessions", "settings", "content_units", "graph_packets", "media_jobs"], "readwrite");
  tx.objectStore("events").clear();
  tx.objectStore("sessions").clear();
  tx.objectStore("settings").clear();
  tx.objectStore("content_units").clear();
  tx.objectStore("graph_packets").clear();
  tx.objectStore("media_jobs").clear();
  await txDone(tx);
}

export async function clearBootstrapImportedEvents() {
  const db = await getDb();
  const tx = db.transaction(["events", "sessions", "settings", "content_units", "graph_packets", "media_jobs"], "readwrite");
  const eventStore = tx.objectStore("events");
  const sourceIndex = eventStore.index("source");
  const deletedEventIds = new Set();
  let deletedCount = 0;

  await new Promise((resolve, reject) => {
    const request = sourceIndex.openCursor(IDBKeyRange.only("history-bootstrap"));
    request.addEventListener("success", () => {
      const cursor = request.result;
      if (!cursor) {
        resolve();
        return;
      }
      deletedEventIds.add(Number(cursor.value?.id || 0));
      cursor.delete();
      deletedCount += 1;
      cursor.continue();
    });
    request.addEventListener("error", () => reject(request.error));
  });

  // Sessions are derived again from remaining events at query time. Clearing the
  // cached session table prevents old imported sessions from staying visible in stats.
  tx.objectStore("sessions").clear();
  tx.objectStore("settings").delete("last_capture_by_url");

  for (const storeName of ["content_units", "graph_packets", "media_jobs"]) {
    const store = tx.objectStore(storeName);
    const index = store.index("event_id");
    for (const eventId of deletedEventIds) {
      if (!eventId) {
        continue;
      }
      await new Promise((resolve, reject) => {
        const request = index.openCursor(IDBKeyRange.only(eventId));
        request.addEventListener("success", () => {
          const cursor = request.result;
          if (!cursor) {
            resolve();
            return;
          }
          cursor.delete();
          cursor.continue();
        });
        request.addEventListener("error", () => reject(request.error));
      });
    }
  }

  await txDone(tx);
  return { deletedCount };
}

export async function getStats() {
  const [
    eventCount,
    sessionCount,
    lastEventAt,
    graphPacketCount,
    contentUnitCount,
    pendingMediaJobCount,
    lastGraphPacketAt,
  ] = await Promise.all([
    getEventCount(),
    getSessionCount(),
    getLatestEventTimestamp(),
    getGraphPacketCount(),
    getContentUnitCount(),
    getPendingMediaJobCount(),
    getLatestGraphPacketTimestamp(),
  ]);
  const recentEvents = await getRecentEvents(1).catch(() => []);
  return {
    eventCount,
    sessionCount,
    graphPacketCount,
    contentUnitCount,
    pendingMediaJobCount,
    lastEventAt: lastEventAt || recentEvents[0]?.occurred_at || null,
    lastGraphPacketAt: lastGraphPacketAt || null
  };
}
