/* ===== 語音辨識字幕 =====
 * Whisper(transformers.js)在瀏覽器內辨識語音,OpenCC 簡轉繁,
 * 逐句編輯校正後匯出 SRT,或用 ffmpeg.wasm(libass + Noto Sans TC)燒進影片。
 * 全程純前端,影片與音訊不離開瀏覽器。
 */
(() => {
  "use strict";

  // ---- 外部資源(CDN 依序備援) ----
  const TRANSFORMERS_URLS = [
    "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.min.js",
    "https://unpkg.com/@huggingface/transformers@3.8.1/dist/transformers.min.js",
  ];
  const OPENCC_URLS = [
    "https://cdn.jsdelivr.net/npm/opencc-js@1.4.1/dist/umd/full.js",
    "https://unpkg.com/opencc-js@1.4.1/dist/umd/full.js",
  ];
  const FONT_URLS = [
    "https://cdn.jsdelivr.net/npm/@expo-google-fonts/noto-sans-tc@0.4.3/400Regular/NotoSansTC_400Regular.ttf",
    "https://unpkg.com/@expo-google-fonts/noto-sans-tc@0.4.3/400Regular/NotoSansTC_400Regular.ttf",
  ];
  const MODEL_ID = "Xenova/whisper-small"; // 中文效果/大小的折衷,q8 量化約 250 MB

  const ASR_SR = 16000;      // Whisper 輸入取樣率
  const SLICE_SEC = 30;      // 逐段辨識長度(= Whisper 視窗),兼作進度單位
  const QUIET_PEAK_DB = -50; // 峰值低於此的片段視為無聲,跳過以減少幻聽
  const DRAFT_KEY = "subtitle-draft-v1";
  const MAX_INPUT_MB = 500;

  // Whisper 的段落起點常把語音前的靜音吸進來(字幕比聲音早出現),
  // 生成時用音訊包絡把每句起點對齊到實際開口點:
  const ONSET_MAX_AHEAD = 2.0; // 起點最多往後找幾秒的「開口點」
  const ONSET_LEAD = 0.05;     // 對齊後仍提前一點點顯示,避免切到字頭
  const OFFSET_STEP = 0.1;     // 位移微調按鈕的步進(秒)

  const { createLoadedFFmpeg, formatSize } = window.FFmpegLoader;

  // ---- DOM ----
  const $ = (id) => document.getElementById(id);
  const dropZone = $("drop-zone");
  const fileInput = $("file-input");
  const fileError = $("file-error");
  const asrCard = $("asr-card");
  const fileNameEl = $("file-name");
  const changeFileBtn = $("change-file-btn");
  const video = $("video-preview");
  const asrBtn = $("asr-btn");
  const progressArea = $("progress-area");
  const progressText = $("progress-text");
  const progressBar = $("progress-bar");
  const cancelBtn = $("cancel-btn");
  const asrError = $("asr-error");
  const captionOverlay = $("caption-overlay");
  const offsetInput = $("offset-input");
  const offsetMinus = $("offset-minus");
  const offsetPlus = $("offset-plus");
  const editorCard = $("editor-card");
  const draftNote = $("draft-note");
  const autosaveNote = $("autosave-note");
  const subList = $("sub-list");
  const addEndBtn = $("add-end-btn");
  const srtBtn = $("srt-btn");
  const burnBtn = $("burn-btn");
  const burnProgressArea = $("burn-progress-area");
  const burnProgressText = $("burn-progress-text");
  const burnProgressBar = $("burn-progress-bar");
  const burnCancelBtn = $("burn-cancel-btn");
  const burnError = $("burn-error");
  const resultCard = $("result-card");
  const resultVideo = $("result-video");
  const resultSize = $("result-size");
  const downloadBtn = $("download-btn");

  // ---- 狀態 ----
  let currentFile = null;
  let videoURL = null;
  let segs = [];            // [{start, end, text}](未套位移的原始時間)
  let timeOffset = 0;       // 字幕整體位移(秒),正=延後;預覽/匯出/燒錄都套用
  let busy = false;
  let cancelled = false;
  let transcriber = null;   // Whisper pipeline(載入後常駐)
  let toTraditional = null; // OpenCC 轉換函式
  let ffmpeg = null;
  let resultURL = null;
  let srtURL = null;
  let saveTimer = null;

  // ==========================================================
  // 檔案選擇(含從合併工具帶過來的影片)
  // ==========================================================

  const ACCEPT_RE = /\.(mp4|mov|webm)$/i;
  const ACCEPT_MIME = ["video/mp4", "video/quicktime", "video/webm"];

  // 以檔名+大小識別「同一支影片」(lastModified 在重選檔案時可能改變,不採計)
  function fileKey(f) {
    return `${f.name}|${f.size}`;
  }

  function pickFile(file) {
    hideError(fileError);
    if (!file) return;
    const okType = ACCEPT_MIME.includes(file.type) || ACCEPT_RE.test(file.name);
    if (!okType) {
      showError(fileError, "這個檔案格式不支援,請選擇 MP4、MOV 或 WebM 影片。");
      return;
    }
    if (file.size > MAX_INPUT_MB * 1024 * 1024) {
      showError(fileError, `檔案太大了(${formatSize(file.size)}),瀏覽器內處理的上限約 ${MAX_INPUT_MB} MB。`);
      return;
    }

    currentFile = file;
    segs = [];
    setOffset(0);
    editorCard.hidden = true;
    resetResult();
    hideError(asrError);
    if (videoURL) URL.revokeObjectURL(videoURL);
    videoURL = URL.createObjectURL(file);
    video.src = videoURL;
    fileNameEl.textContent = `${file.name}(${formatSize(file.size)})`;
    asrCard.hidden = false;
    asrCard.scrollIntoView({ behavior: "smooth", block: "start" });

    // 有同一支影片的編輯草稿就自動還原
    const draft = loadDraft();
    if (draft && draft.key === fileKey(file) && draft.segs.length) {
      segs = draft.segs;
      setOffset(draft.offset || 0);
      renderEditor();
      draftNote.textContent =
        `📌 已還原上次的編輯進度(${draft.segs.length} 句,` +
        `存於 ${new Date(draft.savedAt).toLocaleString()});想重來可再按「開始辨識」。`;
      draftNote.hidden = false;
      editorCard.hidden = false;
    }
  }

  dropZone.addEventListener("click", () => fileInput.click());
  dropZone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fileInput.click();
    }
  });
  fileInput.addEventListener("change", () => {
    pickFile(fileInput.files[0]);
    fileInput.value = "";
  });
  changeFileBtn.addEventListener("click", () => fileInput.click());
  ["dragenter", "dragover"].forEach((t) =>
    dropZone.addEventListener(t, (e) => {
      e.preventDefault();
      dropZone.classList.add("dragover");
    })
  );
  ["dragleave", "drop"].forEach((t) =>
    dropZone.addEventListener(t, (e) => {
      e.preventDefault();
      dropZone.classList.remove("dragover");
    })
  );
  dropZone.addEventListener("drop", (e) => pickFile(e.dataTransfer.files[0]));

  // 從「影片合併剪輯」帶過來的結果(IndexedDB 交接)
  const IDB_NAME = "video-tools";
  function idbOpen() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore("handoff");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function idbTake(key) {
    const db = await idbOpen();
    return new Promise((resolve) => {
      const tx = db.transaction("handoff", "readwrite");
      const store = tx.objectStore("handoff");
      const get = store.get(key);
      get.onsuccess = () => {
        store.delete(key); // 讀完即刪,釋放空間
        resolve(get.result || null);
      };
      get.onerror = () => resolve(null);
    });
  }

  (async () => {
    if (new URLSearchParams(location.search).get("from") !== "merge") return;
    try {
      const rec = await idbTake("merged");
      if (rec && rec.blob) {
        pickFile(new File([rec.blob], rec.name || "merged.mp4", {
          type: "video/mp4",
          lastModified: rec.savedAt || Date.now(),
        }));
      } else {
        showError(fileError, "找不到剛合併的影片(可能已被清除),請重新選擇檔案。");
      }
    } catch (_) { /* 讀不到就讓使用者自己選檔 */ }
  })();

  // ==========================================================
  // 語音辨識引擎(transformers.js + Whisper + OpenCC)
  // ==========================================================

  async function tryUrls(urls, fn) {
    let lastErr = null;
    for (const u of urls) {
      try {
        return await fn(u);
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error("所有 CDN 均無法連線");
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("無法載入 " + src));
      document.head.appendChild(s);
    });
  }

  async function ensureEngine(onModelProgress) {
    if (!toTraditional) {
      await tryUrls(OPENCC_URLS, (u) => loadScript(u));
      // twp:轉台灣正體並套用台灣用語(例如 视频→影片)
      toTraditional = window.OpenCC.Converter({ from: "cn", to: "twp" });
    }
    if (!transcriber) {
      const mod = await tryUrls(TRANSFORMERS_URLS, (u) => import(u));
      mod.env.allowLocalModels = false;
      const files = {}; // 個別檔案的下載進度 → 彙總
      transcriber = await mod.pipeline("automatic-speech-recognition", MODEL_ID, {
        dtype: "q8",
        progress_callback: (p) => {
          if (p.status === "progress" && p.file && p.total) {
            files[p.file] = { loaded: p.loaded, total: p.total };
            let loaded = 0, total = 0;
            for (const f of Object.values(files)) {
              loaded += f.loaded;
              total += f.total;
            }
            onModelProgress(loaded, total);
          }
        },
      });
    }
  }

  // 產生 20ms 一格的音量包絡與自適應門檻(第 95 百分位 −25dB,夾在 −55~−35),
  // 回傳「從時間 t 起、往後最多 maxAhead 秒內第一個有聲時間」的查詢函式
  function makeOnsetFinder(mono) {
    const hop = Math.round(0.02 * ASR_SR);
    const n = Math.max(1, Math.ceil(mono.length / hop));
    const db = new Float32Array(n);
    for (let w = 0; w < n; w++) {
      const s0 = w * hop;
      const s1 = Math.min(mono.length, s0 + hop);
      let sum = 0;
      for (let i = s0; i < s1; i++) sum += mono[i] * mono[i];
      db[w] = 20 * Math.log10(Math.sqrt(sum / Math.max(1, s1 - s0)) + 1e-8);
    }
    const sorted = Array.from(db).sort((a, b) => a - b);
    const p95 = sorted[Math.floor((sorted.length - 1) * 0.95)];
    const threshold = Math.min(-35, Math.max(-55, p95 - 25));
    const hopSec = hop / ASR_SR;
    return (t, maxAhead) => {
      const wEnd = Math.min(n, Math.ceil((t + maxAhead) / hopSec));
      for (let w = Math.max(0, Math.floor(t / hopSec)); w < wEnd; w++) {
        if (db[w] >= threshold) return w * hopSec;
      }
      return null;
    };
  }

  // 解碼音軌成 16kHz 單聲道
  async function decodeAudio(file) {
    const buf = await file.arrayBuffer();
    const actx = new OfflineAudioContext(1, 1, ASR_SR);
    const audio = await actx.decodeAudioData(buf);
    const mono = new Float32Array(audio.length);
    for (let c = 0; c < audio.numberOfChannels; c++) {
      const ch = audio.getChannelData(c);
      for (let i = 0; i < ch.length; i++) mono[i] += ch[i] / audio.numberOfChannels;
    }
    return { mono, duration: audio.duration };
  }

  function setProgress(bar, textEl, ratio, text) {
    bar.style.width = `${Math.round(Math.min(1, Math.max(0, ratio)) * 100)}%`;
    if (text) textEl.textContent = text;
  }

  asrBtn.addEventListener("click", async () => {
    if (busy || !currentFile) return;
    if (segs.length &&
        !window.confirm("重新辨識會覆蓋目前的字幕編輯內容,確定要繼續嗎?")) {
      return;
    }
    busy = true;
    cancelled = false;
    asrBtn.disabled = true;
    hideError(asrError);
    draftNote.hidden = true;
    progressArea.hidden = false;
    setProgress(progressBar, progressText, 0, "準備中…");

    try {
      // 1) 解碼音軌(順便確認有聲音)
      let decoded;
      try {
        decoded = await decodeAudio(currentFile);
      } catch (_) {
        throw new Error("偵測不到音軌(或音訊無法解析),無法進行語音辨識。" +
          "若這是 iPhone 拍的 HEVC 影片,可到「設定 → 相機 → 格式」改選「最相容」。");
      }
      if (cancelled) return;

      // 2) 載入模型(首次會下載,顯示進度)
      await ensureEngine((loaded, total) => {
        setProgress(progressBar, progressText, total ? loaded / total : 0,
          `下載語音辨識模型中… ${formatSize(loaded)} / ${formatSize(total)}(只需下載一次)`);
      });
      if (cancelled) return;

      // 3) 逐段辨識
      const { mono, duration } = decoded;
      const findOnset = makeOnsetFinder(mono);
      const out = [];
      const sliceN = SLICE_SEC * ASR_SR;
      for (let off = 0; off < mono.length; off += sliceN) {
        if (cancelled) return;
        const t0 = off / ASR_SR;
        setProgress(progressBar, progressText, t0 / duration,
          `辨識中… ${formatClock(t0)} / ${formatClock(duration)}`);
        await new Promise((r) => setTimeout(r, 30)); // 讓進度條有機會重繪

        const slice = mono.subarray(off, Math.min(mono.length, off + sliceN));
        // 幾乎無聲的片段直接跳過(Whisper 對無聲容易產生幻覺字幕)
        let peak = 0;
        for (let i = 0; i < slice.length; i++) {
          const a = Math.abs(slice[i]);
          if (a > peak) peak = a;
        }
        if (20 * Math.log10(peak + 1e-8) < QUIET_PEAK_DB) continue;

        const res = await transcriber(slice, {
          language: "chinese",
          task: "transcribe",
          return_timestamps: true,
        });
        const chunks = res.chunks && res.chunks.length
          ? res.chunks
          : (res.text ? [{ timestamp: [0, slice.length / ASR_SR], text: res.text }] : []);
        for (const ch of chunks) {
          let [s, e] = ch.timestamp;
          if (e == null || !isFinite(e)) e = slice.length / ASR_SR;
          const text = toTraditional(String(ch.text || "").trim());
          if (!text) continue;
          let start = t0 + s;
          const end = Math.min(duration, t0 + e);
          // Whisper 起點常偏早(把前面的靜音吸進來),對齊到實際開口點
          const onset = findOnset(start, Math.min(ONSET_MAX_AHEAD, Math.max(0, end - start - 0.1)));
          if (onset !== null && onset > start + 0.06) {
            start = Math.max(0, onset - ONSET_LEAD);
          }
          out.push({
            start: +start.toFixed(2),
            end: +end.toFixed(2),
            text,
          });
        }
      }
      if (cancelled) return;
      setProgress(progressBar, progressText, 1, "辨識完成!");

      segs = out;
      if (!segs.length) {
        showError(asrError, "沒有辨識到任何語音內容。可能是音量太小、背景音太大,或內容不是語音。");
      }
      saveDraft();
      renderEditor();
      editorCard.hidden = false;
      editorCard.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (err) {
      if (!cancelled) {
        console.error(err);
        showError(asrError,
          "辨識失敗:" + (err && err.message ? err.message : err) +
          "\n可能原因:網路無法下載模型,或記憶體不足。可以重新整理後再試一次。");
      }
    } finally {
      busy = false;
      asrBtn.disabled = false;
      progressArea.hidden = true;
    }
  });

  cancelBtn.addEventListener("click", () => {
    cancelled = true;
    busy = false;
    asrBtn.disabled = false;
    progressArea.hidden = true;
    showError(asrError, "已取消辨識。");
  });

  // ==========================================================
  // 字幕編輯器
  // ==========================================================

  function renderEditor() {
    subList.textContent = "";
    segs.forEach((seg, i) => {
      const li = document.createElement("li");
      li.className = "sub-row";
      li.dataset.i = i;

      const play = rowBtn("▶", "跳到這句播放", () => {
        video.currentTime = Math.max(0, seg.start + timeOffset);
        video.play();
        video.scrollIntoView({ behavior: "smooth", block: "nearest" });
      });
      play.classList.add("sub-play");

      const startIn = document.createElement("input");
      startIn.type = "number";
      startIn.className = "sub-time";
      startIn.step = "0.1";
      startIn.min = "0";
      startIn.value = seg.start.toFixed(2);
      startIn.title = "開始秒數";
      startIn.addEventListener("change", () => {
        seg.start = Math.max(0, Math.min(parseFloat(startIn.value) || 0, seg.end - 0.1));
        startIn.value = seg.start.toFixed(2);
        scheduleSave();
      });

      const dash = document.createElement("span");
      dash.className = "sub-dash";
      dash.textContent = "–";

      const endIn = document.createElement("input");
      endIn.type = "number";
      endIn.className = "sub-time";
      endIn.step = "0.1";
      endIn.min = "0";
      endIn.value = seg.end.toFixed(2);
      endIn.title = "結束秒數";
      endIn.addEventListener("change", () => {
        seg.end = Math.max(seg.start + 0.1, parseFloat(endIn.value) || 0);
        endIn.value = seg.end.toFixed(2);
        scheduleSave();
      });

      const textIn = document.createElement("input");
      textIn.type = "text";
      textIn.className = "sub-text";
      textIn.value = seg.text;
      textIn.placeholder = "(字幕文字)";
      textIn.addEventListener("input", () => {
        seg.text = textIn.value;
        scheduleSave();
      });

      const actions = document.createElement("span");
      actions.className = "sub-actions";
      actions.append(
        rowBtn("⇧併", "併入上一句(時間與文字合併)", () => {
          if (i === 0) return;
          segs[i - 1].end = Math.max(segs[i - 1].end, seg.end);
          segs[i - 1].text = (segs[i - 1].text + " " + seg.text).trim();
          segs.splice(i, 1);
          afterStructureChange();
        }, i === 0),
        rowBtn("✂拆", "從游標位置拆成兩句", () => {
          const pos = textIn.selectionStart ?? Math.ceil(seg.text.length / 2);
          const a = seg.text.slice(0, pos).trim();
          const b = seg.text.slice(pos).trim();
          const ratio = seg.text.length ? Math.min(0.9, Math.max(0.1, pos / seg.text.length)) : 0.5;
          const mid = +(seg.start + (seg.end - seg.start) * ratio).toFixed(2);
          const second = { start: mid, end: seg.end, text: b };
          seg.end = mid;
          seg.text = a;
          segs.splice(i + 1, 0, second);
          afterStructureChange();
        }),
        rowBtn("＋", "在這句後面新增一句", () => {
          const start = seg.end;
          const nextStart = segs[i + 1] ? segs[i + 1].start : start + 2;
          segs.splice(i + 1, 0, {
            start,
            end: Math.max(start + 0.5, Math.min(start + 2, nextStart)),
            text: "",
          });
          afterStructureChange();
        }),
        rowBtn("✕", "刪除這句", () => {
          segs.splice(i, 1);
          afterStructureChange();
        }),
      );

      li.append(play, startIn, dash, endIn, textIn, actions);
      subList.appendChild(li);
    });
  }

  function rowBtn(label, title, onClick, disabled = false) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn btn-small";
    b.textContent = label;
    b.title = title;
    b.disabled = disabled;
    b.addEventListener("click", onClick);
    return b;
  }

  function afterStructureChange() {
    renderEditor();
    scheduleSave();
  }

  addEndBtn.addEventListener("click", () => {
    const last = segs[segs.length - 1];
    const start = last ? last.end : 0;
    segs.push({ start, end: start + 2, text: "" });
    afterStructureChange();
  });

  // ==========================================================
  // 字幕時間位移(套用於預覽、匯出、燒錄)
  // ==========================================================

  function setOffset(v) {
    timeOffset = Math.max(-30, Math.min(30, Math.round((v || 0) * 10) / 10));
    offsetInput.value = timeOffset.toFixed(1);
    updateCaption();
    scheduleSave();
  }

  offsetInput.addEventListener("change", () => setOffset(parseFloat(offsetInput.value)));
  offsetMinus.addEventListener("click", () => setOffset(timeOffset - OFFSET_STEP));
  offsetPlus.addEventListener("click", () => setOffset(timeOffset + OFFSET_STEP));

  // 套用位移後的字幕(空句剔除,時間夾到 0 以上)
  function shiftedSegs() {
    return segs
      .filter((s) => s.text.trim())
      .map((s) => ({
        start: Math.max(0, s.start + timeOffset),
        end: Math.max(0.1, s.end + timeOffset),
        text: s.text.trim(),
      }));
  }

  // 預覽播放器上的即時字幕(位移即時生效)
  function updateCaption() {
    if (editorCard.hidden) {
      captionOverlay.hidden = true;
      return;
    }
    const t = video.currentTime;
    const idx = segs.findIndex(
      (s) => s.text.trim() && t >= s.start + timeOffset && t < s.end + timeOffset);
    const seg = segs[idx];
    if (seg) {
      captionOverlay.textContent = seg.text;
      captionOverlay.hidden = false;
    } else {
      captionOverlay.hidden = true;
    }
    subList.querySelectorAll(".sub-row").forEach((el, i) => {
      el.classList.toggle("active", i === idx);
    });
  }

  video.addEventListener("timeupdate", updateCaption);
  video.addEventListener("seeked", updateCaption);
  // 播放中用 rAF 更新,字幕切換才夠即時(timeupdate 只有約每 0.25 秒一次)
  video.addEventListener("play", function loop() {
    updateCaption();
    if (!video.paused && !video.ended) requestAnimationFrame(() => loop());
  });

  // ==========================================================
  // 草稿(localStorage 自動暫存)
  // ==========================================================

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveDraft, 400);
  }

  function saveDraft() {
    if (!currentFile) return;
    if (!segs.length) return; // 不要用剛選檔的空狀態覆蓋既有草稿
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({
        key: fileKey(currentFile),
        segs,
        offset: timeOffset,
        savedAt: Date.now(),
      }));
      autosaveNote.textContent = "已自動暫存 " + new Date().toLocaleTimeString();
    } catch (_) {
      autosaveNote.textContent = "⚠ 暫存失敗(空間不足)";
    }
  }

  function loadDraft() {
    try {
      return JSON.parse(localStorage.getItem(DRAFT_KEY) || "null");
    } catch (_) {
      return null;
    }
  }

  // ==========================================================
  // 匯出 SRT
  // ==========================================================

  function srtTimestamp(t) {
    t = Math.max(0, t);
    const p = (x, l) => String(x).padStart(l, "0");
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = Math.floor(t % 60);
    const ms = Math.round((t - Math.floor(t)) * 1000);
    return `${p(h, 2)}:${p(m, 2)}:${p(s, 2)},${p(ms, 3)}`;
  }

  function toSRT(withBOM) {
    // \u5957\u7528\u6574\u9AD4\u4F4D\u79FB\u5F8C\u8F38\u51FA
    const body = shiftedSegs()
      .map((s, i) => `${i + 1}\n${srtTimestamp(s.start)} --> ${srtTimestamp(s.end)}\n${s.text}\n`)
      .join("\n");
    return (withBOM ? "\uFEFF" : "") + body;
  }

  srtBtn.addEventListener("click", () => {
    // 匯出加 BOM,老播放器比較不會亂碼
    const blob = new Blob([toSRT(true)], { type: "text/plain;charset=utf-8" });
    if (srtURL) URL.revokeObjectURL(srtURL);
    srtURL = URL.createObjectURL(blob);
    srtBtn.href = srtURL;
    const base = currentFile ? currentFile.name.replace(/\.[^.]+$/, "") : "subtitles";
    srtBtn.download = base + ".srt";
  });

  // ==========================================================
  // 字幕燒進影片(ffmpeg.wasm + libass + Noto Sans TC)
  // ==========================================================

  async function getFFmpeg(onStatus) {
    if (ffmpeg && ffmpeg.loaded) return ffmpeg;
    ffmpeg = await createLoadedFFmpeg(onStatus);
    return ffmpeg;
  }

  burnBtn.addEventListener("click", async () => {
    if (busy || !currentFile) return;
    const useful = segs.filter((s) => s.text.trim());
    if (!useful.length) {
      showError(burnError, "目前沒有任何字幕內容可以燒錄。");
      return;
    }
    busy = true;
    cancelled = false;
    burnBtn.disabled = true;
    hideError(burnError);
    resetResult();
    burnProgressArea.hidden = false;
    setProgress(burnProgressBar, burnProgressText, 0, "準備中…");

    const ext = (currentFile.name.match(ACCEPT_RE) || [".mp4"])[0].toLowerCase();
    const inName = "input" + ext;
    const duration = video.duration || 1;

    try {
      const ff = await getFFmpeg((msg) => setProgress(burnProgressBar, burnProgressText, 0, msg));
      if (cancelled) return;
      const { fetchFile } = window.FFmpegUtil;

      setProgress(burnProgressBar, burnProgressText, 0.02, "下載字幕字型(約 7 MB,Noto Sans TC)…");
      const fontData = await tryUrls(FONT_URLS, async (u) => {
        const r = await fetch(u);
        if (!r.ok) throw new Error("font fetch failed");
        return new Uint8Array(await r.arrayBuffer());
      });
      if (cancelled) return;

      setProgress(burnProgressBar, burnProgressText, 0.05, "正在讀取影片…");
      await ff.writeFile(inName, await fetchFile(currentFile));
      await ff.writeFile("subs.srt", toSRT(false));
      await ff.createDir("/fonts").catch(() => {});
      await ff.writeFile("/fonts/NotoSansTC.ttf", fontData);
      if (cancelled) return;

      const onProgress = ({ time }) => {
        const r = Math.min(1, time / 1e6 / duration);
        setProgress(burnProgressBar, burnProgressText, 0.08 + r * 0.9,
          `燒錄中… ${Math.round(r * 100)}%(影片會重新編碼,速度較慢)`);
      };
      ff.on("progress", onProgress);
      let ret;
      try {
        ret = await ff.exec([
          "-i", inName,
          "-vf",
          "subtitles=subs.srt:fontsdir=/fonts:force_style=" +
            "'FontName=Noto Sans TC,FontSize=22,Outline=1,Shadow=0,MarginV=20'",
          "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
          "-c:a", "aac", "-b:a", "128k",
          "burned.mp4",
        ]);
      } finally {
        ff.off("progress", onProgress);
      }
      if (cancelled) return;
      if (ret !== 0) throw new Error("燒錄失敗(exit code " + ret + ")");

      setProgress(burnProgressBar, burnProgressText, 0.99, "正在產生檔案…");
      const data = await ff.readFile("burned.mp4");
      const blob = new Blob([data.buffer], { type: "video/mp4" });

      for (const n of [inName, "subs.srt", "/fonts/NotoSansTC.ttf", "burned.mp4"]) {
        await ff.deleteFile(n).catch(() => {});
      }

      if (resultURL) URL.revokeObjectURL(resultURL);
      resultURL = URL.createObjectURL(blob);
      resultVideo.src = resultURL;
      downloadBtn.href = resultURL;
      const base = currentFile.name.replace(/\.[^.]+$/, "");
      downloadBtn.download = base + "-subtitled.mp4";
      resultSize.textContent = formatSize(blob.size);
      resultCard.hidden = false;
      resultCard.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (err) {
      if (!cancelled) {
        console.error(err);
        showError(burnError,
          "燒錄失敗:" + (err && err.message ? err.message : err) +
          "\n可能原因:網路無法連到 CDN、影片編碼不支援,或記憶體不足。");
        try { ffmpeg && ffmpeg.terminate(); } catch (_) {}
        ffmpeg = null;
      }
    } finally {
      busy = false;
      burnBtn.disabled = false;
      burnProgressArea.hidden = true;
    }
  });

  burnCancelBtn.addEventListener("click", () => {
    cancelled = true;
    try { ffmpeg && ffmpeg.terminate(); } catch (_) {}
    ffmpeg = null;
    busy = false;
    burnBtn.disabled = false;
    burnProgressArea.hidden = true;
    showError(burnError, "已取消燒錄。");
  });

  function resetResult() {
    resultCard.hidden = true;
    if (resultURL) {
      URL.revokeObjectURL(resultURL);
      resultURL = null;
    }
    resultVideo.removeAttribute("src");
  }

  // ==========================================================
  // 小工具
  // ==========================================================

  function formatClock(t) {
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  function showError(el, msg) {
    el.textContent = msg;
    el.hidden = false;
  }

  function hideError(el) {
    el.hidden = true;
  }
})();
