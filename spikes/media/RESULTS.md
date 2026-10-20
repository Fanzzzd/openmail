# On-device media search measurements

It is feasible. OCR uses Vision and the vector store uses sqlite-vec. For images and text, the choice is the MobileCLIP S0 fp32 image encoder with the q8 text encoder. For text, the choice is E5 small q8, keeping FTS and RRF. Speech with the base model is optional. Short Chinese cross-language retrieval and Chinese transcription still have quality problems.

Measured on 2026-09-30 on an M3 Max, 16 cores, 48GB, macOS 26.2, on power. Swift 6.3.3, Node 24.4.1, and Electron 44.4.5 with its bundled Node 24.21.0. ONNX runs on Transformers.js 4.3.0 and onnxruntime-node 1.30.0, on CPU, with 4 compute threads and 1 inter-op thread. The Core ML EP was not tested.

The spike uses only PNGs and speech generated on this machine. It read no real mail, did not touch the openmail user directory or a running app, and committed nothing. The network was used only to download dependencies, source code and models. Models are pinned to fixed versions and verified by SHA-256, and inference has the network disabled.

## OCR and Vision

Vision accurate, languages `zh-Hans`, `zh-Hant`, `en`, with language correction on. The match rate is `1 - Levenshtein distance / truth character count`, with whitespace removed and case and punctuation kept. Each mode runs 6 rounds in a new process. The warm column is the median of the last 5 rounds and excludes image decoding and process startup.

| Sample                                    | Size px  | Truth chars | Whole match | Whole warm ms | Tiled match | Tiled warm ms |
| ----------------------------------------- | -------- | ----------- | ----------- | ------------- | ----------- | ------------- |
| Mixed Simplified, Traditional and English | 1000×600 | 146         | 99.32%      | 216.96        | 99.32%      | 263.07        |
| Long screenshot                           | 900×5200 | 3490        | 99.94%      | 2086.39       | 100.00%     | 3395.08       |
| Small-print shopping receipt              | 600×1100 | 223         | 99.55%      | 205.37        | 99.55%      | 262.08        |
| Boarding pass                             | 1000×560 | 122         | 94.26%      | 195.11        | 94.26%      | 183.44        |
| Code screenshot                           | 1100×750 | 307         | 92.51%      | 277.07        | 92.51%      | 298.65        |

The long image has 113 lines. It is split into 6 vertical tiles at most 1024px high, with a 128px overlap and the full width. Boxes map to top-left pixel coordinates in the source image. Overlap regions are assigned by box center, and no line is duplicated. The first round on the long image took 2498.85ms whole and 3354.30ms tiled. The synthetic small print is 15px. Blur, skew and handwriting are not covered.

The Swift CLI is 133496 bytes, about 130.37KiB. Standard output has one `{text, confidence, box}` per line, and timing goes to stderr. Code punctuation and short fields on tickets are error-prone, so low-confidence results cannot all be dropped by confidence alone.

| Sample                    | Top label | Confidence | Classify warm ms |
| ------------------------- | --------- | ---------- | ---------------- |
| Mixed Chinese and English | document  | 0.495      | 10.05            |
| Long screenshot           | document  | 0.604      | 66.08            |
| Receipt                   | document  | 0.557      | 10.67            |
| Boarding pass             | document  | 0.575      | 9.86             |
| Code                      | document  | 0.463      | 8.51             |

The top 5 labels and scores are saved in `artifacts/vision.json`. document, printed_page and screenshot dominate. Classification can help tell documents from screenshots. It cannot serve directly as a receipt or ticket label.

Feature print revision 2, 768 dimensions. The first image took 79.51ms to extract, and later ones took 8.00 to 11.79ms.

| Compared with the original receipt   | Distance |
| ------------------------------------ | -------- |
| Same image                           | 0.0000   |
| Receipt on a light yellow background | 0.1798   |
| Boarding pass                        | 0.9766   |
| Code screenshot                      | 0.9521   |
| Mixed Chinese and English            | 0.9572   |

This works for similar-image search. The vector cache must record the Vision revision. The distance threshold has not been validated.

