/* ===== 影片合併剪輯 =====
 * 多支影片各剪一段,逐支正規化(統一解析度/幀率/編碼)後以 concat 合併。
 * 逐支處理是刻意設計:同時只有一支影片留在 wasm 檔案系統,控制記憶體用量。
 * 「自動剪輯」用 Web Audio API 分析音量包絡找無聲片段(比 ffmpeg 分析快),
 * 剪除片段直接展開成多段 keep 區間進正規化流程,不增加編碼次數。
 */
(() => {
  "use strict";

  const MAX_INPUT_MB = 500;        // 單支影片上限
  const SUGGESTED_TOTAL_MB = 500;  // 總量建議上限,超過即警告
  const OUT_FPS = 30;              // 合併輸出幀率
  const MAX_OUT_WIDTH = 1280;      // 合併輸出寬度上限(記憶體/速度考量)

  // ---- 自動剪輯參數 ----
  const SENSITIVITY = {
    conservative: 1.5, // 只剪 1.5 秒以上空白
    standard: 0.8,     // 剪 0.8 秒以上停頓
    aggressive: 0.4,   // 連 0.4 秒短停頓都剪
  };
  const CUT_PAD = 0.15;        // 剪除片段前後保留的緩衝秒數
  const ENV_HOP = 0.05;        // 音量包絡取樣間隔(秒)
  const ANALYZE_SR = 8000;     // 分析用取樣率(語音夠用,省記憶體)
  const MIN_KEEP_GAP = 0.2;    // 兩段剪除之間的保留若短於此,併成一段剪除
  const MIN_CUT_LEN = 0.05;    // 扣掉緩衝後短於此的剪除直接捨棄
  const MIN_VOICED_RATIO = 0.05; // 有聲比例低於此視為「幾乎無聲」,整支保留

  const { createLoadedFFmpeg, formatSize } = window.FFmpegLoader;

  // ---- DOM ----
  const $ = (id) => document.getElementById(id);
  const dropZone = $("drop-zone");
  const fileInput = $("file-input");
  const fileError = $("file-error");
  const listCard = $("list-card");
  const videoList = $("video-list");
  const totalSizeEl = $("total-size");
  const totalWarning = $("total-warning");
  const addMoreBtn = $("add-more-btn");
  const editorCard = $("editor-card");
  const editorName = $("editor-name");
  const editorVideo = $("editor-video");
  const editorCloseBtn = $("editor-close-btn");
  const startRange = $("start-range");
  const endRange = $("end-range");
  const startInput = $("start-input");
  const endInput = $("end-input");
  const startNowBtn = $("start-now-btn");
  const endNowBtn = $("end-now-btn");
  const playClipBtn = $("play-clip-btn");
  const clipLengthEl = $("clip-length");
  const mergeCard = $("merge-card");
  const mergeCount = $("merge-count");
  const mergeLength = $("merge-length");
  const mergeBtn = $("merge-btn");
  const autocutToggle = $("autocut-toggle");
  const autocutSettings = $("autocut-settings");
  const previewCard = $("preview-card");
  const analysisNotes = $("analysis-notes");
  const noCutsMsg = $("no-cuts-msg");
  const cutList = $("cut-list");
  const statBefore = $("stat-before");
  const statAfter = $("stat-after");
  const statSaved = $("stat-saved");
  const emptyWarning = $("empty-warning");
  const confirmMergeBtn = $("confirm-merge-btn");
  const previewCancelBtn = $("preview-cancel-btn");
  const progressArea = $("progress-area");
  const progressText = $("progress-text");
  const progressBar = $("progress-bar");
  const cancelBtn = $("cancel-btn");
  const mergeError = $("merge-error");
  const resultCard = $("result-card");
  const resultVideo = $("result-video");
  const resultSize = $("result-size");
  const downloadBtn = $("download-btn");
  const subtitleBtn = $("subtitle-btn");
  const publishBtn = $("publish-btn");

  // ---- 狀態 ----
  let items = [];        // {id, file, url, duration, width, height, start, end, envelope}
  let nextId = 1;
  let selectedId = null; // 正在剪輯的項目
  let dragId = null;     // 正在拖曳的項目
  let busy = false;      // 分析或合併進行中
  let cancelled = false;
  let clipStopTimer = null;
  let resultURL = null;
  let resultBlob = null;
  let ffmpeg = null;
  let pendingCuts = null; // 分析結果:[{itemId, start, end, keep}]
  let pendingNotes = [];  // 分析提示(無音軌等)

  async function getFFmpeg(onStatus) {
    if (ffmpeg && ffmpeg.loaded) return ffmpeg;
    ffmpeg = await createLoadedFFmpeg(onStatus);
    return ffmpeg;
  }

  // ==========================================================
  // 檔案選擇
  // ==========================================================

  const ACCEPT_RE = /\.(mp4|mov|webm)$/i;
  const ACCEPT_MIME = ["video/mp4", "video/quicktime", "video/webm"];
  const HEVC_HINT =
    "若是 iPhone 拍的影片,很可能是 HEVC/H.265 編碼,瀏覽器無法解碼;" +
    "可到 iPhone「設定 → 相機 → 格式」改選「最相容」再重新拍攝/匯出," +
    "或先用其他工具轉成 H.264 MP4。";

  async function addFiles(fileListLike) {
    hideError(fileError);
    const files = Array.from(fileListLike || []);
    const errors = [];

    for (const file of files) {
      const okType = ACCEPT_MIME.includes(file.type) || ACCEPT_RE.test(file.name);
      if (!okType) {
        errors.push(`「${file.name}」格式不支援(僅支援 MP4、MOV、WebM)。`);
        continue;
      }
      if (file.size > MAX_INPUT_MB * 1024 * 1024) {
        errors.push(`「${file.name}」太大(${formatSize(file.size)}),單支上限約 ${MAX_INPUT_MB} MB。`);
        continue;
      }
      try {
        const meta = await readVideoMeta(file);
        items.push({
          id: nextId++,
          file,
          url: meta.url,
          duration: meta.duration,
          width: meta.width,
          height: meta.height,
          start: 0,
          end: meta.duration,
          envelope: null, // 音量包絡快取(自動剪輯用)
        });
      } catch (_) {
        errors.push(`「${file.name}」無法讀取,可能已損壞或編碼不支援。${HEVC_HINT}`);
      }
    }

    if (errors.length) showError(fileError, errors.join("\n"));
    invalidatePreview();
    render();
  }

  // 讀取影片長度與尺寸(不進 wasm,交給瀏覽器解碼 metadata 即可)
  function readVideoMeta(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const v = document.createElement("video");
      v.preload = "metadata";
      v.onloadedmetadata = () => {
        const duration = Math.round(v.duration * 10) / 10;
        if (!isFinite(duration) || duration <= 0 || !v.videoWidth) {
          URL.revokeObjectURL(url);
          reject(new Error("no video track"));
          return;
        }
        resolve({ url, duration, width: v.videoWidth, height: v.videoHeight });
      };
      v.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("decode error"));
      };
      v.src = url;
    });
  }

  dropZone.addEventListener("click", () => fileInput.click());
  dropZone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fileInput.click();
    }
  });
  addMoreBtn.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    addFiles(fileInput.files);
    fileInput.value = "";
  });

  ["dragenter", "dragover"].forEach((type) =>
    dropZone.addEventListener(type, (e) => {
      e.preventDefault();
      dropZone.classList.add("dragover");
    })
  );
  ["dragleave", "drop"].forEach((type) =>
    dropZone.addEventListener(type, (e) => {
      e.preventDefault();
      dropZone.classList.remove("dragover");
    })
  );
  dropZone.addEventListener("drop", (e) => addFiles(e.dataTransfer.files));

  // ==========================================================
  // 清單顯示與排序
  // ==========================================================

  function render() {
    renderList();
    renderTotals();
    const has = items.length > 0;
    listCard.hidden = !has;
    mergeCard.hidden = !has;
    if (selectedId && !items.some((it) => it.id === selectedId)) closeEditor();
  }

  function renderList() {
    videoList.textContent = "";
    items.forEach((item, i) => {
      const li = document.createElement("li");
      li.className = "video-item" + (item.id === selectedId ? " selected" : "");
      li.draggable = true;
      li.dataset.id = item.id;

      const handle = document.createElement("span");
      handle.className = "drag-handle";
      handle.title = "拖曳調整順序";
      handle.textContent = "⠿";

      const idx = document.createElement("span");
      idx.className = "item-index";
      idx.textContent = i + 1;

      const info = document.createElement("div");
      info.className = "item-info";
      const name = document.createElement("div");
      name.className = "item-name";
      name.textContent = item.file.name;
      const meta = document.createElement("div");
      meta.className = "item-meta";
      const keep = item.end - item.start;
      const trimmed = keep < item.duration - 0.05;
      meta.textContent =
        `${formatSize(item.file.size)}・全長 ${item.duration.toFixed(1)} 秒・` +
        (trimmed
          ? `保留 ${item.start.toFixed(1)}–${item.end.toFixed(1)} 秒(${keep.toFixed(1)} 秒)`
          : "保留全部");
      info.append(name, meta);

      const actions = document.createElement("div");
      actions.className = "item-actions";
      actions.append(
        itemBtn("✂ 剪輯", "設定要保留的片段", () => openEditor(item.id)),
        itemBtn("↑", "往前移", () => moveItem(i, i - 1), i === 0),
        itemBtn("↓", "往後移", () => moveItem(i, i + 1), i === items.length - 1),
        itemBtn("✕", "移除這支影片", () => removeItem(item.id)),
      );

      li.append(handle, idx, info, actions);

      li.addEventListener("dragstart", (e) => {
        dragId = item.id;
        li.classList.add("dragging");
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", String(item.id)); // Firefox 需要
      });
      li.addEventListener("dragend", () => {
        dragId = null;
        li.classList.remove("dragging");
        videoList.querySelectorAll(".drop-target").forEach((el) => el.classList.remove("drop-target"));
      });
      li.addEventListener("dragover", (e) => {
        if (dragId === null || dragId === item.id) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        li.classList.add("drop-target");
      });
      li.addEventListener("dragleave", () => li.classList.remove("drop-target"));
      li.addEventListener("drop", (e) => {
        e.preventDefault();
        li.classList.remove("drop-target");
        if (dragId === null || dragId === item.id) return;
        const from = items.findIndex((it) => it.id === dragId);
        const to = items.findIndex((it) => it.id === item.id);
        moveItem(from, to);
      });

      videoList.appendChild(li);
    });
  }

  function itemBtn(label, title, onClick, disabled = false) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn btn-small";
    b.textContent = label;
    b.title = title;
    b.disabled = disabled;
    b.addEventListener("click", onClick);
    return b;
  }

  function moveItem(from, to) {
    if (to < 0 || to >= items.length || from === to) return;
    const [it] = items.splice(from, 1);
    items.splice(to, 0, it);
    invalidatePreview();
    render();
  }

  function removeItem(id) {
    const i = items.findIndex((it) => it.id === id);
    if (i === -1) return;
    URL.revokeObjectURL(items[i].url);
    items.splice(i, 1);
    invalidatePreview();
    render();
  }

  function renderTotals() {
    const totalBytes = items.reduce((s, it) => s + it.file.size, 0);
    totalSizeEl.textContent = formatSize(totalBytes);
    if (totalBytes > SUGGESTED_TOTAL_MB * 1024 * 1024) {
      totalWarning.textContent =
        `⚠️ 總檔案大小 ${formatSize(totalBytes)} 已超過建議上限 ${SUGGESTED_TOTAL_MB} MB。` +
        "瀏覽器內轉檔的記憶體有限,合併可能失敗或讓分頁當掉;建議減少影片數量、先剪短片段,或分批合併。";
      totalWarning.hidden = false;
    } else {
      totalWarning.hidden = true;
    }

    mergeCount.textContent = items.length;
    const totalLen = items.reduce((s, it) => s + (it.end - it.start), 0);
    mergeLength.textContent = totalLen.toFixed(1);
  }

  // ==========================================================
  // 剪輯編輯器(一次編輯一支,清單點「✂ 剪輯」開啟)
  // ==========================================================

  function selectedItem() {
    return items.find((it) => it.id === selectedId) || null;
  }

  function openEditor(id) {
    const item = items.find((it) => it.id === id);
    if (!item) return;
    selectedId = id;
    editorName.textContent = item.file.name;
    editorVideo.src = item.url;
    for (const el of [startRange, endRange, startInput, endInput]) {
      el.max = item.duration;
    }
    setTrim(item.start, item.end);
    editorCard.hidden = false;
    renderList();
    editorCard.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function closeEditor() {
    selectedId = null;
    editorCard.hidden = true;
    editorVideo.pause();
    editorVideo.removeAttribute("src");
    clearTimeout(clipStopTimer);
    renderList();
  }

  editorCloseBtn.addEventListener("click", closeEditor);

  function getTrim() {
    return {
      start: parseFloat(startRange.value) || 0,
      end: parseFloat(endRange.value) || 0,
    };
  }

  function setTrim(start, end) {
    const item = selectedItem();
    if (!item) return;
    const duration = item.duration;
    start = Math.min(Math.max(0, start), duration);
    end = Math.min(Math.max(0, end), duration);
    if (end - start < 0.1) {
      // 保持至少 0.1 秒的區間
      if (start > duration - 0.1) start = Math.max(0, duration - 0.1);
      end = Math.min(duration, start + 0.1);
    }
    startRange.value = startInput.value = start.toFixed(1);
    endRange.value = endInput.value = end.toFixed(1);
    if (item.start !== start || item.end !== end) invalidatePreview();
    item.start = start;
    item.end = end;
    clipLengthEl.textContent = (end - start).toFixed(1);
    renderTotals();
    renderList();
  }

  startRange.addEventListener("input", () => {
    const { end } = getTrim();
    setTrim(parseFloat(startRange.value), Math.max(end, parseFloat(startRange.value) + 0.1));
    editorVideo.currentTime = getTrim().start;
  });
  endRange.addEventListener("input", () => {
    const { start } = getTrim();
    setTrim(Math.min(start, parseFloat(endRange.value) - 0.1), parseFloat(endRange.value));
    editorVideo.currentTime = getTrim().end;
  });
  startInput.addEventListener("change", () => {
    const v = parseFloat(startInput.value) || 0;
    setTrim(v, Math.max(getTrim().end, v + 0.1));
  });
  endInput.addEventListener("change", () => {
    const v = parseFloat(endInput.value) || 0;
    setTrim(Math.min(getTrim().start, v - 0.1), v);
  });
  startNowBtn.addEventListener("click", () => {
    setTrim(editorVideo.currentTime, Math.max(getTrim().end, editorVideo.currentTime + 0.1));
  });
  endNowBtn.addEventListener("click", () => {
    setTrim(Math.min(getTrim().start, editorVideo.currentTime - 0.1), editorVideo.currentTime);
  });
  playClipBtn.addEventListener("click", () => {
    const { start, end } = getTrim();
    clearTimeout(clipStopTimer);
    editorVideo.currentTime = start;
    editorVideo.play();
    clipStopTimer = setTimeout(() => editorVideo.pause(), (end - start) * 1000);
  });

  // ==========================================================
  // 自動剪輯:音量分析(Web Audio API)
  // ==========================================================

  // 解碼音軌並取得音量包絡(每 ENV_HOP 秒一格的 dBFS)。結果快取在 item 上。
  // 沒有音軌或解不開時丟出例外,由呼叫端當成「略過自動剪輯」處理。
  async function getEnvelope(item) {
    if (item.envelope) return item.envelope;
    const buf = await item.file.arrayBuffer();
    // 用低取樣率的 OfflineAudioContext 解碼,自動重取樣,省記憶體
    const actx = new OfflineAudioContext(1, 1, ANALYZE_SR);
    const audio = await actx.decodeAudioData(buf);
    const hopN = Math.round(ENV_HOP * audio.sampleRate);
    const n = Math.max(1, Math.ceil(audio.length / hopN));
    const db = new Float32Array(n);
    const chs = [];
    for (let c = 0; c < audio.numberOfChannels; c++) chs.push(audio.getChannelData(c));
    for (let w = 0; w < n; w++) {
      const s0 = w * hopN;
      const s1 = Math.min(audio.length, s0 + hopN);
      let sum = 0;
      for (const ch of chs) {
        for (let s = s0; s < s1; s++) sum += ch[s] * ch[s];
      }
      const cnt = Math.max(1, (s1 - s0) * chs.length);
      db[w] = 20 * Math.log10(Math.sqrt(sum / cnt) + 1e-8);
    }
    item.envelope = { db, hop: ENV_HOP };
    return item.envelope;
  }

  // 由包絡找出要剪除的區間(以來源影片時間軸計,已限制在手動剪輯範圍內)。
  // 門檻採自適應:以第 95 百分位音量(大聲參考)往下 25 dB,再夾在 -55 ~ -35 dBFS。
  function detectCuts(item, minSilence) {
    const { db, hop } = item.envelope;
    const sorted = Array.from(db).sort((a, b) => a - b);
    const p95 = sorted[Math.floor((sorted.length - 1) * 0.95)];
    const threshold = Math.min(-35, Math.max(-55, p95 - 25));

    let voicedCount = 0;
    for (const v of db) if (v >= threshold) voicedCount++;
    if (voicedCount / db.length < MIN_VOICED_RATIO) {
      return { cuts: [], reason: "too-quiet" }; // 幾乎整段無聲,不敢亂剪,整支保留
    }

    // 找出手動剪輯範圍內、長度達 minSilence 的無聲連續段
    const rawCuts = [];
    let runStart = null;
    for (let w = 0; w <= db.length; w++) {
      const silent = w < db.length && db[w] < threshold;
      const t = w * hop;
      if (silent && runStart === null) runStart = t;
      if (!silent && runStart !== null) {
        const s = Math.max(runStart, item.start);
        const e = Math.min(t, item.end);
        if (e - s >= minSilence) {
          // 前後各留緩衝,避免切到說話的開頭結尾
          const cs = s + CUT_PAD;
          const ce = e - CUT_PAD;
          if (ce - cs >= MIN_CUT_LEN) rawCuts.push([cs, ce]);
        }
        runStart = null;
      }
    }

    // 兩段剪除間夾著極短的保留(通常是雜音)時,併成一段
    const cuts = [];
    for (const c of rawCuts) {
      const last = cuts[cuts.length - 1];
      if (last && c[0] - last[1] < MIN_KEEP_GAP) last[1] = c[1];
      else cuts.push(c);
    }
    return { cuts };
  }

  function currentSensitivity() {
    const el = document.querySelector('input[name="sensitivity"]:checked');
    return SENSITIVITY[el ? el.value : "standard"];
  }

  // 分析所有影片 → pendingCuts / pendingNotes
  async function analyzeAll() {
    const minSilence = currentSensitivity();
    const cuts = [];
    const notes = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      setProgress((i + 0.5) / items.length, `分析音軌中…(${i + 1}/${items.length})${item.file.name}`);
      // 讓進度條有機會重繪
      await new Promise((r) => setTimeout(r, 0));
      if (cancelled) return null;
      try {
        await getEnvelope(item);
      } catch (_) {
        notes.push(`🔇 第 ${i + 1} 支「${item.file.name}」偵測不到音軌(或無法解析音訊),已略過自動剪輯,整支保留。`);
        continue;
      }
      const res = detectCuts(item, minSilence);
      if (res.reason === "too-quiet") {
        notes.push(`🤫 第 ${i + 1} 支「${item.file.name}」幾乎整段都是無聲,為避免剪錯已整支保留;若確定要剪請手動剪輯。`);
        continue;
      }
      for (const [s, e] of res.cuts) {
        cuts.push({ itemId: item.id, start: s, end: e, keep: false });
      }
    }
    return { cuts, notes };
  }

  // ==========================================================
  // 自動剪輯:預覽與確認
  // ==========================================================

  autocutToggle.addEventListener("change", () => {
    autocutSettings.hidden = !autocutToggle.checked;
    mergeBtn.textContent = autocutToggle.checked ? "🔍 分析無聲片段" : "🚀 合併輸出 MP4";
    invalidatePreview();
  });

  document.querySelectorAll('input[name="sensitivity"]').forEach((el) =>
    el.addEventListener("change", () => {
      // 包絡已快取,重跑偵測很快;預覽開著就直接更新
      if (!previewCard.hidden && !busy) runAnalysis();
    })
  );

  function invalidatePreview() {
    pendingCuts = null;
    pendingNotes = [];
    previewCard.hidden = true;
  }

  async function runAnalysis() {
    busy = true;
    cancelled = false;
    mergeBtn.disabled = true;
    hideError(mergeError);
    resetResult();
    previewCard.hidden = true;
    progressArea.hidden = false;
    setProgress(0, "準備分析…");
    try {
      const res = await analyzeAll();
      if (cancelled || !res) return;
      pendingCuts = res.cuts;
      pendingNotes = res.notes;
      renderPreview();
    } catch (err) {
      console.error(err);
      showError(mergeError, "分析失敗:" + (err && err.message ? err.message : err));
    } finally {
      busy = false;
      mergeBtn.disabled = false;
      progressArea.hidden = true;
    }
  }

  // 依項目把「剪除區間」反轉成「保留區間」
  function keepIntervalsFor(item) {
    const active = (pendingCuts || [])
      .filter((c) => c.itemId === item.id && !c.keep)
      .sort((a, b) => a.start - b.start);
    const keeps = [];
    let cur = item.start;
    for (const c of active) {
      if (c.start > cur + MIN_CUT_LEN) keeps.push([cur, c.start]);
      cur = Math.max(cur, c.end);
    }
    if (item.end > cur + MIN_CUT_LEN) keeps.push([cur, item.end]);
    return keeps;
  }

  function renderPreview() {
    // 剪除清單
    cutList.textContent = "";
    const itemIndex = new Map(items.map((it, i) => [it.id, i]));
    pendingCuts.forEach((cut) => {
      const li = document.createElement("li");
      li.className = "cut-item";

      const label = document.createElement("label");
      label.className = "cut-check";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = cut.keep;
      cb.addEventListener("change", () => {
        cut.keep = cb.checked;
        li.classList.toggle("kept", cut.keep);
        renderPreviewStats();
      });
      const cbText = document.createElement("span");
      cbText.textContent = "保留";
      label.append(cb, cbText);

      const desc = document.createElement("span");
      desc.className = "cut-desc";
      const i = itemIndex.get(cut.itemId);
      const name = items[i] ? items[i].file.name : "?";
      desc.textContent =
        `第 ${i + 1} 支「${name}」 ${formatTime(cut.start)} – ${formatTime(cut.end)}` +
        `(${(cut.end - cut.start).toFixed(1)} 秒)`;

      li.append(desc, label);
      li.classList.toggle("kept", cut.keep);
      cutList.appendChild(li);
    });

    // 提示(無音軌等)
    analysisNotes.textContent = "";
    for (const n of pendingNotes) {
      const li = document.createElement("li");
      li.textContent = n;
      analysisNotes.appendChild(li);
    }
    analysisNotes.hidden = pendingNotes.length === 0;
    noCutsMsg.hidden = pendingCuts.length > 0;

    renderPreviewStats();
    previewCard.hidden = false;
    previewCard.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function renderPreviewStats() {
    const before = items.reduce((s, it) => s + (it.end - it.start), 0);
    const cutTotal = pendingCuts.reduce((s, c) => s + (c.keep ? 0 : c.end - c.start), 0);
    const after = Math.max(0, before - cutTotal);
    statBefore.textContent = formatDuration(before);
    statAfter.textContent = formatDuration(after);
    statSaved.textContent = formatDuration(cutTotal);

    // 有影片會被整支剪光時提醒(合併時會跳過)
    const emptied = items.filter((it) => keepIntervalsFor(it).length === 0);
    if (emptied.length) {
      emptyWarning.textContent =
        "⚠️ " + emptied.map((it) => `「${it.file.name}」`).join("、") +
        "剪完後沒有剩餘內容,合併時會整支跳過;若要保留請勾選該影片的片段。";
      emptyWarning.hidden = false;
    } else {
      emptyWarning.hidden = true;
    }
  }

  previewCancelBtn.addEventListener("click", () => {
    previewCard.hidden = true;
    mergeCard.scrollIntoView({ behavior: "smooth", block: "start" });
  });

  confirmMergeBtn.addEventListener("click", () => {
    if (busy) return;
    const jobs = buildJobs(true);
    if (jobs.length === 0) {
      showError(mergeError, "剪完後沒有任何內容可以合併,請取消勾選一些剪除片段。");
      previewCard.hidden = true;
      return;
    }
    previewCard.hidden = true;
    runMerge(jobs);
  });

  // ==========================================================
  // 合併
  // ==========================================================

  function setProgress(ratio, text) {
    progressBar.style.width = `${Math.round(Math.min(1, Math.max(0, ratio)) * 100)}%`;
    if (text) progressText.textContent = text;
  }

  // 輸出解析度:取面積最大的一支為基準,寬度上限 MAX_OUT_WIDTH,取偶數
  function targetSize() {
    let w = 0, h = 0, area = 0;
    for (const it of items) {
      if (it.width * it.height > area) {
        area = it.width * it.height;
        w = it.width;
        h = it.height;
      }
    }
    if (w > MAX_OUT_WIDTH) {
      h = Math.round((h * MAX_OUT_WIDTH) / w);
      w = MAX_OUT_WIDTH;
    }
    w -= w % 2;
    h -= h % 2;
    return { w: Math.max(2, w), h: Math.max(2, h) };
  }

  // 產生指定秒數的靜音 WAV(給沒有聲音的影片墊音軌,避免合併後聲音錯位)
  function makeSilenceWav(seconds) {
    const sr = 44100, ch = 2, bps = 2;
    const dataLen = Math.max(1, Math.round(seconds * sr)) * ch * bps;
    const buf = new ArrayBuffer(44 + dataLen);
    const v = new DataView(buf);
    const ws = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    ws(0, "RIFF"); v.setUint32(4, 36 + dataLen, true); ws(8, "WAVE");
    ws(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true);
    v.setUint32(24, sr, true); v.setUint32(28, sr * ch * bps, true);
    v.setUint16(32, ch * bps, true); v.setUint16(34, 16, true);
    ws(36, "data"); v.setUint32(40, dataLen, true);
    return new Uint8Array(buf);
  }

  // 用 `-i` 的訊息輸出判斷有沒有音軌(wasm 內沒有 ffprobe)
  async function probeHasAudio(ff, name) {
    let logs = "";
    const onLog = ({ message }) => { logs += message + "\n"; };
    ff.on("log", onLog);
    try {
      await ff.exec(["-hide_banner", "-i", name]); // 沒有輸出檔,必定非 0,只取 log
    } catch (_) { /* 忽略 */ }
    ff.off("log", onLog);
    return /Stream #0:\d+.*Audio/.test(logs);
  }

  // 把清單(含自動剪輯結果)展開成逐段工作。
  // 一支影片可能有多個保留區間,每個區間各產生一個正規化片段,
  // 仍然是「每一格輸出畫面只編碼一次」,不會重複編碼。
  function buildJobs(useAutoCut) {
    const jobs = [];
    for (const item of items) {
      const keeps = useAutoCut && pendingCuts
        ? keepIntervalsFor(item)
        : [[item.start, item.end]];
      for (const [s, e] of keeps) {
        if (e - s >= MIN_CUT_LEN) {
          jobs.push({ file: item.file, name: item.file.name, start: s, dur: e - s });
        }
      }
    }
    return jobs;
  }

  mergeBtn.addEventListener("click", () => {
    if (busy || items.length === 0) return;
    if (autocutToggle.checked) {
      runAnalysis();
    } else {
      runMerge(buildJobs(false));
    }
  });

  async function runMerge(jobs) {
    if (busy || jobs.length === 0) return;
    busy = true;
    cancelled = false;
    mergeBtn.disabled = true;
    hideError(mergeError);
    resetResult();
    closeEditor();
    progressArea.hidden = false;
    setProgress(0, "準備中…");

    const totalDur = jobs.reduce((s, j) => s + j.dur, 0);
    const { w, h } = targetSize();
    const segNames = [];

    try {
      const ff = await getFFmpeg((msg) => setProgress(0, msg));
      if (cancelled) return;
      const { fetchFile } = window.FFmpegUtil;

      // 逐段處理:剪輯 + 正規化成相同規格的 mp4 片段。
      // 同一支影片的多個片段共用一次輸入檔寫入與音軌偵測。
      let doneDur = 0;
      let loadedFile = null;
      let loadedName = null;
      let loadedHasAudio = false;
      for (let i = 0; i < jobs.length; i++) {
        const job = jobs[i];
        const ext = (job.name.match(ACCEPT_RE) || [".mp4"])[0].toLowerCase();
        const inName = `input${ext}`;
        const segName = `seg_${i}.mp4`;
        const label = `(${i + 1}/${jobs.length})${job.name}`;

        if (loadedFile !== job.file) {
          if (loadedFile) await ff.deleteFile(loadedName).catch(() => {});
          setProgress((doneDur / totalDur) * 0.9, `讀取中… ${label}`);
          await ff.writeFile(inName, await fetchFile(job.file));
          if (cancelled) return;
          loadedFile = job.file;
          loadedName = inName;
          loadedHasAudio = await probeHasAudio(ff, inName);
          if (cancelled) return;
        }

        const inputs = ["-ss", job.start.toFixed(2), "-t", job.dur.toFixed(2), "-i", loadedName];
        let mapArgs;
        if (loadedHasAudio) {
          mapArgs = ["-map", "0:v:0", "-map", "0:a:0"];
        } else {
          await ff.writeFile("silence.wav", makeSilenceWav(job.dur));
          inputs.push("-i", "silence.wav");
          mapArgs = ["-map", "0:v:0", "-map", "1:a:0", "-shortest"];
        }
        const vf =
          `fps=${OUT_FPS},scale=${w}:${h}:force_original_aspect_ratio=decrease,` +
          `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1`;

        const base = doneDur / totalDur;
        const span = job.dur / totalDur;
        const onProgress = ({ time }) => {
          const r = Math.min(1, time / 1e6 / job.dur);
          setProgress((base + span * r) * 0.9, `轉檔中… ${label} ${Math.round(r * 100)}%`);
        };
        ff.on("progress", onProgress);
        let ret;
        try {
          ret = await ff.exec([
            ...inputs,
            "-vf", vf,
            ...mapArgs,
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2",
            segName,
          ]);
        } finally {
          ff.off("progress", onProgress);
        }
        if (cancelled) return;
        if (ret !== 0) throw new Error(`「${job.name}」轉檔失敗(exit code ${ret})`);

        if (!loadedHasAudio) await ff.deleteFile("silence.wav").catch(() => {});
        segNames.push(segName);
        doneDur += job.dur;
      }
      // 最後一支輸入檔也清掉,控制記憶體
      if (loadedName) await ff.deleteFile(loadedName).catch(() => {});

      // 片段規格一致,concat 直接串流複製,不再重新編碼
      setProgress(0.92, "正在合併片段…");
      const listTxt = segNames.map((n) => `file '${n}'`).join("\n");
      await ff.writeFile("list.txt", listTxt);
      const ret = await ff.exec([
        "-f", "concat", "-safe", "0", "-i", "list.txt",
        "-c", "copy", "-movflags", "+faststart",
        "merged.mp4",
      ]);
      if (cancelled) return;
      if (ret !== 0) throw new Error(`合併失敗(exit code ${ret})`);

      setProgress(0.97, "正在產生檔案…");
      const data = await ff.readFile("merged.mp4");
      const blob = new Blob([data.buffer], { type: "video/mp4" });

      await ff.deleteFile("list.txt").catch(() => {});
      await ff.deleteFile("merged.mp4").catch(() => {});
      for (const n of segNames) await ff.deleteFile(n).catch(() => {});

      showResult(blob);
    } catch (err) {
      if (!cancelled) {
        console.error(err);
        showError(mergeError,
          "合併失敗:" + (err && err.message ? err.message : err) +
          "\n可能原因:網路無法連到 CDN、影片編碼不支援(如 HEVC/H.265),或影片太大導致記憶體不足。" +
          "可以試試剪短片段、減少影片數量或分批合併。");
        // 執行失敗後 wasm 狀態可能已損壞,重建實例
        try { ffmpeg && ffmpeg.terminate(); } catch (_) {}
        ffmpeg = null;
      }
    } finally {
      busy = false;
      mergeBtn.disabled = false;
      progressArea.hidden = true;
    }
  }

  cancelBtn.addEventListener("click", () => {
    if (!busy) return;
    cancelled = true;
    try { ffmpeg && ffmpeg.terminate(); } catch (_) {}
    ffmpeg = null; // terminate 後需要重新載入
    busy = false;
    mergeBtn.disabled = false;
    progressArea.hidden = true;
    showError(mergeError, "已取消。");
  });

  // ==========================================================
  // 結果
  // ==========================================================

  function showResult(blob) {
    if (resultURL) URL.revokeObjectURL(resultURL);
    resultURL = URL.createObjectURL(blob);
    resultBlob = blob;
    resultVideo.src = resultURL;
    downloadBtn.href = resultURL;
    resultSize.textContent = formatSize(blob.size);
    resultCard.hidden = false;
    resultCard.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // 把合併結果交接給其他工具(IndexedDB 傳遞 blob)
  async function handoff(key, record, targetURL) {
    if (!resultBlob) return;
    try {
      const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open("video-tools", 1);
        req.onupgradeneeded = () => req.result.createObjectStore("handoff");
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      await new Promise((resolve, reject) => {
        const tx = db.transaction("handoff", "readwrite");
        tx.objectStore("handoff").put({ ...record, savedAt: Date.now() }, key);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      location.href = targetURL;
    } catch (err) {
      console.error(err);
      showError(mergeError, "無法傳遞影片,請先下載 MP4 再到目標頁面選擇該檔案。");
    }
  }

  subtitleBtn.addEventListener("click", () =>
    handoff("merged", { blob: resultBlob, name: "merged.mp4" }, "subtitle.html?from=merge"));
  publishBtn.addEventListener("click", () =>
    handoff("publish", { blob: resultBlob, name: "merged.mp4" }, "publish.html?from=tool"));

  function resetResult() {
    resultCard.hidden = true;
    resultBlob = null;
    if (resultURL) {
      URL.revokeObjectURL(resultURL);
      resultURL = null;
    }
    resultVideo.removeAttribute("src");
  }

  // ==========================================================
  // 小工具
  // ==========================================================

  function formatTime(t) {
    const m = Math.floor(t / 60);
    const s = t - m * 60;
    return `${m}:${s.toFixed(1).padStart(4, "0")}`;
  }

  function formatDuration(t) {
    const m = Math.floor(t / 60);
    const s = t - m * 60;
    return m > 0 ? `${m} 分 ${s.toFixed(1)} 秒` : `${s.toFixed(1)} 秒`;
  }

  function showError(el, msg) {
    el.textContent = msg;
    el.hidden = false;
  }

  function hideError(el) {
    el.hidden = true;
  }
})();
