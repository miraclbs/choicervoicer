'use strict';
// Videodaki konuşmaları bulup kişilere ayıran basit algoritma.
//  1) Ses enerjisine bakarak konuşma olan yerleri bulur.
//  2) Uzun konuşmaları ses karakterinin değiştiği yerlerden böler.
//  3) Her parçanın ses özelliklerini (perde + MFCC) çıkarıp k-means ile kişilere ayırır.
//  4) Aynı kişinin art arda gelen parçalarını tek replikte birleştirir.
// Sonuç bir tahmindir; kullanıcı arayüzde kontrol edip düzeltir.
const Analyzer = (() => {
  const N = 1024;        // FFT boyu
  const WIN = 512;       // analiz penceresi (16 kHz'de 32 ms)
  const NM = 12;         // MFCC katsayısı sayısı
  const NMEL = 24;

  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang), half = len >> 1;
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < half; k++) {
          const a = i + k, b = a + half;
          const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
          const nr = cr * wr - ci * wi;
          ci = cr * wi + ci * wr; cr = nr;
        }
      }
    }
  }

  function melBank(sr) {
    const mel = f => 2595 * Math.log10(1 + f / 700);
    const inv = m => 700 * (Math.pow(10, m / 2595) - 1);
    const m0 = mel(100), m1 = mel(Math.min(7000, sr / 2 - 100));
    const pts = [];
    for (let i = 0; i < NMEL + 2; i++) pts.push(inv(m0 + (m1 - m0) * i / (NMEL + 1)));
    const binHz = sr / N, bank = [];
    for (let m = 0; m < NMEL; m++) {
      const a = pts[m], b = pts[m + 1], c = pts[m + 2];
      const k0 = Math.floor(a / binHz), k1 = Math.ceil(c / binHz);
      const w = [];
      for (let k = k0; k <= k1; k++) {
        const f = k * binHz;
        w.push(f <= a || f >= c ? 0 : f <= b ? (f - a) / (b - a) : (c - f) / (c - b));
      }
      bank.push({ k0, w });
    }
    return bank;
  }

  // Konuşma olan kare aralıklarını bulur: [[başlangıç, bitiş), ...]
  function detectSpeech(db, hopS) {
    const n = db.length;
    const sorted = Float32Array.from(db).sort();
    const pct = q => sorted[Math.min(n - 1, Math.floor(q * n))];
    const floor = pct(0.1), top = pct(0.98);
    const high = Math.max(floor + 6, floor + (top - floor) * 0.35, -55);
    const low = high - 6;
    const act = new Uint8Array(n);
    for (let f = 0; f < n; f++) if (db[f] > high) act[f] = 1;
    for (let f = 1; f < n; f++) if (!act[f] && act[f - 1] && db[f] > low) act[f] = 1;
    for (let f = n - 2; f >= 0; f--) if (!act[f] && act[f + 1] && db[f] > low) act[f] = 1;

    const runs = [];
    for (let f = 0; f < n; f++) {
      if (!act[f]) continue;
      let g = f;
      while (g < n && act[g]) g++;
      runs.push([f, g]);
      f = g;
    }
    const minGap = Math.round(0.2 / hopS), minLen = Math.round(0.2 / hopS);
    const merged = [];
    for (const r of runs) {
      const last = merged[merged.length - 1];
      if (last && r[0] - last[1] < minGap) last[1] = r[1];
      else merged.push(r);
    }
    return merged.filter(r => r[1] - r[0] >= minLen);
  }

  // Konuşma karelerinin MFCC ve perde (pitch) değerlerini hesaplar
  function features(x, sr, HOP, nF, runs) {
    const mf = new Float32Array(nF * NM);
    const lp = new Float32Array(nF).fill(NaN);   // 100 Hz'e göre yarım ton cinsinden perde
    const hann = new Float64Array(WIN);
    for (let i = 0; i < WIN; i++) hann[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (WIN - 1));
    const re = new Float64Array(N), im = new Float64Array(N), pw = new Float64Array(N);

    // Pencerenin kendi otokorelasyonu (Boersma yöntemi ile düzeltme için)
    for (let i = 0; i < WIN; i++) re[i] = hann[i];
    fft(re, im);
    for (let k = 0; k < N; k++) { re[k] = re[k] * re[k] + im[k] * im[k]; im[k] = 0; }
    fft(re, im);
    const rw = new Float64Array(N);
    for (let k = 0; k < N; k++) rw[k] = re[k] / re[0];

    const bank = melBank(sr);
    const dct = [];
    for (let j = 1; j <= NM; j++) {
      const row = new Float64Array(NMEL);
      for (let m = 0; m < NMEL; m++) row[m] = Math.cos(Math.PI * j * (m + 0.5) / NMEL);
      dct.push(row);
    }
    const minLag = Math.floor(sr / 400), maxLag = Math.min(WIN - 32, Math.ceil(sr / 70));
    const logE = new Float64Array(NMEL), r = new Float64Array(maxLag + 2);

    for (const [a, b] of runs) {
      for (let f = a; f < b; f++) {
        const o = f * HOP;
        let mean = 0;
        for (let i = 0; i < WIN; i++) mean += x[o + i];
        mean /= WIN;
        re.fill(0); im.fill(0);
        for (let i = 0; i < WIN; i++) re[i] = (x[o + i] - mean) * hann[i];
        fft(re, im);
        for (let k = 0; k < N; k++) pw[k] = re[k] * re[k] + im[k] * im[k];

        // MFCC
        for (let m = 0; m < NMEL; m++) {
          const { k0, w } = bank[m];
          let s = 0;
          for (let i = 0; i < w.length; i++) s += w[i] * pw[k0 + i];
          logE[m] = Math.log(s + 1e-10);
        }
        for (let j = 0; j < NM; j++) {
          let s = 0;
          const row = dct[j];
          for (let m = 0; m < NMEL; m++) s += row[m] * logE[m];
          mf[f * NM + j] = s;
        }

        // Perde: güç spektrumundan otokorelasyon
        for (let k = 0; k < N; k++) { re[k] = pw[k]; im[k] = 0; }
        fft(re, im);
        if (re[0] <= 1e-9) continue;
        let best = 0;
        for (let L = minLag; L <= maxLag; L++) {
          r[L] = re[L] / re[0] / Math.max(rw[L], 1e-3);
          if (r[L] > best) best = r[L];
        }
        if (best < 0.45) continue;
        // Oktav hatasını azaltmak için en yüksek değere yakın ilk tepeyi seç
        for (let L = minLag + 1; L < maxLag; L++) {
          if (r[L] >= 0.85 * best && r[L] >= r[L - 1] && r[L] >= r[L + 1]) {
            const den = r[L - 1] - 2 * r[L] + r[L + 1];
            const lag = L + (den < 0 ? 0.5 * (r[L - 1] - r[L + 1]) / den : 0);
            lp[f] = 12 * Math.log2(sr / lag / 100);
            break;
          }
        }
      }
    }
    return { mf, lp };
  }

  function mulberry32(a) {
    return () => {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  function sq(a, b) {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) * (a[i] - b[i]);
    return s;
  }

  // Ağırlıklı k-means (birkaç farklı başlangıçla, en iyisini seçer)
  function kmeans(X, w, k) {
    const n = X.length, D = X[0].length;
    if (n <= k) return X.map((_, i) => i);
    const rnd = mulberry32(1234);
    let best = null;
    for (let rep = 0; rep < 10; rep++) {
      let first = 0;
      if (rep === 0) { for (let i = 1; i < n; i++) if (w[i] > w[first]) first = i; }
      else first = Math.floor(rnd() * n);
      const C = [X[first].slice()];
      while (C.length < k) {
        const d2 = X.map(x => Math.min(...C.map(c => sq(x, c))));
        let pick = 0;
        if (rep === 0) { for (let i = 1; i < n; i++) if (d2[i] > d2[pick]) pick = i; }
        else {
          const tot = d2.reduce((s, v) => s + v, 0);
          let u = rnd() * tot;
          for (pick = 0; pick < n - 1 && (u -= d2[pick]) > 0; pick++);
        }
        C.push(X[pick].slice());
      }
      const lab = new Int32Array(n).fill(-1);
      for (let it = 0; it < 50; it++) {
        let moved = false;
        for (let i = 0; i < n; i++) {
          let bc = 0, bd = Infinity;
          for (let c = 0; c < k; c++) { const d = sq(X[i], C[c]); if (d < bd) { bd = d; bc = c; } }
          if (lab[i] !== bc) { lab[i] = bc; moved = true; }
        }
        if (!moved) break;
        for (let c = 0; c < k; c++) {
          const s = new Float64Array(D);
          let ws = 0;
          for (let i = 0; i < n; i++) if (lab[i] === c) { ws += w[i]; for (let j = 0; j < D; j++) s[j] += w[i] * X[i][j]; }
          if (ws > 0) C[c] = Array.from(s, v => v / ws);
        }
      }
      let inertia = 0;
      for (let i = 0; i < n; i++) inertia += w[i] * sq(X[i], C[lab[i]]);
      if (!best || inertia < best.inertia) best = { lab: Array.from(lab), inertia };
    }
    return best.lab;
  }

  function median(arr) {
    const s = arr.slice().sort((a, b) => a - b);
    return s.length ? s[s.length >> 1] : NaN;
  }

  /**
   * x: mono ses (Float32Array), sr: örnekleme hızı, k: kişi sayısı
   * Dönen değer: [{start, end, spk}] (saniye)
   */
  function split(x, sr, k) {
    const HOP = Math.round(sr * 0.02), hopS = HOP / sr, winS = WIN / sr;
    const nF = x.length >= WIN ? Math.floor((x.length - WIN) / HOP) + 1 : 0;
    if (!nF) return [];

    const db = new Float32Array(nF);
    for (let f = 0; f < nF; f++) {
      let s = 0;
      const o = f * HOP;
      for (let i = 0; i < WIN; i++) s += x[o + i] * x[o + i];
      db[f] = 10 * Math.log10(s / WIN + 1e-10);
    }
    const runs = detectSpeech(db, hopS);
    if (!runs.length) return [];
    const { mf, lp } = features(x, sr, HOP, nF, runs);

    // Konuşma karelerinin genel varyansı (uzaklıkları ölçeklemek için)
    const gMean = new Float64Array(NM), gVar = new Float64Array(NM);
    let cnt = 0;
    const pitches = [];
    for (const [a, b] of runs) for (let f = a; f < b; f++) {
      cnt++;
      for (let j = 0; j < NM; j++) gMean[j] += mf[f * NM + j];
      if (!isNaN(lp[f])) pitches.push(lp[f]);
    }
    for (let j = 0; j < NM; j++) gMean[j] /= cnt;
    for (const [a, b] of runs) for (let f = a; f < b; f++)
      for (let j = 0; j < NM; j++) gVar[j] += (mf[f * NM + j] - gMean[j]) ** 2;
    for (let j = 0; j < NM; j++) gVar[j] = gVar[j] / cnt || 1;
    const pMed = pitches.length ? median(pitches) : 0;
    let pVar = 0;
    for (const p of pitches) pVar += (p - pMed) ** 2;
    pVar = pitches.length > 1 ? pVar / pitches.length : 1;

    const stats = (a, b) => {
      const m = new Float64Array(NM);
      let ps = 0, pn = 0;
      for (let f = a; f < b; f++) {
        for (let j = 0; j < NM; j++) m[j] += mf[f * NM + j];
        if (!isNaN(lp[f])) { ps += lp[f]; pn++; }
      }
      for (let j = 0; j < NM; j++) m[j] /= (b - a);
      return { m, p: pn >= 5 ? ps / pn : NaN };
    };
    const dist = (A, B) => {
      let d = 0;
      for (let j = 0; j < NM; j++) d += (A.m[j] - B.m[j]) ** 2 / gVar[j];
      d /= NM;
      if (!isNaN(A.p) && !isNaN(B.p)) d += (A.p - B.p) ** 2 / pVar;
      return d;
    };

    // Uzun konuşmaları ses karakterinin değiştiği noktalardan böl
    let pieces = [];
    if (k > 1) {
      const W = Math.round(0.5 / hopS), minPiece = Math.round(0.4 / hopS);
      const curves = runs.map(([a, b]) => {
        const c = [];
        if (b - a >= 2 * W + 10) for (let t = a + W; t <= b - W; t++) c.push({ t, d: dist(stats(t - W, t), stats(t, t + W)) });
        return c;
      });
      const all = curves.flat().map(c => c.d);
      const mu = all.reduce((s, v) => s + v, 0) / (all.length || 1);
      const sd = Math.sqrt(all.reduce((s, v) => s + (v - mu) ** 2, 0) / (all.length || 1));
      // Düşük eşik: yanlış bölmeler sonradan aynı kişi çıkınca zaten birleşiyor
      const thr = mu + 0.5 * sd;
      runs.forEach(([a, b], ri) => {
        const c = curves[ri];
        let last = a;
        for (let i = 0; i < c.length; i++) {
          const { t, d } = c[i];
          if (d < thr || t - last < minPiece || b - t < minPiece) continue;
          let isMax = true;
          for (let j = Math.max(0, i - (W >> 1)); j <= Math.min(c.length - 1, i + (W >> 1)); j++) {
            if (c[j].d > d) { isMax = false; break; }
          }
          if (isMax) { pieces.push({ a: last, b: t }); last = t; }
        }
        pieces.push({ a: last, b });
      });
    } else {
      pieces = runs.map(([a, b]) => ({ a, b }));
    }

    // Parçaları kişilere ayır
    if (k > 1 && pieces.length > 1) {
      const raw = pieces.map(pc => {
        const st = stats(pc.a, pc.b);
        const ps = [];
        for (let f = pc.a; f < pc.b; f++) if (!isNaN(lp[f])) ps.push(lp[f]);
        return [...st.m, ps.length >= 3 ? median(ps) : NaN];
      });
      const D = NM + 1;
      const pv = raw.map(v => v[NM]).filter(v => !isNaN(v));
      const pFill = pv.length ? median(pv) : 0;
      raw.forEach(v => { if (isNaN(v[NM])) v[NM] = pFill; });
      for (let j = 0; j < D; j++) {
        const col = raw.map(v => v[j]);
        const m = col.reduce((s, v) => s + v, 0) / col.length;
        const s = Math.sqrt(col.reduce((t, v) => t + (v - m) ** 2, 0) / col.length) || 1;
        const wgt = j === NM ? 3 : 1;   // perde en ayırt edici özellik
        raw.forEach(v => { v[j] = (v[j] - m) / s * wgt; });
      }
      const lab = kmeans(raw, pieces.map(pc => pc.b - pc.a), k);
      pieces.forEach((pc, i) => { pc.spk = lab[i]; });
      // İki yanı aynı kişi olan kısa parçayı o kişiye ver
      for (let i = 1; i < pieces.length - 1; i++) {
        const A = pieces[i - 1], P = pieces[i], B = pieces[i + 1];
        if (A.spk === B.spk && P.spk !== A.spk && (P.b - P.a) * hopS < 0.6
          && (P.a - A.b) * hopS < 0.3 && (B.a - P.b) * hopS < 0.3) P.spk = A.spk;
      }
    } else {
      pieces.forEach(pc => { pc.spk = 0; });
    }

    // Aynı kişinin art arda gelen parçalarını tek replik yap
    const lines = [];
    for (const pc of pieces) {
      const last = lines[lines.length - 1];
      if (last && last.spk === pc.spk && (pc.a - last.b) * hopS < 1.0 && (pc.b - last.a) * hopS < 10) last.b = pc.b;
      else lines.push({ a: pc.a, b: pc.b, spk: pc.spk });
    }
    // Kişi numaralarını ilk konuşma sırasına göre düzenle
    const order = new Map();
    for (const l of lines) if (!order.has(l.spk)) order.set(l.spk, order.size);

    const dur = x.length / sr;
    const out = lines.map(l => ({
      start: Math.max(0, l.a * hopS - 0.05),
      end: Math.min(dur, (l.b - 1) * hopS + winS + 0.08),
      spk: order.get(l.spk),
    }));
    for (let i = 0; i + 1 < out.length; i++) {
      if (out[i].end > out[i + 1].start) {
        const mid = (out[i].end + out[i + 1].start) / 2;
        out[i].end = out[i + 1].start = mid;
      }
    }
    return out;
  }

  // ---------------------------------------------------------- kayıt hizalama

  // x'in [t0, t1) aralığı için 10 ms'lik RMS zarfı (x'in ilk örneği = 0 sn)
  function envelope(x, sr, t0, t1) {
    const hop = Math.round(sr * 0.01), n = Math.max(0, Math.floor((t1 - t0) * 100));
    const out = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      const a = Math.round((t0 + k * 0.01) * sr);
      let s = 0, c = 0;
      for (let i = Math.max(0, a); i < Math.min(x.length, a + hop); i++) { s += x[i] * x[i]; c++; }
      out[k] = c ? Math.sqrt(s / c) : 0;
    }
    return out;
  }

  // Zarfı 0..1 arası "konuşma var" eğrisine çevirir (log ölçek, kendi seviyesine göre)
  function activity(env) {
    const db = Array.from(env, v => 20 * Math.log10(v + 1e-5));
    const sorted = db.slice().sort((a, b) => a - b);
    const lo = sorted[Math.floor(sorted.length * 0.1)] ?? -100;
    const hi = sorted[Math.floor(sorted.length * 0.98)] ?? 0;
    const span = Math.max(6, hi - lo);
    return Float32Array.from(db, d => Math.min(1, Math.max(0, (d - lo) / span)));
  }

  /** Kaydın başındaki ve sonundaki sessizliği keser. Dönen: {pcm, start: kesilen baş (sn)} */
  function trimSilence(pcm, sr, pad = 0.12) {
    const env = envelope(pcm, sr, 0, pcm.length / sr);
    let peak = 0;
    for (const v of env) peak = Math.max(peak, v);
    if (peak < 0.003) return { pcm, start: 0 };
    const thr = Math.max(peak * 0.05, 0.002);
    let a = 0, b = env.length - 1;
    while (a < env.length && env[a] < thr) a++;
    while (b > a && env[b] < thr) b--;
    const p = Math.round(pad * 100);
    const i0 = Math.round(Math.max(0, a - p) * 0.01 * sr);
    const i1 = Math.min(pcm.length, Math.round(Math.min(env.length, b + 1 + p) * 0.01 * sr));
    return { pcm: pcm.slice(i0, i1), start: i0 / sr };
  }

  /**
   * Kaydı orijinal konuşmanın üstüne en iyi oturacağı yere kaydırır.
   * ref: orijinal (tercihen sadece konuşma) ses, seg: {start, end},
   * take: kayıt, offset: kaydın şu anki başlangıç zamanı (sn).
   * Dönen: yeni offset; güvenilir bir eşleşme bulunamazsa null.
   */
  function align(ref, refSr, seg, take, takeSr, offset, maxShift = 0.8) {
    const W0 = seg.start - maxShift - 0.2, W1 = seg.end + maxShift + 0.2;
    const r = activity(envelope(ref, refSr, W0, W1));
    // Sadece bu repliğin aralığına bak (komşu replikler kaydı çekmesin) ve repliğin başına
    // daha çok ağırlık ver: konuşma hızı farklı olsa bile ses, ağız açıldığında başlasın
    for (let k = 0; k < r.length; k++) {
      const t = W0 + k * 0.01;
      if (t < seg.start - 0.15 || t > seg.end + 0.15) r[k] = 0;
      else r[k] *= 0.15 + 0.85 * Math.exp(-Math.max(0, t - seg.start) / 0.6);
    }
    const tk = activity(envelope(take, takeSr, 0, take.length / takeSr));
    const norm = Math.sqrt(r.reduce((s, v) => s + v * v, 0) * tk.reduce((s, v) => s + v * v, 0));
    if (!norm) return null;
    const steps = Math.round(maxShift * 100);
    let best = 0, bestScore = -Infinity;
    for (let d = -steps; d <= steps; d++) {
      const base = Math.round((offset + d * 0.01 - W0) * 100);
      let sum = 0;
      for (let j = 0; j < tk.length; j++) {
        const k = base + j;
        if (k >= 0 && k < r.length) sum += r[k] * tk[j];
      }
      const score = sum / norm - 0.0005 * Math.abs(d); // eşitlikte küçük kaymayı tercih et
      if (score > bestScore) { bestScore = score; best = d; }
    }
    return bestScore < 0.25 ? null : offset + best * 0.01;
  }

  return { split, trimSilence, align };
})();

if (typeof module !== 'undefined') module.exports = Analyzer;
