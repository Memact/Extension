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

function dedupeStrings(values, limit = 12) {
  const seen = new Set();
  const output = [];
  for (const value of values) {
    const normalized = normalizeText(value, 240);
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

function inferActivityLabel(pageType, interactionType, subject, domain) {
  const normalizedType = normalizeText(pageType).toLowerCase();
  const normalizedInteraction = normalizeText(interactionType).toLowerCase();
  const anchor = normalizeText(subject || domain, 96);

  if (normalizedType === "search") {
    return anchor ? `Searched for ${anchor}` : "Searched";
  }
  if (normalizedType === "docs" || normalizedType === "article" || normalizedType === "qa") {
    return anchor ? `Read about ${anchor}` : "Read";
  }
  if (normalizedType === "repo") {
    return anchor ? `Explored ${anchor}` : "Explored a repository";
  }
  if (normalizedType === "video") {
    return anchor ? `Watched ${anchor}` : "Watched";
  }
  if (normalizedType === "discussion" || normalizedType === "chat" || normalizedType === "social") {
    return anchor ? `Followed ${anchor}` : "Followed a conversation";
  }
  if (normalizedType === "product") {
    return anchor ? `Researched ${anchor}` : "Researched a product";
  }
  if (normalizedInteraction === "type") {
    return anchor ? `Worked on ${anchor}` : "Worked actively";
  }
  if (normalizedInteraction === "scroll") {
    return anchor ? `Reviewed ${anchor}` : "Reviewed a page";
  }
  return anchor ? `Looked into ${anchor}` : "Viewed a page";
}

function buildMemoryPoints(profile, activeContext) {
  const factPoints = Array.isArray(profile?.factItems)
    ? profile.factItems.map((item) => `${item.label}: ${item.value}`)
    : [];
  const searchPoints = Array.isArray(profile?.searchResults) ? profile.searchResults : [];
  const derivativePoints = Array.isArray(profile?.derivativeItems)
    ? profile.derivativeItems.map((item) => item?.text)
    : [];
  const selection = normalizeText(activeContext?.selection, 180);

  return dedupeStrings(
    [
      ...factPoints,
      ...searchPoints,
      selection,
      ...derivativePoints,
    ].filter(Boolean),
    8
  );
}

function buildMemoryBlocks(profile) {
  const blocks = [];
  const pushBlock = (kind, label, text) => {
    const normalizedTextValue = normalizeRichText(text, 800);
    if (!normalizedTextValue) {
      return;
    }
    blocks.push({
      kind,
      label: normalizeText(label, 80),
      text: normalizedTextValue,
    });
  };

  if (profile?.structuredSummary) {
    pushBlock("summary", "Summary", profile.structuredSummary);
  }
  for (const fact of profile?.factItems || []) {
    pushBlock("fact", fact.label, `${fact.label}: ${fact.value}`);
  }
  if (Array.isArray(profile?.searchResults) && profile.searchResults.length) {
    pushBlock("search_results", "Captured results", profile.searchResults.map((item, index) => `${index + 1}. ${item}`).join("\n"));
  }
  for (const derivative of profile?.derivativeItems || []) {
    pushBlock(derivative?.kind || "detail", derivative?.label || "Detail", derivative?.text);
  }
  if (profile?.displayFullText) {
    const paragraphs = normalizeRichText(profile.displayFullText, 0)
      .split(/\n{2,}/)
      .map((paragraph) => normalizeRichText(paragraph, 420))
      .filter(Boolean)
      .slice(0, 6);
    for (const paragraph of paragraphs) {
      pushBlock("paragraph", "Paragraph", paragraph);
    }
  }

  return blocks.slice(0, 12);
}

export function buildCapturePacket({ tabData, activeContext, profile, interactionType }) {
  const title = normalizeText(profile?.title || activeContext?.pageTitle || tabData?.activeTab?.title, 180);
  const domain = normalizeText(profile?.domain, 80);
  const subject = normalizeText(profile?.subject, 140);
  const points = buildMemoryPoints(profile, activeContext);
  const blocks = buildMemoryBlocks(profile);
  const searchTerms = dedupeStrings(
    [
      subject,
      ...(profile?.entities || []),
      ...(profile?.topics || []),
      title,
      domain,
    ],
    10
  );

  return {
    version: 1,
    capturedAt: new Date().toISOString(),
    title,
    domain,
    pageType: normalizeText(profile?.pageType, 40),
    pageTypeLabel: normalizeText(profile?.pageTypeLabel, 60),
    subject,
    activityLabel: inferActivityLabel(profile?.pageType, interactionType, subject, domain),
    summary: normalizeText(profile?.structuredSummary || profile?.displayExcerpt || activeContext?.snippet, 280),
    points,
    searchTerms,
    interaction: {
      type: normalizeText(interactionType, 32),
      typingActive: Boolean(activeContext?.typingActive),
      scrollingActive: Boolean(activeContext?.scrollingActive),
    },
    blocks,
  };
}
