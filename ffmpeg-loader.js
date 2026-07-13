/* ===== ffmpeg.wasm 共用載入模組 =====
 * 供 gif.js 與 merge.js 共用。所有轉換皆在瀏覽器內完成,檔案不會上傳。
 * 採用單執行緒版 @ffmpeg/core:GitHub Pages 無法設定 COOP/COEP 標頭,
 * 因此不能使用需要 SharedArrayBuffer 的多執行緒版本。
 */
(() => {
  "use strict";

  const FFMPEG_VER = "0.12.10";
  const UTIL_VER = "0.12.1";
  const CORE_VER = "0.12.6";
  const CDN_BASES = [
    "https://cdn.jsdelivr.net/npm",
    "https://unpkg.com",
  ];

  let libsPromise = null;

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
  function loadLibs() {
    if (!libsPromise) {
      libsPromise = tryCDNs(async (base) => {
        await loadScript(`${base}/@ffmpeg/ffmpeg@${FFMPEG_VER}/dist/umd/ffmpeg.js`);
        await loadScript(`${base}/@ffmpeg/util@${UTIL_VER}/dist/umd/index.js`);
        if (!window.FFmpegWASM || !window.FFmpegUtil) {
          throw new Error("ffmpeg.wasm 程式庫載入不完整");
        }
      }).catch((err) => {
        libsPromise = null; // 失敗後允許重試
        throw err;
      });
    }
    return libsPromise;
  }

  // 建立並載入一個可用的 FFmpeg 實例。
  // GitHub Pages 與 CDN 不同源,Worker 無法直接用跨網域 URL 建立,
  // 因此 worker / core / wasm 都先以 toBlobURL 轉成同源 blob URL。
  // 注意:worker 以 module 模式載入 core,需用有 default export 的 ESM 版。
  async function createLoadedFFmpeg(onStatus) {
    if (onStatus) onStatus("正在載入轉換引擎(首次使用約需下載 25 MB)…");
    await loadLibs();
    const { FFmpeg } = window.FFmpegWASM;
    const { toBlobURL } = window.FFmpegUtil;

    const ffmpeg = new FFmpeg();
    await tryCDNs(async (base) => {
      const ffmpegBase = `${base}/@ffmpeg/ffmpeg@${FFMPEG_VER}/dist/umd`;
      const coreBase = `${base}/@ffmpeg/core@${CORE_VER}/dist/esm`;
      await ffmpeg.load({
        classWorkerURL: await toBlobURL(`${ffmpegBase}/814.ffmpeg.js`, "text/javascript"),
        coreURL: await toBlobURL(`${coreBase}/ffmpeg-core.js`, "text/javascript"),
        wasmURL: await toBlobURL(`${coreBase}/ffmpeg-core.wasm`, "application/wasm"),
      });
    });
    return ffmpeg;
  }

  function formatSize(bytes) {
    if (bytes >= 1024 * 1024 * 1024) return (bytes / 1024 / 1024 / 1024).toFixed(2) + " GB";
    if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + " MB";
    if (bytes >= 1024) return (bytes / 1024).toFixed(0) + " KB";
    return bytes + " B";
  }

  window.FFmpegLoader = { createLoadedFFmpeg, formatSize };
})();
