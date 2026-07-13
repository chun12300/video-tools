# CLAUDE.md

這個檔案提供給 Claude Code 在此專案工作時的背景說明。

## 專案概觀

「影片小工具箱」— 純前端網頁工具箱,在瀏覽器內處理影片:

- **影片合併剪輯**(`merge.html` + `merge.js`):多支影片各剪一段、依順序合併輸出 MP4
- **影片轉 GIF**(`gif.html` + `gif.js`):剪一段影片轉成 GIF

## 核心原則(修改程式時必須遵守)

1. **純 HTML / CSS / JavaScript**:不使用任何框架、不引入建置步驟(無 npm build、無 bundler)。
2. **繁體中文 UI**:所有使用者看得到的文字一律使用繁體中文。
3. **部署於 GitHub Pages**:必須維持純靜態、開箱即用;不能依賴自訂 HTTP 標頭(例如 COOP/COEP)。
4. **隱私優先**:影片檔案絕不離開使用者的瀏覽器,不得加入任何上傳、追蹤或外部回報行為。
5. **注意記憶體**:wasm 記憶體有限(至多 2 GB),多檔處理必須逐支進出 wasm 檔案系統,用完立即 `deleteFile`。

## 檔案結構

- `index.html` — 首頁工具選單(兩個工具入口、三步驟說明)
- `merge.html` / `merge.js` — 影片合併剪輯(多檔清單、拖曳排序、逐支剪輯、合併輸出 MP4)
- `gif.html` / `gif.js` — 影片轉 GIF(單檔、剪輯、尺寸/幀率、輸出 GIF)
- `ffmpeg-loader.js` — 共用的 ffmpeg.wasm CDN 載入模組(`window.FFmpegLoader`)
- `style.css` — 深色主題樣式,響應式(以桌面為主)
- `.github/workflows/pages.yml` — 推送到 `main` 時自動部署 GitHub Pages(首次仍需管理員在 Settings → Pages 把 Source 設為 GitHub Actions)

## 技術要點(踩過的坑,勿隨意更動)

- ffmpeg.wasm 版本組合:`@ffmpeg/ffmpeg@0.12.10`(UMD)+ `@ffmpeg/util@0.12.1`(UMD)+ `@ffmpeg/core@0.12.6`。
- **必須用單執行緒 core**(`@ffmpeg/core`,不是 `core-mt`):GitHub Pages 無法設定 COOP/COEP,`SharedArrayBuffer` 不可用。
- **跨網域 Worker 限制**:CDN 與網站不同源,所以 `classWorkerURL`(`dist/umd/814.ffmpeg.js`)、`coreURL`、`wasmURL` 都要先用 `toBlobURL` 轉成 blob URL 再傳給 `ffmpeg.load()`。
- **core 必須用 ESM 版**(`dist/esm/ffmpeg-core.js`):worker 以 module 模式執行,`importScripts` 不可用,改走 `await import(coreURL)`,需要 default export;UMD 版 core 會報 `failed to import ffmpeg-core.js`。
- CDN 依序嘗試 jsDelivr → unpkg(`ffmpeg-loader.js` 的 `CDN_BASES`)。
- 取消轉換用 `ffmpeg.terminate()`,之後實例已失效,必須設 `ffmpeg = null` 讓下次重新載入。

### 合併(merge.js)的設計

- 逐支影片:`-ss/-t` 剪輯 + 正規化成相同規格的中間檔 `seg_i.mp4`
  (fps=30、scale+pad 到統一解析度、H.264 yuv420p CRF 23、AAC 44.1kHz 立體聲),
  然後用 concat demuxer `-c copy` 串接;規格一致才能無縫串流複製。
- **無音軌的影片要墊靜音**:wasm 內沒有 ffprobe,用 `ffmpeg -i` 的 log 判斷有無
  `Stream #0:x Audio`(`probeHasAudio`);沒有就在 JS 產生靜音 WAV(`makeSilenceWav`)
  當第二個輸入。不能用 `-f lavfi -i anullsrc`,不確定 wasm core 是否含 lavfi。
- 輸出解析度取「面積最大的一支」為基準,寬度上限 1280,寬高取偶數(yuv420p 需要)。
- 記憶體控制:一次只有一支輸入檔在 wasm FS 裡,轉完立刻 `deleteFile`;
  總檔案大小超過 500 MB 在 UI 警告。

## 測試

無自動化測試框架。手動驗證方式:

```bash
python3 -m http.server 8000   # 開 http://localhost:8000
```

跑完整流程確認:合併(兩支以上、其中一支無聲、調順序、各剪一段 → 輸出 MP4 可播放且有聲音)、
GIF(選檔 → 剪輯 → 轉換 → 產出有效 GIF)。
若在無法直連 CDN 的環境,可從 registry.npmjs.org 下載上述套件 tarball,
以本機伺服器或 Playwright route 攔截方式代替 CDN 提供檔案;
無頭 Chromium 可能無法解碼 H.264,驗證 MP4 請改檢查位元組結構(ftyp/mvhd/trak)。
