#!/usr/bin/env python3
"""Seslendirme Stüdyosu - yerel sunucu.

Videoları ve kayıtları ./projeler klasöründe tutar, ffmpeg ile videoyu
tarayıcının oynatabileceği biçime çevirir ve dublajlı MP4'ü üretir.
Arayüz ./static klasöründedir.

Çalıştırma:  python server.py   (tarayıcı kendiliğinden açılır)
Gereksinim:  Python 3.8+ ve PATH'te ffmpeg + ffprobe
"""
import json
import os
import queue
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, unquote, urlparse

import ses_ayirma

ROOT = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(ROOT, "static")
# İstenirse ortam değişkenleriyle başka klasör/port (ör. denemeler için)
PROJECTS_DIR = os.environ.get("SESLENDIRME_PROJELER") or os.path.join(ROOT, "projeler")
HOST, PORT = "127.0.0.1", int(os.environ.get("SESLENDIRME_PORT") or 8765)

ID_RE = re.compile(r"^[a-z0-9]{8,40}$")
SEG_RE = re.compile(r"^[A-Za-z0-9_-]{1,40}$")
NAME_RE = re.compile(r"^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,99}$")

MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".mp4": "video/mp4",
    ".wav": "audio/wav",
    ".jpg": "image/jpeg",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
}

# Arayüzün değiştirebileceği proje alanları (kayıtlar ayrı uç noktadan yönetilir)
EDITABLE = ("name", "speakers", "segments", "splitDone", "settings")

META_LOCK = threading.Lock()

# Arka plan / konuşma ayırma: tek iş parçacığı sırayla işler
SEP_AVAILABLE = ses_ayirma.available()
SEP_QUEUE = queue.Queue()
SEP_PROGRESS = {}  # proje id -> {"progress": 0..1, "phase": ...} (sadece çalışırken)


class NotFound(Exception):
    pass


# ---------------------------------------------------------------- ffmpeg

def run(cmd):
    """ffmpeg/ffprobe çalıştırır; hata olursa stderr'in son satırlarıyla hata fırlatır."""
    p = subprocess.run(cmd, capture_output=True)
    if p.returncode != 0:
        lines = p.stderr.decode("utf-8", "replace").strip().splitlines()
        raise RuntimeError("\n".join(lines[-6:]) or "ffmpeg hatası")
    return p.stdout


def probe(path):
    out = run(["ffprobe", "-v", "error", "-print_format", "json",
               "-show_format", "-show_streams", path])
    info = json.loads(out)
    streams = info.get("streams", [])
    v = next((s for s in streams if s.get("codec_type") == "video"
              and not s.get("disposition", {}).get("attached_pic")), None)
    a = next((s for s in streams if s.get("codec_type") == "audio"), None)
    dur = float(info.get("format", {}).get("duration") or (v or {}).get("duration") or 0)
    return {
        "duration": dur,
        "vcodec": v and v.get("codec_name"),
        "pix_fmt": v and v.get("pix_fmt"),
        "acodec": a and a.get("codec_name"),
        "channels": int(a.get("channels") or 0) if a else 0,
    }


# ---------------------------------------------------------------- projeler

def pdir(pid):
    if not ID_RE.match(pid or ""):
        raise NotFound(pid)
    d = os.path.join(PROJECTS_DIR, pid)
    if not os.path.isfile(os.path.join(d, "meta.json")):
        raise NotFound(pid)
    return d


def load_meta(pid):
    with open(os.path.join(pdir(pid), "meta.json"), encoding="utf-8") as f:
        return json.load(f)


def video_file(meta):
    return meta.get("video") or "video.mp4"


def source_info(meta):
    """Kırpılmamış kaynak video (eski projelerde kaynak = şimdiki video)."""
    return meta.get("source") or {
        "file": video_file(meta),
        "analysis": meta.get("analysis") or ("analiz.wav" if meta.get("hasAudio") else None),
        "duration": meta["duration"],
    }


def meta_with_progress(meta):
    sep = meta.get("separation")
    if sep and meta["id"] in SEP_PROGRESS:
        meta["separation"] = {**sep, **SEP_PROGRESS[meta["id"]]}
    return meta


