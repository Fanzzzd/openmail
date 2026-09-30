"""No network. Evaluate generated PNGs with whitespace-stripped character edit distance."""
import json
import statistics
import subprocess
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parent

def normalize(text):
    return ''.join(unicodedata.normalize('NFC', text).split())

def distance(a, b):
    prev = list(range(len(b) + 1))
    for i, x in enumerate(a, 1):
        row = [i]
        for j, y in enumerate(b, 1):
            row.append(min(row[-1] + 1, prev[j] + 1, prev[j - 1] + (x != y)))
        prev = row
    return prev[-1]

def run(*args):
    return subprocess.run([str(ROOT / 'bin/vision'), *args], capture_output=True, text=True, check=True)

samples = json.loads((ROOT / 'samples/ground-truth.json').read_text())
result = {'ocr': [], 'classifications': [], 'feature_print': None}
for sample in samples:
    if sample['id'] == 'receipt-similar':
        continue
    for tiled in [False, True]:
        proc = run(*(['--tile'] if tiled else []), '--repeat', '6', str(ROOT / 'samples' / (sample['id'] + '.png')))
        lines = [json.loads(line) for line in proc.stdout.splitlines()]
        (ROOT / 'artifacts' / (sample['id'] + ('-tile' if tiled else '-whole') + '.jsonl')).write_text(proc.stdout)
        timing = json.loads(proc.stderr.strip().splitlines()[-1])
        expected = normalize(''.join(line['text'] for line in sorted(sample['lines'], key=lambda x: (x['y'], x['x']))))
        recognized = normalize(''.join(line['text'] for line in lines))
        edits = distance(expected, recognized)
        # Also evaluate each line by nearest ground-truth y. This separates reading order from OCR errors.
        matches = []
        remaining = list(lines)
        for gt in sorted(sample['lines'], key=lambda x: (x['y'], x['x'])):
            candidates = [(i, line) for i, line in enumerate(remaining)
                if abs(line['box'][1] - gt['y']) < gt['size'] * 1.8]
            if candidates:
                i, chosen = min(candidates, key=lambda x: abs(x[1]['box'][0] - gt['x']) + abs(x[1]['box'][1] - gt['y']))
                remaining.pop(i)
                matches.append(distance(normalize(gt['text']), normalize(chosen['text'])))
            else:
                matches.append(len(normalize(gt['text'])))
        assert all(0 <= line['box'][0] <= sample['width'] and 0 <= line['box'][1] <= sample['height']
            and line['box'][0] + line['box'][2] <= sample['width'] + 1
            and line['box'][1] + line['box'][3] <= sample['height'] + 1 for line in lines)
        row = {'sample': sample['id'], 'tiled': tiled, 'ground_truth_characters': len(expected),
            'ground_truth_lines': len(sample['lines']), 'recognized_lines': len(lines),
            'edits': edits, 'character_match_percent': max(0, 100 * (1 - edits / len(expected))),
            'line_aligned_edits': sum(matches) + sum(len(normalize(x['text'])) for x in remaining),
            'cold_ms': timing['ms'][0], 'warm_median_ms': statistics.median(timing['ms'][1:]), 'timing': timing}
        result['ocr'].append(row)
        print(json.dumps(row, ensure_ascii=False), flush=True)
    proc = run('classify', '--repeat', '6', str(ROOT / 'samples' / (sample['id'] + '.png')))
    labels = json.loads(proc.stdout)
    result['classifications'].append({'sample': sample['id'], **labels,
        'warm_median_ms': statistics.median(labels['ms'][1:])})
proc = run('feature', *(str(ROOT / 'samples' / (x + '.png')) for x in ['receipt', 'receipt', 'receipt-similar', 'ticket', 'code', 'mixed']))
result['feature_print'] = json.loads(proc.stdout)
(ROOT / 'artifacts/vision.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
