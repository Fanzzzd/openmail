"""Regenerate numeric tables from raw measurements. --check fails on stale tables."""
import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
parser = argparse.ArgumentParser()
parser.add_argument('--check', action='store_true')
args = parser.parse_args()

def load(name):
    return json.loads((ROOT / 'artifacts' / name).read_text())

def f(value):
    return f'{value:.2f}'

vision = load('vision.json')
q8 = load('embeddings.json')
hybrid = load('embeddings-hybrid.json')
manifest = load('model-manifest.json')
whisper = load('whisper.json')
labels = {'mixed': '中英混排', 'long': '长截图', 'receipt': '票据', 'ticket': '登机牌', 'code': '代码'}
document_labels = {'flight-en': '英文航班', 'receipt-zh': '中文票据', 'code-en': '英文程序', 'meeting-zh': '中文会议'}
tables = []

headers = ['样本', '尺寸 px', '真值字符', '整图匹配率', '整图暖轮 ms', '切片匹配率', '切片暖轮 ms']
rows = []
for sample in ['mixed', 'long', 'receipt', 'ticket', 'code']:
    whole = next(x for x in vision['ocr'] if x['sample'] == sample and not x['tiled'])
    tile = next(x for x in vision['ocr'] if x['sample'] == sample and x['tiled'])
    label = '中英简繁混排' if sample == 'mixed' else '小字购物票据' if sample == 'receipt' else '代码截图' if sample == 'code' else labels[sample]
    rows.append([label, f"{whole['timing']['width']}×{whole['timing']['height']}", str(whole['ground_truth_characters']),
        f(whole['character_match_percent']) + '%', f(whole['warm_median_ms']), f(tile['character_match_percent']) + '%', f(tile['warm_median_ms'])])
tables.append((headers, rows))
tables.append((['样本', '分类最高标签', '置信度', '分类暖轮 ms'],
    [[labels[x['sample']], x['labels'][0]['label'], f"{x['labels'][0]['confidence']:.3f}", f(x['warm_median_ms'])]
        for x in vision['classifications']]))
tables.append((['与原票据比较', '距离'], [[label, f'{d:.4f}'] for label, d in zip(
    ['同图', '改为浅黄背景的票据', '登机牌', '代码截图', '中英混排'], vision['feature_print']['distances_from_first'], strict=True)]))

def clip_files(dtype):
    excluded = 'onnx/vision_model.onnx' if dtype == 'q8' else 'onnx/vision_model_quantized.onnx'
    return [x for x in manifest if x['model'] == 'Xenova/mobileclip_s0' and x['file'] != excluded]

def size(files, weights=False):
    return sum(x['bytes'] for x in files if not weights or x['file'].endswith('.onnx')) / 1e6

e5_files = [x for x in manifest if x['model'] == 'Xenova/multilingual-e5-small']
tables.append((['模型配置', '模型包 MB', 'ONNX 权重 MB', '本地加载 ms'], [
    ['MobileCLIP S0 全 q8，对照', f(size(clip_files('q8'))), f(size(clip_files('q8'), True)), f(q8['clip']['total_load_ms'])],
    ['MobileCLIP S0 图像 fp32、文本 q8，选用', f(size(clip_files('fp32'))), f(size(clip_files('fp32'), True)), f(hybrid['clip']['total_load_ms'])],
    ['multilingual-e5-small q8', f(size(e5_files)), f(size(e5_files, True)), f(hybrid['e5']['load_ms'])],
]))
tables.append((['图像', '全 q8 端到端 ms', '选用配置端到端 ms', '选用配置纯推理 ms'], [
    [labels[x['id']], f(next(y for y in q8['clip']['images'] if y['id'] == x['id'])['end_to_end_ms']['median']),
        f(x['end_to_end_ms']['median']), f(x['inference_ms']['median'])] for x in hybrid['clip']['images']]))
tables.append((['查询', '目标', '全 q8 名次', '选用配置名次', '选用配置文本端到端 ms'], [
    [x['query'], labels[x['expected']], str(next(y for y in q8['clip']['queries'] if y['query'] == x['query'])['correct_rank']),
        str(x['correct_rank']), f(x['end_to_end_ms']['median'])] for x in hybrid['clip']['queries']]))
tables.append((['E5 输入', '字符', '含前缀 tokens', '暖轮 ms'], [
    ['中文块' if x['language'] == 'zh' else '英文块', str(x['characters']), str(x['token_count']), f(x['end_to_end_ms']['median'])]
    for x in hybrid['e5']['chunks']]))
tables.append((['查询', '目标', '名次'], [
    [x['query'], document_labels[x['expected']], str(x['correct_rank'])] for x in hybrid['e5']['queries']]))
sqlite_rows = []
for runtime in ['node', 'electron']:
    x = load('sqlite-' + runtime + '.json')
    label = f"Node {x['versions']['node']}" if runtime == 'node' else f"Electron {x['versions']['electron']} main"
    sqlite_rows.append([label, x['versions']['sqlite'], x['versions']['vec'].lstrip('v'), f(x['load_ms']), f(x['insert_ms']),
        f(x['first_query_ms']), f(x['warm_median_ms']), f(x['warm_p95_ms'])])
tables.append((['环境', 'SQLite', 'sqlite-vec', '加载 ms', '插入 ms', '首查 ms', '暖轮中位 ms', 'p95 ms'], sqlite_rows))
tables.append((['语言', '首次进程 s', '三轮墙钟中位 s', '相对实时倍速', '实时系数'], [
    ['英文' if x['language'] == 'en' else '中文', f(x['runs'][0]['wall_ms'] / 1000), f(x['wall_median_ms'] / 1000),
        f(x['speed_x']) + '×', f"{x['real_time_factor']:.3f}"] for x in whisper['results']]))

path = ROOT / 'RESULTS.md'
lines = path.read_text().splitlines()

def cells(line):
    return [x.strip() for x in line.strip().strip('|').split('|')]

for headers, rows in tables:
    starts = [i for i, line in enumerate(lines) if line.startswith('|') and cells(line) == headers]
    assert len(starts) == 1, headers
    start = starts[0]
    end = start + 1
    while end < len(lines) and lines[end].startswith('|'):
        end += 1
    if args.check:
        actual = [cells(line) for line in lines[start + 2:end]]
        assert actual == rows, f'Stale table: {headers}'
    else:
        def render(row):
            return '| ' + ' | '.join(row) + ' |'
        lines[start:end] = [render(headers), render(['---'] * len(headers)), *map(render, rows)]

if not args.check:
    path.write_text('\n'.join(lines) + '\n')
print('Numeric tables match raw measurements.' if args.check else 'Regenerated numeric tables.')
