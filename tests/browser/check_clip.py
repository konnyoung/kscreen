#!/usr/bin/env python3
"""Checks an Instant Replay clip made by replay-e2e.html (needs ffmpeg/ffprobe).

  python3 tests/browser/check_clip.py clip.mp4 [--tracks N] [--min-seconds S] [--max-offset-ms MS]

- the file decodes with no errors (every track);
- it has the expected number of audio tracks and lasts at least S seconds;
- A/V sync: every white flash of the picture has its beep in the FIRST audio track within
  MS milliseconds (the test page switches both at the same instant).
Prints a JSON summary; exit code 1 when a check fails.
"""
import json
import re
import subprocess
import sys


def run(args):
    return subprocess.run(args, capture_output=True, text=True)


def flashes(path):
    """Times (s) where the picture turns white."""
    out = run(['ffmpeg', '-hide_banner', '-i', path, '-map', '0:v:0', '-vf',
               'signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-', '-f', 'null', '-']).stdout
    times, lit, t = [], False, None
    for line in out.splitlines():
        m = re.search(r'pts_time:([\d.]+)', line)
        if m:
            t = float(m.group(1))
            continue
        m = re.search(r'YAVG=([\d.]+)', line)
        if m and t is not None:
            on = float(m.group(1)) > 128
            if on and not lit:
                times.append(t)
            lit = on
    return times


def beeps(path):
    """Times (s) where the first audio track turns loud (the beep; the mic tone stays below)."""
    err = run(['ffmpeg', '-hide_banner', '-i', path, '-map', '0:a:0', '-af',
               'silencedetect=noise=-14dB:d=0.05', '-f', 'null', '-']).stderr
    return [float(m) for m in re.findall(r'silence_end: ([\d.]+)', err)]


def main():
    path = sys.argv[1]
    opts = dict(zip(sys.argv[2::2], sys.argv[3::2]))
    want_tracks = int(opts.get('--tracks', -1))
    min_seconds = float(opts.get('--min-seconds', 0))
    max_offset = float(opts.get('--max-offset-ms', 60))

    probe = json.loads(run(['ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', path]).stdout)
    streams = probe['streams']
    video = [s for s in streams if s['codec_type'] == 'video']
    audio = [s for s in streams if s['codec_type'] == 'audio']
    # Lines from ffmpeg's own null output (its frame-rate bookkeeping) are not decode errors.
    decode_errors = '\n'.join(l for l in run(['ffmpeg', '-v', 'error', '-i', path, '-map', '0', '-fps_mode', 'passthrough', '-f', 'null', '-']).stderr.splitlines()
                              if l.strip() and not l.startswith('[null @')).strip()
    duration = float(probe['format']['duration'])

    # A clip that opens mid-flash has no beep onset for it: only flashes that start inside.
    f = [t for t in flashes(path) if t > 0.3]
    b = beeps(path)
    offsets = []
    for t in f:
        near = min(b, key=lambda x: abs(x - t)) if b else None
        offsets.append(None if near is None else round((near - t) * 1000))

    problems = []
    if len(video) != 1 or video[0]['codec_name'] != 'h264':
        problems.append('expected one h264 video track')
    if want_tracks >= 0 and len(audio) != want_tracks:
        problems.append(f'expected {want_tracks} audio tracks, got {len(audio)}')
    if decode_errors:
        problems.append('decode errors: ' + decode_errors[:300])
    if duration < min_seconds:
        problems.append(f'lasts {duration:.2f} s, expected at least {min_seconds}')
    if audio and not f:
        problems.append('no flash found in the picture')
    bad = [o for o in offsets if o is None or abs(o) > max_offset]
    if audio and bad:
        problems.append(f'A/V offsets over {max_offset} ms: {offsets}')

    summary = {
        'file': path,
        'duration': round(duration, 2),
        'video': {k: video[0].get(k) for k in ('codec_name', 'profile', 'width', 'height', 'avg_frame_rate', 'nb_frames')} if video else None,
        'audio': [{k: a.get(k) for k in ('codec_name', 'sample_rate', 'channels', 'nb_frames')} | {'name': a.get('tags', {}).get('handler_name')} for a in audio],
        'flashes': [round(t, 3) for t in f],
        'beeps': [round(t, 3) for t in b],
        'offsets_ms': offsets,
        'ok': not problems,
        'problems': problems,
    }
    print(json.dumps(summary, ensure_ascii=False, indent=1))
    sys.exit(0 if not problems else 1)


if __name__ == '__main__':
    main()
