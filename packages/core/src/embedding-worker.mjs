import { createRequire } from "node:module";
import { resettableLoader } from "./resettable-loader.mjs";
import { join } from "node:path";

// Inference is offline even if a tokenizer/processor is accidentally misconfigured.
globalThis.fetch = () => Promise.reject(new Error("Inference network disabled"));
const { env, AutoTokenizer, AutoProcessor, RawImage } = await import("@huggingface/transformers");
const ort = await import("onnxruntime-node");
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = `${process.argv[2]}/`;
env.useFSCache = false;
const opts = { local_files_only: true };
const session = {
  executionProviders: ["cpu"],
  intraOpNumThreads: 1,
  interOpNumThreads: 1,
  graphOptimizationLevel: "all",
};
const clip = "Xenova/mobileclip_s0";
const e5 = "Xenova/multilingual-e5-small";
const sharp = createRequire(import.meta.resolve("@huggingface/transformers"))("sharp");
class ModelLoadError extends Error {}
let current;
let currentKind;
let loader;
async function load(kind) {
  if (kind !== currentKind) {
    if (current?.model) await current.model.release();
    current = undefined;
    currentKind = kind;
    loader = resettableLoader(async () => {
      try {
        const tokenizer =
          kind === "text"
            ? await AutoTokenizer.from_pretrained(e5, opts)
            : kind === "query"
              ? await AutoTokenizer.from_pretrained(clip, opts)
              : undefined;
        const processor =
          kind === "image" ? await AutoProcessor.from_pretrained(clip, opts) : undefined;
        const file =
          kind === "text"
            ? [e5, "onnx/model_quantized.onnx"]
            : [
                clip,
                kind === "query" ? "onnx/text_model_quantized.onnx" : "onnx/vision_model.onnx",
              ];
        const model = await ort.InferenceSession.create(join(process.argv[2], ...file), session);
        current = { tokenizer, processor, model };
        return current;
      } catch (error) {
        throw new ModelLoadError("Local models failed to load", { cause: error });
      }
    });
  }
  return loader();
}
function normalize(values) {
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  if (!Number.isFinite(norm) || norm === 0) throw new Error("Invalid embedding");
  return Array.from(values, (value) => value / norm);
}
async function infer(model, inputs) {
  const feeds = {};
  for (const name of model.inputNames) {
    if (name === "token_type_ids" && !inputs.token_type_ids) {
      feeds[name] = new ort.Tensor(
        "int64",
        new BigInt64Array(inputs.input_ids.size),
        inputs.input_ids.dims,
      );
      continue;
    }
    const tensor = inputs[name];
    feeds[name] = new ort.Tensor(tensor.type, tensor.data, tensor.dims);
  }
  return model.run(feeds);
}
async function request(message) {
  let encoded;
  if (message.kind === "image") {
    // Header-only metadata check before allocating the decompressed pixel buffer.
    encoded = Buffer.from(message.data);
    const header = await sharp(encoded, { limitInputPixels: 16_000_000 }).metadata();
    if (
      !header.width ||
      !header.height ||
      header.width * header.height > 16_000_000 ||
      header.pages > 1
    )
      throw new Error("Image exceeds pixel limit");
  }
  const loaded = await load(message.kind);
  if (message.kind === "text") {
    const inputs = loaded.tokenizer(`${message.mode}: ${message.text}`, {
      truncation: true,
      max_length: 512,
      padding: true,
    });
    const output = await infer(loaded.model, inputs);
    const tensor = output.last_hidden_state;
    const vector = Array.from({ length: 384 }, () => 0);
    let count = 0;
    for (let token = 0; token < tensor.dims[1]; token++)
      if (Number(inputs.attention_mask.data[token]) !== 0) {
        count++;
        for (let dim = 0; dim < 384; dim++) vector[dim] += tensor.data[token * 384 + dim];
      }
    if (!count) throw new Error("No tokens");
    return { vector: normalize(vector.map((value) => value / count)) };
  }
  if (message.kind === "query") {
    const inputs = loaded.tokenizer(message.text, {
      padding: "max_length",
      truncation: true,
      max_length: 77,
    });
    if (inputs.input_ids.size !== 77) throw new Error("Invalid MobileCLIP padding");
    const output = await infer(loaded.model, inputs);
    return { vector: normalize(output.text_embeds.data) };
  }
  const image = await RawImage.fromBlob(new Blob([encoded]));
  const regions = [{ x: 0, y: 0, width: image.width, height: image.height }];
  if (image.height > 1024)
    for (let top = 0; top < image.height; top += 896) {
      regions.push({
        x: 0,
        y: top,
        width: image.width,
        height: Math.min(1024, image.height - top),
      });
      if (top + 1024 >= image.height) break;
    }
  const images = [];
  for (const box of regions) {
    const crop = await image.crop([0, box.y, image.width - 1, box.y + box.height - 1]);
    const output = await infer(loaded.model, await loaded.processor(crop));
    images.push({
      vector: normalize(output.image_embeds.data),
      region: { box, tile: box, imageWidth: image.width, imageHeight: image.height },
    });
  }
  return { images };
}
const utility = process.type === "utility";
const port = process.parentPort;
const send = (value) => (utility ? port.postMessage(value, []) : process.send(value));
let chain = Promise.resolve();
const receive = (message) => {
  chain = chain.then(async () => {
    try {
      send({ ok: true, ...(await request(message)) });
    } catch (error) {
      send({ ok: false, reason: error instanceof ModelLoadError ? "load" : "content" });
    }
    return null;
  });
};
if (utility) port.on("message", (event) => receive(event.data));
else process.on("message", receive);
