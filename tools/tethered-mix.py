# Rebuilds assets/audio/music/sake-tethered.m4a. Needs numpy and ffmpeg. First run:
#   ffmpeg -i assets/audio/music/sake.m4a -af "asetrate=44100*0.8908987,aresample=44100,lowpass=f=3800,highpass=f=35" -ac 2 -ar 44100 -f f32le sake_slow.raw
# then: python3 tools/tethered-mix.py, and encode tethered.raw:
#   ffmpeg -f f32le -ar 44100 -ac 2 -i tethered.raw -af volume=-1.4dB -c:a aac -b:a 160k -movflags +faststart sake-tethered.m4a
# "Sake (Tethered mix)": an original suspense arrangement around a slowed, darkened Sake.
# Everything except the Sake stem is synthesised here (no samples).
import numpy as np

SR = 44100
rng = np.random.default_rng(7)
R = 2 ** (-2 / 12)                      # Sake slowed + pitched down 2 semitones
BPM = 79.0 * R                          # ~70.4
BEAT = 60 / BPM
BAR = 4 * BEAT
sake = np.fromfile('sake_slow.raw', dtype=np.float32).reshape(-1, 2).astype(np.float64)
N = len(sake) + int(SR * 4)            # a little tail for the reverb
T = N / SR
print(f'bpm {BPM:.2f}  bar {BAR:.3f}s  length {T:.1f}s  bars {T / BAR:.1f}')

# Notes are semitones from the original C (B-flat after the shift). Sake's bass alternates
# every bar: odd bars sit on Ab, even bars on F#/Gb (analysed per bar), so every layer follows.
def hz(semi, octave=3):                 # Bb3 = 233.08 Hz
    return 233.0819 * 2 ** (semi / 12 + (octave - 3))

def tline(n):
    return np.arange(n) / SR

def env_adsr(n, a, d, s, r):
    t = tline(n); e = np.ones(n) * s
    ai = int(a * SR); di = int(d * SR); ri = int(r * SR)
    e[:ai] = np.linspace(0, 1, ai, endpoint=False) if ai else e[:ai]
    if di: e[ai:ai + di] = np.linspace(1, s, len(e[ai:ai + di]))
    if ri: e[-ri:] *= np.linspace(1, 0, len(e[-ri:]))
    return e

def lowpass(x, fc, order=2):
    X = np.fft.rfft(x, axis=0); f = np.fft.rfftfreq(len(x), 1 / SR)
    g = 1 / np.sqrt(1 + (f / fc) ** (2 * order))
    return np.fft.irfft(X * (g[:, None] if x.ndim > 1 else g), n=len(x), axis=0)

def highpass(x, fc, order=2):
    X = np.fft.rfft(x, axis=0); f = np.fft.rfftfreq(len(x), 1 / SR)
    g = 1 / np.sqrt(1 + (fc / np.maximum(f, 1e-3)) ** (2 * order))
    return np.fft.irfft(X * (g[:, None] if x.ndim > 1 else g), n=len(x), axis=0)

def bowed(freq, dur, voices=5, detune=0.006, vib=0.004, bright=1.0, formant=None):
    """String-section / choir voice: detuned additive saws with vibrato."""
    n = int(dur * SR); t = tline(n); out = np.zeros(n)
    nh = max(1, min(int(9000 / freq), int(40 * bright)))
    for v in range(voices):
        d = 1 + detune * (v - (voices - 1) / 2) / max(1, voices - 1) * 2
        rate = 4.8 + rng.random() * 1.4
        inst = freq * d * (1 + vib * np.sin(2 * np.pi * rate * t + rng.random() * 6))
        ph = 2 * np.pi * np.cumsum(inst) / SR + rng.random() * 6
        for k in range(1, nh + 1):
            a = 1 / k
            if formant:
                fk = freq * k
                a = sum(g * np.exp(-((fk - F) / bw) ** 2) for F, bw, g in formant) + 0.02 / k
            out += a * np.sin(k * ph)
    return out / voices

def pluck(freq, dur=1.2, bright=1.0):
    n = int(dur * SR); t = tline(n); out = np.zeros(n)
    for k in range(1, 14):
        f = freq * k * (1 + 0.0004 * k * k)
        if f > 12000: break
        out += (1 / k ** 1.2) * np.exp(-t * (4.5 + 2.2 * k / bright)) * np.sin(2 * np.pi * f * t + rng.random())
    att = np.minimum(1, t / 0.003)
    noise = rng.standard_normal(n) * np.exp(-t * 90) * 0.25
    return (out + noise) * att