def save_meta(pid, meta):
    path = os.path.join(PROJECTS_DIR, pid, "meta.json")
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


def list_projects():
    out = []
    if not os.path.isdir(PROJECTS_DIR):
        return out
    for pid in sorted(os.listdir(PROJECTS_DIR), reverse=True):
        try:
            m = meta_with_progress(load_meta(pid))
        except Exception:
            continue
        out.append({
            "id": m["id"],
            "name": m.get("name"),
            "duration": m.get("duration", 0),
            "splitDone": m.get("splitDone", False),
            "trimDone": m.get("trimDone", True),
            "segCount": len(m.get("segments") or []),
            "takeCount": len(m.get("takes") or {}),
            "separation": m.get("separation"),
        })
    return out


def extract_analysis(video, out):
    run(["ffmpeg", "-y", "-v", "error", "-i", video, "-vn", "-ac", "1",
         "-ar", "16000", "-c:a", "pcm_s16le", out])


def make_thumb(video, duration, out):
    try:
        ss = "1" if duration > 2 else "0"
        run(["ffmpeg", "-y", "-v", "error", "-ss", ss, "-i", video,
             "-frames:v", "1", "-vf", "scale=360:-2", out])
    except (RuntimeError, OSError):
        pass  # küçük resim olmasa da olur


def create_project(src, filename):
    """Yüklenen videoyu MP4'e çevirir, analiz sesini ve küçük resmi çıkarır.

    Video 'kaynak.mp4' olarak saklanır; kullanıcı kırparsa üzerinde çalışılan
    video ayrı bir dosya olur, kaynak her zaman korunur.
    """
    pid = time.strftime("%Y%m%d%H%M%S") + uuid.uuid4().hex[:6]
    d = os.path.join(PROJECTS_DIR, pid)
    os.makedirs(os.path.join(d, "takes"))
    try:
        info = probe(src)
        if not info["vcodec"]:
            raise RuntimeError("Dosyada görüntü bulunamadı. Bir video dosyası seç.")
        video = os.path.join(d, "kaynak.mp4")
        vcopy = info["vcodec"] == "h264" and info["pix_fmt"] in ("yuv420p", "yuvj420p")
        acopy = info["acodec"] == "aac" and info["channels"] <= 2
        cmd = ["ffmpeg", "-y", "-v", "error", "-i", src,
               "-map", "0:v:0", "-map", "0:a:0?", "-sn", "-dn"]
        if vcopy:
            cmd += ["-c:v", "copy"]
        else:
            cmd += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
                    "-pix_fmt", "yuv420p", "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2"]
        if info["acodec"]:
            if acopy:
                cmd += ["-c:a", "copy"]
            else:
                cmd += ["-c:a", "aac", "-b:a", "192k"]
                if info["channels"] > 2:
                    cmd += ["-ac", "2"]
        cmd += ["-movflags", "+faststart", video]
        run(cmd)

        info = probe(video)
        has_audio = bool(info["acodec"])
        analysis = "kaynak_analiz.wav" if has_audio else None
        if has_audio:
            extract_analysis(video, os.path.join(d, analysis))
        make_thumb(video, info["duration"], os.path.join(d, "thumb.jpg"))

        meta = {
            "id": pid,
            "name": os.path.splitext(os.path.basename(filename))[0] or "video",
            "created": time.time(),
            "duration": info["duration"],
            "hasAudio": has_audio,
            "channels": info["channels"],
            "source": {"file": "kaynak.mp4", "analysis": analysis, "duration": info["duration"]},
            "video": "kaynak.mp4",
            "analysis": analysis,
            "trim": {"start": 0.0, "end": info["duration"]},
            "trimDone": False,
            "speakers": [],
            "segments": [],
            "splitDone": False,
            "takes": {},
            "settings": {"origMode": "off"},
            # Ses ayırma, kullanıcı kırpma adımını bitirince başlar
            "separation": {"status": "noaudio" if not has_audio
                           else "waiting" if SEP_AVAILABLE else "unavailable"},
        }
        save_meta(pid, meta)
        return meta
    except Exception:
        shutil.rmtree(d, ignore_errors=True)
        raise


