const HASH_MODEL_NAME = "memact-local-hash-embedding-v1";
const SEMANTIC_MODEL_NAME = "Xenova/all-MiniLM-L6-v2";

let modelReady = true;
let providerName = "hash_fallback";
let semanticPipelinePromise = null;

function normalizeVector(values) {
  const vector = Array.from(values || []).map((value) => Number(value) || 0);
  let norm = 0;
  for (const value of vector) {
    norm += value * value;
  }
  norm = Math.sqrt(norm) || 1;
  return vector.map((value) => value / norm);
}

function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9@#./+-]+/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

async function hashEmbedding(text, dim = 384) {
  const vector = new Array(dim).fill(0);
  const tokens = tokenize(text);
  for (const token of tokens) {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(token)
    );
    const bytes = new Uint8Array(digest);
    for (let i = 0; i < bytes.length; i += 1) {
      const slot = (bytes[i] + i * 13) % dim;
      const sign = bytes[(i + 7) % bytes.length] % 2 === 0 ? 1 : -1;
      vector[slot] += sign * (1 + bytes[i] / 255);
    }
  }
  return normalizeVector(vector);
}

async function loadSemanticPipeline() {
  if (semanticPipelinePromise) {
    return semanticPipelinePromise;
  }

  semanticPipelinePromise = (async () => {
    try {
      const module = await import("./vendor/transformers.min.js");
      const pipeline = module.pipeline || module.default?.pipeline;
      if (typeof pipeline !== "function") {
        return null;
      }
      providerName = "loading_sentence_transformer";
      self.postMessage({
        type: "loading_progress",
        provider: providerName,
        model: SEMANTIC_MODEL_NAME
      });
      const extractor = await pipeline("feature-extraction", SEMANTIC_MODEL_NAME, {
        quantized: true,
      });
      providerName = "sentence_transformer";
      return extractor;
    } catch {
      providerName = "hash_fallback";
      return null;
    }
  })();

  return semanticPipelinePromise;
}

function outputToVector(output) {
  if (!output) {
    return [];
  }
  if (Array.isArray(output)) {
    return output.flat(Infinity).map((value) => Number(value) || 0);
  }
  if (Array.isArray(output.data) || ArrayBuffer.isView(output.data)) {
    return Array.from(output.data).map((value) => Number(value) || 0);
  }
  if (typeof output.tolist === "function") {
    return output.tolist().flat(Infinity).map((value) => Number(value) || 0);
  }
  return [];
}

async function semanticEmbedding(text) {
  const extractor = await loadSemanticPipeline();
  if (!extractor) {
    return [];
  }
  const output = await extractor(String(text || ""), {
    pooling: "mean",
    normalize: true,
  });
  return normalizeVector(outputToVector(output));
}

async function embedText(text) {
  const semantic = await semanticEmbedding(text);
  if (semantic.length) {
    return semantic;
  }
  return hashEmbedding(text);
}

self.addEventListener("message", async (event) => {
  const message = event?.data || {};
  if (!message || typeof message.type !== "string") {
    return;
  }

  if (message.type === "status") {
    self.postMessage({
      type: "status_result",
      ready: Boolean(modelReady),
      provider: providerName,
      model: providerName === "sentence_transformer" ? SEMANTIC_MODEL_NAME : HASH_MODEL_NAME,
      fallback_model: HASH_MODEL_NAME
    });
    return;
  }

  if (message.type !== "embed") {
    return;
  }

  try {
    const embedding = await embedText(message.text || "");
    self.postMessage({
      type: "embed_result",
      embedding,
      id: message.id
    });
  } catch (error) {
    self.postMessage({
      type: "embed_error",
      error: String(error?.message || error || "embedding failed"),
      id: message.id
    });
  }
});
