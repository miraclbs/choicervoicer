'use strict';
// Seslendirme Stüdyosu — arayüz

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Math.random().toString(36).slice(2, 10);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const r3 = v => Math.round(v * 1000) / 1000;

const COLORS = ['#4f8cff', '#ff5c7a', '#2fd27a', '#f5a623'];
const LEAD = 0.4;    // replikten önce kayda dahil edilen süre (sn); sessizlik sonra kesilir
const TAIL = 1.0;    // replik bittikten sonra kayda devam süresi (geç biten son kelimeler için)
const TL_H = 120;    // zaman çizelgesi yüksekliği (px)
const TL_H_DUB = 168; // seslendirmede iki şerit: üstte orijinal, altta benim kayıtlarım
const RULER = 18;    // cetvel yüksekliği (px)

const video = $('#video');
const tl = $('#timeline');
const tlScroll = $('#timelineScroll');
const playhead = $('#playhead');

// Cihaza özel tercihler (tarayıcıda saklanır)
const prefs = (() => {
  const def = { preroll: 2, autoListen: true, autoAlign: true, hearOrig: false, hearOthers: false, latencyMs: 0 };
  try { return Object.assign(def, JSON.parse(localStorage.getItem('ss-prefs') || '{}')); } catch { return def; }
})();
function savePrefs() { try { localStorage.setItem('ss-prefs', JSON.stringify(prefs)); } catch { } }

const S = {
  p: null,            // açık proje
  tab: 'split',       // 'split' | 'dub'
  sel: null,          // seçili bölüm id
  audio: null,        // analiz sesi {data, sr}
  peaks: null,        // dalga formu {pk: 10 ms'lik tepe değerleri, max}
  srcPeaks: null,     // kırpılmamış kaynak videonun dalga formu (Kırp sekmesi)
  trim: null,         // Kırp sekmesinde düzenlenen seçim {start, end}
  takeBufs: {},       // bölüm id -> AudioBuffer
  bgBuf: null,        // konuşmaları silinmiş arka plan sesi
  pollTimer: null,    // ses ayırma ilerlemesini izler
  autoSplitPending: false, // ilk otomatik bölme, ses ayırmanın bitmesini bekliyor
  uploads: new Set(), // sunucuya giden kayıtlar
  pps: 50, ppsFit: 50,
  playMode: 'orig',   // 'orig' orijinal ses | 'dub' benim kayıtlarım | 'rec' kayıt
  stopAt: null,       // aralık oynatırken durulacak an
  fullPreview: false, // seslendirmede tüm video izleniyor (ekran oynayan repliği takip eder)
  roleFilter: 'all',
  openToken: 0,
};
const rec = { active: false };
let ask = null;       // "kim konuşuyor?" modu: {i}

// ------------------------------------------------------------ yardımcılar

let toastTimer;
function toast(msg, ms = 3000) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

async function api(method, url, body, headers = {}) {
  const opt = { method, headers: { ...headers } };
  if (body !== undefined) {
    if (body instanceof ArrayBuffer || body instanceof Blob) opt.body = body;
    else { opt.body = JSON.stringify(body); opt.headers['Content-Type'] = 'application/json'; }
  }
  const r = await fetch(url, opt);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Sunucu hatası (${r.status})`);
  return data;
}

function fmt(t) {
  const d = Math.round(Math.max(0, t) * 10), m = Math.floor(d / 600), s = (d % 600) / 10;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}
function fmtRuler(t, step) {
  const m = Math.floor(t / 60 + 1e-9), s = t - m * 60;
  return step < 1 ? `${m}:${s.toFixed(1).padStart(4, '0')}` : `${m}:${String(Math.round(s)).padStart(2, '0')}`;
}
const once = (el, ev, ms = 4000) => new Promise(res => {
  const done = () => { el.removeEventListener(ev, done); clearTimeout(t); res(); };
  const t = setTimeout(done, ms);
  el.addEventListener(ev, done);
});

const mkSpeaker = i => ({ name: `Kişi ${i + 1}`, color: COLORS[i % COLORS.length] });
const spk = i => S.p.speakers[i] || S.p.speakers[0];
const segById = id => S.p && S.p.segments.find(s => s.id === id);
const selSeg = () => (S.sel && segById(S.sel)) || null;
const segAt = t => S.p.segments.find(s => t >= s.start && t <= s.end);
const sortSegs = () => S.p.segments.sort((a, b) => a.start - b.start);

function parseWav(buf) {
  const dv = new DataView(buf);
  let pos = 12, ch = 1, sr = 16000;
  while (pos + 8 <= dv.byteLength) {
    const id = String.fromCharCode(dv.getUint8(pos), dv.getUint8(pos + 1), dv.getUint8(pos + 2), dv.getUint8(pos + 3));
    let size = dv.getUint32(pos + 4, true);
    const body = pos + 8;
    if (id === 'fmt ') { ch = dv.getUint16(body + 2, true); sr = dv.getUint32(body + 4, true); }
    else if (id === 'data') {
      size = Math.min(size, dv.byteLength - body);
      const n = Math.floor(size / 2 / ch), data = new Float32Array(n);
      for (let i = 0; i < n; i++) data[i] = dv.getInt16(body + i * 2 * ch, true) / 32768;
      return { data, sr };
    }
    pos = body + size + (size & 1);
  }
  throw new Error('WAV okunamadı');
}

function encodeWav(pcm, sr) {
  const buf = new ArrayBuffer(44 + pcm.length * 2), dv = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); dv.setUint32(4, 36 + pcm.length * 2, true); w(8, 'WAVE');
  w(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, sr, true); dv.setUint32(28, sr * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  w(36, 'data'); dv.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) dv.setInt16(44 + i * 2, clamp(pcm[i], -1, 1) * 0x7fff, true);
  return buf;
}

// Dalga formu için saniyede 100 tepe değeri
function computePeaks(x, sr = 16000) {
  const hop = Math.round(sr / 100), n = Math.ceil(x.length / hop), pk = new Float32Array(n);
  let max = 1e-4;
  for (let i = 0; i < n; i++) {
    let m = 0;
    const e = Math.min(x.length, (i + 1) * hop);
    for (let j = i * hop; j < e; j++) { const v = Math.abs(x[j]); if (v > m) m = v; }
    pk[i] = m;
    if (m > max) max = m;
  }
  return { pk, max };
}

// Kırp sekmesinde kaynak (kırpılmamış) video, diğerlerinde kırpılmış video gösterilir
const srcDur = () => S.p.source.duration;
const curDur = () => (S.tab === 'trim' ? srcDur() : S.p.duration);

// ------------------------------------------------------------ ses altyapısı

let ctx, origGain, bgGain, takesGain;
let micStream, micAnalyser, recNode, meterBuf;
let takeNodes = [];

function ensureCtx() {
  if (ctx) return;
  ctx = new AudioContext({ latencyHint: 'interactive' });
  const src = ctx.createMediaElementSource(video);
  origGain = ctx.createGain();
  src.connect(origGain).connect(ctx.destination);
  bgGain = ctx.createGain();
  bgGain.connect(ctx.destination);
  takesGain = ctx.createGain();
  takesGain.connect(ctx.destination);
  const unlock = () => { if (ctx.state === 'suspended') ctx.resume(); };
  document.addEventListener('pointerdown', unlock, true);
  document.addEventListener('keydown', unlock, true);
}

const WORKLET = `class Kayit extends AudioWorkletProcessor {
  constructor() { super(); this.on = false; this.port.onmessage = e => { this.on = e.data; }; }
  process(inputs) {
    const c = inputs[0] && inputs[0][0];
    if (this.on && c) this.port.postMessage({ t: currentTime, d: c.slice(0) });
    return true;
  }
}
registerProcessor('kayit', Kayit);`;

async function ensureMic() {
  ensureCtx();
  if (micStream) return true;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true },
    });
    if (!ensureMic.worklet) {
      ensureMic.worklet = ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' })));
    }
    await ensureMic.worklet;
  } catch (e) {
    toast('Mikrofona erişilemedi. Tarayıcının adres çubuğundan mikrofon iznini ver. (' + e.message + ')', 7000);
    if (stream) stream.getTracks().forEach(t => t.stop());
    return false;
  }
  if (micStream) { stream.getTracks().forEach(t => t.stop()); return true; }
  micStream = stream;
  const src = ctx.createMediaStreamSource(micStream);
  micAnalyser = ctx.createAnalyser();
  micAnalyser.fftSize = 1024;
  meterBuf = new Float32Array(micAnalyser.fftSize);
  recNode = new AudioWorkletNode(ctx, 'kayit', { channelCount: 1, channelCountMode: 'explicit' });
  recNode.port.onmessage = e => { if (rec.active) rec.chunks.push(e.data); };
  const mute = ctx.createGain();
  mute.gain.value = 0;
  src.connect(micAnalyser);
  src.connect(recNode).connect(mute).connect(ctx.destination);
  $('#btnMic').hidden = true;
  return true;
}

function setGain(node, v) {
  if (node._t === v) return;
  node._t = v;
  node.gain.setTargetAtTime(v, ctx.currentTime, 0.015);
}

// Videonun kendi sesinin ne kadar duyulacağı (mod ve zamana göre)
function updateGains(t) {
  if (!ctx) return;
  let dry = 1;
  if (S.playMode === 'rec') dry = prefs.hearOrig ? 0.8 : 0;
  else if (S.playMode === 'dub') {
    switch (S.p.settings.origMode) {
      case 'low': dry = 0.15; break;
      case 'gaps': dry = segAt(t) ? 0 : 1; break;
      default: dry = 0; // 'off' ve 'bg' (arka plan ayrı ses olarak çalınır)
    }
  }
  setGain(origGain, dry);
  setGain(bgGain, S.p.settings.bgVolume ?? 1);
}

function stopTakes() {
  for (const n of takeNodes) { try { n.stop(); } catch { } }
  takeNodes = [];
}

// Kayıtları videonun o anki zamanına göre çalmaya başlar
function syncTakes(exclude) {
  stopTakes();
  if (!ctx || video.paused || !S.p) return;
  const vt = video.currentTime, now = ctx.currentTime;
  for (const [id, tk] of Object.entries(S.p.takes)) {
    const buf = S.takeBufs[id];
    if (id === exclude || !buf || tk.offset + buf.duration <= vt) continue;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(takesGain);
    const delay = tk.offset - vt;
    if (delay >= 0) src.start(now + delay); else src.start(now, -delay);
    takeNodes.push(src);
  }
  if (S.bgBuf && S.p.settings.origMode === 'bg' && vt < S.bgBuf.duration) {
    const src = ctx.createBufferSource();
    src.buffer = S.bgBuf;
    src.connect(bgGain);
    src.start(now, vt);
    takeNodes.push(src);
  }
}

function scheduleTakes() {
  if (S.playMode === 'dub') syncTakes(null);
  else if (S.playMode === 'rec' && prefs.hearOthers) syncTakes(rec.seg && rec.seg.id);
  else stopTakes();
}

video.addEventListener('playing', () => { scheduleTakes(); updatePlayBtn(); });
video.addEventListener('seeked', () => { if (!video.paused) scheduleTakes(); });
video.addEventListener('pause', () => { stopTakes(); S.fullPreview = false; updatePlayBtn(); });
video.addEventListener('waiting', stopTakes);
video.addEventListener('seeking', stopTakes);
video.addEventListener('error', () => { if (S.p) toast('Video oynatılamadı.', 5000); });
video.addEventListener('click', () => togglePlay());

function updatePlayBtn() { $('#btnPlay').innerHTML = ic(video.paused ? 'play' : 'pause'); }

function togglePlay() {
  if (rec.active || !S.p) return;
  if (video.paused) {
    // Seslendirmede sadece seçili replik (ve çevresi) oynar
    const seg = S.tab === 'dub' && selSeg();
    if (seg) {
      const [a, b] = clipRange(seg), t = video.currentTime;
      return playRange(t >= a && t < b - 0.15 ? t : a, b, S.playMode === 'orig' ? 'orig' : 'dub');
    }
    S.stopAt = null;
    // Seslendirme sekmesinde anahtarda seçili olan ses (orijinal / benim sesim) çalar
    if (S.tab !== 'dub') S.playMode = 'orig';
    else if (S.playMode !== 'orig') S.playMode = 'dub';
    if (video.currentTime >= curDur() - 0.05) video.currentTime = 0;
    video.play().catch(() => { });
  } else video.pause();
}

function playRange(a, b, mode) {
  if (rec.active) return;
  S.playMode = mode;
  S.stopAt = b;
  video.currentTime = clamp(a, 0, curDur());
  video.play().catch(() => { });
}
const playOrig = seg => playRange(seg.start - 0.2, seg.end + 0.2, 'orig');
function playMine(seg) {
  const tk = S.p.takes[seg.id], d = tk ? (S.takeBufs[seg.id] || tk).duration : 0;
  playRange(Math.min(seg.start, tk ? tk.offset : seg.start) - 1, Math.max(seg.end, tk ? tk.offset + d : seg.end) + 0.4, 'dub');
}
const seek = t => { video.currentTime = clamp(t, 0, curDur()); };

function useVideo(file, at) {
  if (video.dataset.file === file) return;
  video.dataset.file = file;
  video.src = `/media/${S.p.id}/${file}`;
  if (at != null) video.addEventListener('loadedmetadata', () => { video.currentTime = at; }, { once: true });
}

// ------------------------------------------------------------ ana sayfa

async function showHome() {
  await closeProject();
  document.title = 'Seslendirme Stüdyosu';
  setSaveState('');
  delete document.body.dataset.tab;
  $('#steps').hidden = true;
  $('#home').hidden = false;
  $('#project').hidden = true;
  $('#crumb').textContent = '';
  $('#projectList').dataset.ids = '';
  await renderHomeList();
}

let homeTimer = null;
function sepBadge(sep) {
  if (!sep || !['pending', 'running'].includes(sep.status)) return '';
  return `<span class="badge busy">${ic('loader', 'spin')}Arka plan ${sepProgressText(sep).toLowerCase()}</span>`;
}
async function renderHomeList() {
  clearTimeout(homeTimer);
  let list = [];
  try { list = await api('GET', '/api/projects'); } catch (e) { toast(e.message); }
  const el = $('#projectList');
  if ($('#home').hidden) return;
  const ids = list.map(p => p.id).join();
  $('#projCount').textContent = list.length ? `${list.length} video` : '';
  if (el.dataset.ids === ids && ids) {
    // Aynı liste: kartları yeniden çizmeden sadece ayırma durumunu güncelle
    for (const p of list) el.querySelector(`.sepSlot[data-id="${p.id}"]`).innerHTML = sepBadge(p.separation);
  } else if (!list.length) {
    el.innerHTML = '<p class="empty">Henüz video yok. Yukarıdan bir video yükle.</p>';
  } else {
    el.innerHTML = list.map(p => {
      const go = tab => `#/p/${p.id}/${tab}`;
      let status, actions;
      if (!p.trimDone) {
        status = '<span class="badge todo">Kırpma bekliyor</span>';
        actions = `<a class="btn btn-primary" href="${go('trim')}">${ic('scissors')}Kırpmaya başla</a>`;
      } else if (!p.splitDone) {
        status = '<span class="badge todo">Konuşmacılar ayrılmadı</span>';
        actions = `<a class="btn btn-primary" href="${go('split')}">${ic('users')}Konuşmacıları ayır</a>
          <a class="btn btn-secondary iconOnly" href="${go('trim')}" title="Kırpmayı değiştir">${ic('scissors')}</a>`;
      } else {
        status = `<span class="badge done">${ic('check')}Hazır</span>
          <span class="badge ${p.takeCount >= p.segCount ? 'done' : ''}">${p.takeCount}/${p.segCount} replik kaydedildi</span>`;
        actions = `<a class="btn btn-primary" href="${go('dub')}">${ic('mic')}Seslendir</a>
          <a class="btn btn-secondary" href="${go('split')}" title="Konuşmacıları, bölümleri ya da kırpmayı değiştir">${ic('pencil')}Düzenle</a>`;
      }
      return `<div class="card">
        <a class="thumb" href="#/p/${p.id}"><img src="/media/${p.id}/thumb.jpg" alt="" onerror="this.remove()"><span class="dur">${fmt(p.duration)}</span></a>
        <div class="cardBody">
          <div class="cardTitle" title="${esc(p.name)}">${esc(p.name)}</div>
          <div class="cardInfo">${status}<span class="sepSlot" data-id="${p.id}">${sepBadge(p.separation)}</span></div>
          <div class="cardActions">${actions}</div>
        </div>
        <button class="del" data-del="${p.id}" title="Sil">${ic('trash')}</button>
      </div>`;
    }).join('');
  }
  el.dataset.ids = ids;
  if (list.some(p => sepBadge(p.separation))) homeTimer = setTimeout(renderHomeList, 1500);
}