## Image-text and text embeddings

Local load excludes download and library import. Each item runs 2 rounds first, then the median of 10 rounds is measured. Image end-to-end includes PNG decoding, resizing, center cropping and inference. Pure inference uses preprocessed input. MobileCLIP has 512 dimensions, and text is padded to a fixed 77 tokens. E5 has 384 dimensions, uses mean pooling followed by normalization, and uses the `query:` and `passage:` prefixes.

| Model configuration                       | Package MB | ONNX weights MB | Local load ms |
| ----------------------------------------- | ---------- | --------------- | ------------- |
| MobileCLIP S0 all q8, baseline            | 56.87      | 54.65           | 319.50        |
| MobileCLIP S0 image fp32, text q8, chosen | 90.57      | 88.34           | 255.10        |
| multilingual-e5-small q8                  | 135.39     | 118.31          | 733.20        |

MB means 1000000 bytes. A model package includes the tokenizer, configuration and the license files it ships with, and excludes the runtime libraries. Both image-text configurations share the text weights.

| Image                     | All q8 end-to-end ms | Chosen end-to-end ms | Chosen inference ms |
| ------------------------- | -------------------- | -------------------- | ------------------- |
| Mixed Chinese and English | 154.14               | 190.64               | 40.77               |
| Long screenshot           | 222.75               | 251.73               | 68.80               |
| Receipt                   | 161.89               | 148.44               | 55.31               |
| Code                      | 136.11               | 168.92               | 64.26               |
| Boarding pass             | 120.97               | 107.97               | 47.71               |

The candidates are the 5 images above. The table below gives the rank of the target image. Lower is better. The Chinese queries are test data: 机票 means "airline ticket", 机票截图 means "airline ticket screenshot" and 收据 means "receipt". <!-- cjk-ok -->

<!-- cjk-ok:start -->

| Query              | Target        | All q8 rank | Chosen rank | Chosen text end-to-end ms |
| ------------------ | ------------- | ----------- | ----------- | ------------------------- |
| receipt            | Receipt       | 1           | 1           | 19.90                     |
| screenshot of code | Code          | 3           | 1           | 15.92                     |
| airline ticket     | Boarding pass | 1           | 1           | 10.88                     |
| 机票               | Boarding pass | 2           | 1           | 7.14                      |
| 机票截图           | Boarding pass | 2           | 1           | 25.37                     |
| 收据               | Receipt       | 3           | 3           | 15.34                     |

<!-- cjk-ok:end -->

The pass rate on the four specified queries rose from 2/4 to 4/4. The fp32 image encoder is worth its extra 33.70MB. A center crop of the whole image loses the edges of long images, so the real index still needs vectors for both the whole image and its tiles.

| E5 input      | Chars | Tokens with prefix | Warm ms |
| ------------- | ----- | ------------------ | ------- |
| Chinese chunk | 300   | 208                | 44.30   |
| English chunk | 300   | 64                 | 12.03   |

The retrieval corpus has four passages: an English flight, a Chinese shopping receipt, an English program and a Chinese meeting. The ranks are below. The Chinese queries are test data. In order they mean "airline ticket and check-in", "the amount on a shopping receipt", "local image indexing code", "a flight from Singapore to Shanghai that needs a passport and boarding pass" and "a program that indexes images and runs OCR with TypeScript and SQLite".

<!-- cjk-ok:start -->

| Query                                           | Target          | Rank |
| ----------------------------------------------- | --------------- | ---- |
| 机票和登机手续                                  | English flight  | 3    |
| airline ticket and boarding pass                | English flight  | 1    |
| shopping receipt for coffee                     | Chinese receipt | 1    |
| 购物小票的金额                                  | Chinese receipt | 1    |
| 本地图片索引代码                                | English program | 3    |
| project meeting next Tuesday                    | Chinese meeting | 1    |
| 从新加坡飞往上海的航班，需要护照和登机牌        | English flight  | 1    |
| 用 TypeScript 和 SQLite 索引图片并做 OCR 的程序 | English program | 1    |

