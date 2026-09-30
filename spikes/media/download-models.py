"""Download only pinned model/config files. Never reads samples or mail."""
import concurrent.futures
import argparse
import hashlib
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent
MODELS = {
    'Xenova/mobileclip_s0': ['config.json', 'preprocessor_config.json', 'tokenizer.json', 'tokenizer_config.json',
        'onnx/text_model_quantized.onnx', 'onnx/vision_model_quantized.onnx', 'LICENSE'],
    'Xenova/multilingual-e5-small': ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'special_tokens_map.json',
        'onnx/model_quantized.onnx'],
}
REVISIONS = {
    'Xenova/mobileclip_s0': '757d59c9c6870a76a4b0306f05f5061bca15c39f',
    'Xenova/multilingual-e5-small': '761b726dd34fb83930e26aab4e9ac3899aa1fa78',
    'ggerganov/whisper.cpp': '5359861c739e955e79d9a303bcbc70fb988958b1',
}

def curl(url, destination):
    partial = destination.with_name(destination.name + '.part')
    subprocess.run(['curl', '-4', '-fsSL', '--retry', '3', '--retry-delay', '2', '--connect-timeout', '15',
        '--max-time', '180', url, '-o', str(partial)], check=True)
    partial.replace(destination)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--hybrid', action='store_true', help='Also download the fp32 MobileCLIP vision encoder')
    parser.add_argument('--whisper', action='store_true', help='Also download the multilingual Whisper base model')
    args = parser.parse_args()
    if args.hybrid:
        MODELS['Xenova/mobileclip_s0'].append('onnx/vision_model.onnx')
    if args.whisper:
        MODELS['ggerganov/whisper.cpp'] = ['ggml-base.bin']
    jobs = []
    manifests = []
    for model, files in MODELS.items():
        metadata_name = 'whisper-hub.json' if model == 'ggerganov/whisper.cpp' else model.split('/')[-1] + '-hub.json'
        metadata_path = ROOT / 'artifacts' / metadata_name
        if not metadata_path.exists():
            curl(f'https://huggingface.co/api/models/{model}/revision/{REVISIONS[model]}?blobs=true', metadata_path)
        metadata = json.loads(metadata_path.read_text())
        assert metadata['sha'] == REVISIONS[model]
        revision = metadata['sha']
        siblings = {x['rfilename']: x for x in metadata['siblings']}
        for filename in files:
            info = siblings[filename]
            destination = ROOT / 'models' / model / filename if model != 'ggerganov/whisper.cpp' else ROOT / 'models' / filename
            destination.parent.mkdir(parents=True, exist_ok=True)
            row = {'model': model, 'revision': revision, 'file': filename, 'bytes': info['size']}
            if 'lfs' in info:
                row['sha256'] = info['lfs']['sha256']
            jobs.append((f'https://huggingface.co/{model}/resolve/{revision}/{filename}', destination, row))
            manifests.append(row)

    def download(job):
        url, destination, row = job
        if not destination.exists() or destination.stat().st_size != row['bytes']:
            print('Download', row['model'], row['file'], row['bytes'], flush=True)
            curl(url, destination)
        assert destination.stat().st_size == row['bytes']
        sha = hashlib.sha256(destination.read_bytes()).hexdigest()
        if 'sha256' in row:
            assert row['sha256'] == sha, destination
        row['sha256'] = sha
        print('Verified', row['file'], flush=True)

    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        list(pool.map(download, jobs))
    (ROOT / 'artifacts/model-manifest.json').write_text(json.dumps(manifests, indent=2) + '\n')
    print('Total model package bytes:', sum(x['bytes'] for x in manifests))

if __name__ == '__main__':
    main()
