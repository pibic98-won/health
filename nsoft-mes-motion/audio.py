"""Soundtrack for the NSOFT N-MES spot, synthesised from scratch (numpy only).

128 BPM, A minor, 32 beats = 15.000 s. Every hit lines up with a visual event
in motion.js (word slams, N-MES bang, 4M panel slams, scan beep, final impact).
Writes audio.wav (48 kHz, 16-bit stereo).
"""
import wave
import numpy as np

SR = 48000
BPM = 128
BEAT = 60 / BPM
DUR = 15.0
N = int(DUR * SR)
rs = np.random.default_rng(128)

L = np.zeros(N + SR * 3)
R = np.zeros(N + SR * 3)
RVB_L = np.zeros_like(L)  # reverb send
RVB_R = np.zeros_like(R)
SC_TIMES = []             # sidechain triggers (seconds)


def b2s(b):
    return b * BEAT


def tt(dur):
    return np.arange(int(dur * SR)) / SR


def place(sig, beat, gain=1.0, pan=0.0, send=0.0, t=None):
    """Mix a mono (or (2,n) stereo) signal at a beat position."""
    start = int(round((b2s(beat) if t is None else t) * SR))
    if sig.ndim == 1:
        sl, sr_ = sig * np.sqrt(0.5 * (1 - pan)) * 1.414, sig * np.sqrt(0.5 * (1 + pan)) * 1.414
    else:
        sl, sr_ = sig[0], sig[1]
    n = min(len(sl), len(L) - start)
    if n <= 0:
        return
    L[start:start + n] += sl[:n] * gain
    R[start:start + n] += sr_[:n] * gain
    if send:
        RVB_L[start:start + n] += sl[:n] * gain * send
        RVB_R[start:start + n] += sr_[:n] * gain * send


def fft_filter(x, lo=None, hi=None, order=4):
    X = np.fft.rfft(x)
    f = np.fft.rfftfreq(len(x), 1 / SR) + 1e-9
    m = np.ones_like(f)
    if hi:
        m *= 1 / np.sqrt(1 + (f / hi) ** (2 * order))
    if lo:
        m *= 1 / np.sqrt(1 + (lo / f) ** (2 * order))
    return np.fft.irfft(X * m, len(x))


def sweep_filter(x, fc_fn, mode='lp', q=1.0):
    """Time-varying filter via STFT overlap-add. fc_fn(t_seconds) -> cutoff/centre Hz."""
    win, hop = 2048, 256
    w = np.hanning(win)
    pad = np.concatenate([np.zeros(win), x, np.zeros(win)])
    out = np.zeros_like(pad)
    norm = np.zeros_like(pad)
    f = np.fft.rfftfreq(win, 1 / SR) + 1e-9
    for s in range(0, len(pad) - win, hop):
        fc = max(20.0, fc_fn((s + win / 2 - win) / SR))
        if mode == 'lp':
            m = 1 / np.sqrt(1 + (f / fc) ** 8)
        elif mode == 'hp':
            m = 1 / np.sqrt(1 + (fc / f) ** 8)
        else:
            m = np.exp(-0.5 * (np.log2(f / fc) / (0.35 * q)) ** 2)
        seg = np.fft.irfft(np.fft.rfft(pad[s:s + win] * w) * m, win)
        out[s:s + win] += seg * w
        norm[s:s + win] += w * w
    out /= np.maximum(norm, 1e-6)
    return out[win:win + len(x)]


def saw(freq, dur, cutoff=3000, detune=0.0, cut_env=None, voices=1):
    """Additive band-limited saw with per-harmonic lowpass; cut_env(t) scales the cutoff."""
    t = tt(dur)
    out = np.zeros_like(t)
    for v in range(voices):
        d = (v - (voices - 1) / 2) * detune
        fv = freq * (2 ** (d / 1200))
        ph0 = rs.random() * 2 * np.pi
        fc = cutoff * (cut_env(t) if cut_env else 1.0)
        k = 1
        while k * fv < min(16000, SR / 2 - 500) and k <= 60:
            a = (1 / k) / np.sqrt(1 + (k * fv / fc) ** 4)
            out += a * np.sin(2 * np.pi * k * fv * t + ph0 * k)
            k += 1
    return out / voices