$('#projectList').addEventListener('click', async e => {
  const b = e.target.closest('[data-del]');
  if (!b) return;
  e.preventDefault();
  if (!confirm('Bu video ve tüm kayıtları silinsin mi?')) return;
  try { await api('DELETE', `/api/projects/${b.dataset.del}`); } catch (err) { toast(err.message); }
  showHome();
});

function uploadFile(file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/projects');
    xhr.setRequestHeader('X-Filename', encodeURIComponent(file.name));
    xhr.upload.onprogress = e => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.upload.onload = () => onProgress(1);
    xhr.onload = () => {
      let d = {};
      try { d = JSON.parse(xhr.responseText); } catch { }
      if (xhr.status < 300) resolve(d); else reject(new Error(d.error || 'Yükleme başarısız'));
    };
    xhr.onerror = () => reject(new Error('Sunucuya bağlanılamadı'));
    xhr.send(file);
  });
}

async function uploadFiles(files) {
  files = [...files].filter(f => f.type.startsWith('video/') || /\.(mp4|m4v|mov|mkv|webm|avi|wmv|flv|3gp|ts|mts)$/i.test(f.name));
  if (!files.length) return toast('Bir video dosyası seç.');
  const box = $('#uploadStatus');
  let last = null, ok = 0;
  for (const f of files) {
    const row = document.createElement('div');
    row.className = 'upRow';
    row.innerHTML = `<span>${esc(f.name)}</span><div class="bar"><div></div></div><span class="st muted">yükleniyor…</span>`;
    box.append(row);
    try {
      last = await uploadFile(f, x => {
        row.querySelector('.bar div').style.width = x * 100 + '%';
        if (x >= 1) row.querySelector('.st').textContent = 'hazırlanıyor…';
      });
      ok++;
      row.remove();
    } catch (e) {
      row.classList.add('err');
      row.title = 'Kapatmak için tıkla';
      row.onclick = () => row.remove();
      row.querySelector('.st').textContent = 'Hata: ' + e.message;
    }
  }
  if (ok === 1 && files.length === 1) location.hash = '#/p/' + last.id;
  else if (location.hash.length <= 2) showHome();
}

const drop = $('#drop');
drop.addEventListener('click', () => $('#fileInput').click());
drop.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') $('#fileInput').click(); });
$('#fileInput').addEventListener('change', e => { uploadFiles(e.target.files); e.target.value = ''; });
['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, () => drop.classList.remove('over')));
drop.addEventListener('drop', e => { e.preventDefault(); uploadFiles(e.dataTransfer.files); });
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => e.preventDefault());

// ------------------------------------------------------------ proje aç / kapat / kaydet

async function openProject(id, wantTab) {
  if (S.p && S.p.id === id) {
    if (wantTab && wantTab !== S.tab) setTab(wantTab);
    return;
  }
  await closeProject();
  const token = ++S.openToken;
  let p;
  try { p = await api('GET', `/api/projects/${id}`); } catch (e) { toast(e.message); location.hash = '#/'; return; }
  if (token !== S.openToken) return;
  if (!p.speakers || !p.speakers.length) p.speakers = [mkSpeaker(0), mkSpeaker(1)];
  p.settings = Object.assign({ origMode: 'off' }, p.settings);
  p.segments = p.segments || [];
  p.takes = p.takes || {};
  if (p.settings.origMode === 'center') p.settings.origMode = 'gaps'; // eski sürümden kalan mod
  // Kırpma özelliğinden önceki projeler: kaynak = şimdiki video
  p.video = p.video || 'video.mp4';
  p.analysis = p.analysis || (p.hasAudio ? 'analiz.wav' : null);
  p.source = p.source || { file: p.video, analysis: p.analysis, duration: p.duration };
  p.trim = p.trim || { start: 0, end: p.source.duration };
  if (p.trimDone === undefined) p.trimDone = true;
  Object.assign(S, {
    p, sel: null, audio: null, peaks: null, srcPeaks: null, takeBufs: {}, takePk: {}, bgBuf: null,
    roleFilter: 'all', stopAt: null, autoSplitPending: false, tab: null,
  });
  sortSegs();

  document.title = p.name + ' — Seslendirme Stüdyosu';
  $('#home').hidden = true;
  $('#project').hidden = false;
  $('#steps').hidden = false;
  $('#crumb').textContent = p.name;
  $('#exportResult').innerHTML = '';
  ensureCtx();
  $('#zoom').value = 0;
  setSaveState('saved');
  // İstenen sekme yoksa kaldığı yerden: kırpılmadıysa Kırp, ayrıldıysa Seslendir
  setTab(wantTab || (!p.trimDone ? 'trim' : p.splitDone && p.segments.length ? 'dub' : 'split'));
  loadTakes(p);

  if (p.hasAudio) {
    // Ayrılmış konuşma sesi varsa analiz ve dalga formu için onu kullan (müzikten etkilenmez)
    if (sepStatus(p) === 'done') await loadSeparated(p);
    if (token !== S.openToken) return;
    if (!S.audio) {
      try {
        const r = await fetch(`/media/${p.id}/${p.analysis}`);
        if (!r.ok) throw new Error('dosya yok');
        const audio = parseWav(await r.arrayBuffer());
        if (token !== S.openToken) return;
        S.audio = audio;
        S.peaks = computePeaks(audio.data);
        drawTimeline();
      } catch (e) { toast('Ses dalgası yüklenemedi: ' + e.message); }
    }
  }
  preferBg(p);
  renderSepUI();
  startSepPoll(p);
  // Kırpmadan sonraki ilk açılış: otomatik ayır, sonra tek tek sor. Ses ayırma sürüyorsa önce onu bekle.
  if (p.trimDone && !p.splitDone && !p.segments.length) {
    if (isSepBusy(p)) { S.autoSplitPending = true; renderSepUI(); }
    else firstSplit();
  }
}

