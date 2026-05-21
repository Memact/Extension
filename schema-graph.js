const MAX_SCHEMA_PACKETS = 3;
const MAX_EVIDENCE_LINKS = 48;

const SCHEMA_CATEGORIES = [
  {
    id: "building_work",
    label: "Building and work",
    keywords: ["build", "builder", "code", "github", "project", "ship", "startup", "work", "yc"],
  },
  {
    id: "learning_research",
    label: "Learning and research",
    keywords: ["article", "course", "docs", "exam", "learn", "paper", "read", "research", "study"],
  },
  {
    id: "decision_evaluation",
    label: "Decision and evaluation",
    keywords: ["better", "buy", "choose", "compare", "decision", "option", "price", "should", "vs"],
  },
  {
    id: "emotion_pressure",
    label: "Emotion and pressure",
    keywords: ["anxiety", "behind", "confidence", "fear", "feel", "pressure", "prove", "stress", "worry"],
  },
  {
    id: "media_social",
    label: "Media and social exposure",
    keywords: ["comment", "podcast", "post", "reddit", "social", "thread", "video", "watch", "youtube"],
  },
  {
    id: "tools_platforms",
    label: "Tools and platforms",
    keywords: ["chrome", "discord", "gemini", "google", "notion", "openai", "spotify", "terminal", "tool"],
  },
];

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

