const MAX_CONTENT_UNITS = 48;
const MAX_UNIT_TEXT = 1200;
const MAX_NODES = 80;
const MAX_EDGES = 120;

import { buildSchemaGraphEnvelope } from "./schema-graph.js";

const STOPWORDS = new Set([
  "a",
  "about",
  "after",
  "all",
  "also",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "because",
  "been",
  "but",
  "by",
  "can",
  "could",
  "for",
  "from",
  "has",
  "have",
  "how",
  "i",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "may",
  "more",
  "not",
  "of",
  "on",
  "or",
  "should",
  "that",
  "the",
  "their",
  "this",
  "to",
  "was",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "with",
  "you",
  "your",
]);

const RELATION_PATTERNS = [
  { type: "shapes", pattern: /\b(.{3,80}?)\s+(shapes?|shaped|shape)\s+(.{3,80})\b/i, confidence: 0.92 },
  { type: "affects", pattern: /\b(.{3,80}?)\s+(affects?|affected|influences?|influenced)\s+(.{3,80})\b/i, confidence: 0.9 },
  { type: "claims_causes", pattern: /\b(.{3,80}?)\s+(causes?|caused|creates?|created)\s+(.{3,80})\b/i, confidence: 0.78 },
  { type: "leads_to", pattern: /\b(.{3,80}?)\s+(leads?\s+to|led\s+to|moves?\s+toward|pushes?\s+toward)\s+(.{3,80})\b/i, confidence: 0.88 },
  { type: "depends_on", pattern: /\b(.{3,80}?)\s+(depends?\s+on|relies?\s+on)\s+(.{3,80})\b/i, confidence: 0.86 },
  { type: "part_of", pattern: /\b(.{3,80}?)\s+(is\s+part\s+of|are\s+part\s+of|belongs?\s+to)\s+(.{3,80})\b/i, confidence: 0.84 },
  { type: "example_of", pattern: /\b(.{3,80}?)\s+(is\s+an?\s+example\s+of|are\s+examples\s+of)\s+(.{3,80})\b/i, confidence: 0.84 },
  { type: "improves", pattern: /\b(.{3,80}?)\s+(improves?|improved|strengthens?|strengthened)\s+(.{3,80})\b/i, confidence: 0.86 },
  { type: "reduces", pattern: /\b(.{3,80}?)\s+(reduces?|reduced|weakens?|weakened)\s+(.{3,80})\b/i, confidence: 0.86 },
  { type: "changes", pattern: /\b(.{3,80}?)\s+(changes?|changed|transforms?|transformed)\s+(.{3,80})\b/i, confidence: 0.86 },
  { type: "supports", pattern: /\b(.{3,80}?)\s+(supports?|supported|backs?|backed)\s+(.{3,80})\b/i, confidence: 0.82 },
  { type: "contrasts_with", pattern: /\b(.{3,80}?)\s+(contrasts?\s+with|conflicts?\s+with|opposes?)\s+(.{3,80})\b/i, confidence: 0.82 },
  { type: "linked_to", pattern: /\b(.{3,80}?)\s+(is\s+linked\s+to|are\s+linked\s+to|connects?\s+to|relates?\s+to)\s+(.{3,80})\b/i, confidence: 0.76 },
];

function normalizeText(value, maxLength = 0) {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
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

function slug(value, fallback = "node") {
  const normalized = normalizeText(value)
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || fallback;
}

function hostnameFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
}

function unitKey(unit) {
  return [
    normalizeText(unit.unit_type || unit.location || unit.kind, 40).toLowerCase(),
    normalizeText(unit.text, 160).toLowerCase(),
    normalizeText(unit.start, 20),
    normalizeText(unit.end, 20),
  ].join("|");
}

function dedupeUnits(units) {
  const seen = new Set();
  const output = [];
  for (const unit of units) {
    const text = normalizeText(unit?.text, MAX_UNIT_TEXT);
    if (!text || text.length < 8) {
      continue;
    }
    const normalized = {
      ...unit,
      text,
    };
    const key = unitKey(normalized);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(normalized);
    if (output.length >= MAX_CONTENT_UNITS) {
      break;
    }
  }
  return output;
}