async function firstSplit() {
  const p = S.p;
  if (!S.audio) return toast('Bu videoda ses yok. Bölümleri zaman çizelgesinde sürükleyerek ekle.', 6000);
  await autoSplit(true);
  if (S.p === p && p.segments.length && p.speakers.length > 1 && S.tab === 'split') startAsk(0);
}

// ------------------------------------------------------------ arka plan / konuşma ayırma

const sepStatus = p => (p && p.separation && p.separation.status) || 'none';
const isSepBusy = p => ['pending', 'running'].includes(sepStatus(p));

async function loadSeparated(p) {
  const v = p.separation.v || 0;
  try {
    const [a, b] = await Promise.all([
      fetch(`/media/${p.id}/analiz_konusma.wav?v=${v}`).then(r => r.ok ? r.arrayBuffer() : null),
      fetch(`/media/${p.id}/arkaplan.wav?v=${v}`).then(r => r.ok ? r.arrayBuffer() : null),
    ]);
    if (S.p !== p) return;
    if (a) {
      S.audio = parseWav(a);
      S.peaks = computePeaks(S.audio.data);
      drawTimeline();
    }
    if (b) {
      const buf = await ctx.decodeAudioData(b);
      if (S.p === p) S.bgBuf = buf;
    }
  } catch (e) { toast('Arka plan sesi yüklenemedi: ' + e.message, 5000); }
}

// Arka plan hazırsa ve kullanıcı başka bir mod seçmediyse onu kullan
function preferBg(p) {
  if (sepStatus(p) !== 'done' || p.settings.modeChosen || p.settings.origMode !== 'off') return;
  p.settings.origMode = 'bg';
  changed();
  if (S.tab === 'dub') renderDubPanel();
}

function startSepPoll(p) {
  clearInterval(S.pollTimer);
  if (!isSepBusy(p)) return;
  S.pollTimer = setInterval(async () => {
    if (S.p !== p) return clearInterval(S.pollTimer);
    let m;
    try { m = await api('GET', `/api/projects/${p.id}`); } catch { return; }
    if (S.p !== p) return;
    p.separation = m.separation;
    renderSepUI();
    if (!isSepBusy(p)) {
      clearInterval(S.pollTimer);
      onSeparationFinished(p);
    }
  }, 1000);
}

async function onSeparationFinished(p) {
  if (sepStatus(p) === 'done') {
    await loadSeparated(p);
    if (S.p !== p) return;
    preferBg(p);
    renderSepUI();
    if (!S.autoSplitPending) toast('🎵 Arka plan sesleri hazır! Seslendirirken artık müzik ve efektler de duyulacak.', 5000);
  } else if (sepStatus(p) === 'error') {
    toast('Arka plan ayrılamadı: ' + (p.separation.error || ''), 7000);
  }
  if (S.autoSplitPending && S.p === p) {
    S.autoSplitPending = false;
    renderSepUI();
    if (!p.segments.length) firstSplit();
  }
}

async function requestSeparation() {
  const p = S.p;
  try { p.separation = await api('POST', `/api/projects/${p.id}/separate`); } catch (e) { return toast(e.message, 6000); }
  renderSepUI();
  startSepPoll(p);
}

function sepProgressText(sep) {
  if (sep.status === 'pending') return 'Sırada bekliyor…';
  if (sep.phase === 'model') return 'Yapay zekâ modeli hazırlanıyor…';
  if (sep.phase === 'kaydet') return 'Kaydediliyor…';
  return `Ayrılıyor… %${Math.round((sep.progress || 0) * 100)}`;
}

function renderSepUI() {
  if (!S.p) return;
  const sep = S.p.separation || {}, st = sepStatus(S.p), busy = isSepBusy(S.p);
  const pct = Math.round((sep.progress || 0) * 100) + '%';

  // 1. sekmedeki bekleme kutusu
  $('#sepWait').hidden = !(S.autoSplitPending && busy);
  $('#sepWaitText').textContent = sepProgressText(sep) + ' Bitince konuşmacılar çok daha doğru bulunur.';
  $('#sepWaitBar').style.width = pct;

  // 2. sekmedeki arka plan kutusu
  const msg = {
    done: `<span class="ok">${ic('checkCircle')}Müzik, efekt ve ortam sesi hazır</span>`,
    error: `<span class="err">${ic('alert')}Ayrılamadı: ${esc(sep.error || '')}</span>`,
    unavailable: 'Ses ayırma kurulu değil (OKU-BENI dosyasına bak).',
    noaudio: 'Videoda ses yok.',
    waiting: 'Kırpma adımı bitince arka plan ayrılacak.',
    none: 'Arka plan sesleri henüz ayrılmadı.',
  }[st] || `<span>${ic('loader', 'spin')}Arka plan ${sepProgressText(sep).toLowerCase()}</span>`;
  $('#sepStatus').innerHTML = msg;
  $('#sepBar').hidden = !busy;
  $('#sepBar div').style.width = pct;
  const btn = $('#btnSep');
  btn.hidden = !['error', 'none'].includes(st);
  btn.textContent = st === 'error' ? 'Tekrar dene' : 'Arka planı ayır';
  $('#origMode option[value=bg]').disabled = st !== 'done';
  $('#bgVolRow').hidden = S.p.settings.origMode !== 'bg';
}

async function loadTakes(p) {
  await Promise.all(Object.entries(p.takes).map(async ([id, t]) => {
    try {
      const r = await fetch(`/media/${p.id}/takes/${id}.wav?v=${t.v}`);
      if (!r.ok) return;
      const buf = await ctx.decodeAudioData(await r.arrayBuffer());
      if (S.p === p && p.takes[id] === t) S.takeBufs[id] = buf;
    } catch (e) { console.warn('Kayıt yüklenemedi', id, e); }
  }));
}

async function closeProject() {
  if (!S.p) return;
  if (rec.active) cancelRecording();
  if (ask) stopAsk(false);
  clearInterval(S.pollTimer);
  video.pause();
  stopTakes();
  await flushSave();
  S.openToken++;
  S.p = null;
  video.removeAttribute('src');
  video.dataset.file = '';
  video.load();
}

let saveTimer = null, saveChain = Promise.resolve();

// Üst çubuktaki "Kaydediliyor… / ✓ Kaydedildi" göstergesi
function setSaveState(s) {
  const el = $('#saveState');
  el.className = 'saveState ' + s;
  el.innerHTML = {
    saving: `${ic('loader', 'spin')}Kaydediliyor…`,
    saved: `${ic('checkCircle')}Tüm değişiklikler kaydedildi`,
    error: `${ic('alert')}Kaydedilemedi!`,
  }[s] || '';
}
function settleSaveState() {
  if (!saveTimer && !S.uploads.size && S.p) setSaveState('saved');
}

function changed() {
  for (const id of Object.keys(S.p.takes)) {
    if (!segById(id)) { delete S.p.takes[id]; delete S.takeBufs[id]; }
  }
  setSaveState('saving');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 600);
}
function saveBody(p) {
  return { name: p.name, speakers: p.speakers, segments: p.segments, splitDone: p.splitDone, settings: p.settings };
}
function flushSave() {
  if (!saveTimer || !S.p) return saveChain;
  clearTimeout(saveTimer);
  saveTimer = null;
  const p = S.p, body = saveBody(p);
  saveChain = saveChain
    .then(() => api('PUT', `/api/projects/${p.id}`, body))
    .then(settleSaveState)
    .catch(e => { setSaveState('error'); toast('Kaydedilemedi: ' + e.message, 5000); });
  return saveChain;
}
window.addEventListener('beforeunload', () => {
  if (!saveTimer || !S.p) return;
  fetch(`/api/projects/${S.p.id}`, {
    method: 'PUT', keepalive: true, headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(saveBody(S.p)),
  });
});

function setTab(tab) {
  if (rec.active || !S.p) return;
  if (tab !== 'trim' && !S.p.trimDone) { toast('Önce kırpma adımını bitir (kırpmak istemiyorsan “Kırpmadan devam et”).'); tab = 'trim'; }
  if (tab === 'dub' && !S.p.segments.length) { toast('Önce en az bir konuşma bölümü olmalı.'); tab = 'split'; }
  if (ask) stopAsk(false);
  if (tab === 'dub' && !S.p.splitDone) { S.p.splitDone = true; changed(); }
  const wasTrim = S.tab === 'trim', loaded = !!video.dataset.file, t = video.currentTime;
  S.tab = tab;
  document.body.dataset.tab = tab;
  video.pause();
  S.stopAt = null;
  S.playMode = tab === 'dub' ? 'dub' : 'orig';
  // Kırp sekmesi kaynak videoyu gösterir; geçişte aynı kareye denk gelecek şekilde zamanı çevir
  if (tab === 'trim') useVideo(S.p.source.file, loaded && !wasTrim ? t + S.p.trim.start : null);
  else useVideo(S.p.video, loaded && wasTrim ? clamp(t - S.p.trim.start, 0, S.p.duration) : null);
  // Adım göstergesi: tamamlanan adımlarda numara yerine ✓
  const doneStep = { trim: S.p.trimDone, split: S.p.splitDone, dub: false };
  $$('.tab').forEach((b, i) => {
    const t = b.dataset.tab;
    b.classList.toggle('active', t === tab);
    b.classList.toggle('done', doneStep[t] && t !== tab);
    b.disabled = t !== 'trim' && !S.p.trimDone;
    $('.stepNum', b).innerHTML = doneStep[t] && t !== tab ? ic('check') : String(i + 1);
  });
  $('#trimPanel').hidden = tab !== 'trim';
  $('#splitPanel').hidden = tab !== 'split';
  $('#dubPanel').hidden = tab !== 'dub';
  // Seslendirme ekranı parça parça: sadece seçili replik görünür
  $('#timelineScroll').classList.toggle('clip', tab === 'dub');
  $('#dubActions').hidden = tab !== 'dub';
  $('#lineHead').hidden = tab !== 'dub';
  $('#tlHint').hidden = tab === 'dub';
  $('#tlHint').innerHTML = {
    trim: 'Mavi kenarları sürükle = kırp · boş yerde sürükle = yeni seçim · tıkla = o ana git',
    split: 'Tıkla = o ana git · boş yerde sürükle = yeni bölüm · kenarı sürükle = süreyi ayarla',
    dub: '',
  }[tab];
  if (tab === 'trim') {
    S.trim = { ...S.p.trim };
    renderTrimPanel();
    ensureSrcPeaks();
  } else if (tab === 'split') renderSplitPanel();
  else renderDubPanel();
  // Adreste sekme de dursun: sayfa yenilenince aynı yerden devam edilir
  history.replaceState(null, '', `#/p/${S.p.id}/${tab}`);
  fitZoom();
}

// ------------------------------------------------------------ 0. kırp

async function ensureSrcPeaks() {
  const p = S.p;
  if (S.srcPeaks || !p.source.analysis) return;
  try {
    const r = await fetch(`/media/${p.id}/${p.source.analysis}`);
    if (!r.ok) return;
    const a = parseWav(await r.arrayBuffer());
    if (S.p !== p) return;
    S.srcPeaks = computePeaks(a.data);
    drawTimeline();
  } catch (e) { console.warn('Kaynak ses dalgası yüklenemedi', e); }
}

const trimChanged = () => Math.abs(S.trim.start - S.p.trim.start) > 0.01 || Math.abs(S.trim.end - S.p.trim.end) > 0.01;