function slug(value, fallback = "schema") {
  const normalized = normalizeText(value)
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || fallback;
}

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function tokenize(value) {
  return normalizeText(value)
    .toLowerCase()
    .split(/[^a-z0-9+.-]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
}

function classifySourceType({ mediaType, url, domain }) {
  const media = normalizeText(mediaType).toLowerCase();
  const source = `${normalizeText(url)} ${normalizeText(domain)}`.toLowerCase();
  if (media === "video") return "video_transcript_or_context";
  if (media === "audio") return "audio_transcript_or_context";
  if (media === "image") return "image_ocr_or_context";
  if (media === "device_window") return "device_window";
  if (/\b(search|google\.com\/search|bing\.com\/search)\b/.test(source)) return "search_result";
  if (/\b(youtube|vimeo|tiktok)\b/.test(source)) return "video_transcript_or_context";
  if (/\b(reddit|twitter|x\.com|linkedin|bsky|facebook|instagram)\b/.test(source)) return "social_media_post";
  if (/\b(github|gitlab|bitbucket)\b/.test(source)) return "repository_or_code";
  if (/\b(shop|product|pricing|checkout)\b/.test(source)) return "product_page";
  return "webpage";
}

function buildEvidenceLinks({ packetId, url, capturedAt, mediaType, contentUnits }) {
  return contentUnits
    .filter((unit) => normalizeText(unit?.text))
    .slice(0, MAX_EVIDENCE_LINKS)
    .map((unit) => {
      const unitId = normalizeText(unit.unit_id, 80);
      return {
        evidence_id: `ev_${slug(packetId, "packet")}_${slug(unitId, "unit")}`,
        packet_id: packetId,
        unit_id: unitId,
        source_url: normalizeText(url, 400),
        timestamp: capturedAt,
        snippet: normalizeText(unit.text, 320),
        media_type: normalizeText(unit.media_type || mediaType, 40),
        unit_type: normalizeText(unit.unit_type, 48),
        claim_supported: "captured_content",
        score: clamp01(unit.confidence || 0.62),
      };
    });
}

function evidenceIdsForText(evidenceLinks, text) {
  const tokens = new Set(tokenize(text));
  const matches = [];
  for (const evidence of evidenceLinks) {
    const evidenceTokens = tokenize(evidence.snippet);
    const overlap = evidenceTokens.filter((token) => tokens.has(token)).length;
    if (overlap >= 1) {
      matches.push({
        evidence_id: evidence.evidence_id,
        overlap,
      });
    }
  }
  return matches
    .sort((left, right) => right.overlap - left.overlap)
    .slice(0, 4)
    .map((match) => match.evidence_id);
}

function scoreCategories({ nodes, edges, contentUnits, mediaType, url, domain }) {
  const text = normalizeText(
    [
      mediaType,
      url,
      domain,
      ...nodes.map((node) => `${node.label} ${node.type}`),
      ...edges.map((edge) => `${edge.type} ${edge.evidence}`),
      ...contentUnits.map((unit) => unit.text),
    ].join(" "),
    18000
  ).toLowerCase();

  return SCHEMA_CATEGORIES.map((category) => {
    const hits = category.keywords.filter((keyword) => text.includes(keyword));
    const score = clamp01((hits.length / Math.max(3, category.keywords.length)) + (hits.length ? 0.22 : 0));
    return {
      ...category,
      score,
      hits,
    };
  })
    .filter((category) => category.score >= 0.18)
    .sort((left, right) => right.score - left.score)
    .slice(0, MAX_SCHEMA_PACKETS);
}

function enrichNodes(nodes, evidenceLinks) {
  return nodes.map((node) => {
    const evidenceIds = evidenceIdsForText(evidenceLinks, node.label);
    return {
      ...node,
      evidence_ids: evidenceIds,
      weight: clamp01((Number(node.count || 0) / 8) + (evidenceIds.length ? 0.2 : 0.05)),
    };
  });
}

function enrichEdges(edges, evidenceLinks) {
  return edges.map((edge, index) => {
    const edgeId = `edge_${slug(edge.from, "from")}_${slug(edge.type, "linked_to")}_${slug(edge.to, "to")}_${index + 1}`;
    const evidenceIds = edge.unit_id
      ? evidenceLinks
          .filter((evidence) => evidence.unit_id === edge.unit_id)
          .map((evidence) => evidence.evidence_id)
      : evidenceIdsForText(evidenceLinks, edge.evidence);
    return {
      edge_id: edgeId,
      ...edge,
      evidence_ids: evidenceIds.slice(0, 4),
      weight: clamp01(edge.confidence || 0.42),
      claim_status: edge.extraction === "pattern" ? "text_pattern" : "co_mentioned",
    };
  });
}

function schemaEvidenceIdsForCategory(category, evidenceLinks) {
  const keywordSet = new Set(category.keywords);
  return evidenceLinks
    .map((evidence) => {
      const tokens = tokenize(evidence.snippet);
      return {
        evidence_id: evidence.evidence_id,
        hits: tokens.filter((token) => keywordSet.has(token)).length,
      };
    })
    .filter((item) => item.hits > 0)
    .sort((left, right) => right.hits - left.hits)
    .slice(0, 6)
    .map((item) => item.evidence_id);
}

function buildSchemaPackets({ packetId, categories, nodes, edges, evidenceLinks, sourceType, capturedAt }) {
  const fallbackEvidenceIds = evidenceLinks.slice(0, 6).map((evidence) => evidence.evidence_id);
  const fallbackNodeIds = nodes.slice(0, 12).map((node) => node.id);
  const fallbackEdgeIds = edges.slice(0, 12).map((edge) => edge.edge_id);

  const selectedCategories = categories.length
    ? categories
    : [{ id: "general_activity", label: "General activity", score: 0.24, hits: [], keywords: [] }];

  return selectedCategories.map((category) => {
    const evidenceIds = schemaEvidenceIdsForCategory(category, evidenceLinks);
    const categoryText = new Set(category.keywords);
    const nodeIds = nodes
      .filter((node) => tokenize(node.label).some((token) => categoryText.has(token)))
      .map((node) => node.id)
      .slice(0, 16);
    const edgeIds = edges
      .filter((edge) => tokenize(`${edge.type} ${edge.evidence}`).some((token) => categoryText.has(token)))
      .map((edge) => edge.edge_id)
      .slice(0, 16);

    return {
      schema_id: `schema_${slug(packetId, "packet")}_${category.id}`,
      packet_id: packetId,
      schema_version: 1,
      status: "captured_candidate",
      category: category.id,
      label: category.label,
      source_type: sourceType,
      created_at: capturedAt,
      node_ids: nodeIds.length ? nodeIds : fallbackNodeIds,
      edge_ids: edgeIds.length ? edgeIds : fallbackEdgeIds,
      evidence_ids: evidenceIds.length ? evidenceIds : fallbackEvidenceIds,
      confidence: Number(clamp01(category.score).toFixed(4)),
      retention_hint: category.score >= 0.58 ? "schema_candidate" : "supporting_context",
      note: "Capture produced this local schema candidate from observed content; downstream Schema decides if it becomes durable memory.",
    };
  });
}

export function buildSchemaGraphEnvelope({
  packetId,
  url,
  domain,
  title,
  mediaType,
  capturedAt,
  contentUnits = [],
  nodes = [],
  edges = [],
} = {}) {
  const normalizedPacketId = normalizeText(packetId, 140) || `packet_${Date.now()}`;
  const sourceType = classifySourceType({ mediaType, url, domain });
  const evidenceLinks = buildEvidenceLinks({
    packetId: normalizedPacketId,
    url,
    capturedAt,
    mediaType,
    contentUnits,
  });
  const graphNodes = enrichNodes(nodes, evidenceLinks);
  const graphEdges = enrichEdges(edges, evidenceLinks);
  const categories = scoreCategories({
    nodes,
    edges,
    contentUnits,
    mediaType,
    url,
    domain,
  });
  const schemaPackets = buildSchemaPackets({
    packetId: normalizedPacketId,
    categories,
    nodes: graphNodes,
    edges: graphEdges,
    evidenceLinks,
    sourceType,
    capturedAt,
  });

  return {
    version: 1,
    packet_id: normalizedPacketId,
    created_at: capturedAt,
    title: normalizeText(title, 180),
    source_type: sourceType,
    authority: "local_evidence_graph",
    evidence_links: evidenceLinks,
    knowledge_graph: {
      nodes: graphNodes,
      edges: graphEdges,
      node_count: graphNodes.length,
      edge_count: graphEdges.length,
    },
    schema_packets: schemaPackets,
    access_boundary: {
      default_visibility: "counts_only",
      evidence_scope: "memory:read_evidence",
      graph_scope: "memory:read_graph",
      note: "Apps can ask Memact to form schema packets without receiving raw graph objects by default.",
    },
  };
}
