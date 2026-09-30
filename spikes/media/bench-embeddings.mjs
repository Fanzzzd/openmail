import { performance } from "node:perf_hooks";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const root = fileURLToPath(new URL(".", import.meta.url));
// Model downloads are a separate command. Any attempted inference-time network access fails.
globalThis.fetch = async () => {
  throw new Error("Network disabled during benchmark");
};
let started = performance.now();
const {
  env,
  AutoTokenizer,
  AutoProcessor,
  CLIPTextModelWithProjection,
  CLIPVisionModelWithProjection,
  pipeline,
  RawImage,
} = await import("@huggingface/transformers");
const importMs = performance.now() - started;
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = `${root}models/`;
env.cacheDir = `${root}artifacts/transformers-cache/`;
const options = {
  device: "cpu",
  dtype: "q8",
  local_files_only: true,
  session_options: { intraOpNumThreads: 4, interOpNumThreads: 1, graphOptimizationLevel: "all" },
};

function stats(values) {
  const sorted = [...values].toSorted((a, b) => a - b);
  return {
    median: (sorted[(sorted.length - 1) >> 1] + sorted[sorted.length >> 1]) / 2,
    min: sorted[0],
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
    runs: values,
  };
}
function normalize(values) {
  const norm = Math.sqrt(values.reduce((s, x) => s + x * x, 0));
  assert.ok(norm > 0 && Number.isFinite(norm));
  return Array.from(values, (x) => x / norm);
}
function rank(query, items) {
  return items
    .map((item) => ({ id: item.id, score: query.reduce((s, x, i) => s + x * item.vector[i], 0) }))
    .toSorted((a, b) => b.score - a.score);
}
async function bench(fn, n = 10) {
  started = performance.now();
  let output = await fn();
  const firstMs = performance.now() - started;
  await fn();
  const times = [];
  for (let i = 0; i < n; i++) {
    started = performance.now();
    output = await fn();
    times.push(performance.now() - started);
  }
  return { output, first_ms: firstMs, warm_ms: stats(times) };
}

const clipId = "Xenova/mobileclip_s0";
const visionDtype = process.env.MEDIA_VISION_DTYPE ?? "q8";
assert.ok(["q8", "fp32"].includes(visionDtype));
const result = {
  runtime: {
    node: process.versions.node,
    arch: process.arch,
    library: "4.3.0",
    onnxruntime: "1.30.0",
    execution_provider: "cpu",
    intra_op_threads: 4,
    inter_op_threads: 1,
    import_ms: importMs,
    network_disabled: true,
  },
  clip: { text_dtype: "q8", vision_dtype: visionDtype },
  e5: {},
};
started = performance.now();
const clipTokenizer = await AutoTokenizer.from_pretrained(clipId, { local_files_only: true });
const clipProcessor = await AutoProcessor.from_pretrained(clipId, { local_files_only: true });
result.clip.tokenizer_processor_load_ms = performance.now() - started;
started = performance.now();
const clipText = await CLIPTextModelWithProjection.from_pretrained(clipId, options);
result.clip.text_model_load_ms = performance.now() - started;
started = performance.now();
const clipVision = await CLIPVisionModelWithProjection.from_pretrained(clipId, {
  ...options,
  dtype: visionDtype,
});
result.clip.vision_model_load_ms = performance.now() - started;
result.clip.total_load_ms =
  result.clip.tokenizer_processor_load_ms +
  result.clip.text_model_load_ms +
  result.clip.vision_model_load_ms;
result.clip.images = [];
const imageVectors = [];
for (const id of ["mixed", "long", "receipt", "code", "ticket"]) {
  const imagePath = `${root}samples/${id}.png`;
  const endToEnd = await bench(async () => {
    const image = await RawImage.read(imagePath);
    return await clipVision(await clipProcessor(image));
  });
  const inputs = await clipProcessor(await RawImage.read(imagePath));
  const inference = await bench(() => clipVision(inputs));
  const vector = normalize(inference.output.image_embeds.data);
  imageVectors.push({ id, vector });
  result.clip.images.push({
    id,
    dimensions: vector.length,
    input_shape: inputs.pixel_values.dims,
    first_ms: endToEnd.first_ms,
    end_to_end_ms: endToEnd.warm_ms,
    inference_ms: inference.warm_ms,
  });
  console.log("CLIP image", id, endToEnd.warm_ms.median.toFixed(2), "ms");
}
result.clip.queries = [];
for (const [query, expected] of [
  ["receipt", "receipt"],
  ["screenshot of code", "code"],
  ["airline ticket", "ticket"],
  ["机票", "ticket"],
  ["机票截图", "ticket"],
  ["收据", "receipt"],
]) {
  // MobileCLIP S0's exported text graph has a fixed sequence length of 77.
  const tokenOptions = { padding: "max_length", truncation: true, max_length: 77 };
  const endToEnd = await bench(async () => clipText(clipTokenizer(query, tokenOptions)));
  const inputs = clipTokenizer(query, tokenOptions);
  const inference = await bench(() => clipText(inputs));
  const ranked = rank(normalize(endToEnd.output.text_embeds.data), imageVectors);
  result.clip.queries.push({
    query,
    expected,
    correct_rank: ranked.findIndex((x) => x.id === expected) + 1,
    ranking: ranked,
    token_count: inputs.input_ids.size,
    first_ms: endToEnd.first_ms,
    end_to_end_ms: endToEnd.warm_ms,
    inference_ms: inference.warm_ms,
  });
  console.log(
    "CLIP query",
    query,
    "rank",
    result.clip.queries.at(-1).correct_rank,
    endToEnd.warm_ms.median.toFixed(2),
    "ms",
  );
}
await clipText.dispose();
await clipVision.dispose();