def adsr(n_or_t, a=0.005, d=0.1, s=0.7, r=0.2, hold=None):
    t = n_or_t if isinstance(n_or_t, np.ndarray) else tt(n_or_t)
    dur = t[-1] if len(t) else 0
    hold = dur - r if hold is None else hold
    env = np.where(t < a, t / a, s + (1 - s) * np.exp(-(t - a) / max(d, 1e-4)))
    rel = np.clip((t - hold) / r, 0, 1)
    return env * (1 - rel)


# ------------------------------------------------------------------ voices
def kick(punch=1.0, dur=0.5):
    t = tt(dur)
    f = 44 + 150 * np.exp(-t * 38)
    ph = 2 * np.pi * np.cumsum(f) / SR
    body = np.sin(ph) * np.exp(-t * 6.0)
    click = fft_filter(rs.standard_normal(len(t)), 1500, 9000) * np.exp(-t * 350) * 0.35
    return np.tanh(1.8 * punch * body) * 0.9 + click


def clap():
    t = tt(0.35)
    n = fft_filter(rs.standard_normal(len(t)), 900, 5200)
    env = np.zeros_like(t)
    for off in (0, 0.011, 0.022):
        env += np.where(t >= off, np.exp(-(t - off) * (180 if off < 0.02 else 18)), 0)
    body = np.sin(2 * np.pi * 185 * t) * np.exp(-t * 30) * 0.4
    return (n * env * 0.8 + body) * 0.9


def snare(dur=0.18):
    t = tt(dur)
    n = fft_filter(rs.standard_normal(len(t)), 1200, 9000) * np.exp(-t * 28)
    return n * 0.7 + np.sin(2 * np.pi * 200 * t) * np.exp(-t * 40) * 0.35


def hat(open_=False):
    t = tt(0.25 if open_ else 0.06)
    n = fft_filter(rs.standard_normal(len(t)), 7000, None)
    return n * np.exp(-t * (14 if open_ else 70)) * 0.5


def clank():
    """Metallic slam for the 4M panels."""
    t = tt(0.6)
    out = np.zeros_like(t)
    for f, a, d in ((310, .5, 9), (863, .35, 12), (1720, .25, 16), (2911, .18, 22), (4410, .12, 30)):
        out += a * np.sin(2 * np.pi * f * t) * np.exp(-t * d)
    out += fft_filter(rs.standard_normal(len(t)), 2000, 8000) * np.exp(-t * 60) * 0.5
    return out


def boom(dur=2.4, f0=62, f1=30):
    t = tt(dur)
    f = f1 + (f0 - f1) * np.exp(-t * 2.5)
    ph = 2 * np.pi * np.cumsum(f) / SR
    sub = np.tanh(2.2 * np.sin(ph) * np.exp(-t * 1.6))
    crack = fft_filter(rs.standard_normal(len(t)), 200, 6000) * np.exp(-t * 9) * 0.7
    return sub + crack


def crash(dur=2.5):
    t = tt(dur)
    n = fft_filter(rs.standard_normal(len(t)), 4000, 15000)
    return n * np.exp(-t * 1.8) * 0.45


def riser(dur, f_lo=300, f_hi=9000, curve=2.5):
    t = tt(dur)
    n = rs.standard_normal(len(t))
    y = sweep_filter(n, lambda s: f_lo * (f_hi / f_lo) ** ((max(0, s) / dur) ** curve), 'bp', q=1.3)
    return y * (t / dur) ** 1.6


def whoosh(dur=0.5, up=True):
    t = tt(dur)
    n = rs.standard_normal(len(t))
    lo, hi = (500, 7000) if up else (7000, 400)
    y = sweep_filter(n, lambda s: lo * (hi / lo) ** (np.clip(s / dur, 0, 1)), 'bp', q=1.6)
    return y * np.sin(np.pi * np.clip(t / dur, 0, 1)) ** 1.5


def blip(f, dur=0.09, wave_='sine'):
    t = tt(dur)
    s = np.sin(2 * np.pi * f * t) if wave_ == 'sine' else np.sign(np.sin(2 * np.pi * f * t)) * 0.4
    return s * np.exp(-t * 35) * np.minimum(1, t / 0.002)