function renderTrimPanel() {
  const full = S.trim.start < 0.01 && S.trim.end > srcDur() - 0.01;
  $('#trimStartLbl').textContent = fmt(S.trim.start);
  $('#trimEndLbl').textContent = fmt(S.trim.end);
  $('#trimLenLbl').textContent = `${fmt(S.trim.end - S.trim.start)}  (videonun tamamı ${fmt(srcDur())})`;
  $('#btnTrimApply').innerHTML = (!S.p.trimDone
    ? (full ? 'Kırpmadan devam et' : 'Kırp ve devam et')
    : (trimChanged() ? 'Yeni kırpmayı uygula' : 'Devam et')) + ic('arrowRight');
  $('#trimNote').textContent = S.p.trimDone && trimChanged() && S.p.segments.length
    ? 'Bölümler ve kayıtlar yeni zamana kaydırılacak; seçimin dışında kalanlar silinecek. Arka plan sesi yeniden ayrılacak.'
    : '';
}

function setTrimEdge(edge, t) {
  const D = srcDur();
  t = clamp(t, 0, D);
  // Başlangıç bitişin ötesine (ya da bitiş başlangıcın gerisine) konursa diğer ucu sona/başa taşı
  if (edge === 'start') {
    if (t > S.trim.end - 0.5) S.trim.end = D;
    S.trim.start = r3(clamp(t, 0, S.trim.end - 0.5));
  } else {
    if (t < S.trim.start + 0.5) S.trim.start = 0;
    S.trim.end = r3(clamp(t, S.trim.start + 0.5, D));
  }
  renderTrimPanel();
  drawTimeline();
}

async function applyTrim() {
  const p = S.p, changedTrim = trimChanged();
  if (p.trimDone && !changedTrim) return setTab(p.splitDone && p.segments.length ? 'dub' : 'split');
  if (p.trimDone && p.segments.length && !confirm('Kırpma değişecek. Bölümler ve kayıtlar yeni zamana kaydırılacak, '
    + 'seçimin dışında kalanlar silinecek. Devam edilsin mi?')) return;
  const btn = $('#btnTrimApply');
  btn.disabled = true;
  btn.innerHTML = ic('loader', 'spin') + (changedTrim ? 'Kırpılıyor… (biraz sürebilir)' : 'Hazırlanıyor…');
  video.pause();
  try {
    await flushSave();
    await Promise.all([...S.uploads]);
    await api('POST', `/api/projects/${p.id}/trim`, { start: r3(S.trim.start), end: r3(S.trim.end) });
  } catch (e) {
    toast('Kırpılamadı: ' + e.message, 7000);
    return;
  } finally {
    btn.disabled = false;
    if (S.p === p) renderTrimPanel();
  }
  if (S.p !== p) return;
  // Proje yeni videoyla baştan yüklenir (ses ayırma ve otomatik bölme oradan devam eder)
  await closeProject();
  await openProject(p.id);
}

$('#btnTrimStart').addEventListener('click', () => setTrimEdge('start', video.currentTime));
$('#btnTrimEnd').addEventListener('click', () => setTrimEdge('end', video.currentTime));
$('#btnTrimPlayStart').addEventListener('click', () => playRange(S.trim.start, Math.min(S.trim.end, S.trim.start + 3), 'orig'));
$('#btnTrimPlayEnd').addEventListener('click', () => playRange(Math.max(S.trim.start, S.trim.end - 3), S.trim.end, 'orig'));
$('#btnTrimPlay').addEventListener('click', () => playRange(S.trim.start, S.trim.end, 'orig'));
$('#btnTrimReset').addEventListener('click', () => { S.trim = { start: 0, end: srcDur() }; renderTrimPanel(); drawTimeline(); });
$('#btnTrimApply').addEventListener('click', applyTrim);
$$('.tab').forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)));

function select(id, opts = {}) {
  S.sel = id;
  const list = S.tab === 'dub' ? $('#lineList') : $('#segList');
  for (const el of list.children) el.classList.toggle('sel', el.dataset.id === id);
  const el = id && list.querySelector(`.seg[data-id="${id}"]`);
  if (el) el.scrollIntoView({ block: 'nearest' });
  if (S.tab === 'dub') renderStage();
  // Seslendirmede zaman çizelgesi seçili repliğe yakınlaşır
  if (!opts.noFocus && focusOnSel()) return;
  const seg = selSeg();
  if (seg) {
    const x0 = seg.start * S.pps, x1 = seg.end * S.pps, sl = tlScroll.scrollLeft, cw = tlScroll.clientWidth;
    if (x0 < sl || x1 > sl + cw) tlScroll.scrollLeft = Math.max(0, x0 - 40);
  }
  drawTimeline();
}

function stepSel(d, play) {
  const list = S.tab === 'dub' ? visibleLines() : S.p.segments;
  if (!list.length) return;
  let i = list.findIndex(s => s.id === S.sel);
  i = i < 0 ? (d > 0 ? 0 : list.length - 1) : clamp(i + d, 0, list.length - 1);
  const seg = list[i];
  select(seg.id);
  if (play) playOrig(seg);
  else { video.pause(); seek(seg.start); }
}

// ------------------------------------------------------------ zaman çizelgesi

function niceStep(minSec) {
  return [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600].find(s => s >= minSec) || 600;
}

function fitZoom() {
  if (!S.p) return;
  S.ppsFit = Math.max(1, (tlScroll.clientWidth - 2) / Math.max(0.5, curDur()));
  if (!focusOnSel()) applyZoom();
}

// Bir repliğin ekranda gösterilen/oynatılan parçası: replik + kaydı, biraz payla
function clipRange(seg) {
  const tk = S.p.takes[seg.id], d = tk ? (S.takeBufs[seg.id] || tk).duration : 0;
  return [
    Math.max(0, Math.min(seg.start, tk ? tk.offset : seg.start) - 1.0),
    Math.min(S.p.duration, Math.max(seg.end, tk ? tk.offset + d : seg.end) + 0.8),
  ];
}

// Seslendirmede zaman çizelgesi sadece seçili repliğin parçasını gösterir
function focusOnSel() {
  const seg = selSeg();
  if (!seg || S.tab !== 'dub') return false;
  const [a, b] = clipRange(seg);
  const cw = tlScroll.clientWidth - 2;
  S.pps = clamp(cw / Math.max(0.5, b - a), S.ppsFit, Math.max(S.ppsFit, 30000 / S.p.duration));
  drawTimeline();
  tlScroll.scrollLeft = Math.max(0, a * S.pps - Math.max(0, (cw - (b - a) * S.pps) / 2));
  updatePlayhead(video.currentTime);
  return true;
}

function applyZoom() {
  const v = +$('#zoom').value / 100, maxPps = Math.max(S.ppsFit, 400);
  S.pps = Math.min(S.ppsFit * Math.pow(maxPps / S.ppsFit, v), Math.max(S.ppsFit, 30000 / curDur()));
  drawTimeline();
  const x = video.currentTime * S.pps;
  tlScroll.scrollLeft = Math.max(0, x - tlScroll.clientWidth / 2);
  updatePlayhead(video.currentTime);
}
$('#zoom').addEventListener('input', () => S.p && applyZoom());
window.addEventListener('resize', () => S.p && fitZoom());

// Şeritlerin yeri: üstte orijinal (bölümler + dalga), seslendirmede altta benim kayıtlarım
function lanes() {
  const dub = S.tab === 'dub', H = dub ? TL_H_DUB : TL_H, top = RULER + 6, h = dub ? 76 : H - top - 6;
  return { H, top, h, take: dub ? { top: top + h + 8, h: H - (top + h + 8) - 6 } : null };
}

// peaks'i (100 değer/sn, ilk değer t0 anında) mid çizgisi etrafına çizer
function drawWave(g, peaks, t0, W, mid, amp) {
  const pk = peaks.pk;
  const xa = Math.max(0, Math.floor(t0 * S.pps)), xb = Math.min(W, Math.ceil((t0 + pk.length / 100) * S.pps));
  for (let x = xa; x < xb; x++) {
    const i0 = Math.floor((x / S.pps - t0) * 100), i1 = Math.max(i0 + 1, Math.floor(((x + 1) / S.pps - t0) * 100));
    let m = 0;
    for (let i = Math.max(0, i0); i < i1 && i < pk.length; i++) if (pk[i] > m) m = pk[i];
    const y = Math.max(0.5, m / peaks.max * amp);
    g.fillRect(x, mid - y, 1, y * 2);
  }
}

function takePeaks(id, buf) {
  const c = S.takePk[id];
  if (c && c.buf === buf) return c.peaks;
  const peaks = computePeaks(buf.getChannelData(0), buf.sampleRate);
  S.takePk[id] = { buf, peaks };
  return peaks;
}

function drawTimeline() {
  if (!S.p) return;
  const dpr = window.devicePixelRatio || 1, dur = curDur(), trimTab = S.tab === 'trim';
  const L = lanes(), TH = L.H;
  const W = Math.max(tlScroll.clientWidth - 2, Math.ceil(dur * S.pps));
  if (tl._w !== W || tl._dpr !== dpr || tl._h !== TH) {
    tl.style.width = W + 'px';
    tl.style.height = TH + 'px';
    tl.width = Math.round(W * dpr);
    tl.height = Math.round(TH * dpr);
    tl._w = W; tl._dpr = dpr; tl._h = TH;
  }
  const g = tl.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = '#0e1016';
  g.fillRect(0, 0, W, TH);

  // cetvel
  const step = niceStep(80 / S.pps);
  g.font = '500 10.5px Inter, "Segoe UI", system-ui, sans-serif';
  g.textBaseline = 'middle';
  for (let i = 0; i * step <= dur + 1e-6; i++) {
    const t = i * step, x = Math.round(t * S.pps);
    g.fillStyle = '#262a38'; g.fillRect(x, 0, 1, RULER);
    g.fillStyle = '#6c7489'; g.fillText(fmtRuler(t, step), x + 5, RULER / 2 + 1);
  }
  g.fillStyle = '#232735';
  g.fillRect(0, RULER, W, 1);
  const endX = dur * S.pps;
  if (endX < W) { g.fillStyle = 'rgba(0,0,0,.4)'; g.fillRect(endX, RULER, W - endX, TH); }

  const top = L.top, h = L.h;
  const done = s => S.tab === 'dub' && S.p.takes[s.id];
  if (!trimTab) {
    for (const s of S.p.segments) {
      const x = s.start * S.pps, w = Math.max(2, (s.end - s.start) * S.pps);
      g.fillStyle = spk(s.spk).color;
      g.globalAlpha = done(s) ? 0.55 : 0.22;
      g.fillRect(x, top, w, h);
      g.globalAlpha = 1;
      g.fillRect(x, top, w, 3);
    }
  }
  // dalga formu
  const peaks = trimTab ? S.srcPeaks : S.peaks;
  if (peaks) {
    g.fillStyle = 'rgba(214,220,240,.55)';
    drawWave(g, peaks, 0, W, top + h / 2, h / 2 - 3);
  }
  if (trimTab) {
    // seçilmeyen kısımları karart, seçimi mavi çerçeve ve tutamaçlarla göster
    const a = S.trim.start * S.pps, b = S.trim.end * S.pps;
    g.fillStyle = 'rgba(0,0,0,.62)';
    g.fillRect(0, RULER + 1, a, TH - RULER - 1);
    g.fillRect(b, RULER + 1, W - b, TH - RULER - 1);
    g.strokeStyle = '#7c6cff';
    g.lineWidth = 2;
    g.strokeRect(a, top - 3, Math.max(2, b - a), h + 6);
    for (const x of [a, b]) {
      g.fillStyle = '#7c6cff';
      g.fillRect(x - 5, top - 3, 10, h + 6);
      g.fillStyle = '#fff';
      g.fillRect(x - 1, top + h / 2 - 9, 2, 18);
    }
    if (b - a > 70) {
      g.fillStyle = '#fff';
      g.font = '600 11px system-ui, sans-serif';
      g.textBaseline = 'top';
      g.fillText(fmt(S.trim.end - S.trim.start), a + 9, top + 3);
    }
    return;
  }
  // etiketler ve seçim çerçevesi
  g.textBaseline = 'top';
  g.font = '600 11px Inter, "Segoe UI", system-ui, sans-serif';
  S.p.segments.forEach((s, i) => {
    const x = s.start * S.pps, w = (s.end - s.start) * S.pps;
    if (w > 26) {
      g.save();
      g.beginPath(); g.rect(x, top, w, h); g.clip();
      g.fillStyle = '#fff'; g.shadowColor = '#000'; g.shadowBlur = 3;
      g.fillText(`${i + 1} · ${spk(s.spk).name}${done(s) ? ' ✓' : ''}`, x + 5, top + 7);
      g.restore();
    }
    if (s.id === S.sel) {
      g.strokeStyle = '#fff'; g.lineWidth = 2;
      g.strokeRect(x + 1, top + 1, Math.max(2, w - 2), h - 2);
    }
  });
  if (L.take) drawTakeLane(g, W, L.take);
}

