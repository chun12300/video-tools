# 🎬 影片轉 GIF 小工具

一個純前端的網頁小工具:把影片(MP4 / MOV / WebM)剪一段轉成 GIF 動圖。
所有轉換都透過 [ffmpeg.wasm](https://ffmpegwasm.netlify.app/) **在你的瀏覽器裡完成**,影片檔案不會上傳到任何伺服器。

## 功能

- 📂 選擇或拖放影片檔(MP4、MOV、WebM)
- ▶️ 影片預覽與播放
- ✂️ 設定開始/結束時間,只轉換想要的片段(可一鍵取目前播放位置、試播片段)
- 🖼️ GIF 尺寸三檔(小 240px / 中 360px / 大 480px)與幀率選項(8 / 12 / 15 / 24 fps)
- 📊 轉換進度顯示,可中途取消
- ⬇️ 完成後可預覽並下載 GIF
- 💡 片段過長或產出檔案過大時給予友善提示
- 🌙 繁體中文介面、深色主題、支援手機瀏覽器

## 使用方式

1. **選影片** — 把影片拖進頁面,或點擊選擇檔案
2. **設定** — 拉動滑桿剪出片段,選擇尺寸與幀率
3. **下載** — 按「開始轉換」,完成後預覽並下載 GIF

## 部署到 GitHub Pages

這是純靜態網站,不需要任何建置步驟。儲存庫已內建部署 workflow
(`.github/workflows/pages.yml`):推送到 `main` 分支時會**自動啟用並部署
GitHub Pages**,完成後網站出現在 `https://<帳號>.github.io/<儲存庫名>/`。
部署進度可在儲存庫的 **Actions** 頁籤查看。

如果偏好手動設定,也可以改用傳統方式:**Settings → Pages → Source** 選
「Deploy from a branch」,Branch 選 `main` + `/ (root)`(此時可刪除上述 workflow)。

## 本機開發

因為瀏覽器對 `file://` 的限制,請用任何靜態伺服器開啟,例如:

```bash
python3 -m http.server 8000
# 然後打開 http://localhost:8000
```

## 技術說明

- 純 HTML / CSS / JavaScript,無框架、無建置步驟
- ffmpeg.wasm(`@ffmpeg/ffmpeg` 0.12 + 單執行緒版 `@ffmpeg/core`)從 CDN 載入(jsDelivr,失敗時自動改用 unpkg)
- GitHub Pages 無法設定 COOP/COEP 標頭,因此刻意採用**單執行緒**核心(不需要 `SharedArrayBuffer`)
- CDN 與網站不同源,Worker 無法直接以跨網域 URL 建立,因此 worker、core、wasm 都先用 `toBlobURL` 轉成同源 blob URL 再載入
- GIF 以 `palettegen` / `paletteuse` 兩階段調色盤濾鏡產生,品質較佳

## 已知限制

- **首次轉換需下載約 25 MB** 的 ffmpeg 核心(之後由瀏覽器快取)
- **單執行緒轉換速度較慢**:長片段或大尺寸可能要等比較久
- **記憶體限制**:輸入檔案上限設為 500 MB,過大的影片可能導致瀏覽器記憶體不足
- **編碼支援**:HEVC/H.265 等部分編碼的 MOV 檔可能無法解碼,建議使用 H.264 MP4 或 WebM
- **GIF 本身的限制**:最多 256 色、檔案效率差;長片段請剪短或降低尺寸/幀率
- 需要較新的瀏覽器(支援 WebAssembly 與 module worker);建議使用桌面版 Chrome / Edge / Firefox