<!-- cjk-ok:end -->

Overall 6/8, and 4/6 across languages. Short Chinese queries show a language preference. OCR text plus E5 lets 机票 ("airline ticket") find the boarding pass, but 收据 ("receipt") and `screenshot of code` both hit the mixed-language explainer image first. E5 can serve as a candidate ranking signal. It cannot replace exact search. <!-- cjk-ok -->

## sqlite-vec

The same arm64 dylib, 161896 bytes, in both runtimes. It loads through `DatabaseSync({allowExtension:true})` and `loadExtension`, and extension loading is turned off after the load. The on-disk database uses WAL. A transaction inserts 10000 random normalized float32 vectors from a fixed seed. Queries are 384 dimensions with k=10, and 50 different vectors are queried after the first round. The top 10 neighbors match a brute-force JS computation.

| Runtime              | SQLite | sqlite-vec | Load ms | Insert ms | First query ms | Warm median ms | p95 ms |
| -------------------- | ------ | ---------- | ------- | --------- | -------------- | -------------- | ------ |
| Node 24.4.1          | 3.53.1 | 0.1.9      | 1.76    | 204.44    | 3.87           | 3.43           | 5.01   |
| Electron 44.4.5 main | 3.53.4 | 0.1.9      | 0.45    | 132.92    | 2.97           | 2.71           | 3.00   |

The database is 16003072 bytes. Integer primary keys must be bound as `BigInt`. Electron uses the existing binary from the repo's main working directory and a separate profile inside the spike, and openmail was not started. A signed release build has not been tested. 384-dimension text vectors and 512-dimension image-text vectors need separate tables.

## Optional speech

whisper.cpp v1.9.4, multilingual base F16, 147.95MB. Metal, 4 threads, beam=5, best-of=5. The system `say` command generates 30 seconds each of Chinese and English mono 16kHz audio, with the full speech retimed to 30 seconds. Each language starts 3 new processes.

| Language | First process s | Median wall clock of 3 runs s | Speed vs real time | Real-time factor |
| -------- | --------------- | ----------------------------- | ------------------ | ---------------- |
| English  | 25.19           | 0.64                          | 46.82×             | 0.021            |
| Chinese  | 1.23            | 1.12                          | 26.74×             | 0.037            |

The first English run includes Metal initialization. The library's own timing is only 1.04 seconds, so this number is not a stable transcription time. The original Chinese speech is 42.91 seconds long and was sped up 1.43 times. It has homophone errors, such as 登机牌 ("boarding pass") transcribed as 灯鸡排. base is a speed candidate. Chinese quality needs a separate test with a larger model. <!-- cjk-ok -->

## Choice and scope

Start with Vision OCR, sqlite-vec and FTS. Background indexing adds MobileCLIP mixed precision and E5 q8, merged by RRF. Classification is only a helper. The user chooses whether to download speech.

The recommended image-text and text model packages total **225.96MB**. With speech, the total is **373.91MB**. All models tried in this spike took **385.76MB** to download. The extra 11.85MB is the rejected q8 image encoder. Vision uses system models, so the spike downloads no extra model for it.

Nothing blocks running on this machine. The quality limits are short Chinese cross-language queries and Chinese speech transcription. The samples are small. Real attachments, phones, signed Electron, background queues and PDFs have not been verified. The code here is not wired into the app.

Swift compilation, JSON and coordinate checks, CLI error paths, Python syntax, model hashes, the KNN comparison across both runtimes, spike lint and format checks pass. The app build and tests were not run, and apps, packages and root dependencies were not changed. To reproduce, see [README.md](README.md). The raw numbers are in [artifacts/](artifacts/).

Component usage follows [MobileCLIP ONNX](https://huggingface.co/Xenova/mobileclip_s0), [the E5 model card](https://huggingface.co/intfloat/multilingual-e5-small), [the sqlite-vec Node example](https://github.com/asg017/sqlite-vec/blob/main/examples/simple-node2/demo.mjs) and [whisper.cpp](https://github.com/ggml-org/whisper.cpp). All performance and ranking numbers above were measured on this machine.