function inferMediaType(profile, activeContext, units) {
  const explicit = normalizeText(activeContext?.mediaType || activeContext?.media_type).toLowerCase();
  if (explicit) return explicit;
  const mediaElements = Array.isArray(activeContext?.mediaElements) ? activeContext.mediaElements : [];
  if (mediaElements.some((media) => normalizeText(media?.media_type).toLowerCase() === "video")) {
    return "video";
  }
  if (mediaElements.some((media) => normalizeText(media?.media_type).toLowerCase() === "audio")) {
    return "audio";
  }
  const unitTypes = units.map((unit) => normalizeText(unit.media_type || unit.unit_type).toLowerCase()).join(" ");
  if (/\b(video|transcript|caption)\b/.test(unitTypes)) return "video";
  if (/\baudio\b/.test(unitTypes)) return "audio";
  if (/\b(image|ocr)\b/.test(unitTypes)) return "image";
  const pageType = normalizeText(profile?.pageType || profile?.page_type).toLowerCase();
  if (pageType === "video") return "video";
  if (pageType === "audio" || pageType === "podcast") return "audio";
  if (pageType === "docs" || pageType === "article" || pageType === "qa") return "article";
  return "webpage";
}

function normalizeIncomingUnit(unit, index, mediaType = "webpage") {
  const unitType = normalizeText(unit?.unit_type || unit?.type || unit?.kind || unit?.location, 48) || "text";
  const rawId = normalizeText(unit?.unit_id || unit?.id, 80);
  const start = Number(unit?.start ?? unit?.start_time ?? NaN);
  const end = Number(unit?.end ?? unit?.end_time ?? NaN);
  const normalized = {
    unit_id: rawId || `${slug(unitType, "unit")}_${index + 1}`,
    media_type: normalizeText(unit?.media_type || mediaType, 32) || mediaType,
    unit_type: unitType,
    text: normalizeText(unit?.text || unit?.caption || unit?.alt || "", MAX_UNIT_TEXT),
    source: normalizeText(unit?.source, 80),
    location: normalizeText(unit?.location, 80),
    section: normalizeText(unit?.section, 120),
    confidence: Number.isFinite(Number(unit?.confidence)) ? Number(unit.confidence) : 0.72,
  };

  if (Number.isFinite(start)) {
    normalized.start = start;
  }
  if (Number.isFinite(end)) {
    normalized.end = end;
  }
  if (unit?.page_number) {
    normalized.page_number = Number(unit.page_number) || undefined;
  }
  if (unit?.image && typeof unit.image === "object") {
    normalized.image = {
      src: normalizeText(unit.image.src, 400),
      alt: normalizeText(unit.image.alt, 240),
      caption: normalizeText(unit.image.caption, 320),
      width: Number(unit.image.width || 0),
      height: Number(unit.image.height || 0),
      text_likelihood: normalizeText(unit.image.text_likelihood, 40),
    };
  }
  return normalized;
}

function unitsFromCapturePacket(capturePacket, mediaType) {
  const blocks = Array.isArray(capturePacket?.blocks) ? capturePacket.blocks : [];
  return blocks.map((block, index) => ({
    unit_id: `block_${index + 1}`,
    media_type: mediaType,
    unit_type: normalizeText(block.kind, 40) || "capture_block",
    text: normalizeRichText(block.text, MAX_UNIT_TEXT),
    location: normalizeText(block.label, 80) || "Capture block",
    confidence: 0.68,
  }));
}

function unitsFromFullText(fullText, mediaType) {
  return normalizeRichText(fullText, 0)
    .split(/\n{2,}/)
    .map((paragraph, index) => ({
      unit_id: `text_${index + 1}`,
      media_type: mediaType,
      unit_type: "paragraph",
      text: normalizeText(paragraph, MAX_UNIT_TEXT),
      location: "Extracted text",
      confidence: 0.62,
    }))
    .filter((unit) => unit.text.length >= 40)
    .slice(0, 12);
}

function splitSentences(text) {
  return normalizeText(text, 0)
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => normalizeText(sentence, 240))
    .filter((sentence) => sentence.length >= 16);
}

function cleanPhrase(value) {
  let phrase = normalizeText(value, 90)
    .replace(/^[,;:.\-\s]+|[,;:.\-\s]+$/g, "")
    .replace(/^(the|a|an|this|that|these|those)\s+/i, "")
    .replace(/\s+(is|are|was|were|can|could|may|might|will|would)$/i, "");

  const tokens = phrase
    .split(/\s+/)
    .filter((token) => token && !STOPWORDS.has(token.toLowerCase()));
  if (tokens.length > 7) {
    phrase = tokens.slice(-7).join(" ");
  }
  return normalizeText(phrase, 80);
}

function classifyNode(label) {
  const text = normalizeText(label).toLowerCase();
  if (/(feel|feeling|fear|anxiety|hope|stress|pressure|confidence|sad|angry|happy|worried)/i.test(text)) {
    return "emotion";
  }
  if (/(build|watch|read|search|apply|learn|study|work|write|ship|choose|decide)/i.test(text)) {
    return "action";
  }
  if (/(youtube|github|google|reddit|x\.com|twitter|linkedin|spotify)/i.test(text)) {
    return "platform";
  }
  if (/^[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3}$/.test(label)) {
    return "person";
  }
  return "concept";
}