def trim_project(pid, start, end):
    """Kaynak videonun [start, end] aralığını yeni çalışma videosu yapar.

    Bölümler ve kayıtlar yeni zamana kaydırılır, aralık dışında kalanlar silinir.
    Ses ayırma yeni video için (yeniden) başlatılır.
    """
    d = pdir(pid)
    meta = load_meta(pid)
    if (meta.get("separation") or {}).get("status") == "running":
        raise RuntimeError("Arka plan sesi şu an ayrılıyor; bitince tekrar dene.")
    src = source_info(meta)
    sdur = float(src["duration"])
    start = min(max(0.0, float(start)), sdur)
    end = min(max(start, float(end)), sdur)
    if end - start < 0.5:
        raise RuntimeError("Seçilen kısım çok kısa.")
    old = meta.get("trim") or {"start": 0.0, "end": sdur}
    same = abs(start - old["start"]) < 0.01 and abs(end - old["end"]) < 0.01
    if same and meta.get("trimDone", True):
        return meta

    if same:  # ilk onay, kırpma değişmedi
        video_name, analysis_name, dur = video_file(meta), meta.get("analysis"), meta["duration"]
    elif start < 0.01 and end > sdur - 0.01:  # tamamı seçildi: kaynağa dön
        video_name, analysis_name, dur = src["file"], src.get("analysis"), sdur
    else:
        v = int(time.time() * 1000)
        video_name = f"video_{v}.mp4"
        # -ss girişten önce + yeniden kodlama: kare hassasiyetinde kesim
        run(["ffmpeg", "-y", "-v", "error", "-ss", f"{start:.3f}", "-i", os.path.join(d, src["file"]),
             "-t", f"{end - start:.3f}", "-map", "0:v:0", "-map", "0:a:0?",
             "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
             "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", os.path.join(d, video_name)])
        analysis_name = None
        if meta.get("hasAudio"):
            analysis_name = f"analiz_{v}.wav"
            extract_analysis(os.path.join(d, video_name), os.path.join(d, analysis_name))
        dur = probe(os.path.join(d, video_name))["duration"]
    if not same:
        make_thumb(os.path.join(d, video_name), dur, os.path.join(d, "thumb.jpg"))

    shift = float(old["start"]) - start
    queue_it = False
    with META_LOCK:
        meta = load_meta(pid)
        segs = []
        for s in meta.get("segments") or []:
            a, b = max(0.0, s["start"] + shift), min(dur, s["end"] + shift)
            if b - a >= 0.1:
                segs.append({**s, "start": round(a, 3), "end": round(b, 3)})
        keep = {s["id"] for s in segs}
        takes = {}
        for sid, t in (meta.get("takes") or {}).items():
            if sid in keep:
                takes[sid] = {**t, "offset": round(float(t["offset"]) + shift, 4),
                              "recOffset": round(float(t.get("recOffset", t["offset"])) + shift, 4)}
            else:
                try:
                    os.remove(os.path.join(d, "takes", sid + ".wav"))
                except OSError:
                    pass
        meta.update(segments=segs, takes=takes, source=src, video=video_name, analysis=analysis_name,
                    duration=dur, trim={"start": round(start, 3), "end": round(end, 3)}, trimDone=True)
        status = (meta.get("separation") or {}).get("status")
        if meta.get("hasAudio") and SEP_AVAILABLE and (not same or status == "waiting"):
            meta["separation"] = {"status": "pending"}
            queue_it = True
        save_meta(pid, meta)

    if not same:
        # Eski kırpmadan kalan dosyaları temizle (kullanımdaysa sonra silinir)
        current = {video_name, analysis_name, src["file"], src.get("analysis")}
        for f in os.listdir(d):
            if f in ("arkaplan.wav", "analiz_konusma.wav") or (
                    re.match(r"^(video_\d+\.mp4|analiz_\d+\.wav)$", f) and f not in current):
                try:
                    os.remove(os.path.join(d, f))
                except OSError:
                    pass
    if queue_it:
        SEP_QUEUE.put(pid)
    return meta


