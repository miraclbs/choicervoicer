"""Videonun sesini konuşma ve arka plan (müzik, efekt, ortam sesi) olarak ayırır.

Meta'nın ücretsiz Demucs modelini (htdemucs) kullanır. server.py bunu arka planda
çağırır; tek başına denemek için:

    python ses_ayirma.py video.mp4 cikti_klasoru

Kurulum:  python -m pip install demucs
"""
import importlib.util
import os
import subprocess

os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
_model = None


def available():
    return all(importlib.util.find_spec(m) for m in ("demucs", "torch", "numpy"))


def _load_model():
    global _model
    if _model is None:
        from demucs.pretrained import get_model
        _model = get_model("htdemucs")  # ilk seferde ~80 MB indirilir
        _model.eval()
    return _model


def _ffmpeg(args, data=None):
    p = subprocess.run(["ffmpeg", "-y", "-v", "error", *args], input=data, capture_output=True)
    if p.returncode != 0:
        raise RuntimeError(p.stderr.decode("utf-8", "replace").strip()[-500:] or "ffmpeg hatası")
    return p.stdout


def separate(video, bg_path, speech_path, progress=None):
    """bg_path: arka plan (stereo WAV), speech_path: sadece konuşma (mono 16 kHz WAV, analiz için).

    progress(oran, aşama) çağrılır; aşama: "model" | "ayir" | "kaydet".
    """
    import numpy as np
    import torch
    from demucs.apply import apply_model

    progress = progress or (lambda p, phase: None)
    progress(0.0, "model")
    model = _load_model()
    sr = model.samplerate
    raw = _ffmpeg(["-i", video, "-vn", "-ac", "2", "-ar", str(sr), "-f", "f32le", "-"])
    wav = torch.from_numpy(np.frombuffer(raw, dtype=np.float32).reshape(-1, 2).T.copy())
    length = wav.shape[-1]
    if length == 0:
        raise RuntimeError("Videoda ses yok")

    ref = wav.mean(0)
    mean, std = ref.mean(), ref.std()
    if std < 1e-5:  # tamamen sessiz video
        sources = torch.zeros(len(model.sources), 2, length)
    else:
        seg_len = int(sr * float(getattr(model, "segment", 8)))

        def on_chunk(d):
            if d.get("state") == "end":
                frac = min(1.0, (d["segment_offset"] + seg_len) / length)
                progress((d["model_idx_in_bag"] + frac) / max(1, d["models"]), "ayir")

        progress(0.0, "ayir")
        with torch.no_grad():
            sources = apply_model(model, ((wav - mean) / std)[None], shifts=1, split=True,
                                  overlap=0.25, device="cpu", callback=on_chunk)[0]
        sources = sources * std + mean

    progress(1.0, "kaydet")
    vi = model.sources.index("vocals")
    speech = sources[vi]
    bg = sum(sources[i] for i in range(len(model.sources)) if i != vi)
    _ffmpeg(["-f", "f32le", "-ar", str(sr), "-ac", "2", "-i", "-", "-c:a", "pcm_s16le", bg_path],
            bg.T.contiguous().numpy().tobytes())
    _ffmpeg(["-f", "f32le", "-ar", str(sr), "-ac", "2", "-i", "-", "-ac", "1", "-ar", "16000",
             "-c:a", "pcm_s16le", speech_path],
            speech.T.contiguous().numpy().tobytes())


if __name__ == "__main__":
    import os
    import sys
    import time

    t0 = time.time()
    out = sys.argv[2]
    os.makedirs(out, exist_ok=True)
    separate(sys.argv[1], os.path.join(out, "arkaplan.wav"), os.path.join(out, "konusma16k.wav"),
             lambda p, ph: print(f"\r{ph} {p * 100:5.1f}%   ", end="", flush=True))
    print(f"\nbitti: {time.time() - t0:.1f} sn")