def bell(f, dur=2.5):
    t = tt(dur)
    mod = np.sin(2 * np.pi * f * 3.5 * t) * 2.2 * np.exp(-t * 3)
    return np.sin(2 * np.pi * f * t + mod) * np.exp(-t * 2.2) * np.minimum(1, t / 0.003)


def chord_stab(freqs, dur=0.5, cutoff=4200, decay=5.0):
    t = tt(dur)
    s = sum(saw(f, dur, cutoff, detune=14, voices=3, cut_env=lambda tt_: np.exp(-tt_ * 6) * 0.85 + 0.15) for f in freqs)
    return s * np.exp(-t * decay) * np.minimum(1, t / 0.003) / len(freqs) ** 0.5


def pad(freqs, dur, cutoff=1400, a=0.3, r=0.6):
    s = sum(saw(f, dur, cutoff, detune=18, voices=3) for f in freqs)
    return s * adsr(tt(dur), a=a, d=0.5, s=0.9, r=r) / len(freqs) ** 0.5


# ------------------------------------------------------------------ harmony
HZ = lambda m: 440 * 2 ** ((m - 69) / 12)  # midi -> Hz
CH = {  # (bass midi, pad midis)
    'Am': (33, [57, 60, 64, 71]),
    'F': (29, [53, 57, 60, 64]),
    'C': (36, [55, 60, 64, 71]),
    'G': (31, [55, 59, 62, 67]),
    'E': (28, [52, 56, 59, 62]),
}
BARS = ['Am', 'F', 'C', 'G', 'Am', 'F', 'E', 'Am']

# ------------------------------------------------------------------ arrangement
# bar 0: three slams + digitise + flight
for b in (0, 1, 2):
    place(kick(1.3), b, 1.0); SC_TIMES.append(b2s(b))
    place(chord_stab([HZ(m) for m in (45, 57, 60, 64, 69)], 0.9, 5200, 4.0), b, 0.55, send=0.5)
    place(boom(0.9, 70, 40), b, 0.35)
place(crash(1.5), 2, 0.25, send=0.3)
# digitising arpeggio (scan sweep, beats 2-3)
arp = [69, 72, 76, 81, 84, 88, 93, 96]
for i in range(16):
    place(blip(HZ(arp[i % 8]), 0.07), 2 + i / 16, 0.16, pan=np.sin(i) * .6, send=.3)
place(riser(b2s(1.1), 400, 8000, 1.5), 2.9, 0.35, send=0.2)       # particles flying
place(whoosh(b2s(1.0), True), 3.0, 0.3, send=0.3)

# bars 1-6 groove
for b in range(4, 28):
    place(kick(1.0), b, 0.95); SC_TIMES.append(b2s(b))
    bar = b // 4
    if b % 2 == 1 and bar != 6:
        place(clap(), b, 0.42, send=0.25)
    # offbeat hats, 16ths from bar 2
    place(hat(), b + 0.5, 0.35, pan=0.25)
    if bar >= 2 and bar != 3:
        for s in (0.25, 0.75):
            place(hat(), b + s, 0.14, pan=-0.3)
    if b % 4 == 3:
        place(hat(True), b + 0.5, 0.15, pan=0.3)
# bass: offbeat 8ths, pumping
for b in range(4, 28):
    bar = b // 4
    root = CH[BARS[bar]][0]
    for s in (0.5,):
        note = saw(HZ(root + 12), b2s(0.42), 900, detune=8, voices=2, cut_env=lambda t: np.exp(-t * 9) * 0.8 + 0.2)
        note = note * adsr(tt(b2s(0.42)), 0.003, 0.08, 0.6, 0.05)
        sub = np.sin(2 * np.pi * HZ(root) * tt(b2s(0.42))) * adsr(tt(b2s(0.42)), 0.003, 0.2, 0.8, 0.05)
        place(note * 0.55 + sub * 0.5, b + s, 0.55)
# pads (sidechained later)
PAD_L = np.zeros_like(L); PAD_R = np.zeros_like(R)
for bar in range(1, 7):
    ch = CH[BARS[bar]][1]
    p = pad([HZ(m) for m in ch], b2s(4.05), 1100 if bar < 6 else 2200, a=0.08, r=0.2)
    st = int(b2s(bar * 4) * SR)
    PAD_L[st:st + len(p)] += p * 0.30
    PAD_R[st + 480:st + 480 + len(p)] += p * 0.30