# ---------------------------------------------------------------- ses ayırma

def set_separation(pid, **fields):
    with META_LOCK:
        meta = load_meta(pid)
        meta["separation"] = {**(meta.get("separation") or {}), **fields}
        save_meta(pid, meta)
        return meta["separation"]


def request_separation(pid):
    """Ayırmayı (yeniden) sıraya koyar."""
    meta = load_meta(pid)
    if not meta.get("hasAudio"):
        raise RuntimeError("Videoda ses yok.")
    if not SEP_AVAILABLE:
        raise RuntimeError("Ses ayırma kurulu değil. Komut satırında: python -m pip install demucs")
    status = (meta.get("separation") or {}).get("status")
    if status in ("pending", "running"):
        return meta_with_progress(meta)["separation"]
    sep = set_separation(pid, status="pending", error=None)
    SEP_QUEUE.put(pid)
    return sep


def separation_worker():
    while True:
        pid = SEP_QUEUE.get()
        try:
            d = pdir(pid)
            meta = load_meta(pid)
            if (meta.get("separation") or {}).get("status") != "pending":
                continue  # bu arada başka bir istekle zaten işlenmiş
            set_separation(pid, status="running", error=None)
            SEP_PROGRESS[pid] = {"progress": 0.0, "phase": "model"}

            def report(p, phase):
                SEP_PROGRESS[pid] = {"progress": round(p, 3), "phase": phase}

            t0 = time.time()
            bg_tmp = os.path.join(d, "arkaplan.tmp.wav")
            sp_tmp = os.path.join(d, "analiz_konusma.tmp.wav")
            ses_ayirma.separate(os.path.join(d, video_file(meta)), bg_tmp, sp_tmp, report)
            os.replace(bg_tmp, os.path.join(d, "arkaplan.wav"))
            os.replace(sp_tmp, os.path.join(d, "analiz_konusma.wav"))
            set_separation(pid, status="done", v=int(time.time() * 1000),
                           seconds=round(time.time() - t0, 1))
            print(f"Ses ayrıldı: {pid} ({time.time() - t0:.0f} sn)")
        except NotFound:
            pass  # proje bu arada silinmiş
        except Exception as e:
            print(f"Ses ayrılamadı: {pid}: {e}")
            try:
                set_separation(pid, status="error", error=str(e)[-300:])
            except Exception:
                pass
        finally:
            SEP_PROGRESS.pop(pid, None)


def start_separation_worker():
    threading.Thread(target=separation_worker, daemon=True).start()
    if not os.path.isdir(PROJECTS_DIR):
        return
    # Program kapanırken yarım kalan ayırmaları yeniden sıraya koy
    for pid in sorted(os.listdir(PROJECTS_DIR)):
        try:
            sep = load_meta(pid).get("separation") or {}
        except Exception:
            continue
        if sep.get("status") in ("pending", "running"):
            if SEP_AVAILABLE:
                set_separation(pid, status="pending")
                SEP_QUEUE.put(pid)
            else:
                set_separation(pid, status="unavailable")


def update_meta(pid, body):
    with META_LOCK:
        meta = load_meta(pid)
        for k in EDITABLE:
            if k in body:
                meta[k] = body[k]
        # Silinen bölümlerin kayıtlarını da sil
        ids = {s.get("id") for s in meta.get("segments") or []}
        for seg_id in list(meta.get("takes", {})):
            if seg_id not in ids:
                del meta["takes"][seg_id]
                try:
                    os.remove(os.path.join(PROJECTS_DIR, pid, "takes", seg_id + ".wav"))
                except OSError:
                    pass
        save_meta(pid, meta)
        return meta