// Alt şerit: kayıtlarım, videodaki yerlerinde (fareyle sürüklenebilir)
function drawTakeLane(g, W, L) {
  g.fillStyle = '#13151d';
  g.fillRect(0, L.top - 3, W, L.h + 6);
  for (const [id, tk] of Object.entries(S.p.takes)) {
    const seg = segById(id);
    if (!seg) continue;
    const buf = S.takeBufs[id], d = (buf || tk).duration;
    const x = tk.offset * S.pps, w = Math.max(3, d * S.pps);
    g.fillStyle = spk(seg.spk).color;
    g.globalAlpha = id === S.sel ? 0.6 : 0.35;
    g.fillRect(x, L.top, w, L.h);
    g.globalAlpha = 1;
    if (buf) {
      g.fillStyle = 'rgba(255,255,255,.8)';
      drawWave(g, takePeaks(id, buf), tk.offset, W, L.top + L.h / 2, L.h / 2 - 3);
    }
    if (id === S.sel) {
      g.strokeStyle = '#fff'; g.lineWidth = 2;
      g.strokeRect(x + 1, L.top + 1, w - 2, L.h - 2);
    }
  }
}

function updatePlayhead(t) {
  const x = t * S.pps;
  playhead.style.transform = `translateX(${x}px)`;
  // Seslendirmede görünüm replikte sabit kalır (tüm video izlenirken ekran repliği takip eder)
  if (!video.paused && S.tab !== 'dub') {
    const sl = tlScroll.scrollLeft, cw = tlScroll.clientWidth;
    if (x < sl || x > sl + cw - 40) tlScroll.scrollLeft = Math.max(0, x - cw * 0.2);
  }
}

// --- fare ile düzenleme
let drag = null;
const xToTime = e => clamp((e.clientX - tl.getBoundingClientRect().left) / S.pps, 0, curDur());

// Kırp sekmesi: imleç bir tutamacın üstünde mi?
function trimHit(e) {
  const x = e.clientX - tl.getBoundingClientRect().left;
  const da = Math.abs(x - S.trim.start * S.pps), db = Math.abs(x - S.trim.end * S.pps);
  if (Math.min(da, db) > 9) return null;
  return da <= db ? 'start' : 'end';
}

// Seslendirme sekmesi: imleç alt şeritte bir kaydın üstünde mi?
function takeHit(e) {
  if (S.tab !== 'dub') return null;
  const r = tl.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top, L = lanes().take;
  if (y < L.top - 3 || y > L.top + L.h + 3) return null;
  let found = null;
  for (const [id, tk] of Object.entries(S.p.takes)) {
    const seg = segById(id), d = (S.takeBufs[id] || tk).duration;
    if (seg && x >= tk.offset * S.pps && x <= (tk.offset + d) * S.pps) {
      found = { seg };
      if (id === S.sel) break; // üst üste binenlerde seçili olan öncelikli
    }
  }
  return found;
}

function hitTest(e) {
  const x = e.clientX - tl.getBoundingClientRect().left;
  if (S.tab === 'split') {
    let best = null;
    for (const s of S.p.segments) {
      for (const edge of ['start', 'end']) {
        const d = Math.abs(x - s[edge] * S.pps);
        if (d <= 6 && (!best || d < best.d)) best = { seg: s, edge, d };
      }
    }
    if (best) return best;
  }
  const seg = S.p.segments.find(s => x >= s.start * S.pps && x <= s.end * S.pps);
  return seg ? { seg } : null;
}

// t anını içeren boş aralık [önceki bölümün sonu, sonraki bölümün başı]
function freeRange(t, ignore) {
  let lo = 0, hi = S.p.duration;
  for (const s of S.p.segments) {
    if (s === ignore) continue;
    if (s.end <= t + 1e-6) lo = Math.max(lo, s.end);
    if (s.start >= t - 1e-6) hi = Math.min(hi, s.start);
  }
  return [lo, hi];
}

tl.addEventListener('pointerdown', e => {
  if (!S.p || rec.active || e.button !== 0) return;
  if (ask) stopAsk(false);
  const t = xToTime(e);
  tl.setPointerCapture(e.pointerId);
  if (S.tab === 'trim') {
    const edge = trimHit(e);
    video.pause();
    if (edge) { drag = { kind: 'trimEdge', edge }; seek(S.trim[edge]); }
    else { drag = { kind: 'trimNew', t0: t, x0: e.clientX }; seek(t); }
    return;
  }
  const th = takeHit(e);
  if (th) {
    drag = { kind: 'take', seg: th.seg, x0: e.clientX, off0: S.p.takes[th.seg.id].offset, moved: false };
    tl.style.cursor = 'grabbing';
    if (S.sel !== th.seg.id) select(th.seg.id, { noFocus: true });
    return;
  }
  const hit = hitTest(e);
  if (hit && hit.edge) {
    drag = { kind: 'edge', seg: hit.seg, edge: hit.edge };
    select(hit.seg.id);
  } else if (hit) {
    drag = { kind: 'none' };
    select(hit.seg.id);
    seek(t);
  } else {
    drag = { kind: 'new', t0: t, x0: e.clientX, seg: null };
    select(null);
    seek(t);
  }
});

tl.addEventListener('pointermove', e => {
  if (!S.p) return;
  if (!drag) {
    let cur = 'pointer';
    if (S.tab === 'trim') { if (trimHit(e)) cur = 'ew-resize'; }
    else if (takeHit(e)) cur = 'grab';
    else if ((hitTest(e) || {}).edge) cur = 'ew-resize';
    tl.style.cursor = cur;
    return;
  }
  const t = xToTime(e);
  if (drag.kind === 'trimNew' && Math.abs(e.clientX - drag.x0) > 6) drag.kind = 'trimSel';
  if (drag.kind === 'take') {
    const dx = e.clientX - drag.x0;
    if (Math.abs(dx) > 3) drag.moved = true;
    if (drag.moved) setTakeOffset(drag.seg, drag.off0 + dx / S.pps, false);
  } else if (drag.kind === 'trimEdge') {
    setTrimEdge(drag.edge, t);
    seek(S.trim[drag.edge]); // sürüklerken o karenin görüntüsünü göster
  } else if (drag.kind === 'trimSel') {
    S.trim.start = r3(Math.min(drag.t0, t));
    S.trim.end = r3(Math.max(drag.t0, t));
    seek(t);
    renderTrimPanel();
    drawTimeline();
  } else if (drag.kind === 'edge') {
    const s = drag.seg, [lo, hi] = freeRange((s.start + s.end) / 2, s);
    if (drag.edge === 'start') s.start = r3(clamp(t, lo, s.end - 0.1));
    else s.end = r3(clamp(t, s.start + 0.1, hi));
    drawTimeline();
  } else if (drag.kind === 'new' && S.tab === 'split') {
    if (!drag.seg && Math.abs(e.clientX - drag.x0) > 6) {
      const [lo, hi] = freeRange(drag.t0);
      drag.lo = lo; drag.hi = hi;
      drag.seg = { id: uid(), start: drag.t0, end: drag.t0, spk: guessSpk(drag.t0), text: '' };
      S.p.segments.push(drag.seg);
      sortSegs();
    }
    if (drag.seg) {
      drag.seg.start = r3(clamp(Math.min(drag.t0, t), drag.lo, drag.hi));
      drag.seg.end = r3(clamp(Math.max(drag.t0, t), drag.lo, drag.hi));
      drawTimeline();
    }
  }
});

tl.addEventListener('pointerup', () => {
  if (!drag) return;
  const d = drag;
  drag = null;
  if (d.kind === 'take') {
    tl.style.cursor = 'grab';
    const tk = S.p.takes[d.seg.id];
    if (d.moved && tk) setTakeOffset(d.seg, tk.offset);
    else if (tk) { video.pause(); seek(tk.offset); }
  }
  if (d.kind === 'trimSel' && S.trim.end - S.trim.start < 0.5) {
    S.trim.end = Math.min(srcDur(), S.trim.start + 0.5);
    renderTrimPanel();
    drawTimeline();
  }
  if (d.kind === 'edge') { changed(); renderSegList(); select(d.seg.id); }
  if (d.kind === 'new' && d.seg) {
    if (d.seg.end - d.seg.start < 0.15) removeSeg(d.seg);
    else { changed(); renderSegList(); select(d.seg.id); }
  }
});

// ------------------------------------------------------------ 1. konuşmacıları ayır

// Yeni bölüm için tahmin: bir önceki konuşanın karşısındaki kişi
function guessSpk(t) {
  const prev = S.p.segments.filter(s => s.end <= t).pop();
  return prev ? (prev.spk + 1) % S.p.speakers.length : 0;
}

function renderSplitPanel() {
  $('#speakerCount').value = S.p.speakers.length;
  $('#speakerNames').innerHTML = S.p.speakers.map((s, i) => `
    <label class="spkName"><span class="dot" style="background:${s.color}"></span>
      <input data-spk="${i}" value="${esc(s.name)}" maxlength="24" placeholder="İsim"><kbd>${i + 1}</kbd></label>`).join('');
  renderSegList();
}

function renderSegList() {
  const el = $('#segList');
  if (!S.p.segments.length) {
    el.innerHTML = '<p class="empty">Bölüm yok. “Otomatik ayır”a bas ya da zaman çizelgesinde sürükleyerek bölüm ekle.</p>';
    return;
  }
  el.innerHTML = S.p.segments.map((s, i) => `
    <div class="seg${s.id === S.sel ? ' sel' : ''}" data-id="${s.id}" style="--c:${spk(s.spk).color}">
      <div class="segTop">
        <span class="num">${i + 1}</span>
        <span class="time">${fmt(s.start)} – ${fmt(s.end)}</span>
        <span class="spkBtns">${S.p.speakers.map((sp, k) =>
          `<button data-act="spk" data-k="${k}" class="spkBtn${k === s.spk ? ' on' : ''}" style="--c:${sp.color}" title="${esc(sp.name)}">${k + 1}</button>`).join('')}</span>
        <button data-act="play" class="iconBtn segIcon" title="Dinle">${ic('play')}</button>
        <button data-act="del" class="iconBtn segIcon" title="Sil">${ic('x')}</button>
      </div>
      <input class="segText" value="${esc(s.text || '')}" placeholder="Replik metni (isteğe bağlı)">
    </div>`).join('');
}