const e5Id = "Xenova/multilingual-e5-small";
started = performance.now();
const extractor = await pipeline("feature-extraction", e5Id, options);
result.e5.load_ms = performance.now() - started;
const e5Options = { pooling: "mean", normalize: true, truncation: true, max_length: 512 };
result.e5.chunks = [];
for (const [language, sentence] of [
  [
    "zh",
    "您的新加坡至上海机票已经确认，航班在十月一日上午八点三十分起飞，请携带护照和电子登机牌提前到机场办理手续。",
  ],
  [
    "en",
    "Your flight from Singapore to Shanghai is confirmed. Please bring your passport and boarding pass to the airport before departure. ",
  ],
]) {
  const chunk = sentence.repeat(10).slice(0, 300);
  const text = `passage: ${chunk}`;
  const measured = await bench(() => extractor(text, e5Options));
  const tokens = extractor.tokenizer(text, { truncation: true, max_length: 512 });
  assert.equal(chunk.length, 300);
  assert.equal(measured.output.dims.at(-1), 384);
  result.e5.chunks.push({
    language,
    characters: chunk.length,
    token_count: tokens.input_ids.size,
    first_ms: measured.first_ms,
    end_to_end_ms: measured.warm_ms,
  });
  console.log(
    "E5 chunk",
    language,
    tokens.input_ids.size,
    "tokens",
    measured.warm_ms.median.toFixed(2),
    "ms",
  );
}
const documents = [
  {
    id: "flight-en",
    text: "The airline ticket confirms a flight from Singapore to Shanghai on October 1. Bring your passport and boarding pass.",
  },
  { id: "receipt-zh", text: "这张购物收据记录了咖啡、牛奶和面包的费用，总金额为三十五元。" },
  {
    id: "code-en",
    text: "The TypeScript program indexes images locally, extracts text with OCR and stores vectors in SQLite.",
  },
  { id: "meeting-zh", text: "下周二下午三点召开项目会议，讨论邮件同步和版本发布计划。" },
];
const docVectors = [];
for (const doc of documents) {
  const output = await extractor(`passage: ${doc.text}`, e5Options);
  docVectors.push({ id: doc.id, vector: normalize(output.data) });
}
result.e5.queries = [];
for (const [query, expected] of [
  ["机票和登机手续", "flight-en"],
  ["airline ticket and boarding pass", "flight-en"],
  ["shopping receipt for coffee", "receipt-zh"],
  ["购物小票的金额", "receipt-zh"],
  ["本地图片索引代码", "code-en"],
  ["project meeting next Tuesday", "meeting-zh"],
  ["从新加坡飞往上海的航班，需要护照和登机牌", "flight-en"],
  ["用 TypeScript 和 SQLite 索引图片并做 OCR 的程序", "code-en"],
]) {
  const measured = await bench(() => extractor(`query: ${query}`, e5Options));
  const ranked = rank(normalize(measured.output.data), docVectors);
  result.e5.queries.push({
    query,
    expected,
    correct_rank: ranked.findIndex((x) => x.id === expected) + 1,
    ranking: ranked,
    end_to_end_ms: measured.warm_ms,
  });
  console.log("E5 query", query, "rank", result.e5.queries.at(-1).correct_rank);
}
// Search image OCR text using the multilingual text model as a Chinese-query bridge.
const ocrVectors = [];
for (const id of ["mixed", "long", "receipt", "code", "ticket"]) {
  const text = readFileSync(`${root}artifacts/${id}-tile.jsonl`, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line).text)
    .join("\n")
    .slice(0, 300);
  const output = await extractor(`passage: ${text}`, e5Options);
  ocrVectors.push({ id, vector: normalize(output.data) });
}
result.e5.ocr_image_queries = [];
for (const query of ["机票", "收据", "截图中的代码"]) {
  const output = await extractor(`query: ${query}`, e5Options);
  result.e5.ocr_image_queries.push({ query, ranking: rank(normalize(output.data), ocrVectors) });
}
await extractor.dispose();
const resultName = visionDtype === "q8" ? "embeddings" : "embeddings-hybrid";
writeFileSync(`${root}artifacts/${resultName}.json`, `${JSON.stringify(result, null, 2)}\n`);
console.log(`Saved artifacts/${resultName}.json`);