def save_take(pid, seg_id, data, offset, duration, rec_offset):
    d = pdir(pid)
    if not data.startswith(b"RIFF"):
        raise RuntimeError("Geçersiz ses dosyası")
    with open(os.path.join(d, "takes", seg_id + ".wav"), "wb") as f:
        f.write(data)
    # offset: kaydın videodaki yeri (hizalanmış); recOffset: kaydedildiği andaki yeri
    take = {"offset": offset, "recOffset": rec_offset, "duration": duration, "v": int(time.time() * 1000)}
    with META_LOCK:
        meta = load_meta(pid)
        meta.setdefault("takes", {})[seg_id] = take
        save_meta(pid, meta)
    return take


def set_take_offset(pid, seg_id, offset):
    """Kaydı zaman çizelgesinde kaydırır (elle sürükleme / otomatik hizalama)."""
    with META_LOCK:
        meta = load_meta(pid)
        take = (meta.get("takes") or {}).get(seg_id)
        if not take:
            raise NotFound(seg_id)
        take["offset"] = round(float(offset), 4)
        save_meta(pid, meta)
        return take


def delete_take(pid, seg_id):
    d = pdir(pid)
    with META_LOCK:
        meta = load_meta(pid)
        meta.get("takes", {}).pop(seg_id, None)
        save_meta(pid, meta)
    try:
        os.remove(os.path.join(d, "takes", seg_id + ".wav"))
    except OSError:
        pass


def delete_project(pid):
    d = pdir(pid)
    shutil.rmtree(d, ignore_errors=True)
    if os.path.exists(d):
        raise RuntimeError("Bazı dosyalar kullanımda, birkaç saniye sonra tekrar dene.")


def export_project(pid):
    """Kayıtları videonun üstüne yerleştirip yeni bir MP4 üretir."""
    d = pdir(pid)
    meta = load_meta(pid)
    video = os.path.join(d, video_file(meta))
    segs = sorted(meta.get("segments") or [], key=lambda s: s["start"])
    takes = [(sid, t) for sid, t in (meta.get("takes") or {}).items()
             if os.path.isfile(os.path.join(d, "takes", sid + ".wav"))]
    mode = (meta.get("settings") or {}).get("origMode", "off")
    if not meta.get("hasAudio"):
        mode = "off"

    settings = meta.get("settings") or {}
    bg_file = os.path.join(d, "arkaplan.wav")
    if mode == "bg" and not os.path.isfile(bg_file):
        raise RuntimeError("Arka plan sesi henüz hazır değil. Ayırma bitince tekrar dene "
                           "ya da Ayarlar'dan başka bir mod seç.")

    fmt = "aformat=sample_rates=48000:channel_layouts=stereo"
    speech = "+".join(f"between(t,{s['start']:.3f},{s['end']:.3f})" for s in segs) or "0"
    inputs = ["-i", video]
    parts, labels = [], []
    if mode == "low":
        parts.append(f"[0:a]{fmt},volume=0.15[o]")
        labels.append("[o]")
    elif mode == "gaps":
        parts.append(f"[0:a]{fmt},volume=0:enable='{speech}'[o]")
        labels.append("[o]")
    elif mode == "bg":
        # Konuşmaları silinmiş arka plan (müzik, efekt, ortam sesi) baştan sona çalar
        inputs += ["-i", bg_file]
        vol = float(settings.get("bgVolume", 1))
        parts.append(f"[1:a]{fmt},volume={vol:.2f}[o]")
        labels.append("[o]")
    for sid, t in takes:
        i = len(inputs) // 2
        inputs += ["-i", os.path.join(d, "takes", sid + ".wav")]
        offset = float(t.get("offset", 0))
        if offset >= 0:
            parts.append(f"[{i}:a]{fmt},adelay={int(round(offset * 1000))}:all=1[t{i}]")
        else:  # kırpma sonrası videonun başından önce başlayan kayıt: baş kısmını kes
            parts.append(f"[{i}:a]atrim=start={-offset:.4f},asetpts=PTS-STARTPTS,{fmt}[t{i}]")
        labels.append(f"[t{i}]")
    if not takes:
        raise RuntimeError("Henüz hiç replik kaydetmedin.")
    if len(labels) == 1:
        parts.append(f"{labels[0]}alimiter=limit=0.95,apad[mix]")
    else:
        parts.append(f"{''.join(labels)}amix=inputs={len(labels)}:normalize=0:dropout_transition=0,"
                     f"alimiter=limit=0.95,apad[mix]")

    os.makedirs(os.path.join(d, "exports"), exist_ok=True)
    name = time.strftime("dublaj_%Y%m%d_%H%M%S.mp4")
    out = os.path.join(d, "exports", name)
    run(["ffmpeg", "-y", "-v", "error", *inputs, "-filter_complex", ";".join(parts),
         "-map", "0:v:0", "-map", "[mix]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
         "-t", f"{meta['duration']:.3f}", "-movflags", "+faststart", out])
    return name


