# Regenerate: python3 tools/make-alert-sound.py public/sounds/ready.wav  (needs numpy)
# Writes the "order ready" alert: two-tone pager chime, played twice. 16-bit PCM mono WAV.
import sys, wave, numpy as np
RATE = 22050
def note(freq, dur=0.16):
    t = np.arange(int(RATE * dur)) / RATE
    # band-limited square wave: odd harmonics below Nyquist, so it's bright but not harsh
    wave_ = sum(np.sin(2 * np.pi * freq * k * t) / k for k in range(1, 40, 2) if freq * k < RATE / 2 * 0.9)
    env = np.minimum(1, t / 0.008) * np.exp(-t / 0.07)   # 8 ms attack, fast decay
    return wave_ * env
gap = lambda s: np.zeros(int(RATE * s))
parts = [gap(0.03)]
for f in (1046.5, 1318.5, 1046.5, 1318.5):
    parts += [note(f), gap(0.02)]
parts.append(gap(0.05))
sig = np.concatenate(parts)
sig = sig / np.max(np.abs(sig)) * 0.85
pcm = (sig * 32767).astype('<i2')
with wave.open(sys.argv[1], 'wb') as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(RATE); w.writeframes(pcm.tobytes())
print(f'{len(pcm)/RATE:.2f} s, {len(pcm)*2+44} bytes')
