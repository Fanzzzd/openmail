# On-device media search spike

Results are in [RESULTS.md](RESULTS.md). The scripts read only generated samples and write only to this directory. Model download is separate from inference. Inference disables remote models and `fetch` and calls no server inference.

You need an Apple Silicon Mac, Node 24, `swiftc`, Python 3 and npm. The speech spike also needs `cmake`, `ffmpeg`, and the Samantha and Tingting system voices installed. No Xcode project is needed.

```sh
cd spikes/media
mkdir -p bin artifacts models samples
npm ci --no-audit --no-fund --cache ./artifacts/npm-cache
npm run samples
npm run vision
npm run download -- --hybrid --whisper
npm run embeddings
MEDIA_VISION_DTYPE=fp32 npm run embeddings
npm run sqlite
npm run report
npm run check-report
```

The Swift CLI writes JSON lines to standard output, with the fields `text`, `confidence` and `box`. `box` is `[x, y, width, height]` in source image pixels, with the origin at the top left. Timing and image size go to standard error. Tiles are 1024px high with a 128px overlap, and boxes are deduplicated by which tile holds their center. The language order is `zh-Hans`, `zh-Hant`, `en`, and the recognition level is accurate.

```sh
bin/vision samples/mixed.png
bin/vision --tile samples/long.png
bin/vision classify samples/receipt.png
bin/vision feature samples/receipt.png samples/receipt-similar.png samples/code.png
```

The Electron test must use the repo's 44.4.5 binary and must not set `ELECTRON_RUN_AS_NODE`. After `pnpm install` at the repo root, use the Electron binary that desktop depends on. It starts only `electron-main.mjs` and does not load openmail. Before ready, it moves userData, sessionData and the log directory to `artifacts/electron-profile/`. It opens no window.

```sh
MEDIA_ELECTRON_BIN="$(cd ../../apps/desktop && node -p 'require("electron")')"
env -u ELECTRON_RUN_AS_NODE "$MEDIA_ELECTRON_BIN" electron-main.mjs
```

The speech spike pins whisper.cpp v1.9.4. The network requests below only download source code. The download script above fetches and verifies the base model at a pinned version.

```sh
curl -4 -fsSL https://api.github.com/repos/ggml-org/whisper.cpp/tarball/v1.9.4 -o artifacts/whisper-src.tar.gz
mkdir -p artifacts/whisper-src
tar -xzf artifacts/whisper-src.tar.gz -C artifacts/whisper-src --strip-components=1
cmake -S artifacts/whisper-src -B artifacts/whisper-build -DCMAKE_BUILD_TYPE=Release -DGGML_METAL=ON -DWHISPER_BUILD_TESTS=OFF
cmake --build artifacts/whisper-build --target whisper-cli -j 6
python3 bench-whisper.py
```

`atempo` stretches each full `say` recording to 30 seconds, and trailing silence is padded or trimmed. The output is mono 16kHz 16-bit PCM. Transcripts keep timestamps. The original English length is 28.82 seconds and the Chinese length is 42.91 seconds, so the Chinese speech is sped up about 1.43 times.

The raw results are in `artifacts/vision.json`, `embeddings.json`, `embeddings-hybrid.json`, `sqlite-node.json`, `sqlite-electron.json` and `whisper.json`. Model versions, sizes and SHA-256 are in `model-manifest.json`, and the machine configuration is in `environment.json`. This directory's `.gitignore` ignores large files, generated samples, databases and dependencies. You can rebuild them with the commands above.