# ---------------------------------------------------------------- HTTP

class Handler(BaseHTTPRequestHandler):
    server_version = "SeslendirmeStudyosu/1.0"

    def log_message(self, fmt, *args):
        pass  # konsolu her istekte doldurmasın

    def do_GET(self):
        self.dispatch("get")

    def do_HEAD(self):
        self.dispatch("get")

    def do_POST(self):
        self.dispatch("post")

    def do_PUT(self):
        self.dispatch("put")

    def do_DELETE(self):
        self.dispatch("delete")

    def dispatch(self, method):
        u = urlparse(self.path)
        parts = [unquote(p) for p in u.path.split("/") if p]
        try:
            getattr(self, "h_" + method)(parts, parse_qs(u.query))
        except NotFound:
            self.send_json({"error": "Bulunamadı"}, 404)
        except ConnectionError:
            pass  # tarayıcı bağlantıyı kapattı
        except Exception as e:
            try:
                self.send_json({"error": str(e)}, 500)
            except ConnectionError:
                pass

    # ---- yardımcılar

    def send_json(self, obj, status=200):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def read_body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n > 0 else b""

    def send_file(self, path, download=None):
        if not os.path.isfile(path):
            raise NotFound(path)
        size = os.path.getsize(path)
        ctype = MIME.get(os.path.splitext(path)[1].lower(), "application/octet-stream")
        start, end, status = 0, size - 1, 200
        m = re.match(r"bytes=(\d*)-(\d*)$", self.headers.get("Range") or "")
        if m and (m.group(1) or m.group(2)):
            if m.group(1):
                start = int(m.group(1))
                if m.group(2):
                    end = min(int(m.group(2)), size - 1)
            else:
                start = max(0, size - int(m.group(2)))
            if start > end:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            status = 206
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", "no-cache")
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        if download:
            self.send_header("Content-Disposition",
                             "attachment; filename=\"dublaj.mp4\"; filename*=UTF-8''" + quote(download))
        self.end_headers()
        if self.command == "HEAD":
            return
        with open(path, "rb") as f:
            f.seek(start)
            left = end - start + 1
            while left > 0:
                chunk = f.read(min(left, 256 * 1024))
                if not chunk:
                    break
                self.wfile.write(chunk)
                left -= len(chunk)

    # ---- yönlendirme

    def h_get(self, p, q):
        if not p or p == ["index.html"]:
            return self.send_file(os.path.join(STATIC_DIR, "index.html"))
        if p[0] == "static" and len(p) == 2 and NAME_RE.match(p[1]):
            return self.send_file(os.path.join(STATIC_DIR, p[1]))
        if p[:2] == ["api", "projects"]:
            if len(p) == 2:
                return self.send_json(list_projects())
            if len(p) == 3:
                return self.send_json(meta_with_progress(load_meta(p[2])))
        if p[0] == "media" and len(p) in (3, 4):
            d = pdir(p[1])
            rest = p[2:]
            if len(rest) == 2 and rest[0] not in ("takes", "exports"):
                raise NotFound(self.path)
            if not all(NAME_RE.match(x) for x in rest):
                raise NotFound(self.path)
            name = None
            if "download" in q:
                name = (load_meta(p[1]).get("name") or "video") + "_dublaj.mp4"
            return self.send_file(os.path.join(d, *rest), download=name)
        raise NotFound(self.path)

    def h_post(self, p, q):
        if p == ["api", "projects"]:
            return self.upload()
        if len(p) == 4 and p[:2] == ["api", "projects"] and p[3] == "export":
            name = export_project(p[2])
            return self.send_json({"file": name, "url": f"/media/{p[2]}/exports/{name}"})
        if len(p) == 4 and p[:2] == ["api", "projects"] and p[3] == "separate":
            return self.send_json(request_separation(p[2]))
        if len(p) == 6 and p[:2] == ["api", "projects"] and p[3] == "takes" and p[5] == "offset" \
                and SEG_RE.match(p[4]):
            body = json.loads(self.read_body() or b"{}")
            return self.send_json(set_take_offset(p[2], p[4], body["offset"]))
        if len(p) == 4 and p[:2] == ["api", "projects"] and p[3] == "trim":
            body = json.loads(self.read_body() or b"{}")
            return self.send_json(meta_with_progress(trim_project(p[2], body["start"], body["end"])))
        raise NotFound(self.path)

    def h_put(self, p, q):
        if len(p) == 3 and p[:2] == ["api", "projects"]:
            body = json.loads(self.read_body() or b"{}")
            return self.send_json(update_meta(p[2], body))
        if len(p) == 5 and p[:2] == ["api", "projects"] and p[3] == "takes" and SEG_RE.match(p[4]):
            offset = float(self.headers.get("X-Offset") or 0)
            take = save_take(p[2], p[4], self.read_body(), offset,
                             float(self.headers.get("X-Duration") or 0),
                             float(self.headers.get("X-Rec-Offset") or offset))
            return self.send_json(take)
        raise NotFound(self.path)

    def h_delete(self, p, q):
        if len(p) == 3 and p[:2] == ["api", "projects"]:
            delete_project(p[2])
            return self.send_json({"ok": True})
        if len(p) == 5 and p[:2] == ["api", "projects"] and p[3] == "takes" and SEG_RE.match(p[4]):
            delete_take(p[2], p[4])
            return self.send_json({"ok": True})
        raise NotFound(self.path)

    def upload(self):
        filename = unquote(self.headers.get("X-Filename") or "video")
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0:
            return self.send_json({"error": "Dosya boş"}, 400)
        os.makedirs(PROJECTS_DIR, exist_ok=True)
        ext = os.path.splitext(filename)[1].lower()
        if not re.match(r"^\.[a-z0-9]{1,5}$", ext):
            ext = ".bin"
        tmp = os.path.join(PROJECTS_DIR, f"_yukleme_{uuid.uuid4().hex}{ext}")
        try:
            with open(tmp, "wb") as f:
                left = n
                while left > 0:
                    chunk = self.rfile.read(min(left, 1 << 20))
                    if not chunk:
                        raise ConnectionError("Yükleme yarıda kesildi")
                    f.write(chunk)
                    left -= len(chunk)
            meta = create_project(tmp, filename)
        finally:
            if os.path.exists(tmp):
                os.remove(tmp)
        self.send_json(meta)


def main():
    missing = [t for t in ("ffmpeg", "ffprobe") if not shutil.which(t)]
    if missing:
        print("HATA: ffmpeg bulunamadı (" + ", ".join(missing) + ").")
        print("ffmpeg'i kurup PATH'e ekle: https://www.gyan.dev/ffmpeg/builds/")
        input("Kapatmak için Enter'a bas...")
        sys.exit(1)
    os.makedirs(PROJECTS_DIR, exist_ok=True)
    url = f"http://{HOST}:{PORT}/"
    try:
        srv = ThreadingHTTPServer((HOST, PORT), Handler)
    except OSError:
        print(f"{PORT} portu kullanımda; program zaten açık olabilir. Tarayıcı açılıyor: {url}")
        webbrowser.open(url)
        return
    start_separation_worker()
    print(f"Seslendirme Stüdyosu çalışıyor: {url}")
    if not SEP_AVAILABLE:
        print("Not: Arka plan sesini ayırma kapalı. Açmak için: python -m pip install demucs")
    print("Kapatmak için bu pencereyi kapat (veya Ctrl+C).")
    if "--no-browser" not in sys.argv:
        threading.Timer(0.8, webbrowser.open, args=(url,)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