# callout blips (bar 1)
for b, f in ((4.5, 88), (5.0, 91), (5.5, 86), (6.0, 93)):
    place(blip(HZ(f), 0.08), b, 0.2, pan=.4, send=.4)
    place(blip(HZ(f + 7), 0.08), b + 0.06, 0.14, pan=-.4, send=.4)
# into the bang: reverse swell
rev = (crash(1.6)[::-1] + riser(1.6, 200, 6000, 1.2)) * np.linspace(0, 1, int(1.6 * SR)) ** 2
place(rev, 0, 0.45, t=b2s(8) - 1.6)
# bar 2: N-MES impact
place(boom(2.4, 66, 30), 8, 0.9)
place(crash(2.5), 8, 0.4, send=0.4)
place(chord_stab([HZ(m) for m in (48, 60, 64, 67, 71, 76)], 1.6, 3800, 1.8), 8, 0.5, send=0.6)
# typewriter ticks (MANUFACTURING EXECUTION SYSTEM)
for i in range(30):
    place(fft_filter(rs.standard_normal(600), 2500, 9000) * np.exp(-np.arange(600) / 60), 9 + i / 30, 0.16, pan=-.5 + i / 30)
for eb in (10, 10.5, 11):
    place(blip(HZ(84), 0.2), eb, 0.1, send=.6)
place(riser(b2s(0.85), 300, 12000, 2.0), 11.15, 0.5, send=0.2)    # zoom-through
place(whoosh(b2s(0.8), True), 11.2, 0.35)
# bar 3: 4M panel slams
for b in (12, 13, 14, 15):
    place(clank(), b, 0.28, pan=(-.45, -.15, .15, .45)[b - 12], send=0.35)
    place(blip(HZ(76 + (b - 12) * 3), 0.12, 'sq'), b + 0.12, 0.06, send=.3)
