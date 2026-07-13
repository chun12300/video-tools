/* ===== 影片合併剪輯 =====
 * 多支影片各剪一段,逐支正規化(統一解析度/幀率/編碼)後以 concat 合併。
 * 逐支處理是刻意設計:同時只有一支影片留在 wasm 檔案系統,控制記憶體用量。
 */
(() => {
  "use strict";

  const MAX_INPUT_MB = 500;        // 單支影片上限
  const SUGGESTED_TOTAL_MB = 500;  // 總量建議上限,超過即警告
  const OUT_FPS = 30;              // 合併輸出幀率
  const MAX_OUT_WIDTH = 1280;      // 合併輸出寬度上限(記憶體/速度考量)

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
  const progressArea = $("progress-area");
  const progressText = $("progress-text");
  const progressBar = $("progress-bar");
  const cancelBtn = $("cancel-btn");
  const mergeError = $("merge-error");
  const resultCard = $("result-card");
  const resultVideo = $("result-video");
  const resultSize = $("result-size");
  const downloadBtn = $("download-btn");

  // ---- 狀態 ----
  let items = [];        // {id, file, url, duration, width, height, start, end}
  let nextId = 1;
  let selectedId = null; // 正在剪輯的項目
  let dragId = null;     // 正在拖曳的項目
  let merging = false;
  let cancelled = false;
  let clipStopTimer = null;
  let resultURL = null;
  let ffmpeg = null;

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
        });
      } catch (_) {
        errors.push(`「${file.name}」無法讀取,可能已損壞或編碼不支援。`);
      }
    }

    if (errors.length) showError(fileError, errors.join("\n"));
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
    render();
  }

  function removeItem(id) {
    const i = items.findIndex((it) => it.id === id);
    if (i === -1) return;
    URL.revokeObjectURL(items[i].url);
    items.splice(i, 1);
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

  mergeBtn.addEventListener("click", async () => {
    if (merging || items.length === 0) return;
    merging = true;
    cancelled = false;
    mergeBtn.disabled = true;
    hideError(mergeError);
    resetResult();
    closeEditor();
    progressArea.hidden = false;
    setProgress(0, "準備中…");

    // 先固定這次要處理的清單快照,避免轉檔中清單被改動
    const jobs = items.map((it) => ({
      file: it.file,
      start: it.start,
      dur: Math.max(0.1, it.end - it.start),
    }));
    const totalDur = jobs.reduce((s, j) => s + j.dur, 0);
    const { w, h } = targetSize();
    const segNames = [];

    try {
      const ff = await getFFmpeg((msg) => setProgress(0, msg));
      if (cancelled) return;
      const { fetchFile } = window.FFmpegUtil;

      // 逐支處理:剪輯 + 正規化成相同規格的 mp4 片段
      let doneDur = 0;
      for (let i = 0; i < jobs.length; i++) {
        const job = jobs[i];
        const ext = (job.file.name.match(ACCEPT_RE) || [".mp4"])[0].toLowerCase();
        const inName = `in_${i}${ext}`;
        const segName = `seg_${i}.mp4`;
        const label = `(${i + 1}/${jobs.length})${job.file.name}`;

        setProgress(doneDur / totalDur * 0.9, `讀取中… ${label}`);
        await ff.writeFile(inName, await fetchFile(job.file));
        if (cancelled) return;

        const hasAudio = await probeHasAudio(ff, inName);
        if (cancelled) return;

        const inputs = ["-ss", job.start.toFixed(2), "-t", job.dur.toFixed(2), "-i", inName];
        let mapArgs;
        if (hasAudio) {
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
        if (ret !== 0) throw new Error(`「${job.file.name}」轉檔失敗(exit code ${ret})`);

        // 立刻清掉輸入檔,控制記憶體
        await ff.deleteFile(inName).catch(() => {});
        if (!hasAudio) await ff.deleteFile("silence.wav").catch(() => {});
        segNames.push(segName);
        doneDur += job.dur;
      }

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
      merging = false;
      mergeBtn.disabled = false;
      progressArea.hidden = true;
    }
  });

  cancelBtn.addEventListener("click", () => {
    if (!merging) return;
    cancelled = true;
    try { ffmpeg && ffmpeg.terminate(); } catch (_) {}
    ffmpeg = null; // terminate 後需要重新載入
    merging = false;
    mergeBtn.disabled = false;
    progressArea.hidden = true;
    showError(mergeError, "已取消合併。");
  });

  // ==========================================================
  // 結果
  // ==========================================================

  function showResult(blob) {
    if (resultURL) URL.revokeObjectURL(resultURL);
    resultURL = URL.createObjectURL(blob);
    resultVideo.src = resultURL;
    downloadBtn.href = resultURL;
    resultSize.textContent = formatSize(blob.size);
    resultCard.hidden = false;
    resultCard.scrollIntoView({ behavior: "smooth", block: "start" });
  }

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

  function showError(el, msg) {
    el.textContent = msg;
    el.hidden = false;
  }

  function hideError(el) {
    el.hidden = true;
  }
})();
