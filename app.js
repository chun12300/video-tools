/* ===== 影片轉 GIF 小工具 =====
 * 所有轉換皆透過 ffmpeg.wasm 在瀏覽器內完成,檔案不會上傳到任何伺服器。
 * 採用單執行緒版 @ffmpeg/core:GitHub Pages 無法設定 COOP/COEP 標頭,
 * 因此不能使用需要 SharedArrayBuffer 的多執行緒版本。
 */
(() => {
  "use strict";

  // ---- CDN 設定(jsdelivr 為主,unpkg 備援) ----
  const FFMPEG_VER = "0.12.10";
  const UTIL_VER = "0.12.1";
  const CORE_VER = "0.12.6";
  const CDN_BASES = [
    "https://cdn.jsdelivr.net/npm",
    "https://unpkg.com",
  ];

  const MAX_INPUT_MB = 500;      // 輸入檔案大小上限(wasm 記憶體限制)
  const LONG_CLIP_SEC = 15;      // 超過此長度提醒使用者剪短
  const BIG_GIF_MB = 10;         // 產出超過此大小給予提示

  // ---- DOM ----
  const $ = (id) => document.getElementById(id);
  const dropZone = $("drop-zone");
  const fileInput = $("file-input");
  const fileError = $("file-error");
  const workspace = $("workspace");
  const fileNameEl = $("file-name");
  const changeFileBtn = $("change-file-btn");
  const video = $("video-preview");
  const startRange = $("start-range");
  const endRange = $("end-range");
  const startInput = $("start-input");
  const endInput = $("end-input");
  const startNowBtn = $("start-now-btn");
  const endNowBtn = $("end-now-btn");
  const playClipBtn = $("play-clip-btn");
  const clipLengthEl = $("clip-length");
  const lengthWarning = $("length-warning");
  const convertBtn = $("convert-btn");
  const progressArea = $("progress-area");
  const progressText = $("progress-text");
  const progressBar = $("progress-bar");
  const cancelBtn = $("cancel-btn");
  const convertError = $("convert-error");
  const resultCard = $("result-card");
  const gifPreview = $("gif-preview");
  const gifSizeEl = $("gif-size");
  const sizeWarning = $("size-warning");
  const downloadBtn = $("download-btn");
  const againBtn = $("again-btn");

  // ---- 狀態 ----
  let currentFile = null;
  let videoURL = null;
  let gifURL = null;
  let duration = 0;
  let converting = false;
  let cancelled = false;
  let clipStopTimer = null;
  let ffmpeg = null;          // FFmpeg 實例(lazy 載入,可重複使用)
  let ffmpegLibsPromise = null;

  // ==========================================================
  // ffmpeg.wasm 載入
  // ==========================================================

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("無法載入 " + src));
      document.head.appendChild(s);
    });
  }

  // 依序嘗試各 CDN,直到成功為止
  async function tryCDNs(fn) {
    let lastErr = null;
    for (const base of CDN_BASES) {
      try {
        return await fn(base);
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error("所有 CDN 均無法連線");
  }

  // 載入 @ffmpeg/ffmpeg 與 @ffmpeg/util 的 UMD script
  function loadFFmpegLibs() {
    if (!ffmpegLibsPromise) {
      ffmpegLibsPromise = tryCDNs(async (base) => {
        await loadScript(`${base}/@ffmpeg/ffmpeg@${FFMPEG_VER}/dist/umd/ffmpeg.js`);
        await loadScript(`${base}/@ffmpeg/util@${UTIL_VER}/dist/umd/index.js`);
        if (!window.FFmpegWASM || !window.FFmpegUtil) {
          throw new Error("ffmpeg.wasm 程式庫載入不完整");
        }
      }).catch((err) => {
        ffmpegLibsPromise = null; // 失敗後允許重試
        throw err;
      });
    }
    return ffmpegLibsPromise;
  }

  // 建立並載入 FFmpeg 實例。
  // GitHub Pages 與 CDN 不同源,Worker 無法直接用跨網域 URL 建立,
  // 因此 worker / core / wasm 都先以 toBlobURL 轉成同源 blob URL。
  async function getFFmpeg(onStatus) {
    if (ffmpeg && ffmpeg.loaded) return ffmpeg;

    onStatus("正在載入轉換引擎(首次使用約需下載 25 MB)…");
    await loadFFmpegLibs();
    const { FFmpeg } = window.FFmpegWASM;
    const { toBlobURL } = window.FFmpegUtil;

    ffmpeg = new FFmpeg();
    await tryCDNs(async (base) => {
      const ffmpegBase = `${base}/@ffmpeg/ffmpeg@${FFMPEG_VER}/dist/umd`;
      // worker 以 module 模式載入 core,需用有 default export 的 ESM 版
      const coreBase = `${base}/@ffmpeg/core@${CORE_VER}/dist/esm`;
      await ffmpeg.load({
        classWorkerURL: await toBlobURL(`${ffmpegBase}/814.ffmpeg.js`, "text/javascript"),
        coreURL: await toBlobURL(`${coreBase}/ffmpeg-core.js`, "text/javascript"),
        wasmURL: await toBlobURL(`${coreBase}/ffmpeg-core.wasm`, "application/wasm"),
      });
    });
    return ffmpeg;
  }

  // ==========================================================
  // 檔案選擇
  // ==========================================================

  const ACCEPT_RE = /\.(mp4|mov|webm)$/i;
  const ACCEPT_MIME = ["video/mp4", "video/quicktime", "video/webm"];

  function pickFile(file) {
    fileError.hidden = true;
    if (!file) return;

    const okType = ACCEPT_MIME.includes(file.type) || ACCEPT_RE.test(file.name);
    if (!okType) {
      showError(fileError, "這個檔案格式不支援,請選擇 MP4、MOV 或 WebM 影片。");
      return;
    }
    if (file.size > MAX_INPUT_MB * 1024 * 1024) {
      showError(fileError,
        `檔案太大了(${formatSize(file.size)})。瀏覽器內轉換的上限約 ${MAX_INPUT_MB} MB,` +
        "建議先用其他工具把影片剪短或壓縮後再試。");
      return;
    }

    currentFile = file;
    resetResult();
    hideError(convertError);

    if (videoURL) URL.revokeObjectURL(videoURL);
    videoURL = URL.createObjectURL(file);
    video.src = videoURL;
    fileNameEl.textContent = `${file.name}(${formatSize(file.size)})`;
    workspace.hidden = false;
    workspace.scrollIntoView({ behavior: "smooth", block: "start" });
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
  dropZone.addEventListener("drop", (e) => pickFile(e.dataTransfer.files[0]));

  // ==========================================================
  // 剪輯區間
  // ==========================================================

  video.addEventListener("loadedmetadata", () => {
    duration = Math.round(video.duration * 10) / 10;
    for (const el of [startRange, endRange, startInput, endInput]) {
      el.max = duration;
    }
    setTrim(0, Math.min(duration, 5)); // 預設剪前 5 秒,避免整支影片直接轉
  });

  function getTrim() {
    return {
      start: parseFloat(startRange.value) || 0,
      end: parseFloat(endRange.value) || 0,
    };
  }

  function setTrim(start, end) {
    start = Math.min(Math.max(0, start), duration);
    end = Math.min(Math.max(0, end), duration);
    if (end - start < 0.1) {
      // 保持至少 0.1 秒的區間
      if (start > duration - 0.1) start = Math.max(0, duration - 0.1);
      end = Math.min(duration, start + 0.1);
    }
    startRange.value = startInput.value = start.toFixed(1);
    endRange.value = endInput.value = end.toFixed(1);
    updateClipInfo();
  }

  function updateClipInfo() {
    const { start, end } = getTrim();
    const len = Math.max(0, end - start);
    clipLengthEl.textContent = len.toFixed(1);
    if (len > LONG_CLIP_SEC) {
      lengthWarning.textContent =
        `💡 片段長達 ${len.toFixed(1)} 秒,GIF 檔案可能會很大、轉換也比較久。` +
        "建議剪短到 15 秒以內,或選用較小的尺寸與幀率。";
      lengthWarning.hidden = false;
    } else {
      lengthWarning.hidden = true;
    }
  }

  startRange.addEventListener("input", () => {
    const { end } = getTrim();
    setTrim(parseFloat(startRange.value), Math.max(end, parseFloat(startRange.value) + 0.1));
    video.currentTime = getTrim().start;
  });
  endRange.addEventListener("input", () => {
    const { start } = getTrim();
    setTrim(Math.min(start, parseFloat(endRange.value) - 0.1), parseFloat(endRange.value));
    video.currentTime = getTrim().end;
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
    setTrim(video.currentTime, Math.max(getTrim().end, video.currentTime + 0.1));
  });
  endNowBtn.addEventListener("click", () => {
    setTrim(Math.min(getTrim().start, video.currentTime - 0.1), video.currentTime);
  });

  playClipBtn.addEventListener("click", () => {
    const { start, end } = getTrim();
    clearTimeout(clipStopTimer);
    video.currentTime = start;
    video.play();
    clipStopTimer = setTimeout(() => video.pause(), (end - start) * 1000);
  });

  // ==========================================================
  // 轉換
  // ==========================================================

  function getOptions() {
    const width = parseInt(document.querySelector('input[name="size"]:checked').value, 10);
    const fps = parseInt(document.querySelector('input[name="fps"]:checked').value, 10);
    return { width, fps };
  }

  function setProgress(ratio, text) {
    progressBar.style.width = `${Math.round(Math.min(1, Math.max(0, ratio)) * 100)}%`;
    if (text) progressText.textContent = text;
  }

  convertBtn.addEventListener("click", async () => {
    if (converting || !currentFile) return;
    converting = true;
    cancelled = false;
    convertBtn.disabled = true;
    hideError(convertError);
    resetResult();
    progressArea.hidden = false;
    setProgress(0, "準備中…");

    const { start, end } = getTrim();
    const clipLen = end - start;
    const { width, fps } = getOptions();
    const ext = (currentFile.name.match(ACCEPT_RE) || [".mp4"])[0].toLowerCase();
    const inputName = "input" + ext;
    const outputName = "output.gif";

    try {
      const ff = await getFFmpeg((msg) => setProgress(0, msg));
      if (cancelled) return;

      const { fetchFile } = window.FFmpegUtil;
      setProgress(0.02, "正在讀取影片…");
      await ff.writeFile(inputName, await fetchFile(currentFile));
      if (cancelled) return;

      const onProgress = ({ time }) => {
        // time 為已處理的輸出時間(微秒),以片段長度換算百分比
        const ratio = time / 1e6 / clipLen;
        setProgress(0.05 + ratio * 0.9, `轉換中… ${Math.round(Math.min(1, ratio) * 100)}%`);
      };
      ff.on("progress", onProgress);

      try {
        // 以調色盤兩階段濾鏡產生高品質 GIF
        const vf =
          `fps=${fps},scale=${width}:-1:flags=lanczos,` +
          "split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle";
        const ret = await ff.exec([
          "-ss", start.toFixed(2),
          "-t", clipLen.toFixed(2),
          "-i", inputName,
          "-vf", vf,
          "-loop", "0",
          "-f", "gif",
          outputName,
        ]);
        if (ret !== 0) throw new Error("ffmpeg 轉換失敗(exit code " + ret + ")");
      } finally {
        ff.off("progress", onProgress);
      }
      if (cancelled) return;

      setProgress(0.97, "正在產生 GIF…");
      const data = await ff.readFile(outputName);
      const blob = new Blob([data.buffer], { type: "image/gif" });

      // 清掉虛擬檔案系統中的暫存,釋放記憶體
      await ff.deleteFile(inputName).catch(() => {});
      await ff.deleteFile(outputName).catch(() => {});

      showResult(blob);
    } catch (err) {
      if (!cancelled) {
        console.error(err);
        showError(convertError,
          "轉換失敗:" + (err && err.message ? err.message : err) +
          "\n可能原因:網路無法連到 CDN、影片編碼不支援(如 HEVC/H.265),或影片太大導致記憶體不足。" +
          "可以試試較短的片段或較小的尺寸。");
        // 執行失敗後 wasm 狀態可能已損壞,重建實例
        try { ffmpeg && ffmpeg.terminate(); } catch (_) {}
        ffmpeg = null;
      }
    } finally {
      converting = false;
      convertBtn.disabled = false;
      progressArea.hidden = true;
    }
  });

  cancelBtn.addEventListener("click", () => {
    if (!converting) return;
    cancelled = true;
    try { ffmpeg && ffmpeg.terminate(); } catch (_) {}
    ffmpeg = null; // terminate 後需要重新載入
    converting = false;
    convertBtn.disabled = false;
    progressArea.hidden = true;
    showError(convertError, "已取消轉換。");
  });

  // ==========================================================
  // 結果
  // ==========================================================

  function showResult(blob) {
    if (gifURL) URL.revokeObjectURL(gifURL);
    gifURL = URL.createObjectURL(blob);
    gifPreview.src = gifURL;
    downloadBtn.href = gifURL;
    const base = (currentFile.name.replace(/\.[^.]+$/, "") || "output");
    downloadBtn.download = base + ".gif";
    gifSizeEl.textContent = formatSize(blob.size);

    if (blob.size > BIG_GIF_MB * 1024 * 1024) {
      sizeWarning.textContent =
        `⚠️ 這個 GIF 有 ${formatSize(blob.size)},在很多平台上可能太大而無法上傳。` +
        "建議把片段剪短一點,或改用較小的尺寸、較低的幀率再轉一次。";
      sizeWarning.hidden = false;
    } else {
      sizeWarning.hidden = true;
    }

    resultCard.hidden = false;
    resultCard.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function resetResult() {
    resultCard.hidden = true;
    sizeWarning.hidden = true;
    if (gifURL) {
      URL.revokeObjectURL(gifURL);
      gifURL = null;
    }
    gifPreview.removeAttribute("src");
  }

  againBtn.addEventListener("click", () => {
    workspace.scrollIntoView({ behavior: "smooth", block: "start" });
  });

  // ==========================================================
  // 小工具
  // ==========================================================

  function formatSize(bytes) {
    if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + " MB";
    if (bytes >= 1024) return (bytes / 1024).toFixed(0) + " KB";
    return bytes + " B";
  }

  function showError(el, msg) {
    el.textContent = msg;
    el.hidden = false;
  }

  function hideError(el) {
    el.hidden = true;
  }
})();
