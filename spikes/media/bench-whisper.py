"""Generate two local 30-second speech clips and run whisper.cpp base with Metal."""
import hashlib
import json
import re
import statistics
import subprocess
import time
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parent
AUDIO = ROOT / 'artifacts/audio'
AUDIO.mkdir(exist_ok=True)
texts = {
    'en': ('Samantha', 'Welcome to the local media search test. Your flight from Singapore to Shanghai is confirmed for Thursday morning. '
        'Please bring your passport and boarding pass to the airport. The shopping receipt includes coffee, milk, and bread. '
        'The total amount is thirty five dollars. We will index email attachments on this computer. Images and recordings stay on this Mac. '
        'Our next project meeting is on Tuesday afternoon. Please review the search results before the meeting.'),
    'zh': ('Tingting', '欢迎参加本地媒体搜索测试。您从新加坡飞往上海的航班已经确认，将于星期四上午出发。'
        '请带好护照和登机牌，提前到机场办理手续。购物小票包括咖啡、牛奶和面包，总金额为三十五元。'
        '我们将在这台电脑上索引邮件附件。图片和录音都保留在本机。下次项目会议安排在星期二下午。'
        '请在会议之前查看搜索结果，并确认机票时间和购物金额。所有语音转写都在本地完成。'),
}
results = []
for language, (voice, text) in texts.items():
    source = AUDIO / (language + '.txt')
    source.write_text(text)
    aiff = AUDIO / (language + '.aiff')
    wav = AUDIO / (language + '.wav')
    subprocess.run(['say', '-v', voice, '-r', '145', '-f', str(source), '-o', str(aiff)], check=True)
    duration = float(subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1', str(aiff)], text=True).strip())
    tempo = duration / 30
    assert 0.5 <= tempo <= 2
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', str(aiff), '-af', f'atempo={tempo},apad,atrim=duration=30',
        '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', str(wav)], check=True)
    with wave.open(str(wav)) as file:
        assert file.getnframes() == 480000 and file.getframerate() == 16000
    rows = []
    for repeat in range(3):
        output = AUDIO / f'{language}-{repeat}'
        start = time.perf_counter()
        proc = subprocess.run([str(ROOT / 'artifacts/whisper-build/bin/whisper-cli'),
            '-m', str(ROOT / 'models/ggml-base.bin'), '-f', str(wav), '-l', language,
            '-t', '4', '-bs', '5', '-bo', '5', '-oj', '-of', str(output)],
            capture_output=True, text=True, check=True)
        wall_ms = (time.perf_counter() - start) * 1000
        output.with_suffix('.log').write_text(proc.stderr)
        timing = {}
        for name, ms in re.findall(r'whisper_print_timings:\s+(.+?)\s+time\s*=\s*([\d.]+) ms', proc.stderr):
            timing[name.strip()] = float(ms)
        transcript = json.loads(output.with_suffix('.json').read_text())
        rows.append({'wall_ms': wall_ms, 'timing_ms': timing,
            'transcript': ' '.join(x['text'] for x in transcript['transcription'])})
        print(language, repeat, round(wall_ms, 1), timing, flush=True)
    median = statistics.median(x['wall_ms'] for x in rows)
    results.append({'language': language, 'voice': voice, 'source_text': text, 'original_speech_seconds': duration,
        'atempo': tempo, 'audio_seconds': 30, 'sample_rate': 16000, 'wall_median_ms': median,
        'real_time_factor': median / 30000, 'speed_x': 30000 / median, 'runs': rows})
model = ROOT / 'models/ggml-base.bin'
result = {'model': 'base multilingual F16', 'model_bytes': model.stat().st_size,
    'model_sha256': hashlib.sha256(model.read_bytes()).hexdigest(),
    'whisper': {'version': 'v1.9.4', 'source': 'https://github.com/ggml-org/whisper.cpp/releases/tag/v1.9.4'},
    'threads': 4, 'beam_size': 5, 'best_of': 5, 'metal': True, 'results': results}
(ROOT / 'artifacts/whisper.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
