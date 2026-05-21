import { getDocument } from "./vendor/pdf.min.mjs";

function normalizeText(value, maxLength = 0) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) {
    return "";
  }
  return maxLength && text.length > maxLength ? `${text.slice(0, maxLength - 3).trim()}...` : text;
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

function looksLikePdfTitle(pageTitle = "") {
  return /\.(pdf)\b/i.test(pageTitle) || /\bpdf\b/i.test(pageTitle);
}

function extractDriveFileId(url) {
  const match = String(url || "").match(/\/file\/d\/([^/]+)/i);
  return match?.[1] || "";
}

export function looksLikePdfResource(url = "", pageTitle = "") {
  try {
    const parsed = new URL(url);
    if (parsed.pathname.toLowerCase().endsWith(".pdf")) {
      return true;
    }
    if (parsed.hostname === "drive.google.com" && extractDriveFileId(url) && looksLikePdfTitle(pageTitle)) {
      return true;
    }
  } catch {
    return looksLikePdfTitle(pageTitle);
  }
  return looksLikePdfTitle(pageTitle);
}

function candidatePdfUrls(url, pageTitle) {
  const candidates = [];
  const push = (value) => {
    if (value && !candidates.includes(value)) {
      candidates.push(value);
    }
  };

  push(url);

  const driveFileId = extractDriveFileId(url);
  if (driveFileId && looksLikePdfTitle(pageTitle)) {
    push(`https://drive.google.com/uc?export=download&id=${driveFileId}`);
    push(`https://drive.google.com/uc?id=${driveFileId}&export=download`);
  }

  return candidates;
}

function itemToText(item) {
  const text = String(item?.str || "");
  return text.replace(/\u0000/g, "").trim();
}

function pageTextFromContent(textContent) {
  const lines = [];
  let currentLine = [];
  let currentY = null;

  for (const item of textContent?.items || []) {
    const text = itemToText(item);
    if (!text) {
      continue;
    }

    const y = Math.round(Number(item?.transform?.[5] || 0) * 10) / 10;
    if (currentY !== null && Math.abs(y - currentY) > 0.9 && currentLine.length) {
      lines.push(currentLine.join(" ").replace(/\s+/g, " ").trim());
      currentLine = [];
    }

    currentY = y;
    currentLine.push(text);
  }

  if (currentLine.length) {
    lines.push(currentLine.join(" ").replace(/\s+/g, " ").trim());
  }

  return lines.filter(Boolean).join("\n");
}

async function fetchPdfBuffer(url) {
  const response = await fetch(url, {
    credentials: "include",
    mode: "cors",
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`PDF fetch failed with ${response.status}`);
  }

  const contentType = response.headers.get("content-type") || "";
  const buffer = await response.arrayBuffer();
  return {
    buffer,
    contentType: contentType.toLowerCase(),
  };
}

export async function extractPdfTextFromUrl(url, pageTitle = "", options = {}) {
  const {
    maxPages = 8,
    maxChars = 12000,
  } = options;

  if (!looksLikePdfResource(url, pageTitle)) {
    return null;
  }

  let bufferInfo = null;
  for (const candidate of candidatePdfUrls(url, pageTitle)) {
    try {
      const nextBufferInfo = await fetchPdfBuffer(candidate);
      const contentTypeLooksPdf = nextBufferInfo.contentType.includes("pdf");
      if (contentTypeLooksPdf || candidate.toLowerCase().includes(".pdf") || looksLikePdfTitle(pageTitle)) {
        bufferInfo = nextBufferInfo;
        break;
      }
    } catch {
      // Try the next candidate URL.
    }
  }

  if (!bufferInfo?.buffer) {
    return null;
  }

  const loadingTask = getDocument({
    data: bufferInfo.buffer,
    disableWorker: true,
    isEvalSupported: false,
    useWorkerFetch: false,
    verbosity: 0,
  });

  try {
    const pdf = await loadingTask.promise;
    const totalPages = Math.min(pdf.numPages || 0, maxPages);
    const pageBlocks = [];

    for (let pageNumber = 1; pageNumber <= totalPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const textContent = await page.getTextContent({ disableNormalization: false });
      const pageText = pageTextFromContent(textContent);
      if (pageText) {
        pageBlocks.push(`Page ${pageNumber}\n${pageText}`);
      }
      if (pageBlocks.join("\n\n").length >= maxChars) {
        break;
      }
    }

    const fullText = normalizeRichText(pageBlocks.join("\n\n"), maxChars);
    if (!fullText) {
      return null;
    }

    return {
      snippet: normalizeText(fullText, 280),
      fullText,
      pageCount: pdf.numPages || totalPages || 0,
      extractedWith: "pdfjs",
    };
  } finally {
    await loadingTask.destroy().catch(() => {});
  }
}