def boom(dur=3.0, f0=62, f1=38):
    n = int(dur * SR); t = tline(n)
    f = f1 + (f0 - f1) * np.exp(-t * 6)
    ph = 2 * np.pi * np.cumsum(f) / SR
    body = np.sin(ph) * np.exp(-t * 1.6)
    hit = lowpass(rng.standard_normal(n) * np.exp(-t * 25), 900) * 0.6
    return body + hit

def heartbeat():
    n = int(0.9 * SR); out = np.zeros(n)
    for off, amp in [(0, 1.0), (0.24, 0.7)]:
        m = int(0.35 * SR); t = tline(m)
        f = 38 + 30 * np.exp(-t * 30)
        s = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 11) * amp
        i = int(off * SR); out[i:i + m] += s
    return out

def place(buf, sig, t0, gain=1.0, pan=0.0):
    i = int(t0 * SR)
    if i >= len(buf): return
    sig = sig[:len(buf) - i]
    l, r = np.cos((pan + 1) * np.pi / 4), np.sin((pan + 1) * np.pi / 4)
    buf[i:i + len(sig), 0] += sig * gain * l * 1.414
    buf[i:i + len(sig), 1] += sig * gain * r * 1.414

def reverb(x, secs=3.2, mix=0.35, damp=2200):
    """Convolution with a synthetic hall: decaying, darkening stereo noise."""
    m = int(secs * SR); t = tline(m)
    ir = rng.standard_normal((m, 2)) * np.exp(-t * 6.9 / secs)[:, None]
    ir = lowpass(ir, damp); ir[: int(0.02 * SR)] *= 0.2
    ir /= np.sqrt((ir ** 2).sum(0))
    L = 1 << int(np.ceil(np.log2(len(x) + m)))
    wet = np.fft.irfft(np.fft.rfft(x, L, axis=0) * np.fft.rfft(ir, L, axis=0), L, axis=0)[: len(x)]
    return x * (1 - mix) + wet * mix * 2.2

bar = lambda b: b * BAR
# Sake's own shape (slowed): quiet intro until ~11 s, break ~95-107 s, outro from ~184 s
B_IN, B_BREAK, B_BACK, B_END = 11.2 / BAR, 95.4 / BAR, 107.5 / BAR, 184.0 / BAR

# ---------- layers ----------
pizz = np.zeros((N, 2)); strings = np.zeros((N, 2)); low = np.zeros((N, 2)); high = np.zeros((N, 2))
choir = np.zeros((N, 2)); perc = np.zeros((N, 2))

# 1. Pizzicato ostinato: a creeping music-box figure in Bb minor with a tritone lean (original).
FIG_ODD = [0, 3, 8, 7, 0, 3, 8, 10]     # over the Ab bars
FIG_EVEN = [0, 3, 6, 5, 0, 1, 3, -1]    # over the F# bars: chromatic creep down
FIG_TURN = [0, 3, 6, 5, 6, 5, 3, -1]    # every 4th bar
nbars = int(T / BAR)
for b in range(nbars):
    if b >= B_END + 1: break
    fig = FIG_ODD if b % 2 else (FIG_TURN if b % 4 == 2 else FIG_EVEN)
    for i, s in enumerate(fig):
        t0 = bar(b) + i * BEAT / 2
        accent = 1.0 if i % 2 == 0 else 0.7
        g = 0.5 if b < 2 else 0.85
        if B_BREAK <= b < B_BACK: g = 1.0
        place(pizz, pluck(hz(s, 4)), t0, 0.16 * accent * g, pan=-0.35 + 0.1 * (i % 3))
        if b >= 8 and i % 2 == 0:          # cellos double it an octave down from bar 8
            place(pizz, pluck(hz(s, 2), 1.6, 0.7), t0, 0.12 * g, pan=0.3)

# 2. Low drone (cellos/basses), bowed tremolo that swells every 4 bars.
CHORDS = [(-6, 1), (-4, 3), (-6, 1), (-4, 3)]   # follows Sake's bass: F# / Ab (root, fifth)
for b in range(0, nbars, 4):
    if b > B_END: break
    for j, (r, f5) in enumerate(CHORDS):
        t0 = bar(b + j); d = BAR + 0.6
        sig = bowed(hz(r, 1), d, voices=4, bright=0.6) + 0.6 * bowed(hz(f5, 2), d, voices=3, bright=0.6)
        e = env_adsr(len(sig), 0.9, 0.1, 1.0, 0.7)
        trem = 1 - 0.35 * (0.5 + 0.5 * np.sin(2 * np.pi * 7.5 * tline(len(sig)))) * (b >= 16)
        g = 0.05 if b < 4 else 0.09
        if B_BREAK <= b + j < B_BACK: g = 0.04
        place(low, sig * e * trem, t0, g, pan=0.1)

