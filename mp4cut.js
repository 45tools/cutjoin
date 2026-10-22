/* mp4cut.js — 45tools 45 Cut & Join
 * 再エンコードなしで MP4/MOV を切り出し・結合する小さなライブラリ。
 * 元ファイルのバイト列をそのままコピー（Blob.slice）するので、
 * 長い動画でも一瞬で終わり、メモリもほとんど使わない。
 * 切れ目はキーフレーム単位（スマホ動画なら通常1秒以内）。
 */
(function (global) {
  "use strict";

  /* ---------- 読み取り ---------- */
  const td = new TextDecoder("latin1");
  const typeAt = (dv, p) => td.decode(new Uint8Array(dv.buffer, dv.byteOffset + p, 4));
  const u64 = (dv, p) => dv.getUint32(p) * 4294967296 + dv.getUint32(p + 4);

  async function readBytes(file, start, len) {
    return new DataView(await file.slice(start, start + len).arrayBuffer());
  }

  // トップレベルの box を探す（moov 本体だけ読み込む）
  async function topBoxes(file) {
    const boxes = [];
    let pos = 0;
    while (pos + 8 <= file.size) {
      const h = await readBytes(file, pos, 16);
      let size = h.getUint32(0), hdr = 8;
      const type = typeAt(h, 4);
      if (size === 1) { size = u64(h, 8); hdr = 16; }
      else if (size === 0) size = file.size - pos;
      if (size < hdr) break;
      boxes.push({ type, start: pos, size, hdr });
      pos += size;
    }
    return boxes;
  }

  function* children(dv, start, end) {
    let p = start;
    while (p + 8 <= end) {
      let size = dv.getUint32(p), hdr = 8;
      const type = typeAt(dv, p + 4);
      if (size === 1) { size = u64(dv, p + 8); hdr = 16; }
      else if (size === 0) size = end - p;
      if (size < hdr || p + size > end) break;
      yield { type, start: p, end: p + size, body: p + hdr };
      p += size;
    }
  }
  function find(dv, start, end, path) {
    let s = start, e = end, hit = null;
    for (const t of path) {
      hit = null;
      for (const b of children(dv, s, e)) if (b.type === t) { hit = b; break; }
      if (!hit) return null;
      s = hit.body; e = hit.end;
    }
    return hit;
  }
  const raw = (dv, b) => new Uint8Array(dv.buffer.slice(dv.byteOffset + b.start, dv.byteOffset + b.end));

  function parseTrak(dv, trak) {
    const tkhd = find(dv, trak.body, trak.end, ["tkhd"]);
    const mdia = find(dv, trak.body, trak.end, ["mdia"]);
    const hdlr = find(dv, mdia.body, mdia.end, ["hdlr"]);
    const mdhd = find(dv, mdia.body, mdia.end, ["mdhd"]);
    const minf = find(dv, mdia.body, mdia.end, ["minf"]);
    const stbl = find(dv, minf.body, minf.end, ["stbl"]);
    if (!tkhd || !hdlr || !mdhd || !stbl) return null;
    const handler = typeAt(dv, hdlr.body + 8);
    const mv = dv.getUint8(mdhd.body);
    const timescale = dv.getUint32(mdhd.body + (mv === 1 ? 20 : 12));

    const sb = name => find(dv, stbl.body, stbl.end, [name]);
    const stsd = sb("stsd"), stts = sb("stts"), ctts = sb("ctts"), stss = sb("stss");
    const stsz = sb("stsz"), stsc = sb("stsc"), stco = sb("stco"), co64 = sb("co64");
    if (!stsd || !stts || !stsz || !stsc || !(stco || co64)) return null;

    // サンプルサイズ
    const fixed = dv.getUint32(stsz.body + 4), n = dv.getUint32(stsz.body + 8);
    const size = new Uint32Array(n);
    for (let i = 0; i < n; i++) size[i] = fixed || dv.getUint32(stsz.body + 12 + i * 4);
    // デコード時刻
    const dts = new Float64Array(n + 1), dur = new Float64Array(n);
    { let k = 0, t = 0; const cnt = dv.getUint32(stts.body + 4);
      for (let e = 0; e < cnt; e++) {
        const c = dv.getUint32(stts.body + 8 + e * 8), d = dv.getUint32(stts.body + 12 + e * 8);
        for (let j = 0; j < c && k < n; j++, k++) { dts[k] = t; dur[k] = d; t += d; }
      }
      for (; k < n; k++) { dts[k] = t; dur[k] = 0; }
      dts[n] = t; }
    // 表示時刻オフセット
    const cts = new Float64Array(n);
    if (ctts) { let k = 0; const cnt = dv.getUint32(ctts.body + 4);
      for (let e = 0; e < cnt; e++) {
        const c = dv.getUint32(ctts.body + 8 + e * 8), o = dv.getInt32(ctts.body + 12 + e * 8);
        for (let j = 0; j < c && k < n; j++) cts[k++] = o;
      } }
    // キーフレーム
    let sync = null;
    if (stss) { sync = new Uint8Array(n); const cnt = dv.getUint32(stss.body + 4);
      for (let e = 0; e < cnt; e++) { const i = dv.getUint32(stss.body + 8 + e * 4) - 1; if (i < n) sync[i] = 1; } }
    // チャンク → サンプル位置
    const offs = new Float64Array(n);
    { const co = stco || co64, big = !!co64, nch = dv.getUint32(co.body + 4);
      const chunkOff = i => big ? u64(dv, co.body + 8 + i * 8) : dv.getUint32(co.body + 8 + i * 4);
      const ne = dv.getUint32(stsc.body + 4); const ent = [];
      for (let e = 0; e < ne; e++) ent.push([dv.getUint32(stsc.body + 8 + e * 12) - 1, dv.getUint32(stsc.body + 12 + e * 12)]);
      let k = 0;
      for (let e = 0; e < ent.length; e++) {
        const first = ent[e][0], last = e + 1 < ent.length ? ent[e + 1][0] : nch, per = ent[e][1];
        for (let c = first; c < last && k < n; c++) { let o = chunkOff(c); for (let j = 0; j < per && k < n; j++) { offs[k++] = o; o += size[k - 1]; } }
      } }
    // 編集リスト（最初の有効な編集の media_time）
    let mediaTime = 0;
    const elst = find(dv, trak.body, trak.end, ["edts", "elst"]);
    if (elst) { const v = dv.getUint8(elst.body), cnt = dv.getUint32(elst.body + 4);
      for (let e = 0, p = elst.body + 8; e < cnt; e++, p += v === 1 ? 20 : 12) {
        const mt = v === 1 ? dv.getInt32(p + 8) * 4294967296 + dv.getUint32(p + 12) : dv.getInt32(p + 4);
        if (mt >= 0) { mediaTime = mt; break; }
      } }

    const vmhd = find(dv, minf.body, minf.end, ["vmhd"]) || find(dv, minf.body, minf.end, ["smhd"]);
    const dinf = find(dv, minf.body, minf.end, ["dinf"]);
    return {
      handler, timescale, n, size, dts, dur, cts, sync, offs, mediaTime, hasCtts: !!ctts,
      raw: { tkhd: raw(dv, tkhd), mdhd: raw(dv, mdhd), hdlr: raw(dv, hdlr), stsd: raw(dv, stsd),
             xmhd: vmhd ? raw(dv, vmhd) : null, dinf: dinf ? raw(dv, dinf) : null },
      pt(i) { return (this.dts[i] + this.cts[i] - this.mediaTime) / this.timescale; },
      isSync(i) { return !this.sync || this.sync[i] === 1; },
    };
  }

  async function parse(file) {
    const tops = await topBoxes(file);
    if (tops.some(b => b.type === "moof")) throw new Error("fragmented");
    const ftypB = tops.find(b => b.type === "ftyp"), moovB = tops.find(b => b.type === "moov");
    if (!moovB || moovB.size > 200 * 1024 * 1024) throw new Error("no moov");
    const dv = await readBytes(file, moovB.start, moovB.size);
    const mvhd = find(dv, 0, dv.byteLength, ["moov", "mvhd"]);
    const moov = find(dv, 0, dv.byteLength, ["moov"]);
    let video = null, audio = null;
    for (const b of children(dv, moov.body, moov.end)) {
      if (b.type !== "trak") continue;
      const tr = parseTrak(dv, b); if (!tr || !tr.n) continue;
      if (tr.handler === "vide" && !video) video = tr;
      else if (tr.handler === "soun" && !audio) audio = tr;
    }
    if (!video) throw new Error("no video");
    const extra = [];
    for (const b of children(dv, moov.body, moov.end)) if (b.type === "udta" || b.type === "meta") extra.push(raw(dv, b));
    const ftyp = ftypB ? new Uint8Array(await file.slice(ftypB.start, ftypB.start + ftypB.size).arrayBuffer()) : null;
    const isMov = ftyp ? td.decode(ftyp.subarray(8, 12)) === "qt  " : false;
    // キーフレームの表示時刻（秒）
    const keyTimes = [];
    for (let i = 0; i < video.n; i++) if (video.isSync(i)) keyTimes.push(video.pt(i));
    const duration = (video.dts[video.n] - video.mediaTime) / video.timescale;
    // 撮影日時：iPhoneのメタデータ(creationdate, 現地時刻つき) → mvhd の作成時刻 の順に採用
    let created = null;
    for (const x of extra) {
      const m = td.decode(x).match(/(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.\d+)?(Z|[+-]\d\d:?\d\d)?/);
      if (m) { let tz = m[2] || ""; if (/^[+-]\d{4}$/.test(tz)) tz = tz.slice(0, 3) + ":" + tz.slice(3); const t = Date.parse(m[1] + tz); if (!isNaN(t)) { created = t; break; } }
    }
    if (created === null) {
      const mv = raw(dv, mvhd), d = new DataView(mv.buffer), secs = d.getUint8(8) === 1 ? u64(d, 12) : d.getUint32(12);
      if (secs > 2082844800 + 86400 * 365 * 30) created = (secs - 2082844800) * 1000;
    }
    return { file, ftyp, isMov, mvhd: raw(dv, mvhd), extra, video, audio, keyTimes, duration, created };
  }

  /* ---------- 互換性 ---------- */
  // コーデック設定の「指紋」。ビットレート等ファイルごとに変わる値は除く
  function indexOfStr(u8, s, from = 0) {
    outer: for (let i = from; i <= u8.length - s.length; i++) { for (let j = 0; j < s.length; j++) if (u8[i + j] !== s.charCodeAt(j)) continue outer; return i; }
    return -1;
  }
  const hex = u8 => Array.from(u8, x => x.toString(16).padStart(2, "0")).join("");
  function videoSig(tr) {
    const s = tr.raw.stsd, dv = new DataView(s.buffer);
    let sig = td.decode(s.subarray(20, 24)) + ":" + dv.getUint16(48) + "x" + dv.getUint16(50);
    for (const t of ["avcC", "hvcC", "dvcC", "dvvC", "av1C", "vpcC"]) {
      const p = indexOfStr(s, t); if (p >= 4) sig += ":" + t + hex(s.subarray(p - 4, p - 4 + dv.getUint32(p - 4)));
    }
    return sig + ":" + tr.timescale;
  }
  function audioSig(tr) {
    const s = tr.raw.stsd;
    let sig = td.decode(s.subarray(20, 24)) + ":" + tr.timescale;
    const p = indexOfStr(s, "esds");
    if (p >= 0) { // DecoderSpecificInfo (tag 5) を取り出す
      let q = p + 8; const len = () => { let l = 0, b; do { b = s[q++]; l = (l << 7) | (b & 0x7f); } while (b & 0x80 && q < s.length); return l; };
      while (q < s.length) { const tag = s[q++], l = len();
        if (tag === 3) { const fl = s[q + 2]; q += 3 + (fl & 0x80 ? 2 : 0) + (fl & 0x40 ? 1 + s[q + 3] : 0) + (fl & 0x20 ? 2 : 0); }
        else if (tag === 4) q += 13;
        else if (tag === 5) { sig += ":" + hex(s.subarray(q, q + l)); break; }
        else break; }
    } else { // esds 以外（Opus 等）：ビットレート情報(btrt)を除いて比較
      let u = s.subarray(16); const b = indexOfStr(u, "btrt");
      if (b >= 4) { const L = new DataView(u.buffer, u.byteOffset).getUint32(b - 4); u = new Uint8Array([...u.subarray(0, b - 4), ...u.subarray(b - 4 + L)]); }
      sig += ":" + hex(u);
    }
    return sig;
  }
  function compatible(list) {
    const a = list[0], va = videoSig(a.video), aa = a.audio ? audioSig(a.audio) : "";
    return list.every(m => videoSig(m.video) === va && (m.audio ? audioSig(m.audio) : "") === aa);
  }

  /* ---------- 書き出し ---------- */
  function nearestKeyIndex(tr, t) {
    let best = 0, bd = Infinity;
    for (let i = 0; i < tr.n; i++) if (tr.isSync(i)) { const d = Math.abs(tr.pt(i) - t); if (d < bd) { bd = d; best = i; } }
    return best;
  }
  function snap(m, t) {
    let best = 0, bd = Infinity;
    for (const k of m.keyTimes) { const d = Math.abs(k - t); if (d < bd) { bd = d; best = k; } }
    return best;
  }

  // バイナリ組み立て
  function box(type, ...parts) {
    let len = 8; for (const p of parts) len += p.length;
    const out = new Uint8Array(len), dv = new DataView(out.buffer);
    dv.setUint32(0, len); for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    let o = 8; for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }
  function u32s(...vals) { const a = new Uint8Array(vals.length * 4), dv = new DataView(a.buffer); vals.forEach((v, i) => dv.setUint32(i * 4, v >>> 0)); return a; }
  function setU64(dv, p, v) { dv.setUint32(p, Math.floor(v / 4294967296)); dv.setUint32(p + 4, v % 4294967296); }

  function sampleTable(tr, S, base, use64) {
    const n = S.length;
    // stts
    const stts = []; for (let i = 0; i < n; i++) { const d = S[i].dur; if (stts.length && stts[stts.length - 1][1] === d) stts[stts.length - 1][0]++; else stts.push([1, d]); }
    const sttsB = box("stts", u32s(0, stts.length, ...stts.flat()));
    // ctts
    let cttsB = null;
    if (S.some(s => s.cts !== 0)) {
      const neg = S.some(s => s.cts < 0); const runs = [];
      for (const s of S) { if (runs.length && runs[runs.length - 1][1] === s.cts) runs[runs.length - 1][0]++; else runs.push([1, s.cts]); }
      cttsB = box("ctts", u32s(neg ? 0x01000000 : 0, runs.length, ...runs.flat()));
    }
    // stss
    let stssB = null;
    if (tr.sync) { const idx = []; S.forEach((s, i) => { if (s.sync) idx.push(i + 1); }); stssB = box("stss", u32s(0, idx.length, ...idx)); }
    const stszB = box("stsz", u32s(0, 0, n, ...S.map(s => s.size)));
    const stscB = box("stsc", u32s(0, 1, 1, 1, 1));
    let coB;
    if (use64) { const a = new Uint8Array(8 + n * 8), dv = new DataView(a.buffer); dv.setUint32(4, n); S.forEach((s, i) => setU64(dv, 8 + i * 8, base + s.newOff)); coB = box("co64", a); }
    else coB = box("stco", u32s(0, n, ...S.map(s => base + s.newOff)));
    return box("stbl", tr.raw.stsd, sttsB, ...(cttsB ? [cttsB] : []), ...(stssB ? [stssB] : []), stszB, stscB, coB);
  }

  function trakBox(tr, S, id, movieTs, mediaStart, base, use64) {
    const mediaDur = S.reduce((a, s) => a + s.dur, 0);
    // 映像: 表示区間は [先頭の表示時刻, +全長]。音声: 先頭の無音(プライミング)分だけ短い
    const presDur = Math.max(0, tr.handler === "vide" ? mediaDur : mediaDur - mediaStart);
    const movieDur = Math.round(presDur * movieTs / tr.timescale);
    // tkhd: track_ID と duration を書き換え
    const tk = tr.raw.tkhd.slice(), tdv = new DataView(tk.buffer), tv = tdv.getUint8(8);
    if (tv === 1) { tdv.setUint32(8 + 20, id); setU64(tdv, 8 + 28, movieDur); }
    else { tdv.setUint32(8 + 12, id); tdv.setUint32(8 + 20, movieDur); }
    const elst = box("edts", box("elst", u32s(0, 1, movieDur, mediaStart, 0x00010000)));
    const md = tr.raw.mdhd.slice(), mdv = new DataView(md.buffer), mv = mdv.getUint8(8);
    if (mv === 1) setU64(mdv, 8 + 24, mediaDur); else mdv.setUint32(8 + 16, Math.min(mediaDur, 0xffffffff));
    const minf = box("minf", ...(tr.raw.xmhd ? [tr.raw.xmhd] : []), ...(tr.raw.dinf ? [tr.raw.dinf] : []), sampleTable(tr, S, base, use64));
    return { box: box("trak", tk, elst, box("mdia", md, tr.raw.hdlr, minf)), movieDur };
  }

  /**
   * parts: [{ m: parse()の結果, start: 秒, end: 秒 }]
   * 戻り値: { blob, ext, mime, duration }
   */
  function build(parts, opts = {}) {
    const first = parts[0].m, V = first.video, A = opts.mute ? null : first.audio;
    const vS = [], aS = [], runs = [];
    let cumV = 0, cumA = 0, outOff = 0, aStart = 0;

    parts.forEach((p, pi) => {
      const v = p.m.video, a = A ? p.m.audio : null, f = V.timescale / v.timescale;
      const ks = nearestKeyIndex(v, p.start);
      const ke = p.end >= p.m.duration - 0.02 ? v.n : nearestKeyIndex(v, p.end);
      if (ke <= ks) return;
      const picked = [];
      const d0 = v.dts[ks];
      for (let i = ks; i < ke; i++) {
        const dA = Math.round((v.dts[i] - d0) * f), dB = Math.round((v.dts[i + 1] - d0) * f);
        picked.push({ t: "v", off: v.offs[i], size: v.size[i], dur: dB - dA, cts: Math.round(v.cts[i] * f), sync: v.isSync(i) ? 1 : 0 });
      }
      cumV += (v.dts[ke] - d0) / v.timescale;
      if (a) {
        const t0 = v.pt(ks);
        let ai = 0; while (ai < a.n && a.pt(ai) < t0 - a.dur[ai] / a.timescale / 2) ai++;
        if (pi === 0) aStart = ai === 0 ? a.mediaTime : 0;
        while (ai < a.n && cumA + a.dur[ai] / a.timescale / 2 <= cumV - (pi === 0 ? 0 : 0)) {
          picked.push({ t: "a", off: a.offs[ai], size: a.size[ai], dur: a.dur[ai], cts: 0, sync: 1 });
          cumA += a.dur[ai] / a.timescale; ai++;
        }
      }
      // ファイル内の並び順のまま、連続した範囲をまとめてコピー
      const order = picked.slice().sort((x, y) => x.off - y.off);
      let run = null;
      for (const s of order) {
        if (run && s.off >= run.end && s.off - run.end < 256 * 1024) run.end = Math.max(run.end, s.off + s.size);
        else { if (run) { outOff += run.end - run.start; runs.push(run); } run = { file: p.m.file, start: s.off, end: s.off + s.size, base: outOff }; }
        s.newOff = run.base + (s.off - run.start);
      }
      if (run) { outOff += run.end - run.start; runs.push(run); }
      for (const s of picked) (s.t === "v" ? vS : aS).push(s);
    });
    if (!vS.length) throw new Error("empty");

    const mdatLen = outOff, big = !!opts.force64 || mdatLen + 16 > 0xffffffff;
    const mdatHdr = big ? (() => { const h = new Uint8Array(16), d = new DataView(h.buffer); d.setUint32(0, 1); h.set([109, 100, 97, 116], 4); setU64(d, 8, mdatLen + 16); return h; })()
                        : (() => { const h = new Uint8Array(8), d = new DataView(h.buffer); d.setUint32(0, mdatLen + 8); h.set([109, 100, 97, 116], 4); return h; })();
    const ftyp = first.ftyp || box("ftyp", new Uint8Array([105, 115, 111, 109, 0, 0, 2, 0, 105, 115, 111, 109, 105, 115, 111, 50, 109, 112, 52, 49]));
    const mvdv = new DataView(first.mvhd.buffer), mvv = mvdv.getUint8(8);
    const movieTs = mvdv.getUint32(8 + (mvv === 1 ? 20 : 12));
    const vStart = vS[0].cts; // 先頭キーフレームの表示オフセット

    const makeMoov = (base) => {
      const tv = trakBox(V, vS, 1, movieTs, Math.max(0, vStart), base, big);
      const ta = A && aS.length ? trakBox(A, aS, 2, movieTs, aStart, base, big) : null;
      const mv = first.mvhd.slice(), d = new DataView(mv.buffer), ver = d.getUint8(8);
      const dur = Math.max(tv.movieDur, ta ? ta.movieDur : 0);
      if (ver === 1) setU64(d, 8 + 24, dur); else d.setUint32(8 + 16, dur);
      d.setUint32(mv.length - 4, ta ? 3 : 2); // next_track_ID
      return { moov: box("moov", mv, tv.box, ...(ta ? [ta.box] : []), ...first.extra), dur };
    };
    const probe = makeMoov(0);
    const base = ftyp.length + probe.moov.length + mdatHdr.length;
    const final = makeMoov(base);
    if (final.moov.length !== probe.moov.length) throw new Error("layout");

    const blobParts = [ftyp, final.moov, mdatHdr, ...runs.map(r => r.file.slice(r.start, r.end))];
    const ext = first.isMov ? "mov" : "mp4", mime = first.isMov ? "video/quicktime" : "video/mp4";
    return { blob: new Blob(blobParts, { type: mime }), ext, mime, duration: final.dur / movieTs };
  }

  global.MP4Cut = { parse, compatible, build, snap };
})(window);
