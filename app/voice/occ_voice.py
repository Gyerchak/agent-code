#!/usr/bin/env python3
"""Agent Code voice worker — one persistent process per role, JSON lines on stdin/stdout.

    occ_voice.py kokoro    (run with a Python that has `kokoro`)            text -> wav
    occ_voice.py rvc       (run with Applio's Python, --applio <dir>)       wav -> wav in an RVC voice
    occ_voice.py whisper   (run with a Python that has `faster_whisper`)    wav -> text
    occ_voice.py utau      (any Python 3 with numpy; needs rubberband)      text -> UTAU-sung/spoken wav
    occ_voice.py probe     prints what this Python can do (JSON)

Request:  {"id": 1, ...}            Response: {"id": 1, "ok": true, ...} or {"id": 1, "ok": false, "error": "..."}
Everything the libraries print goes to stderr; stdout carries only responses.
"""
import json, os, sys, wave, re, random, subprocess, tempfile, shutil
from concurrent.futures import ThreadPoolExecutor

# Keep stdout clean for the protocol: libraries that print() end up on stderr.
OUT = os.fdopen(os.dup(1), "w", buffering=1)
os.dup2(2, 1)
sys.stdout = sys.stderr

def reply(obj):
    OUT.write(json.dumps(obj, ensure_ascii=False) + "\n")
    OUT.flush()

def serve(handler, ready=None):
    reply({"id": 0, "ok": True, "ready": True, **(ready or {})})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception as e:
            reply({"id": None, "ok": False, "error": f"bad json: {e}"})
            continue
        try:
            reply({"id": req.get("id"), "ok": True, **(handler(req) or {})})
        except Exception as e:
            reply({"id": req.get("id"), "ok": False, "error": f"{type(e).__name__}: {e}"})

