# CLAUDE.md

這個檔案提供給 Claude Code 在此專案工作時的背景說明。

## 專案概觀

「影片轉 GIF 小工具」— 純前端網頁工具,在瀏覽器內把影片片段轉成 GIF。

## 核心原則(修改程式時必須遵守)

1. **純 HTML / CSS / JavaScript**:不使用任何框架、不引入建置步驟(無 npm build、無 bundler)。
2. **繁體中文 UI**:所有使用者看得到的文字一律使用繁體中文。
3. **部署於 GitHub Pages**:必須維持純靜態、開箱即用;不能依賴自訂 HTTP 標頭(例如 COOP/COEP)。
4. **隱私優先**:影片檔案絕不離開使用者的瀏覽器,不得加入任何上傳、追蹤或外部回報行為。

## 檔案結構

- `index.html` — 單頁介面(三步驟說明、拖放區、預覽/剪輯/設定、進度、結果)
- `style.css` — 深色主題樣式,響應式(以桌面為主)
- `app.js` — 全部邏輯:檔案選擇、剪輯區間、ffmpeg.wasm 載入與轉換、進度、下載
- `.github/workflows/pages.yml` — 推送到 `main` 時自動啟用並部署 GitHub Pages

## 技術要點(踩過的坑,勿隨意更動)

- ffmpeg.wasm 版本組合:`@ffmpeg/ffmpeg@0.12.10`(UMD)+ `@ffmpeg/util@0.12.1`(UMD)+ `@ffmpeg/core@0.12.6`。
- **必須用單執行緒 core**(`@ffmpeg/core`,不是 `core-mt`):GitHub Pages 無法設定 COOP/COEP,`SharedArrayBuffer` 不可用。
- **跨網域 Worker 限制**:CDN 與網站不同源,所以 `classWorkerURL`(`dist/umd/814.ffmpeg.js`)、`coreURL`、`wasmURL` 都要先用 `toBlobURL` 轉成 blob URL 再傳給 `ffmpeg.load()`。
- **core 必須用 ESM 版**(`dist/esm/ffmpeg-core.js`):worker 以 module 模式執行,`importScripts` 不可用,改走 `await import(coreURL)`,需要 default export;UMD 版 core 會報 `failed to import ffmpeg-core.js`。
- CDN 依序嘗試 jsDelivr → unpkg(`CDN_BASES`)。
- 取消轉換用 `ffmpeg.terminate()`,之後實例已失效,必須設 `ffmpeg = null` 讓下次重新載入。

## 測試

無自動化測試框架。手動驗證方式:

```bash
python3 -m http.server 8000   # 開 http://localhost:8000
```

選一支短影片跑完整流程(選檔 → 剪輯 → 轉換 → 下載),確認產出為有效 GIF。
若在無法直連 CDN 的環境,可從 registry.npmjs.org 下載上述套件 tarball,
以本機伺服器或 Playwright route 攔截方式代替 CDN 提供檔案。