function addNode(nodes, label, source = "text") {
  const clean = cleanPhrase(label);
  if (!clean || clean.length < 3) {
    return null;
  }
  const id = slug(clean, "concept");
  if (!nodes.has(id)) {
    nodes.set(id, {
      id,
      label: clean,
      type: classifyNode(clean),
      source,
      count: 0,
    });
  }
  const node = nodes.get(id);
  node.count += 1;
  return node;
}

function extractCandidatePhrases(sentence) {
  const phrases = [];
  const capitalized = sentence.match(/\b[A-Z][A-Za-z0-9+.-]*(?:\s+[A-Z][A-Za-z0-9+.-]*){0,3}\b/g) || [];
  phrases.push(...capitalized);

  const tokens = normalizeText(sentence)
    .split(/\s+/)
    .map((token) => token.replace(/^[^\w]+|[^\w]+$/g, ""))
    .filter((token) => token && !STOPWORDS.has(token.toLowerCase()) && token.length > 2);

  for (let size = 3; size >= 2; size -= 1) {
    for (let index = 0; index <= tokens.length - size; index += 1) {
      phrases.push(tokens.slice(index, index + size).join(" "));
    }
  }
  return phrases;
}

function extractExplicitEdges(units, nodes) {
  const edges = [];
  const seen = new Set();

  for (const unit of units) {
    for (const sentence of splitSentences(unit.text)) {
      for (const relation of RELATION_PATTERNS) {
        const match = sentence.match(relation.pattern);
        if (!match) {
          continue;
        }
        const fromNode = addNode(nodes, match[1], "explicit_relation");
        const toNode = addNode(nodes, match[3], "explicit_relation");
        if (!fromNode || !toNode || fromNode.id === toNode.id) {
          continue;
        }
        const key = `${fromNode.id}|${relation.type}|${toNode.id}|${unit.unit_id}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        edges.push({
          from: fromNode.id,
          to: toNode.id,
          type: relation.type,
          evidence: sentence,
          unit_id: unit.unit_id,
          confidence: relation.confidence,
          extraction: "pattern",
        });
      }
    }
  }
  return edges;
}

function extractMentionEdges(units, nodes) {
  const edges = [];
  const seen = new Set();
  for (const unit of units) {
    const unitNodes = [];
    for (const sentence of splitSentences(unit.text).slice(0, 4)) {
      for (const phrase of extractCandidatePhrases(sentence).slice(0, 12)) {
        const node = addNode(nodes, phrase, "mention");
        if (node) {
          unitNodes.push(node);
        }
      }
    }
    const uniqueNodes = [...new Map(unitNodes.map((node) => [node.id, node])).values()].slice(0, 4);
    for (let index = 0; index < uniqueNodes.length - 1; index += 1) {
      const fromNode = uniqueNodes[index];
      const toNode = uniqueNodes[index + 1];
      if (!fromNode || !toNode || fromNode.id === toNode.id) {
        continue;
      }
      const key = `${fromNode.id}|co_mentions|${toNode.id}|${unit.unit_id}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      edges.push({
        from: fromNode.id,
        to: toNode.id,
        type: "co_mentions",
        evidence: normalizeText(unit.text, 220),
        unit_id: unit.unit_id,
        confidence: 0.42,
        extraction: "co_mention",
      });
    }
  }
  return edges;
}

function seedNodesFromProfile(nodes, profile, capturePacket) {
  const seeds = [
    profile?.subject,
    ...(Array.isArray(profile?.entities) ? profile.entities : []),
    ...(Array.isArray(profile?.topics) ? profile.topics : []),
    ...(Array.isArray(profile?.keyphrases) ? profile.keyphrases : []),
    ...(Array.isArray(capturePacket?.searchTerms) ? capturePacket.searchTerms : []),
  ];
  for (const seed of seeds) {
    addNode(nodes, seed, "context");
  }
}

function buildProcessingJobs({ packetId, eventId, url, title, mediaType, contentUnits, activeContext }) {
  const jobs = [];
  const hasTranscript = contentUnits.some((unit) =>
    /transcript|caption/i.test(`${unit.unit_type} ${unit.location}`)
  );
  const mediaElements = Array.isArray(activeContext?.mediaElements) ? activeContext.mediaElements : [];
  if ((mediaType === "video" || mediaType === "audio") && mediaElements.length && !hasTranscript) {
    jobs.push({
      id: `${packetId}:asr`,
      packet_id: packetId,
      event_id: eventId,
      job_type: "asr_transcript",
      status: "pending",
      url,
      title,
      media_type: mediaType,
      created_at: new Date().toISOString(),
      note: "Transcript unavailable in page. Local helper can transcribe an available media stream later.",
    });
  }

  const imageUnits = contentUnits.filter((unit) => unit.media_type === "image" && unit.image?.src);
  for (const unit of imageUnits.slice(0, 8)) {
    if (!unit.text || normalizeText(unit.image?.text_likelihood).toLowerCase() === "likely_text") {
      jobs.push({
        id: `${packetId}:ocr:${unit.unit_id}`,
        packet_id: packetId,
        event_id: eventId,
        unit_id: unit.unit_id,
        job_type: "image_ocr",
        status: "pending",
        url,
        title,
        media_type: "image",
        source_url: unit.image.src,
        created_at: new Date().toISOString(),
        note: "Image may contain useful text. OCR should run locally during idle time.",
      });
    }
  }

  return jobs;
}

export function buildMultimediaGraphPacket({
  tabData = {},
  activeContext = {},
  profile = {},
  capturePacket = {},
  eventId = null,
} = {}) {
  const url = normalizeText(profile.url || tabData.activeTab?.url, 400);
  const title = normalizeText(profile.title || activeContext.pageTitle || tabData.activeTab?.title, 180);
  const capturedAt = new Date().toISOString();
  const incomingUnits = Array.isArray(activeContext.contentUnits)
    ? activeContext.contentUnits.map((unit, index) => normalizeIncomingUnit(unit, index, profile.pageType || "webpage"))
    : [];
  const mediaType = inferMediaType(profile, activeContext, incomingUnits);
  const contentUnits = dedupeUnits([
    ...incomingUnits.map((unit, index) => normalizeIncomingUnit(unit, index, mediaType)),
    ...unitsFromCapturePacket(capturePacket, mediaType),
    ...unitsFromFullText(profile.displayFullText || profile.fullText, mediaType),
  ]).map((unit, index) => ({
    ...unit,
    unit_id: normalizeText(unit.unit_id, 80) || `${slug(unit.unit_type || "unit")}_${index + 1}`,
  }));

  const nodes = new Map();
  seedNodesFromProfile(nodes, profile, capturePacket);
  const explicitEdges = extractExplicitEdges(contentUnits, nodes);
  const mentionEdges = extractMentionEdges(contentUnits, nodes);
  const finalNodes = [...nodes.values()]
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label))
    .slice(0, MAX_NODES)
    .map((node) => ({
      id: node.id,
      label: node.label,
      type: node.type,
      source: node.source,
      count: node.count,
    }));
  const allowedNodeIds = new Set(finalNodes.map((node) => node.id));
  const finalEdges = [...explicitEdges, ...mentionEdges]
    .filter((edge) => allowedNodeIds.has(edge.from) && allowedNodeIds.has(edge.to))
    .slice(0, MAX_EDGES);
  const packetId = `mgc_${eventId || Date.now()}_${slug(title || hostnameFromUrl(url) || "capture", "capture")}`;
  const schemaMemory = buildSchemaGraphEnvelope({
    packetId,
    url,
    domain: hostnameFromUrl(url),
    title,
    mediaType,
    capturedAt,
    contentUnits,
    nodes: finalNodes,
    edges: finalEdges,
  });
  const processingJobs = buildProcessingJobs({
    packetId,
    eventId,
    url,
    title,
    mediaType,
    contentUnits,
    activeContext,
  });

  return {
    packet_id: packetId,
    packet_type: "multimedia_graph_capture",
    schema_version: 1,
    source: "browser_extension",
    event_id: eventId,
    url,
    domain: hostnameFromUrl(url),
    title,
    media_type: mediaType,
    captured_at: capturedAt,
    content_units: contentUnits,
    nodes: finalNodes,
    edges: finalEdges,
    evidence_links: schemaMemory.evidence_links,
    knowledge_graph: schemaMemory.knowledge_graph,
    schema_packets: schemaMemory.schema_packets,
    schema_memory: schemaMemory,
    processing_jobs: processingJobs,
    stats: {
      content_unit_count: contentUnits.length,
      node_count: finalNodes.length,
      edge_count: finalEdges.length,
      evidence_link_count: schemaMemory.evidence_links.length,
      schema_packet_count: schemaMemory.schema_packets.length,
      explicit_edge_count: explicitEdges.length,
      pending_job_count: processingJobs.length,
    },
  };
}