def write_wav(path, samples, sr):
    import numpy as np
    data = np.clip(np.asarray(samples, dtype=np.float32), -1, 1)
    with wave.open(path, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
        w.writeframes((data * 32767).astype(np.int16).tobytes())

def read_wav(path):
    import numpy as np
    with wave.open(path, "rb") as w:
        sr, n, ch, width = w.getframerate(), w.getnframes(), w.getnchannels(), w.getsampwidth()
        raw = w.readframes(n)
    if width == 2:
        data = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768
    elif width == 4:
        data = np.frombuffer(raw, dtype=np.int32).astype(np.float32) / 2147483648
    else:
        data = (np.frombuffer(raw, dtype=np.uint8).astype(np.float32) - 128) / 128
    if ch > 1:
        data = data.reshape(-1, ch).mean(axis=1)
    return data, sr

# ---------------------------------------------------------------------------
# Kokoro TTS
# ---------------------------------------------------------------------------

def run_kokoro():
    import numpy as np
    from kokoro import KPipeline
    pipes = {}

    def pipe(lang):
        if lang not in pipes:
            pipes[lang] = KPipeline(lang_code=lang, repo_id="hexgrad/Kokoro-82M")
        return pipes[lang]

    def handle(req):
        text = req["text"].strip()
        voice = req.get("voice", "af_heart")
        lang = req.get("lang") or voice[0]
        chunks = [audio for _, _, audio in pipe(lang)(text, voice=voice, speed=float(req.get("speed", 1.0)))]
        audio = np.concatenate([np.asarray(c) for c in chunks]) if chunks else np.zeros(2400)
        write_wav(req["out"], audio, 24000)
        return {"out": req["out"], "seconds": round(len(audio) / 24000, 2)}

    pipe("a")  # warm up the default English pipeline
    serve(handle, {"engine": "kokoro"})

# ---------------------------------------------------------------------------
# RVC voice conversion through Applio (kept warm: the model stays loaded)
# ---------------------------------------------------------------------------

def run_rvc(applio):
    os.chdir(applio)
    sys.path.insert(0, applio)
    from rvc.infer.infer import VoiceConverter
    vc = VoiceConverter()

    def handle(req):
        vc.convert_audio(
            audio_input_path=req["in"],
            audio_output_path=req["out"],
            model_path=req["model"],
            index_path=req.get("index") or "",
            pitch=int(req.get("pitch", 0)),
            f0_method=req.get("f0", "rmvpe"),
            index_rate=float(req.get("indexRate", 0.5)),
            protect=float(req.get("protect", 0.33)),
            export_format="WAV",
        )
        return {"out": req["out"]}

    serve(handle, {"engine": "rvc"})

# ---------------------------------------------------------------------------
# faster-whisper speech recognition
# ---------------------------------------------------------------------------

def run_whisper(model_name, device):
    from faster_whisper import WhisperModel
    try:
        model = WhisperModel(model_name, device=device, compute_type="float16" if device == "cuda" else "int8")
    except Exception:
        device = "cpu"
        model = WhisperModel(model_name, device="cpu", compute_type="int8")

    state = {"model": model, "device": device}

    def transcribe(req):
        kw = {"vad_filter": True, "beam_size": 1}
        if req.get("language"):
            kw["language"] = req["language"]
        segments, info = state["model"].transcribe(req["audio"], **kw)
        text = " ".join(s.text.strip() for s in segments).strip()
        return {"text": text, "language": info.language, "device": state["device"]}

    def handle(req):
        try:
            return transcribe(req)
        except RuntimeError as e:
            # GPU runtime libraries missing (e.g. libcublas): switch to CPU once and retry
            if state["device"] == "cpu" or not re.search(r"cublas|cudnn|cuda", str(e), re.I):
                raise
            state["model"] = WhisperModel(model_name, device="cpu", compute_type="int8")
            state["device"] = "cpu"
            return transcribe(req)

    serve(handle, {"engine": "whisper", "model": model_name, "device": device})

# ---------------------------------------------------------------------------
# UTAU renderer (OpenUtau voicebanks): text -> kana syllables -> styled prosody
# ---------------------------------------------------------------------------

VOWELS = "aeiou"
# romaji syllable -> hiragana (CV voicebanks use plain hiragana aliases)
KANA = {
    "a": "あ", "i": "い", "u": "う", "e": "え", "o": "お",
    "ka": "か", "ki": "き", "ku": "く", "ke": "け", "ko": "こ",
    "ga": "が", "gi": "ぎ", "gu": "ぐ", "ge": "げ", "go": "ご",
    "sa": "さ", "si": "すぃ", "su": "す", "se": "せ", "so": "そ",
    "za": "ざ", "zi": "ずぃ", "zu": "ず", "ze": "ぜ", "zo": "ぞ",
    "ta": "た", "ti": "てぃ", "tu": "とぅ", "te": "て", "to": "と",
    "da": "だ", "di": "でぃ", "du": "どぅ", "de": "で", "do": "ど",
    "na": "な", "ni": "に", "nu": "ぬ", "ne": "ね", "no": "の",
    "ha": "は", "hi": "ひ", "hu": "ふ", "he": "へ", "ho": "ほ",
    "ba": "ば", "bi": "び", "bu": "ぶ", "be": "べ", "bo": "ぼ",
    "pa": "ぱ", "pi": "ぴ", "pu": "ぷ", "pe": "ぺ", "po": "ぽ",
    "ma": "ま", "mi": "み", "mu": "む", "me": "め", "mo": "も",
    "ya": "や", "yi": "い", "yu": "ゆ", "ye": "いぇ", "yo": "よ",
    "ra": "ら", "ri": "り", "ru": "る", "re": "れ", "ro": "ろ",
    "wa": "わ", "wi": "うぃ", "wu": "う", "we": "うぇ", "wo": "うぉ",
    "fa": "ふぁ", "fi": "ふぃ", "fu": "ふ", "fe": "ふぇ", "fo": "ふぉ",
    "va": "ゔぁ", "vi": "ゔぃ", "vu": "ゔ", "ve": "ゔぇ", "vo": "ゔぉ",
    "sha": "しゃ", "shi": "し", "shu": "しゅ", "she": "しぇ", "sho": "しょ",
    "cha": "ちゃ", "chi": "ち", "chu": "ちゅ", "che": "ちぇ", "cho": "ちょ",
    "ja": "じゃ", "ji": "じ", "ju": "じゅ", "je": "じぇ", "jo": "じょ",
    "tsa": "つぁ", "tsi": "つぃ", "tsu": "つ", "tse": "つぇ", "tso": "つぉ",
    "kya": "きゃ", "kyu": "きゅ", "kyo": "きょ", "nya": "にゃ", "nyu": "にゅ", "nyo": "にょ",
    "rya": "りゃ", "ryu": "りゅ", "ryo": "りょ", "mya": "みゃ", "myu": "みゅ", "myo": "みょ",
    "n": "ん",
}
# epenthetic vowel after a lone consonant (Japanese-style loanword reading)
LONE = {"t": "o", "d": "o", "ch": "i", "j": "i", "sh": "u"}

def romanize(text, lang):
    t = text.lower()
    if lang == "pl":
        t = t.replace("j", "Y")  # Polish j = English y; protect it from the digraph rules below
        for a, b in [("ch", "h"), ("sz", "sh"), ("cz", "C"), ("dż", "J"), ("rz", "J"), ("ż", "J"), ("ź", "J"),
                     ("dz", "z"), ("ś", "sh"), ("ć", "C"), ("ń", "n"), ("ł", "w"), ("w", "v"), ("ó", "u"),
                     ("ą", "on"), ("ę", "en"), ("c", "ts"), ("y", "i")]:
            t = t.replace(a, b)
        t = t.replace("Y", "y").replace("J", "j").replace("C", "ch")
    else:
        for a, b in [("tion", "shon"), ("igh", "ai"), ("th", "s"), ("ph", "f"), ("ck", "k"), ("qu", "kw"),
                     ("ee", "i"), ("oo", "u"), ("ou", "au"), ("ea", "i"), ("wh", "w"), ("y", "i")]:
            t = t.replace(a, b)
        t = re.sub(r"c(?![h])(?=[eiy])", "s", t)
    t = t.replace("ch", "C")  # keep "ch" through the c -> k rule
    t = t.replace("l", "r").replace("q", "k").replace("x", "ks").replace("c", "k")
    return t.replace("C", "ch")

def syllables(word):
    """Split a romanized word into kana-able syllables."""
    out, i = [], 0
    multi = ["tsa", "tsi", "tsu", "tse", "tso", "sh", "ch", "ts", "ky", "ny", "ry", "my"]
    while i < len(word):
        ch = word[i]
        if ch in VOWELS:
            out.append(ch); i += 1; continue
        if not ch.isalpha():
            i += 1; continue
        cons = next((m for m in ["sh", "ch", "ts", "ky", "ny", "ry", "my"] if word.startswith(m, i)), ch)
        j = i + len(cons)
        if j < len(word) and word[j] in VOWELS:
            syl = cons + word[j]
            out.append(syl if syl in KANA else (cons[0] + word[j] if cons[0] + word[j] in KANA else word[j])); i = j + 1
        elif cons == "n" and (j >= len(word) or word[j] not in VOWELS + "y"):
            out.append("n"); i = j
        else:
            v = LONE.get(cons, "u")
            syl = cons + v
            out.append(syl if syl in KANA else (cons[0] + "u" if cons[0] + "u" in KANA else "u")); i = j
    return out

def to_phrases(text, lang):
    """[(syllables, ending)] where ending is '.', '?', '!' or ','."""
    phrases = []
    for part in re.findall(r"[^.?!,;:]+[.?!,;:]?", text):
        end = part[-1] if part[-1] in ".?!,;:" else "."
        words = re.findall(r"[^\W\d_]+", romanize(part, lang))
        syl = [s for w in words for s in syllables(w)]
        if syl:
            phrases.append((syl, "," if end in ",;:" else end))
    return phrases

def load_bank(singer_dir):
    """alias -> (wav path, offset, consonant, cutoff) across every sub-bank's oto.ini."""
    bank = {}
    for root, _, files in os.walk(singer_dir):
        if "oto.ini" not in files:
            continue
        raw = open(os.path.join(root, "oto.ini"), "rb").read()
        try:
            text = raw.decode("cp932")
        except UnicodeDecodeError:
            text = raw.decode("utf-8", errors="replace")
        for line in text.splitlines():
            if "=" not in line:
                continue
            f, rest = line.split("=", 1)
            p = rest.split(",")
            if len(p) < 6 or not p[0]:
                continue
            alias = p[0].strip()
            for prefix in ("- ", "* "):
                if alias.startswith(prefix):
                    alias = alias[len(prefix):]
            try:
                bank.setdefault(alias, (os.path.join(root, f), float(p[1] or 0), float(p[2] or 0), float(p[3] or 0)))
            except ValueError:
                pass
    return bank

def run_utau(styles_file):
    import numpy as np
    styles = json.load(open(styles_file, encoding="utf-8"))
    banks = {}
    SR = 44100

    def sample(bank, kana, suffix):
        for alias in (kana + suffix, kana, kana[:1] + suffix, kana[:1]):
            if alias in bank:
                return bank[alias]
        return None

    def cut(entry):
        path, off, cons, cutoff = entry
        data, sr = read_wav(path)
        dur = len(data) / sr * 1000
        a = int(off * sr / 1000)
        b = int((dur - cutoff) * sr / 1000) if cutoff >= 0 else int((off - cutoff) * sr / 1000)
        seg = data[a:max(a + 1, min(len(data), b))]
        if sr != SR:
            idx = np.arange(0, len(seg), sr / SR)
            seg = np.interp(idx, np.arange(len(seg)), seg)
        return seg.astype(np.float32)

    def handle(req):
        singer = req["singer"]
        if singer not in banks:
            banks[singer] = load_bank(singer)
        bank = banks[singer]
        if not bank:
            raise RuntimeError(f"no oto.ini found under {singer}")
        style = styles.get(req.get("style", "talking")) or styles["talking"]
        r = random.Random(req.get("seed", 7))
        base = float(req.get("base", 63)) + style.get("pitch", 0)
        span = style.get("range", 2)
        note = style.get("note", 0.16) / max(0.25, style.get("tempo", 1.0))
        tmp = tempfile.mkdtemp(prefix="occ-utau-")
        jobs = []  # (index, sample, semitones, seconds) or (index, None, 0, pause seconds)
        k = 0
        melody = style.get("melody") or [0]
        for phrase, end in to_phrases(req["text"], req.get("lang", "en")):
            n = len(phrase)
            for i, syl in enumerate(phrase):
                entry = sample(bank, KANA.get(syl, syl), style.get("suffix", ""))
                if not entry:
                    continue
                pos = i / max(1, n - 1)
                contour = style.get("contour", "declining")
                if contour == "declining":
                    semis = span * (1 - pos) - span / 2
                elif contour == "rising":
                    semis = span * pos - span / 2
                elif contour == "arch":
                    semis = span * (1 - abs(pos - 0.4) * 2) - span / 2
                elif contour == "melody":
                    semis = melody[k % len(melody)]
                else:  # flat
                    semis = 0
                semis += r.uniform(-1, 1) * style.get("jitter", 0.3)
                if end == "?" and i >= n - 2:
                    semis += 3
                if end == "!" and i == 0:
                    semis += 2
                length = note * (style.get("final", 1.8) if i == n - 1 else 1.0)
                if style.get("accent") and k % style["accent"] == 0:
                    semis += style.get("accentPitch", 1)
                jobs.append((len(jobs), entry, base + semis, length))
                k += 1
            pause = {".": 0.32, "?": 0.36, "!": 0.3, ",": 0.16}[end] * style.get("pauses", 1.0)
            jobs.append((len(jobs), None, 0, pause))

        def render(job):
            idx, entry, midi, seconds = job
            if entry is None:
                return idx, np.zeros(int(seconds * SR), dtype=np.float32)
            seg = cut(entry)
            src = os.path.join(tmp, f"s{idx}.wav"); dst = os.path.join(tmp, f"d{idx}.wav")
            write_wav(src, seg, SR)
            # bank pitch ~ base 63 (D#4); shift to target and fit the duration
            shift = midi - float(req.get("bankPitch", 63))
            subprocess.run(["rubberband", "-q", "-F", "-p", f"{shift:.2f}", "-D", f"{max(0.05, seconds):.3f}", src, dst],
                           check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            data, _ = read_wav(dst)
            fade = min(len(data) // 4, int(0.012 * SR))
            if fade:
                data[:fade] *= np.linspace(0, 1, fade); data[-fade:] *= np.linspace(1, 0, fade)
            return idx, data * style.get("gain", 1.0)

        with ThreadPoolExecutor(max_workers=os.cpu_count() or 4) as pool:
            parts = dict(pool.map(render, jobs))
        overlap = int(style.get("legato", 0.02) * SR)
        out = np.zeros(0, dtype=np.float32)
        for i in range(len(jobs)):
            seg = parts[i]
            if overlap and len(out) > overlap and len(seg) > overlap and jobs[i][1] is not None:
                out[-overlap:] += seg[:overlap]
                out = np.concatenate([out, seg[overlap:]])
            else:
                out = np.concatenate([out, seg])
        peak = float(np.abs(out).max() or 1)
        write_wav(req["out"], out / peak * 0.9, SR)
        shutil.rmtree(tmp, ignore_errors=True)
        return {"out": req["out"], "seconds": round(len(out) / SR, 2)}

    serve(handle, {"engine": "utau", "styles": sorted(styles)})

# ---------------------------------------------------------------------------

def probe():
    caps = {"python": sys.executable, "version": sys.version.split()[0]}
    for mod in ("kokoro", "faster_whisper", "torch", "numpy"):
        try:
            __import__(mod)
            caps[mod] = True
        except Exception:
            caps[mod] = False
    try:
        import torch
        caps["cuda"] = bool(torch.cuda.is_available())
    except Exception:
        caps["cuda"] = False
    reply(caps)

if __name__ == "__main__":
    role = sys.argv[1] if len(sys.argv) > 1 else "probe"
    args = sys.argv[2:]
    opt = lambda name, default=None: args[args.index(name) + 1] if name in args else default
    if role == "kokoro":
        run_kokoro()
    elif role == "rvc":
        run_rvc(opt("--applio", os.path.expanduser("~/Applio")))
    elif role == "whisper":
        run_whisper(opt("--model", "small"), opt("--device", "cuda"))
    elif role == "utau":
        run_utau(opt("--styles", os.path.join(os.path.dirname(os.path.abspath(__file__)), "styles.json")))
    else:
        probe()
