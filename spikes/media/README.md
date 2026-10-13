# 端侧媒体搜索实验

结果见 [RESULTS.md](RESULTS.md)。脚本只读生成样本，只写本目录。模型下载与推理分开。推理禁用远程模型和 `fetch`，不调用服务端推理。

需要 Apple Silicon Mac、Node 24、`swiftc`、Python 3、npm。语音实验另需 `cmake`、`ffmpeg`、已安装的 Samantha 和 Tingting 系统声音。无需 Xcode 项目。

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

Swift CLI 的标准输出是 JSON lines，字段为 `text`、`confidence`、`box`。`box` 是原图像素坐标 `[x, y, width, height]`，原点在左上。耗时和图像尺寸写到标准错误。切片高 1024px，重叠 128px，按框中心归属去重。语言顺序为 `zh-Hans`、`zh-Hant`、`en`，识别级别为 accurate。

```sh
bin/vision samples/mixed.png
bin/vision --tile samples/long.png
bin/vision classify samples/receipt.png
bin/vision feature samples/receipt.png samples/receipt-similar.png samples/code.png
```

Electron 测试要用仓库的 44.4.5 二进制，不能设置 `ELECTRON_RUN_AS_NODE`。在仓库根目录 `pnpm install` 后，用 desktop 依赖的 Electron 二进制。只启动 `electron-main.mjs`，不加载 openmail。它在 ready 前把 userData、sessionData 和日志目录改到 `artifacts/electron-profile/`，无窗口。

```sh
MEDIA_ELECTRON_BIN="$(cd ../../apps/desktop && node -p 'require("electron")')"
env -u ELECTRON_RUN_AS_NODE "$MEDIA_ELECTRON_BIN" electron-main.mjs
```

语音实验固定 whisper.cpp v1.9.4。以下网络请求只下载源码。base 模型由上面的下载脚本按固定版本下载并校验。

```sh
curl -4 -fsSL https://api.github.com/repos/ggml-org/whisper.cpp/tarball/v1.9.4 -o artifacts/whisper-src.tar.gz
mkdir -p artifacts/whisper-src
tar -xzf artifacts/whisper-src.tar.gz -C artifacts/whisper-src --strip-components=1
cmake -S artifacts/whisper-src -B artifacts/whisper-build -DCMAKE_BUILD_TYPE=Release -DGGML_METAL=ON -DWHISPER_BUILD_TESTS=OFF
cmake --build artifacts/whisper-build --target whisper-cli -j 6
python3 bench-whisper.py
```

`say` 生成的整段语音经 `atempo` 调至 30 秒，补齐或截去末尾静音。输出为单声道 16kHz、16-bit PCM。转写保留时间戳。英文原始长度 28.82 秒，中文 42.91 秒，中文语速被加快约 1.43 倍。

原始结果在 `artifacts/vision.json`、`embeddings.json`、`embeddings-hybrid.json`、`sqlite-node.json`、`sqlite-electron.json`、`whisper.json`。模型版本、大小和 SHA-256 在 `model-manifest.json`，机器配置在 `environment.json`。大文件、生成样本、数据库和依赖被本目录的 `.gitignore` 忽略，可按上述命令重建。