$('#segList').addEventListener('click', e => {
  const row = e.target.closest('.seg');
  const seg = row && segById(row.dataset.id);
  if (!seg) return;
  const b = e.target.closest('button'), act = b && b.dataset.act;
  if (act === 'spk') return setSpk(seg, +b.dataset.k, false);
  if (act === 'play') { select(seg.id); return playOrig(seg); }
  if (act === 'del') return deleteSeg(seg);
  if (e.target.matches('input')) { if (S.sel !== seg.id) select(seg.id); return; }
  select(seg.id);
  video.pause();
  seek(seg.start);
});
$('#segList').addEventListener('input', e => {
  if (!e.target.matches('.segText')) return;
  const seg = segById(e.target.closest('.seg').dataset.id);
  if (seg) { seg.text = e.target.value; changed(); }
});
$('#speakerNames').addEventListener('input', e => {
  const i = e.target.dataset.spk;
  if (i == null) return;
  S.p.speakers[i].name = e.target.value || `Kişi ${+i + 1}`;
  changed();
  drawTimeline();
});
$('#speakerCount').addEventListener('change', e => {
  const n = +e.target.value, sp = S.p.speakers;
  while (sp.length < n) sp.push(mkSpeaker(sp.length));
  sp.length = n;
  S.p.segments.forEach(s => { if (s.spk >= n) s.spk = n - 1; });
  changed();
  renderSplitPanel();
  drawTimeline();
  if (S.audio) toast('Kişi sayısı değişti. Yeniden ayırmak için “Otomatik ayır”a bas.', 4500);
});

function setSpk(seg, k, advance) {
  if (k >= S.p.speakers.length) return;
  seg.spk = k;
  changed();
  renderSegList();
  if (advance) {
    const next = S.p.segments[S.p.segments.indexOf(seg) + 1];
    if (next) { select(next.id); playOrig(next); return; }
    toast('Son bölüm. Bitince “Tamam, seslendirmeye geç”e bas.');
  }
  select(seg.id);
}

function removeSeg(seg) {
  const i = S.p.segments.indexOf(seg);
  if (i < 0) return;
  S.p.segments.splice(i, 1);
  if (S.sel === seg.id) S.sel = (S.p.segments[i] || S.p.segments[i - 1] || {}).id || null;
  changed();
  renderSegList();
  select(S.sel);
}

function deleteSeg(seg) {
  if (S.p.takes[seg.id] && !confirm('Bu bölümün kaydı da silinecek. Devam edilsin mi?')) return;
  removeSeg(seg);
}

function addSegAt(t) {
  if (segAt(t)) return toast('Burada zaten bir bölüm var. Boş bir yere git.');
  const [, hi] = freeRange(t);
  const end = Math.min(hi, t + 1.5);
  if (end - t < 0.2) return toast('Burada yeni bölüm için yer yok.');
  const seg = { id: uid(), start: r3(t), end: r3(end), spk: guessSpk(t), text: '' };
  S.p.segments.push(seg);
  sortSegs();
  changed();
  renderSegList();
  select(seg.id);
}

function splitAtPlayhead() {
  const t = video.currentTime, seg = segAt(t);
  if (!seg || t - seg.start < 0.1 || seg.end - t < 0.1) {
    return toast('Önce oynatma çizgisini (sarı) bölmek istediğin bölümün içine getir.');
  }
  const part = { id: uid(), start: r3(t), end: seg.end, spk: (seg.spk + 1) % S.p.speakers.length, text: '' };
  seg.end = r3(t);
  S.p.segments.push(part);
  sortSegs();
  changed();
  renderSegList();
  select(part.id);
}

function mergeNext(seg) {
  const next = S.p.segments[S.p.segments.indexOf(seg) + 1];
  if (!next) return toast('Bu bölümden sonra bölüm yok.');
  seg.end = next.end;
  seg.text = [seg.text, next.text].filter(Boolean).join(' ');
  removeSeg(next);
  select(seg.id);
}

async function autoSplit(initial) {
  if (!S.audio) return toast('Videoda ses olmadığı için otomatik ayırma yapılamıyor.');
  if (!initial && S.p.segments.length) {
    const hasTakes = Object.keys(S.p.takes).length > 0;
    if (!confirm('Mevcut bölümler silinip yeniden otomatik ayrılacak.'
      + (hasTakes ? ' Yaptığın kayıtlar da silinecek!' : '') + ' Devam edilsin mi?')) return;
  }
  if (ask) stopAsk(false);
  toast('Konuşmalar analiz ediliyor…', 0);
  await new Promise(r => setTimeout(r, 50));
  const p = S.p;
  let found;
  try { found = Analyzer.split(S.audio.data, S.audio.sr, p.speakers.length); } catch (e) {
    console.error(e);
    return toast('Analiz hatası: ' + e.message, 5000);
  }
  if (S.p !== p) return;
  p.segments = found.map(s => ({ id: uid(), start: r3(s.start), end: r3(s.end), spk: Math.min(s.spk, p.speakers.length - 1), text: '' }));
  S.sel = null;
  changed();
  renderSegList();
  drawTimeline();
  toast(found.length ? `${found.length} konuşma bölümü bulundu.` : 'Konuşma bulunamadı; bölümleri elle ekle.', 4000);
}

$('#btnAuto').addEventListener('click', () => autoSplit(false));
$('#btnAsk').addEventListener('click', () => startAsk(Math.max(0, S.p.segments.findIndex(s => s.id === S.sel))));
$('#btnAdd').addEventListener('click', () => addSegAt(video.currentTime));
$('#btnSplitAt').addEventListener('click', splitAtPlayhead);
$('#btnMerge').addEventListener('click', () => { const s = selSeg(); s ? mergeNext(s) : toast('Önce bir bölüm seç.'); });
$('#btnDelete').addEventListener('click', () => { const s = selSeg(); s ? deleteSeg(s) : toast('Önce bir bölüm seç.'); });
$('#btnSplitDone').addEventListener('click', () => setTab('dub'));

// --- "Bu kim konuşuyor?" (tek tek sorma modu)
function startAsk(i) {
  if (!S.p.segments.length) return toast('Önce bölüm oluştur (“Otomatik ayır” ya da zaman çizelgesinde sürükle).');
  ask = { i: clamp(i, 0, S.p.segments.length - 1) };
  showAsk();
}
function showAsk() {
  const seg = S.p.segments[ask.i];
  if (!seg) return stopAsk(true);
  select(seg.id);
  $('#askBox').hidden = false;
  $('#askTitle').textContent = `Bölüm ${ask.i + 1} / ${S.p.segments.length} — kim konuşuyor?`;
  $('#askBtns').innerHTML = S.p.speakers.map((sp, k) =>
    `<button data-k="${k}" class="askBtn${k === seg.spk ? ' guess' : ''}" style="--c:${sp.color}">
      <span class="dot" style="background:${sp.color}"></span>${esc(sp.name)}<kbd>${k + 1}</kbd></button>`).join('');
  $('#askBack').disabled = ask.i === 0;
  playOrig(seg);
}
function answerAsk(k) {
  const seg = S.p.segments[ask.i];
  if (!seg) return;
  seg.spk = k;
  changed();
  renderSegList();
  ask.i++;
  showAsk();
}
function stopAsk(finished) {
  ask = null;
  $('#askBox').hidden = true;
  video.pause();
  if (finished) toast('Hepsi tamam! Şimdi “Tamam, seslendirmeye geç”e bas.', 5000);
}
$('#askBtns').addEventListener('click', e => { const b = e.target.closest('button'); if (b && ask) answerAsk(+b.dataset.k); });
$('#askReplay').addEventListener('click', () => ask && showAsk());
$('#askBack').addEventListener('click', () => { if (ask && ask.i > 0) { ask.i--; showAsk(); } });
$('#askRemove').addEventListener('click', () => {
  if (!ask) return;
  const seg = S.p.segments[ask.i];
  if (seg) removeSeg(seg);
  showAsk();
});
$('#askClose').addEventListener('click', () => stopAsk(false));

// ------------------------------------------------------------ 2. seslendir

const visibleLines = () => S.p.segments.filter(s => S.roleFilter === 'all' || s.spk === +S.roleFilter);
const firstPending = () => { const l = visibleLines(); return l.find(s => !S.p.takes[s.id]) || l[0] || null; };

function renderDubPanel() {
  const rf = $('#roleFilter');
  rf.innerHTML = '<option value="all">Herkesi</option>'
    + S.p.speakers.map((s, i) => `<option value="${i}">${esc(s.name)}</option>`).join('');
  if (S.roleFilter !== 'all' && +S.roleFilter >= S.p.speakers.length) S.roleFilter = 'all';
  rf.value = S.roleFilter;

  const om = $('#origMode');
  om.disabled = !S.p.hasAudio;
  om.value = S.p.settings.origMode;
  $('#bgVol').value = Math.round((S.p.settings.bgVolume ?? 1) * 100);
  $('#bgVolVal').textContent = $('#bgVol').value + '%';
  renderSepUI();
  $('#preroll').value = String(prefs.preroll);
  $('#autoListen').checked = prefs.autoListen;
  $('#autoAlign').checked = prefs.autoAlign;
  $('#hearOrig').checked = prefs.hearOrig;
  $('#hearOthers').checked = prefs.hearOthers;
  $('#latency').value = prefs.latencyMs;
  $('#latencyVal').textContent = prefs.latencyMs + ' ms';
  $('#btnMic').hidden = !!micStream;
  renderLines();
  if (!visibleLines().some(s => s.id === S.sel)) {
    const f = firstPending();
    S.sel = f ? f.id : null;
  }
  select(S.sel);
}

// Sağ paneldeki kısa replik listesi (ayrıntılar); işlemler ortadaki ekranda
function renderLines() {
  const lines = visibleLines(), done = lines.filter(s => S.p.takes[s.id]).length;
  $('#progress').textContent = `${done} / ${lines.length} kaydedildi`;
  $('#progressFill').style.width = (lines.length ? done / lines.length * 100 : 0) + '%';
  $('#lineList').innerHTML = lines.map(s => {
    const has = !!S.p.takes[s.id];
    return `<div class="seg line${s.id === S.sel ? ' sel' : ''}${has ? ' done' : ''}" data-id="${s.id}" style="--c:${spk(s.spk).color}">
      <span class="lnNum">${S.p.segments.indexOf(s) + 1}</span>
      <div class="lnBody">
        <div class="lnTop"><b>${esc(spk(s.spk).name)}</b><span class="time">${fmt(s.start)}</span></div>
        <div class="lnText">${s.text ? esc(s.text) : `${(s.end - s.start).toFixed(1)} sn`}</div>
      </div>
      <span class="lnState" title="${has ? 'Kaydedildi' : 'Kaydedilmedi'}">${has ? ic('check') : ''}</span>
    </div>`;
  }).join('') || '<p class="empty">Bu kişiye ait replik yok.</p>';
}