# 3. High violins: a minor-second cluster (F + Gb, later Db + D) that swells and falls away.
for b in range(4, nbars, 4):
    if b > B_END: break
    pair = (5, 6) if (b // 4) % 2 == 0 else (11, 12)
    d = 4 * BAR
    sig = bowed(hz(pair[0], 5), d, voices=6, vib=0.006, bright=0.5) + bowed(hz(pair[1], 5), d, voices=6, vib=0.006, bright=0.5)
    tt = tline(len(sig)) / d
    e = np.sin(np.pi * tt) ** 2.2           # slow crescendo / decrescendo over 4 bars
    g = 0.035 if b < 16 else 0.05
    if B_BREAK - 1 <= b < B_BACK: g = 0.07
    place(high, sig * e, bar(b), g, pan=0.4 if (b // 4) % 2 else -0.4)

# 4. Choir ("ooh") from bar 16: Bb minor triad, then a darker Gb major / F suspended turn.
OOH = [(320, 90, 1.0), (800, 160, 0.45), (2600, 300, 0.05)]
CH_SEQ = [(0, 5, 7), (0, 3, 8), (0, 5, 6), (0, 3, 8)]   # sus / Ab / tense cluster / Ab
for b in range(16, nbars, 4):
    if b > B_END - 1 or B_BREAK <= b < B_BACK: continue
    for j, ch in enumerate(CH_SEQ):
        d = BAR + 0.8
        sig = sum(bowed(hz(s, 4), d, voices=5, detune=0.009, vib=0.007, formant=OOH) for s in ch)
        e = env_adsr(len(sig), 1.2, 0.2, 0.9, 0.9)
        place(choir, sig * e, bar(b + j), 0.09 if b < 24 else 0.12, pan=(-0.25, 0.25)[j % 2])

# 5. Percussion: heartbeat in the intro and break; timpani booms and string stabs on sections.
for b in range(0, nbars):
    if b < B_IN + 1 or (B_BREAK <= b < B_BACK):
        place(perc, heartbeat(), bar(b), 0.55)
        place(perc, heartbeat(), bar(b) + 2 * BEAT, 0.45)
for b in [int(round(B_IN)), 16, 24, int(round(B_BACK)), 40, 48]:
    if b < nbars and b <= B_END:
        place(perc, boom(), bar(b), 0.55)
        stab = sum(bowed(hz(s, 3), 0.7, voices=4, bright=1.2) for s in (0, 3, 7, 12))
        stab *= np.exp(-tline(len(stab)) * 5) * np.minimum(1, tline(len(stab)) / 0.01)
        place(strings, stab, bar(b), 0.06)
# riser into the return from the break: rising noise swell + bowed glissando
rs = int(2 * BAR * SR); tr = tline(rs) / (2 * BAR)
riser = lowpass(highpass(rng.standard_normal(rs), 500), 6000) * tr ** 3 * 0.05
gl = np.sin(2 * np.pi * np.cumsum(hz(0, 3) * 2 ** (tr * 1.0)) / SR) * tr ** 2 * 0.05
place(perc, riser + gl, bar(B_BACK) - 2 * BAR)

# ---------- mix ----------
sake_bus = np.zeros((N, 2)); sake_bus[: len(sake)] = sake
t = tline(N)
# duck Sake under the break and let it creep in at the start
duck = np.ones(N)
duck *= np.clip((t - 2.0) / 9.0, 0.15, 1)
bi, be = int(bar(B_BREAK) * SR), int(bar(B_BACK) * SR)
duck[bi:be] *= 0.55
sake_bus *= duck[:, None] * 0.55

band = lambda x: np.sqrt((highpass(lowpass(x, 4000), 200) ** 2).mean())
print('mid-band rms  sake', band(sake_bus), ' pizz', band(pizz), ' low', band(low), ' high', band(high), ' choir', band(choir))
orch = reverb(pizz + strings + low + high + choir, 3.4, 0.4, 2600) + perc * 0.9
orch = reverb(orch, 1.2, 0.15, 5000)
sake_bus = reverb(sake_bus, 2.2, 0.22, 3000)
mix = sake_bus + orch
mix = highpass(mix, 28)
# fade the very end so the loop restarts cleanly
fade = np.ones(N); fo = int(5 * SR); fade[-fo:] = np.linspace(1, 0, fo) ** 1.5; mix *= fade[:, None]
mix = np.tanh(mix * 1.6) / np.tanh(1.6)
mix *= 0.95 / np.abs(mix).max()
print('rms', np.sqrt((mix ** 2).mean()))
mix.astype(np.float32).tofile('tethered.raw')
