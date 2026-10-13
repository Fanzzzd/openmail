export const MODEL_FILES = [
  {
    model: "Xenova/mobileclip_s0",
    revision: "757d59c9c6870a76a4b0306f05f5061bca15c39f",
    file: "config.json",
    bytes: 344,
    sha256: "8e33c1f2634a33de3e38715f9809ef86742aacbe31c310c66fc2636755458d56",
  },
  {
    model: "Xenova/mobileclip_s0",
    revision: "757d59c9c6870a76a4b0306f05f5061bca15c39f",
    file: "preprocessor_config.json",
    bytes: 382,
    sha256: "b031f09fbd69e22a605b6cc7433993249ee893b7fc1b79321f669cd015493dd4",
  },
  {
    model: "Xenova/mobileclip_s0",
    revision: "757d59c9c6870a76a4b0306f05f5061bca15c39f",
    file: "tokenizer.json",
    bytes: 2224081,
    sha256: "72ed5c96db5729294468543e4bc75fce14ca63f58e37300290189ba1c1e52b85",
  },
  {
    model: "Xenova/mobileclip_s0",
    revision: "757d59c9c6870a76a4b0306f05f5061bca15c39f",
    file: "tokenizer_config.json",
    bytes: 763,
    sha256: "a7d9d24f248071b792e4a3b56ab0539c2f40eec8da56d6fd91fb3a50058acebd",
  },
  {
    model: "Xenova/mobileclip_s0",
    revision: "757d59c9c6870a76a4b0306f05f5061bca15c39f",
    file: "onnx/text_model_quantized.onnx",
    bytes: 42799238,
    sha256: "b8557b10e5c23a0126c6d2e6eba48d240484979007917d128953b31618a04211",
  },
  {
    model: "Xenova/mobileclip_s0",
    revision: "757d59c9c6870a76a4b0306f05f5061bca15c39f",
    file: "LICENSE",
    bytes: 2671,
    sha256: "18e4e6b95d7272051fabdad125ba0467549c181ef20b7fa0eafbac3825471483",
  },
  {
    model: "Xenova/mobileclip_s0",
    revision: "757d59c9c6870a76a4b0306f05f5061bca15c39f",
    file: "onnx/vision_model.onnx",
    bytes: 45543630,
    sha256: "17d3c037b1d488c10c50e09f6009ea5a198caef4e0e8f4ea5617b7cb2d067ac0",
  },
  {
    model: "Xenova/multilingual-e5-small",
    revision: "761b726dd34fb83930e26aab4e9ac3899aa1fa78",
    file: "config.json",
    bytes: 658,
    sha256: "cb99455288675345e1a4f411438d5d0adbba5fbd3a67ea4fb03c015433b996c1",
  },
  {
    model: "Xenova/multilingual-e5-small",
    revision: "761b726dd34fb83930e26aab4e9ac3899aa1fa78",
    file: "tokenizer.json",
    bytes: 17082730,
    sha256: "0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39",
  },
  {
    model: "Xenova/multilingual-e5-small",
    revision: "761b726dd34fb83930e26aab4e9ac3899aa1fa78",
    file: "tokenizer_config.json",
    bytes: 443,
    sha256: "a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b",
  },
  {
    model: "Xenova/multilingual-e5-small",
    revision: "761b726dd34fb83930e26aab4e9ac3899aa1fa78",
    file: "special_tokens_map.json",
    bytes: 167,
    sha256: "d05497f1da52c5e09554c0cd874037a083e1dc1b9cfd48034d1c717f1afc07a7",
  },
  {
    model: "Xenova/multilingual-e5-small",
    revision: "761b726dd34fb83930e26aab4e9ac3899aa1fa78",
    file: "onnx/model_quantized.onnx",
    bytes: 118308185,
    sha256: "f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193",
  },
] as const;
export const MODEL_BYTES = MODEL_FILES.reduce((sum, file) => sum + file.bytes, 0);
export const MODEL_VERSION =
  "e5-761b726d:clip-757d59c9:fp32-q8:e5-prefix-mean-l2:clip77:tile1024-128:chunk300-sentence:ort1.30.0:tf4.3.0:header16MP:isolated:v2";