const fmtShift = d => `${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(2)} sn`;
const takeShift = seg => { const tk = S.p.takes[seg.id]; return tk ? tk.offset - (tk.recOffset ?? tk.offset) : 0; };

function renderSyncInfo() {
  const seg = selSeg();
  if (seg) $('#syncVal').textContent = fmtShift(takeShift(seg));
}

// Ortadaki ekran: üzerinde çalışılan replik ve onun işlemleri
function renderStage() {
  const seg = selSeg();
  $('#lineHead').hidden = !seg;
  $('#dubActions').hidden = !seg;
  if (!seg) return;
  const list = visibleLines(), i = list.indexOf(seg), sp = spk(seg.spk), has = !!S.p.takes[seg.id];
  $('#lhNum').textContent = S.p.segments.indexOf(seg) + 1;
  $('#lhTotal').textContent = S.p.segments.length;
  $('#lhWho').innerHTML = `<span class="dot" style="background:${sp.color}"></span>${esc(sp.name)}`;
  $('#lhTime').textContent = `${fmt(seg.start)} – ${fmt(seg.end)} · ${(seg.end - seg.start).toFixed(1)} sn`;
  const st = $('#lhStatus');
  st.className = 'status ' + (has ? 'ok' : 'todo');
  st.innerHTML = has ? `${ic('check')}Kaydedildi` : 'Kaydedilmedi';
  $('#lhText').innerHTML = seg.text
    ? `“${esc(seg.text)}”`
    : '<span class="muted">Replik metni yok — önce orijinali dinle, sonra aynı repliği kendi sesinle söyle.</span>';
  $('#lhPrev').disabled = i <= 0;
  $('#lhNext').disabled = i < 0 || i >= list.length - 1;
  $('#actMine').disabled = !has;
  $('#syncBar').hidden = !has;
  $('#syncEmpty').hidden = has;
  renderSyncInfo();
  updateRecButton();
}

// Kaydı zaman çizelgesinde kaydırır; final=false iken (sürüklerken) sadece ekranı günceller
function setTakeOffset(seg, offset, final = true) {
  const tk = S.p.takes[seg.id];
  if (!tk) return;
  const d = (S.takeBufs[seg.id] || tk).duration;
  tk.offset = Math.round(clamp(offset, 0.1 - d, S.p.duration - 0.1) * 10000) / 10000;
  drawTimeline();
  renderSyncInfo();
  if (!final) return;
  if (!video.paused && S.playMode === 'dub') scheduleTakes();
  const p = S.p;
  clearTimeout(tk._timer);
  setSaveState('saving');
  tk._timer = setTimeout(async () => {
    try {
      await Promise.all([...S.uploads]); // kayıt dosyası sunucuya ulaşmadan yeri yazılamaz
      await api('POST', `/api/projects/${p.id}/takes/${seg.id}/offset`, { offset: tk.offset });
      settleSaveState();
    } catch (e) { setSaveState('error'); toast('Kaydın yeri kaydedilemedi: ' + e.message, 5000); }
  }, 400);
}

function autoAlignTake(seg) {
  const tk = S.p.takes[seg.id], buf = S.takeBufs[seg.id];
  if (!tk || !buf) return;
  if (!S.audio) return toast('Orijinal ses yüklenmediği için hizalanamıyor.');
  const a = Analyzer.align(S.audio.data, S.audio.sr, seg, buf.getChannelData(0), buf.sampleRate, tk.offset);
  if (a == null) return toast('Orijinal konuşmayla eşleşme bulunamadı; kaydını alt şeritte elle sürükle.', 5000);
  setTakeOffset(seg, a);
  toast(`🎯 Hizalandı (kaydettiğin ana göre ${fmtShift(takeShift(seg))})`);
}

function goToLine(seg) {
  if (!seg || rec.active) return;
  video.pause();
  select(seg.id);
  seek(seg.start);
}

$('#lineList').addEventListener('click', e => {
  const row = e.target.closest('.seg');
  goToLine(row && segById(row.dataset.id));
});

// Ortadaki işlem butonları (seçili replik için)
const withSel = fn => () => { const seg = selSeg(); if (seg && !rec.active) fn(seg); };
$('#actOrig').addEventListener('click', withSel(playOrig));
$('#actMine').addEventListener('click', withSel(playMine));
$('#actAlign').addEventListener('click', withSel(autoAlignTake));
$('#actReset').addEventListener('click', withSel(seg => {
  const tk = S.p.takes[seg.id];
  if (tk) setTakeOffset(seg, tk.recOffset ?? tk.offset);
}));
$('#actDelTake').addEventListener('click', withSel(deleteTake));
$$('#syncBar [data-nudge]').forEach(b => b.addEventListener('click', withSel(seg => {
  const tk = S.p.takes[seg.id];
  if (tk) setTakeOffset(seg, tk.offset + +b.dataset.nudge);
})));
$('#lhPrev').addEventListener('click', () => !rec.active && stepSel(-1, false));
$('#lhNext').addEventListener('click', () => !rec.active && stepSel(1, false));

$('#roleFilter').addEventListener('change', e => { S.roleFilter = e.target.value; renderDubPanel(); });
$('#origMode').addEventListener('change', e => {
  S.p.settings.origMode = e.target.value;
  S.p.settings.modeChosen = true;
  changed();
  renderSepUI();
  if (!video.paused) scheduleTakes();
});
$('#bgVol').addEventListener('input', e => {
  S.p.settings.bgVolume = +e.target.value / 100;
  $('#bgVolVal').textContent = e.target.value + '%';
  changed();
});
$('#btnSep').addEventListener('click', requestSeparation);
$('#btnNoWait').addEventListener('click', () => {
  S.autoSplitPending = false;
  renderSepUI();
  firstSplit();
});
$('#preroll').addEventListener('change', e => { prefs.preroll = +e.target.value; savePrefs(); });
for (const k of ['autoListen', 'autoAlign', 'hearOrig', 'hearOthers']) {
  $('#' + k).addEventListener('change', e => { prefs[k] = e.target.checked; savePrefs(); });
}
$('#latency').addEventListener('input', e => {
  prefs.latencyMs = +e.target.value;
  $('#latencyVal').textContent = prefs.latencyMs + ' ms';
  savePrefs();
});
$('#btnMic').addEventListener('click', () => ensureMic());
$('#btnRecord').addEventListener('click', () => rec.active ? finishRecording() : startRecording(selSeg() || firstPending()));
function watchFromStart(mode) {
  if (rec.active) return;
  S.stopAt = null;
  S.playMode = mode;
  video.currentTime = 0;
  video.play().then(() => { S.fullPreview = true; }).catch(() => { });
}
$('#btnPreview').addEventListener('click', () => watchFromStart('dub'));
$('#btnPreviewOrig').addEventListener('click', () => watchFromStart('orig'));

// Orijinal ses ↔ benim sesim (izlerken anında geçer)
function setListenMode(mode) {
  if (rec.active || S.tab !== 'dub') return;
  S.playMode = mode;
  if (!video.paused) scheduleTakes();
}
$('#modeSwitch').addEventListener('click', e => {
  const b = e.target.closest('button[data-mode]');
  if (b) setListenMode(b.dataset.mode);
});

let modeKey = '';
function updateModeUI() {
  const key = `${S.tab}|${rec.active}|${S.playMode}`;
  if (key === modeKey) return;
  modeKey = key;
  const dub = S.tab === 'dub';
  $('#modeSwitch').hidden = !dub;
  $$('#modeSwitch button').forEach(b => b.classList.toggle('on', b.dataset.mode === S.playMode));
  $('#zoomLbl').hidden = dub; // seslendirmede çizelge hep repliğe odaklı
  $('#laneLabels').hidden = !dub;
  const badge = $('#modeBadge');
  badge.hidden = !dub || rec.active;
  badge.className = 'modeBadge ' + S.playMode;
  badge.innerHTML = S.playMode === 'orig' ? `${ic('volume')}ORİJİNAL SES` : `${ic('mic')}BENİM SESİM`;
}
$('#btnExport').addEventListener('click', exportVideo);
$('#btnPlay').addEventListener('click', togglePlay);

async function deleteTake(seg) {
  if (!S.p.takes[seg.id] || !confirm('Bu replik kaydı silinsin mi?')) return;
  delete S.p.takes[seg.id];
  delete S.takeBufs[seg.id];
  renderLines();
  renderStage();
  focusOnSel() || drawTimeline();
  setSaveState('saving');
  api('DELETE', `/api/projects/${S.p.id}/takes/${seg.id}`)
    .then(settleSaveState)
    .catch(e => { setSaveState('error'); toast(e.message); });
}

// --- kayıt
async function startRecording(seg) {
  if (rec.active || !seg || !S.p) return;
  if (!(await ensureMic())) return;
  if (ctx.state !== 'running') await ctx.resume();
  video.pause();
  S.stopAt = null;
  const startPos = Math.max(0, seg.start - prefs.preroll);
  Object.assign(rec, { active: true, phase: 'seek', seg, p: S.p, startPos, chunks: [], diffs: [] });
  S.playMode = 'rec';
  select(seg.id);
  document.body.classList.add('recording');
  const sp = spk(seg.spk);
  $('#recOverlay').hidden = false;
  $('#recOverlay').classList.remove('live');
  $('#recWho').textContent = sp.name;
  $('#recWho').style.color = sp.color;
  $('#recText').textContent = seg.text || '';
  $('#recBarFill').style.width = '0%';
  $('#recCount').textContent = '';
  updateRecButton();
  video.currentTime = startPos;
  await once(video, 'seeked');
  if (!rec.active || rec.seg !== seg) return;
  // Replikten önce yeterli video yoksa, video durmuş haldeyken geri sayım yapılır
  rec.waitUntil = performance.now() + Math.max(0, prefs.preroll - (seg.start - startPos)) * 1000;
  rec.phase = 'wait';
}

function showCountdown(sec) {
  const el = $('#recCount');
  el.classList.remove('go');
  el.textContent = Math.max(1, Math.ceil(sec - 0.05));
  $('#recOverlay').classList.remove('live');
}

function recTick(t) {
  const seg = rec.seg;
  if (rec.phase === 'seek' || rec.phase === 'starting') return;
  if (rec.phase === 'wait') {
    const left = (rec.waitUntil - performance.now()) / 1000;
    showCountdown(left + (seg.start - rec.startPos));
    if (left <= 0) {
      rec.phase = 'starting';
      recNode.port.postMessage(true);
      video.play()
        .then(() => { if (rec.active && rec.seg === seg) rec.phase = 'run'; })
        .catch(() => cancelRecording('Video oynatılamadı.'));
    }
    return;
  }
  // Video zamanı ile ses saatinin farkı: kaydı videoya hizalamak için
  if (!video.paused && video.readyState >= 3) rec.diffs.push(t - ctx.currentTime);
  const toGo = seg.start - t;
  if (toGo > 0) showCountdown(toGo);
  else {
    const el = $('#recCount');
    if (!el.classList.contains('go')) {
      el.classList.add('go');
      el.textContent = 'KONUŞ';
      $('#recOverlay').classList.add('live');
    }
    $('#recBarFill').style.width = clamp((t - seg.start) / (seg.end - seg.start), 0, 1) * 100 + '%';
  }
  if (t >= Math.min(seg.end + TAIL, S.p.duration - 0.03) || video.ended) finishRecording();
}

