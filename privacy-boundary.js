const BLOCKED_HOST_KEYWORDS = [
  "bank",
  "netbanking",
  "banking",
  "paypal",
  "stripe",
  "razorpay",
  "medical",
  "health",
  "hospital",
  "clinic",
  "patient",
  "mail",
  "inbox",
  "messages",
  "whatsapp",
  "telegram",
];

const BLOCKED_PATH_KEYWORDS = [
  "login",
  "signin",
  "password",
  "reset",
  "checkout",
  "payment",
  "billing",
  "account",
  "messages",
  "inbox",
  "compose",
  "medical",
  "health",
  "patient",
  "admin",
];

const BLOCKED_TEXT_PATTERNS = [
  /\b(one[-\s]?time password|otp|cvv|card number|account number|routing number)\b/i,
  /\b(private message|direct message|dm|inbox|compose mail)\b/i,
  /\b(medical record|patient portal|lab result|prescription)\b/i,
  /\b(netbanking|bank statement|payment method|checkout|billing address)\b/i,
  /\b(password|two[-\s]?factor|2fa|security code)\b/i,
];

function normalize(value, maxLength = 0) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!maxLength || text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3).trim()}...`;
}

function parseUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function keywordHit(value, keywords) {
  const haystack = normalize(value).toLowerCase();
  return keywords.find((keyword) => haystack.includes(keyword)) || "";
}

export function classifyCapturePrivacy(profile = {}) {
  const parsed = parseUrl(profile.url || "");
  const hostname = parsed?.hostname.replace(/^www\./i, "").toLowerCase() || normalize(profile.domain).toLowerCase();
  const path = parsed?.pathname?.toLowerCase() || "";
  const title = normalize(profile.title, 180);
  const pageType = normalize(profile.pageType || profile.page_type, 80).toLowerCase();
  const visibleText = normalize(
    [
      profile.subject,
      profile.snippet,
      profile.fullText,
      profile.displayFullText,
      profile.rawFullText,
    ].filter(Boolean).join(" "),
    1200
  );

  const hostHit = keywordHit(hostname, BLOCKED_HOST_KEYWORDS);
  const pathHit = keywordHit(path, BLOCKED_PATH_KEYWORDS);
  const textHit = BLOCKED_TEXT_PATTERNS.find((pattern) => pattern.test(`${title} ${visibleText}`));
  const authLike = pageType === "auth" || /\b(login|signin|password|2fa|otp|verify)\b/i.test(`${title} ${path}`);

  if (hostHit || pathHit || textHit || authLike) {
    return {
      version: 1,
      action: "block",
      reason: hostHit
        ? `Sensitive host category matched "${hostHit}".`
        : pathHit
          ? `Sensitive path category matched "${pathHit}".`
          : textHit
            ? "Sensitive page text matched a private-data rule."
            : "Authentication or credential page detected.",
      categories: [
        hostHit ? "sensitive_host" : "",
        pathHit ? "sensitive_path" : "",
        textHit ? "sensitive_text" : "",
        authLike ? "auth_or_credentials" : "",
      ].filter(Boolean),
      allowMetadata: false,
      allowContent: false,
      allowGraph: false,
    };
  }

  return {
    version: 1,
    action: "allow",
    reason: "No sensitive capture rule matched.",
    categories: [],
    allowMetadata: true,
    allowContent: true,
    allowGraph: true,
  };
}

export function redactPrivateCapture(value) {
  const text = normalize(value);
  if (!text) return "";
  return text
    .replace(/\b\d{12,19}\b/g, "[redacted-number]")
    .replace(/\b\d{4,8}\b/g, "[redacted-code]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]");
}
