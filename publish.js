/* ===== 發佈準備包 =====
 * 影片完成後一鍵產出發佈素材:直式版本(ffmpeg.wasm 重新編碼)、
 * 封面截圖(canvas)、SRT 字幕、文案提示詞。全程純前端。
 */
(() => {
  "use strict";

  const MAX_INPUT_MB = 500;
  const PORTRAIT_W = 1080;   // 直式目標寬(來源不足時等比例縮小)
  const THUMB_COUNT = 6;
  const JPG_QUALITY = 0.92;

  const { createLoadedFFmpeg, formatSize } = window.FFmpegLoader;

  // ---- DOM ----
  const $ = (id) => document.getElementById(id);
  const dropZone = $("drop-zone");
  const fileInput = $("file-input");
  const fileError = $("file-error");
  const workspace = $("workspace");
  const fileNameEl = $("file-name");
  const changeFileBtn = $("change-file-btn");
  const video = $("video-preview");
  const landscapeBtn = $("landscape-btn");
  const portraitBtn = $("portrait-btn");
  const portraitProgress = $("portrait-progress");
  const portraitProgressText = $("portrait-progress-text");
  const portraitProgressBar = $("portrait-progress-bar");
  const portraitCancelBtn = $("portrait-cancel-btn");
  const portraitError = $("portrait-error");
  const portraitResult = $("portrait-result");
  const portraitVideo = $("portrait-video");
  const portraitDownloadBtn = $("portrait-download-btn");
  const thumbGrid = $("thumb-grid");
  const captureBtn = $("capture-btn");
  const coverArea = $("cover-area");
  const coverPreview = $("cover-preview");
  const coverYtBtn = $("cover-yt-btn");
  const coverPortraitBtn = $("cover-portrait-btn");
  const coverError = $("cover-error");
  const srtHint = $("srt-hint");
  const srtBtn = $("srt-btn");
  const copyHint = $("copy-hint");
  const copyPromptBtn = $("copy-prompt-btn");
  const copyDone = $("copy-done");

  // ---- 狀態 ----
  let currentFile = null;
  let videoURL = null;
  let segs = null;          // 來自字幕工具的 [{start,end,text}](原始時間)
  let timeOffset = 0;       // 字幕位移(套用於 SRT 與文案)
  let busy = false;
  let cancelled = false;
  let ffmpeg = null;
  let portraitURL = null;
  let srtURL = null;
  let selectedTime = null;  // 封面時間點
  let captureVideo = null;  // 隱藏的截圖用 video 元素

  const ACCEPT_RE = /\.(mp4|mov|webm)$/i;
  const ACCEPT_MIME = ["video/mp4", "video/quicktime", "video/webm"];

  function baseName() {
    return currentFile ? currentFile.name.replace(/\.[^.]+$/, "") : "video";
  }

  // ==========================================================
  // 載入影片(交接或自選)
  // ==========================================================

  function pickFile(file, handedSegs, handedOffset) {
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
    segs = Array.isArray(handedSegs) && handedSegs.length ? handedSegs : null;
    timeOffset = handedOffset || 0;

    // 沒帶字幕進來時,試著用字幕工具的草稿(同一支影片)補上
    if (!segs) {
      try {
        const draft = JSON.parse(localStorage.getItem("subtitle-draft-v1") || "null");
        if (draft && draft.key === `${file.name}|${file.size}` && draft.segs.length) {
          segs = draft.segs;
          timeOffset = draft.offset || 0;
        }
      } catch (_) { /* 沒有就算了 */ }
    }

    if (videoURL) URL.revokeObjectURL(videoURL);
    videoURL = URL.createObjectURL(file);
    video.src = videoURL;
    fileNameEl.textContent = `${file.name}(${formatSize(file.size)})`;

    // 橫式原片:直接下載來源檔
    const ext = (file.name.match(ACCEPT_RE) || [".mp4"])[0].toLowerCase();
    landscapeBtn.href = videoURL;
    landscapeBtn.download = `${baseName()}-landscape${ext}`;

    resetPortrait();
    resetCover();
    setupSubtitleSections();

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

  // IndexedDB 交接(從合併/字幕工具帶影片與字幕過來)
  function idbOpen() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open("video-tools", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("handoff");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  (async () => {
    if (new URLSearchParams(location.search).get("from") !== "tool") return;
    try {
      const db = await idbOpen();
      const rec = await new Promise((resolve) => {
        const tx = db.transaction("handoff", "readwrite");
        const store = tx.objectStore("handoff");
        const get = store.get("publish");
        get.onsuccess = () => {
          store.delete("publish"); // 讀完即刪
          resolve(get.result || null);
        };
        get.onerror = () => resolve(null);
      });
      if (rec && rec.blob) {
        pickFile(
          new File([rec.blob], rec.name || "video.mp4", { type: rec.blob.type || "video/mp4" }),
          rec.segs, rec.offset);
      } else {
        showError(fileError, "找不到剛完成的影片(可能已被清除),請重新選擇檔案。");
      }
    } catch (_) { /* 讓使用者自己選檔 */ }
  })();

  // ==========================================================
  // 區塊一:直式版本(ffmpeg.wasm)
  // ==========================================================

  async function getFFmpeg(onStatus) {
    if (ffmpeg && ffmpeg.loaded) return ffmpeg;
    ffmpeg = await createLoadedFFmpeg(onStatus);
    return ffmpeg;
  }

  function setProgress(ratio, text) {
    portraitProgressBar.style.width = `${Math.round(Math.min(1, Math.max(0, ratio)) * 100)}%`;
    if (text) portraitProgressText.textContent = text;
  }

  // 直式目標尺寸:1080×1920,來源寬度不足就等比例縮小(維持 9:16、取偶數)
  function portraitTarget() {
    let w = Math.min(PORTRAIT_W, video.videoWidth || PORTRAIT_W);
    w -= w % 2;
    let h = Math.round((w * 16) / 9);
    h -= h % 2;
    return { w: Math.max(2, w), h: Math.max(2, h) };
  }

  function portraitFilter(mode, w, h) {
    if (mode === "black") {
      return `scale=${w}:${h}:force_original_aspect_ratio=decrease,` +
        `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1`;
    }
    if (mode === "crop") {
      return `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1`;
    }
    // blur(預設):背景=原畫面放大裁滿再模糊(wasm core 沒有 gblur,用 boxblur 近似),
    // 前景=原比例縮好置中疊上去
    return (
      `split[bg][fg];` +
      `[bg]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},boxblur=10:2[bgb];` +
      `[fg]scale=${w}:${h}:force_original_aspect_ratio=decrease[fgs];` +
      `[bgb][fgs]overlay=(W-w)/2:(H-h)/2,setsar=1`
    );
  }

  portraitBtn.addEventListener("click", async () => {
    if (busy || !currentFile) return;
    busy = true;
    cancelled = false;
    portraitBtn.disabled = true;
    hideError(portraitError);
    portraitResult.hidden = true;
    portraitProgress.hidden = false;
    setProgress(0, "準備中…");

    const mode = document.querySelector('input[name="portrait-mode"]:checked').value;
    const { w, h } = portraitTarget();
    const ext = (currentFile.name.match(ACCEPT_RE) || [".mp4"])[0].toLowerCase();
    const inName = "input" + ext;
    const duration = video.duration || 1;

    try {
      const ff = await getFFmpeg((msg) => setProgress(0, msg));
      if (cancelled) return;
      const { fetchFile } = window.FFmpegUtil;

      setProgress(0.02, "正在讀取影片…");
      await ff.writeFile(inName, await fetchFile(currentFile));
      if (cancelled) return;

      const onProgress = ({ time }) => {
        const r = Math.min(1, time / 1e6 / duration);
        setProgress(0.05 + r * 0.92, `轉換直式版本中… ${Math.round(r * 100)}%`);
      };
      ff.on("progress", onProgress);
      let ret;
      try {
        ret = await ff.exec([
          "-i", inName,
          "-vf", portraitFilter(mode, w, h),
          "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
          "-c:a", "aac", "-b:a", "128k",
          "portrait.mp4",
        ]);
      } finally {
        ff.off("progress", onProgress);
      }
      if (cancelled) return;
      if (ret !== 0) throw new Error("轉換失敗(exit code " + ret + ")");

      setProgress(0.99, "正在產生檔案…");
      const data = await ff.readFile("portrait.mp4");
      const blob = new Blob([data.buffer], { type: "video/mp4" });
      await ff.deleteFile(inName).catch(() => {});
      await ff.deleteFile("portrait.mp4").catch(() => {});

      if (portraitURL) URL.revokeObjectURL(portraitURL);
      portraitURL = URL.createObjectURL(blob);
      portraitVideo.src = portraitURL;
      portraitDownloadBtn.href = portraitURL;
      portraitDownloadBtn.download = `${baseName()}-portrait.mp4`;
      portraitResult.hidden = false;
      portraitResult.scrollIntoView({ behavior: "smooth", block: "nearest" });
    } catch (err) {
      if (!cancelled) {
        console.error(err);
        showError(portraitError,
          "轉換失敗:" + (err && err.message ? err.message : err) +
          "\n可能原因:網路無法連到 CDN、影片編碼不支援,或記憶體不足。");
        try { ffmpeg && ffmpeg.terminate(); } catch (_) {}
        ffmpeg = null;
      }
    } finally {
      busy = false;
      portraitBtn.disabled = false;
      portraitProgress.hidden = true;
    }
  });

  portraitCancelBtn.addEventListener("click", () => {
    cancelled = true;
    try { ffmpeg && ffmpeg.terminate(); } catch (_) {}
    ffmpeg = null;
    busy = false;
    portraitBtn.disabled = false;
    portraitProgress.hidden = true;
    showError(portraitError, "已取消轉換。");
  });

  function resetPortrait() {
    portraitResult.hidden = true;
    hideError(portraitError);
    if (portraitURL) {
      URL.revokeObjectURL(portraitURL);
      portraitURL = null;
    }
    portraitVideo.removeAttribute("src");
  }

  // ==========================================================
  // 區塊二:封面截圖(canvas)
  // ==========================================================

  // 隱藏的 video 專門做截圖(seek 不干擾使用者正在看的播放器)
  function getCaptureVideo() {
    if (captureVideo && captureVideo.src === videoURL) return Promise.resolve(captureVideo);
    return new Promise((resolve, reject) => {
      const v = document.createElement("video");
      v.muted = true;
      v.preload = "auto";
      v.src = videoURL;
      v.onloadeddata = () => {
        captureVideo = v;
        resolve(v);
      };
      v.onerror = () => reject(new Error("影片無法解碼"));
    });
  }

  function seekTo(v, t) {
    return new Promise((resolve) => {
      v.onseeked = () => resolve();
      v.currentTime = Math.min(Math.max(0, t), Math.max(0, v.duration - 0.05));
    });
  }

  // 產生 6 張平均分布的縮圖
  video.addEventListener("loadedmetadata", async () => {
    thumbGrid.textContent = "";
    hideError(coverError);
    try {
      const v = await getCaptureVideo();
      const dur = v.duration;
      for (let i = 0; i < THUMB_COUNT; i++) {
        const t = (dur * (i + 0.5)) / THUMB_COUNT;
        await seekTo(v, t);
        const cv = document.createElement("canvas");
        const tw = 176;
        cv.width = tw;
        cv.height = Math.round((tw * v.videoHeight) / v.videoWidth) || 99;
        cv.getContext("2d").drawImage(v, 0, 0, cv.width, cv.height);

        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "thumb-btn";
        btn.title = `選這張(${t.toFixed(1)} 秒)`;
        const img = document.createElement("img");
        img.src = cv.toDataURL("image/jpeg", 0.7);
        img.alt = `第 ${t.toFixed(1)} 秒的畫面`;
        const tag = document.createElement("span");
        tag.textContent = formatClock(t);
        btn.append(img, tag);
        btn.addEventListener("click", () => selectCover(t, btn));
        thumbGrid.appendChild(btn);
      }
    } catch (err) {
      console.error(err);
      showError(coverError,
        "無法擷取縮圖:瀏覽器不能解碼這支影片的畫面(例如 HEVC 編碼)。" +
        "仍可使用其他區塊的功能。");
    }
  });

  captureBtn.addEventListener("click", () => {
    if (!currentFile) return;
    selectCover(video.currentTime, null);
  });

  async function selectCover(t, btn) {
    hideError(coverError);
    thumbGrid.querySelectorAll(".thumb-btn").forEach((b) => b.classList.toggle("selected", b === btn));
    try {
      selectedTime = t;
      // 預覽用 16:9 版本
      const blob = await renderCover(1280, 720, false);
      coverPreview.src = URL.createObjectURL(blob);
      coverArea.hidden = false;
    } catch (err) {
      console.error(err);
      showError(coverError, "擷取畫面失敗:" + (err && err.message ? err.message : err));
    }
  }

  // 把選定時間點的畫面畫成指定尺寸的 JPG。
  // 直式(narrow=true 時)用「模糊背景 + 原比例前景」的組合,與直式影片一致。
  async function renderCover(W, H, portrait) {
    if (selectedTime === null) throw new Error("尚未選擇畫面");
    const v = await getCaptureVideo();
    await seekTo(v, selectedTime);
    const cv = document.createElement("canvas");
    cv.width = W;
    cv.height = H;
    const ctx = cv.getContext("2d");
    const vw = v.videoWidth, vh = v.videoHeight;

    // cover-fill:放大到填滿、置中裁切
    const fillScale = Math.max(W / vw, H / vh);
    const fw = vw * fillScale, fh = vh * fillScale;
    if (portrait) {
      ctx.filter = "blur(24px)";
      ctx.drawImage(v, (W - fw) / 2, (H - fh) / 2, fw, fh);
      ctx.filter = "none";
      // 前景:原比例縮好置中
      const fitScale = Math.min(W / vw, H / vh);
      const gw = vw * fitScale, gh = vh * fitScale;
      ctx.drawImage(v, (W - gw) / 2, (H - gh) / 2, gw, gh);
    } else {
      ctx.drawImage(v, (W - fw) / 2, (H - fh) / 2, fw, fh);
    }
    return new Promise((resolve, reject) => {
      cv.toBlob((b) => (b ? resolve(b) : reject(new Error("無法產生 JPG"))), "image/jpeg", JPG_QUALITY);
    });
  }

  async function downloadCover(W, H, portrait, suffix) {
    hideError(coverError);
    try {
      const blob = await renderCover(W, H, portrait);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${baseName()}-cover-${suffix}.jpg`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    } catch (err) {
      console.error(err);
      showError(coverError, "產生封面失敗:" + (err && err.message ? err.message : err));
    }
  }

  coverYtBtn.addEventListener("click", () => downloadCover(1280, 720, false, "1280x720"));
  coverPortraitBtn.addEventListener("click", () => downloadCover(1080, 1920, true, "1080x1920"));

  function resetCover() {
    selectedTime = null;
    captureVideo = null;
    coverArea.hidden = true;
    thumbGrid.textContent = "";
    hideError(coverError);
  }

  // ==========================================================
  // 區塊三、四:字幕檔與文案提示詞
  // ==========================================================

  function shiftedSegs() {
    return (segs || [])
      .filter((s) => s.text.trim())
      .map((s) => ({
        start: Math.max(0, s.start + timeOffset),
        end: Math.max(0.1, s.end + timeOffset),
        text: s.text.trim(),
      }));
  }

  function srtTimestamp(t) {
    t = Math.max(0, t);
    const p = (x, l) => String(x).padStart(l, "0");
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = Math.floor(t % 60);
    const ms = Math.round((t - Math.floor(t)) * 1000);
    return `${p(h, 2)}:${p(m, 2)}:${p(s, 2)},${p(ms, 3)}`;
  }

  function setupSubtitleSections() {
    copyDone.hidden = true;
    if (segs && shiftedSegs().length) {
      srtHint.textContent = `已帶入 ${shiftedSegs().length} 句字幕(含時間位移)。`;
      srtBtn.classList.remove("btn-disabled");
      srtBtn.removeAttribute("aria-disabled");
      copyPromptBtn.disabled = false;
      copyHint.textContent = "複製後貼到 Claude 或任何 AI 聊天工具即可生成標題、說明欄與各平台貼文文案。";
    } else {
      srtHint.textContent = "這支影片沒有字幕資料。請先到「語音辨識字幕」完成字幕,再從那裡按「產生發佈包」帶過來。";
      srtBtn.classList.add("btn-disabled");
      srtBtn.setAttribute("aria-disabled", "true");
      srtBtn.removeAttribute("href");
      copyPromptBtn.disabled = true;
      copyHint.textContent = "需要字幕資料才能生成文案提示詞(文案是根據字幕內容產生的)。";
    }
  }

  srtBtn.addEventListener("click", (e) => {
    const list = shiftedSegs();
    if (!list.length) {
      e.preventDefault();
      return;
    }
    const body = list
      .map((s, i) => `${i + 1}\n${srtTimestamp(s.start)} --> ${srtTimestamp(s.end)}\n${s.text}\n`)
      .join("\n");
    const blob = new Blob(["\uFEFF" + body], { type: "text/plain;charset=utf-8" });
    if (srtURL) URL.revokeObjectURL(srtURL);
    srtURL = URL.createObjectURL(blob);
    srtBtn.href = srtURL;
    srtBtn.download = `${baseName()}.srt`;
  });

  function buildPrompt() {
    const lines = shiftedSegs()
      .map((s) => `${formatClock(s.start)} ${s.text}`)
      .join("\n");
    return `你是社群內容編輯。根據以下影片字幕內容,請生成:
1. YouTube 標題建議 3 個(吸引點擊但不誇大)
2. YouTube 說明欄文案(含重點時間軸)
3. Instagram Reels 貼文文案(口語、精簡)+ 10 個相關 hashtag
4. Facebook 貼文文案(可稍長,結尾帶互動提問)
全部使用繁體中文。

影片字幕內容:
${lines}`;
  }

  copyPromptBtn.addEventListener("click", async () => {
    const text = buildPrompt();
    try {
      await navigator.clipboard.writeText(text);
    } catch (_) {
      // 剪貼簿 API 不可用時的備援
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    copyDone.hidden = false;
    setTimeout(() => { copyDone.hidden = true; }, 3000);
  });

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