function endRecording() {
  rec.active = false;
  rec.phase = null;
  S.playMode = S.tab === 'dub' ? 'dub' : 'orig';
  document.body.classList.remove('recording');
  $('#recOverlay').hidden = true;
  updateRecButton();
}

function cancelRecording(msg) {
  if (!rec.active) return;
  if (recNode) recNode.port.postMessage(false);
  endRecording();
  video.pause();
  toast(msg || 'Kayıt iptal edildi.');
}

function finishRecording() {
  if (!rec.active) return;
  if (rec.phase !== 'run') return cancelRecording();
  recNode.port.postMessage(false);
  const { seg, chunks, diffs, p } = rec;
  endRecording();
  video.pause();
  if (!chunks.length || diffs.length < 3) return toast('Kayıt alınamadı, tekrar dene.');

  diffs.sort((a, b) => a - b);
  const diff = diffs[diffs.length >> 1];
  const sr = ctx.sampleRate;
  const total = chunks.reduce((n, c) => n + c.d.length, 0);
  const all = new Float32Array(total);
  let o = 0;
  for (const c of chunks) { all.set(c.d, o); o += c.d.length; }
  // İlk örneğin video zamanı (gecikme düzeltmesi dahil)
  const v0 = chunks[0].t + diff - prefs.latencyMs / 1000;
  const want0 = Math.max(0, seg.start - LEAD), want1 = Math.min(p.duration, seg.end + TAIL);
  const i0 = Math.max(0, Math.round((want0 - v0) * sr));
  const i1 = Math.min(total, Math.round((want1 - v0) * sr));
  if (i1 - i0 < sr * 0.2) return toast('Kayıt çok kısa, tekrar dene.');
  // Baştaki ve sondaki sessizliği kes (kayıt bilerek geniş alınıyor)
  const cut = Analyzer.trimSilence(all.slice(i0, i1), sr);
  const pcm = cut.pcm, recOffset = v0 + i0 / sr + cut.start;

  // Kenarlarda yumuşak geçiş + sesi biraz yükselt (en fazla 4 kat)
  const fade = Math.min(pcm.length >> 2, Math.round(sr * 0.01));
  for (let i = 0; i < fade; i++) { pcm[i] *= i / fade; pcm[pcm.length - 1 - i] *= i / fade; }
  let peak = 0;
  for (const v of pcm) peak = Math.max(peak, Math.abs(v));
  if (peak < 0.01) toast('Ses çok düşük geldi — mikrofonu kontrol et.', 5000);
  const gain = peak > 0 ? Math.min(4, 0.9 / peak) : 1;
  if (gain > 1) for (let i = 0; i < pcm.length; i++) pcm[i] *= gain;

  // Sesi orijinal konuşmanın üstüne otomatik oturt (geç/erken başlamayı düzeltir)
  let offset = recOffset;
  if (prefs.autoAlign && S.audio && peak >= 0.01) {
    const a = Analyzer.align(S.audio.data, S.audio.sr, seg, pcm, sr, recOffset);
    if (a != null) offset = a;
    else toast('Otomatik hizalama emin olamadı; gerekirse kaydını alt şeritte sürükle.', 4000);
  }
  saveTake(p, seg, pcm, sr, offset, recOffset);
}

function saveTake(p, seg, pcm, sr, offset, recOffset) {
  const buf = ctx.createBuffer(1, pcm.length, sr);
  buf.copyToChannel(pcm, 0);
  const take = { offset, recOffset, duration: buf.duration, v: Date.now() };
  p.takes[seg.id] = take;
  S.takeBufs[seg.id] = buf;
  if (S.p === p) {
    renderLines();
    select(seg.id);
    if (prefs.autoListen) playMine(seg);
  }
  const up = api('PUT', `/api/projects/${p.id}/takes/${seg.id}`, encodeWav(pcm, sr), {
    'X-Offset': offset.toFixed(4), 'X-Duration': buf.duration.toFixed(4), 'X-Rec-Offset': recOffset.toFixed(4),
  })
    .then(t => { take.v = t.v; }) // bu arada sürüklenmiş olabilir: yerini sunucudan alma
    .then(() => { S.uploads.delete(up); settleSaveState(); })
    .catch(e => { S.uploads.delete(up); setSaveState('error'); toast('Kayıt diske yazılamadı: ' + e.message, 6000); });
  S.uploads.add(up);
  setSaveState('saving');
}

function updateRecButton() {
  const seg = selSeg(), again = seg && S.p && S.p.takes[seg.id];
  $('#btnRecord').innerHTML = rec.active
    ? `${ic('stop')}Bitir <kbd>Boşluk</kbd>`
    : `${ic('record')}${again ? 'Tekrar kaydet' : 'Kaydet'} <kbd>R</kbd>`;
}

async function exportVideo() {
  if (rec.active || !S.p) return;
  if (!Object.keys(S.p.takes).length) return toast('Önce en az bir replik kaydet.');
  const p = S.p, btn = $('#btnExport');
  btn.disabled = true;
  btn.innerHTML = `${ic('loader', 'spin')}Video hazırlanıyor…`;
  try {
    await flushSave();
    await Promise.all([...S.uploads]);
    const r = await api('POST', `/api/projects/${p.id}/export`);
    if (S.p === p) {
      $('#exportResult').innerHTML = `<div class="exportBox">
        <div class="exTitle">${ic('checkCircle')}Video hazır</div>
        <div class="exLinks"><a href="${r.url}?download=1">${ic('download')}İndir</a>
          <a href="${r.url}" target="_blank">${ic('external')}Yeni sekmede izle</a></div>
        <div class="exPath">projeler/${esc(p.id)}/exports/${esc(r.file)}</div></div>`;
    }
  } catch (e) {
    toast('Video oluşturulamadı: ' + e.message, 7000);
  } finally {
    btn.disabled = false;
    setExportLabel();
  }
}
function setExportLabel() { $('#btnExport').innerHTML = `${ic('download')}MP4 olarak dışa aktar`; }

// ------------------------------------------------------------ klavye

document.addEventListener('keydown', e => {
  if (!S.p || $('#project').hidden) return;
  if (e.target.matches('input, select, textarea')) {
    if (e.key === 'Escape' || e.key === 'Enter') e.target.blur();
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key.toLowerCase();
  let handled = true;

  if (rec.active) {
    if (k === 'escape') cancelRecording();
    else if (k === ' ' || k === 'r' || k === 'enter') finishRecording();
    e.preventDefault();
    return;
  }
  if (ask) {
    if (/^[1-4]$/.test(k) && +k <= S.p.speakers.length) answerAsk(+k - 1);
    else if (k === ' ' || k === 'enter') showAsk();
    else if (k === 'escape') stopAsk(false);
    else if (k === 'backspace' || k === 'arrowleft') $('#askBack').click();
    else if (k === 'delete') $('#askRemove').click();
    else handled = false;
    if (handled) e.preventDefault();
    return;
  }

  if (S.tab === 'trim') {
    if (k === ' ') togglePlay();
    else if (k === 'i' || k === 'ı') setTrimEdge('start', video.currentTime);
    else if (k === 'o') setTrimEdge('end', video.currentTime);
    else if (k === 'enter') playRange(S.trim.start, S.trim.end, 'orig');
    else if (k === 'arrowleft') { video.pause(); seek(video.currentTime - (e.shiftKey ? 1 : 0.1)); }
    else if (k === 'arrowright') { video.pause(); seek(video.currentTime + (e.shiftKey ? 1 : 0.1)); }
    else if (k === 'escape') video.pause();
    else handled = false;
    if (handled) e.preventDefault();
    return;
  }

  const seg = selSeg();
  if (k === ' ') togglePlay();
  else if (k === 'escape') video.pause();
  else if (k === 'arrowleft' || k === 'arrowup') stepSel(-1, S.tab === 'split');
  else if (k === 'arrowright' || k === 'arrowdown') stepSel(1, S.tab === 'split');
  else if (S.tab === 'split') {
    if (/^[1-4]$/.test(k) && seg) setSpk(seg, +k - 1, true);
    else if ((k === 'delete' || k === 'backspace') && seg) deleteSeg(seg);
    else if (k === 's') splitAtPlayhead();
    else if (k === 'm' && seg) mergeNext(seg);
    else if (k === 'n') addSegAt(video.currentTime);
    else if (k === 'enter' && seg) playOrig(seg);
    else handled = false;
  } else {
    if (k === 'r') startRecording(seg || firstPending());
    else if (k === 'n') stepSel(1, false);
    else if (k === 'o' && seg) playOrig(seg);
    else if (k === 't') setListenMode(S.playMode === 'orig' ? 'dub' : 'orig');
    else if ((e.code === 'Comma' || e.code === 'Period') && seg && S.p.takes[seg.id]) {
      // , ve . : kaydı 20 ms (Shift ile 100 ms) erkene/geçe kaydır
      const d = (e.shiftKey ? 0.1 : 0.02) * (e.code === 'Comma' ? -1 : 1);
      setTakeOffset(seg, S.p.takes[seg.id].offset + d);
    }
    else if (k === 'a' && seg) autoAlignTake(seg);
    else if (k === 'enter' && seg) S.p.takes[seg.id] ? playMine(seg) : playOrig(seg);
    else handled = false;
  }
  if (handled) e.preventDefault();
});

// Tıklanan buton odakta kalıp Boşluk tuşunu çalmasın
document.addEventListener('click', e => {
  const b = e.target.closest('button');
  if (b) b.blur();
});
document.addEventListener('change', e => {
  if (e.target.matches('select, input[type=range], input[type=checkbox]')) e.target.blur();
});

// ------------------------------------------------------------ ana döngü

function tick() {
  requestAnimationFrame(tick);
  if (!S.p) return;
  const t = video.currentTime;
  updatePlayhead(t);
  // Tüm video izlenirken ortadaki ekran o an oynayan repliği gösterir
  if (S.fullPreview && S.tab === 'dub' && !video.paused) {
    const cur = S.p.segments.find(s => t < s.end + 0.05);
    if (cur && cur.id !== S.sel) select(cur.id);
  }
  // Seslendirmede süre, repliğin parçasına göre gösterilir
  const seg = S.tab === 'dub' && !S.fullPreview && selSeg();
  if (seg) {
    const [a, b] = clipRange(seg);
    $('#timeLabel').textContent = `${fmt(clamp(t - a, 0, b - a))} / ${fmt(b - a)}`;
  } else $('#timeLabel').textContent = `${fmt(t)} / ${fmt(curDur())}`;
  if (S.stopAt != null && !video.paused && t >= S.stopAt) { video.pause(); S.stopAt = null; }
  updateGains(t);
  updateModeUI();
  if (rec.active) recTick(t);
  if (micAnalyser && S.tab === 'dub') {
    micAnalyser.getFloatTimeDomainData(meterBuf);
    let m = 0;
    for (const v of meterBuf) m = Math.max(m, Math.abs(v));
    $('#micMeter').style.width = Math.min(100, m * 120) + '%';
  }
}

async function route() {
  const m = location.hash.match(/^#\/p\/([a-z0-9]+)(?:\/(trim|split|dub))?/);
  if (m) await openProject(m[1], m[2]);
  else await showHome();
}
window.addEventListener('hashchange', route);
updatePlayBtn();
updateRecButton();
setExportLabel();
route();
requestAnimationFrame(tick);