place(whoosh(b2s(0.7), False), 15.6, 0.4)                           # blinds
# bar 4: monitoring — data arpeggio + card pops
pent = [81, 84, 86, 88, 91, 93, 96, 98]
for i in range(64):
    b = 16 + i / 16
    if b >= 19.5:
        break
    place(blip(HZ(pent[(i * 5 + i // 4) % 8]), 0.06), b, 0.07 + 0.03 * (i % 4 == 0), pan=np.sin(i * 1.3) * .7, send=.25)
for b in (16.25, 16.5, 16.75, 17.0):
    place(blip(HZ(100), 0.05), b, 0.12, send=.3)
place(whoosh(b2s(0.6), True), 19.5, 0.55)                           # whip pan
# bar 5: barcode scan + trace
tl = tt(b2s(0.75))
laser = np.sin(2 * np.pi * (1500 + 60 * np.sin(2 * np.pi * 18 * tl)) * tl) * 0.5 + 0.15 * np.sign(np.sin(2 * np.pi * 750 * tl))
place(laser * np.minimum(1, tl / 0.02) * np.minimum(1, (tl[-1] - tl) / 0.03), 20.25, 0.12, send=.2)
place(blip(2093, 0.09), 21.0, 0.25, send=.3)
place(blip(2637, 0.14), 21.12, 0.25, send=.3)
tf = tt(b2s(0.6))
place(np.sin(2 * np.pi * np.cumsum(400 * 4 ** (tf / tf[-1])) / SR) * np.sin(np.pi * tf / tf[-1]), 22.55, 0.12, pan=-.3, send=.4)
tb = tt(b2s(0.5))
place(np.sin(2 * np.pi * np.cumsum(1600 * 0.25 ** (tb / tb[-1])) / SR) * np.sin(np.pi * tb / tb[-1]), 23.15, 0.12, pan=.3, send=.4)
place(whoosh(b2s(0.45), True), 23.6, 0.5)                           # slab wipe
# bar 6: build — word hits, snare roll, riser
for b in (24, 25, 26, 27):
    place(chord_stab([HZ(m) for m in (40, 52, 56, 59, 64)], 0.5, 3000 + (b - 24) * 1200, 6), b, 0.42, send=0.35)
roll = [24 + i / 2 for i in range(4)] + [26 + i / 4 for i in range(4)] + [27 + i / 8 for i in range(4)]
for i, b in enumerate(roll):
    place(snare(), b, 0.18 + 0.25 * i / len(roll), pan=.1, send=.3)
for b in (27.5, 27.625, 27.75, 27.875):
    place(kick(1.1, 0.12), b, 0.7); SC_TIMES.append(b2s(b))
    place(chord_stab([HZ(m) for m in (52, 56, 59, 64)], 0.12, 5000, 20), b, 0.4)
place(riser(b2s(4.0), 250, 12000, 2.2), 24, 0.55, send=0.2)
tr = tt(b2s(4.0))
place(np.sin(2 * np.pi * np.cumsum(110 * 8 ** ((tr / tr[-1]) ** 2)) / SR) * (tr / tr[-1]) ** 2 * 0.3, 24, 0.5)
# bar 7: final impact + resolve
place(kick(1.5, 0.7), 28, 1.0); SC_TIMES.append(b2s(28))
place(boom(3.2, 60, 27), 28, 1.0)
place(crash(3.5), 28, 0.5, send=0.5)
final = pad([HZ(m) for m in (45, 52, 57, 60, 64, 71, 76)], 7 * BEAT, 2600, a=0.005, r=1.2)
final *= np.exp(-tt(7 * BEAT) * 0.9)
place(final, 28, 0.42, send=0.6)
place(chord_stab([HZ(m) for m in (57, 64, 69, 72, 76)], 1.5, 6000, 2.5), 28, 0.35, send=0.7)
for f, d, g in ((HZ(88), 0.0, .22), (HZ(93), 0.12, .18), (HZ(100), 0.24, .12)):   # NSOFT sting
    place(bell(f, 2.5), 29 + d, g, pan=(d - .12) * 3, send=.7)
for i in range(10):                                                   # sweep shimmer
    place(blip(HZ(96 + [0, 3, 5, 7, 10][i % 5] + 12 * (i // 5)), 0.3), 30.9 + i * 0.06, 0.05, pan=-.6 + i * .12, send=.8)

# ------------------------------------------------------------------ sidechain + mix
t_all = np.arange(len(L)) / SR
sc = np.ones_like(t_all)
for s in SC_TIMES:
    i0 = int(s * SR); n = int(0.35 * SR)
    seg = 1 - 0.75 * np.exp(-np.arange(n) / SR / 0.085)
    sc[i0:i0 + n] = np.minimum(sc[i0:i0 + n], seg[:len(sc[i0:i0 + n])])
L += PAD_L * sc; R += PAD_R * sc
RVB_L += PAD_L * sc * 0.3; RVB_R += PAD_R * sc * 0.3

# reverb (stereo decorrelated noise IR)
ir_t = tt(2.2)
def ir():
    n = rs.standard_normal(len(ir_t)) * np.exp(-ir_t / 0.55)
    return fft_filter(n, 200, 7000) * 0.06
def conv(x, h):
    n = len(x) + len(h)
    return np.fft.irfft(np.fft.rfft(x, n) * np.fft.rfft(h, n), n)[:len(x)]
L += conv(RVB_L, ir()); R += conv(RVB_R, ir())

mix = np.stack([L[:N], R[:N]])
mix = fft_filter(mix[0], 25, None, 2), fft_filter(mix[1], 25, None, 2)
mix = np.stack(mix)
# glue: gentle saturation, then normalise
mix = np.tanh(mix / np.max(np.abs(mix)) * 1.8) / np.tanh(1.8)
fade = np.ones(N); fn = int(0.35 * SR); fade[-fn:] = np.linspace(1, 0, fn) ** 1.5
mix *= fade * 0.93

pcm = (np.clip(mix, -1, 1) * 32767).astype('<i2').T.copy()
with wave.open('audio.wav', 'wb') as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
    w.writeframes(pcm.tobytes())
print('audio.wav', mix.shape, 'peak', float(np.max(np.abs(mix))), 'rms dB', 20 * np.log10(np.sqrt(np.mean(mix ** 2))))
