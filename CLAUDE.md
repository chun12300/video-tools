# CLAUDE.md

這個檔案提供給 Claude Code 在此專案工作時的背景說明。

## 專案概觀

「影片小工具箱」— 純前端網頁工具箱,在瀏覽器內處理影片:

- **影片合併剪輯**(`merge.html` + `merge.js`):多支影片各剪一段、依順序合併輸出 MP4
- **影片轉 GIF**(`gif.html` + `gif.js`):剪一段影片轉成 GIF
- **語音辨識字幕**(`subtitle.html` + `subtitle.js`):Whisper 辨識 → 逐句編輯 → SRT / 燒進影片
- **發佈準備包**(`publish.html` + `publish.js`):直式版本、封面截圖、SRT、文案提示詞
- **腳本轉影片**(`script.html` + `script.js`):文案分句 → 配圖 → TTS 旁白 → 直式短影片 + SRT

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
- `subtitle.html` / `subtitle.js` — 語音辨識字幕(辨識、編輯、SRT、燒錄)
- `publish.html` / `publish.js` — 發佈準備包(直式轉換、封面、SRT、文案提示詞;
  不在首頁選單,從合併/字幕工具的完成畫面進入,亦可直接開頁選檔)
- `script.html` / `script.js` — 腳本轉影片(4 步驟精靈:貼腳本分句 → 場景配圖 →
  語音/字幕設定 → canvas 預覽與錄製輸出 WebM + SRT;不用 ffmpeg.wasm)
- `ffmpeg-loader.js` — 共用的 ffmpeg.wasm CDN 載入模組(`window.FFmpegLoader`)
- `style.css` — 深色主題樣式,響應式(以桌面為主)

部署:GitHub Pages 以「Deploy from a branch」(`main` + root)方式部署,
推送到 `main` 即自動重新部署,不需要 workflow。

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

### 自動剪輯(剪掉無聲片段)的設計

- 音訊分析用 Web Audio API 而不是 ffmpeg(快很多):
  `OfflineAudioContext(1, 1, 8000)` + `decodeAudioData` 重取樣到 8kHz,
  算每 50ms 的 RMS 轉 dBFS 當音量包絡,快取在 `item.envelope`(換靈敏度不用重解碼)。
- 門檻自適應:第 95 百分位音量 − 25 dB,夾在 −55 ~ −35 dBFS(`detectCuts`)。
  有聲比例 < 5% 的影片視為「幾乎無聲」整支保留,避免全片被剪光。
- 靈敏度=最短無聲長度:保守 1.5s/標準 0.8s/積極 0.4s;剪除段前後各留 0.15s 緩衝
  (`CUT_PAD`),兩段剪除之間保留 < 0.2s 時併成一段。
- **先預覽再剪**:分析結果存 `pendingCuts`(每段可勾「保留」),按「確認並合併」
  才把剪除區間反轉成保留區間(`keepIntervalsFor`)展開成多段 job 進正規化流程,
  不增加編碼次數;清單或剪輯一有變動就 `invalidatePreview()`。
- `decodeAudioData` 失敗=沒有音軌(或音訊解不開),提示後整支保留。

### 語音辨識字幕(subtitle.js)的設計

- Whisper 用 `@huggingface/transformers@3.8.1`(**固定 3.x**,4.x API 未驗證),
  以動態 `import()` 從 CDN 載入 ESM;模型 `Xenova/whisper-small` + `dtype:"q8"`
  (約 250 MB,transformers.js 會用瀏覽器 Cache API 快取)。
- 音訊用 `OfflineAudioContext(1,1,16000)` 解碼成 16kHz 單聲道,**每 30 秒一段**
  依序餵給 pipeline(`language:"chinese"`、`return_timestamps:true`),
  段與段之間更新進度;峰值 < −50 dB 的段直接跳過(Whisper 對無聲會幻聽)。
- **Whisper 段落起點系統性偏早**(把語音前的靜音吸進段落、視窗首段常從 0.00 開始),
  生成時用 20ms 音量包絡把每句起點對齊到實際開口點(`makeOnsetFinder`,
  往後最多找 2 秒、對齊後提前 0.05 秒),門檻同自動剪輯(p95−25dB 夾 −55~−35)。
- 「字幕時間位移」`timeOffset`(正=延後):**segs 永遠存原始時間**,
  位移只在預覽(`updateCaption`)、匯出/燒錄(`shiftedSegs`)時套用,並存進草稿。
  預覽字幕疊在播放器上(`#caption-overlay`),播放中用 rAF 更新。
- 簡轉繁用 `opencc-js@1.4.1`(UMD),`Converter({from:"cn", to:"twp"})`
  ——twp 會一併轉台灣用語(视频→影片)。
- 編輯器狀態存 `segs[{start,end,text}]`;任何修改 debounce 400ms 寫入
  localStorage(`subtitle-draft-v1`),以「檔名|大小」識別同一支影片來還原。
- 燒錄用 `subtitles=subs.srt:fontsdir=/fonts:force_style='FontName=Noto Sans TC,...'`
  ——core 已含 libass;字型用 npm 套件 `@expo-google-fonts/noto-sans-tc` 的 TTF
  (約 7 MB,SIL OFL),寫進 wasm FS 的 `/fonts/`。FontName 必須是字型內部
  家族名「Noto Sans TC」。SRT 匯出下載加 BOM,燒錄用的不加。
- 「合併 → 生成字幕」交接:merge.js 把結果 blob 放進 IndexedDB(`video-tools`
  資料庫的 `handoff` store),subtitle.html?from=merge 讀出後即刪。

### 腳本轉影片(script.js)的設計

- **不用 ffmpeg.wasm**:畫面用 canvas(1080×1920)逐場景繪製,
  `canvas.captureStream(30)` + MediaRecorder 輸出 WebM(vp9→vp8→預設依序嘗試)。
- **TTS 錄音靠分頁音訊分享**:speechSynthesis 的聲音無法被 MediaRecorder 直接擷取,
  生成時用 `getDisplayMedia({video, audio, preferCurrentTab, systemAudio:"include"})`
  引導使用者分享「目前分頁+分頁音訊」,取音訊軌與 canvas 影像軌合併錄製;
  拒絕/失敗/瀏覽器不支援時退回無聲模式(不發聲,場景長度改用字數估計:
  每字 0.22 秒 ÷ 語速,下限 1.2 秒)。部分系統的本機語音不進分頁音訊,
  UI 有提示可改分享「整個畫面+系統音訊」。
- 場景時長 = 該句 utterance `onend` 的實際時間 + 0.4s 緩衝;utterance 要存進
  變數防 GC,另設估計長度 ×3 + 4s 的保險絲 timeout。記錄每句相對錄製起點的
  起訖秒數產生 SRT(下載加 BOM)。
- **一句多素材(分鏡)**:`scene.media[]`(上限 3)裝圖片 `{kind:"image",image,thumb,crop}`
  或影片 `{kind:"video",videoEl,videoUrl,thumb}`,多個時把該句進度平均切段、依序硬切
  (index=floor(p×n)),圖片各自跑運鏡;場景卡片用 `<details>` 摺疊收納素材/運鏡/音效
  (`scene.advOpen` 記住開合,重繪保留)。
- **影片素材**:mp4/webm ≤50MB,靜音、cover 置中裁滿、不裁剪不運鏡;
  `loop=true` 補滿語音長度、切段時 `currentTime=0` 從頭播(drawScene 內驅動
  `play.activeVideo`),blob URL 在素材存活期間不 revoke,刪素材時才釋放。
- **三層混音**:單一 `AudioContext`(`getAudioCtx`,首次手勢時建立);
  場景音效 `scene.sfx{name,buffer,volume}`(≤5MB,預設 60%,場景始播終停)與
  BGM(≤15MB,loop,預設 25%,`duckBgm` 有語音時降至 40%、0.5s 恢復,結尾淡出 1s)
  走 BufferSource+Gain 進 `setupAudio` 的 out;預覽接 destination,
  錄製接 `MediaStreamAudioDestinationNode` 並把分頁音訊(TTS)用
  `createMediaStreamSource` 混進同一條音軌(MediaRecorder 只錄第一條音軌,
  錄製時音效/BGM 不出喇叭以免被分頁音訊重複收音);沒有音效/BGM 時維持
  原本的分頁音訊直通路徑。音訊 buffer 不進 localStorage 草稿。
- **場景圖片可裁剪**:彈窗內 9:16 鎖比例裁剪框(Pointer Events,滑鼠/觸控通用;
  拖曳移動、四角縮放、框外 box-shadow 遮罩),每個素材只存裁剪座標 `item.crop`
  (原圖座標 x,y,w,h),原圖保留可重調;預設=置中最大 9:16(`defaultCrop`)。
  縮圖/預覽/輸出都用 drawImage 九參數版取裁剪範圍。
- **運鏡** `scene.motion`(`motionSourceRect`):zoom 緩慢放大 1.0→1.08(預設)/
  push 快速推進 1.0→1.25/pan 左右橫移(固定放大 1.12 預留平移空間)/
  shake 震動(固定放大 1.05,每格 ±6px 隨機位移)/parallax 3D 視差/none 固定;
  取樣範圍一律夾在裁剪範圍內,不會露出圖片外的黑邊。
- **3D 視差運鏡**:transformers.js(動態 import CDN)+ `onnx-community/depth-anything-v2-small`
  估整張原圖的深度(縮到 768 邊長餵模型,`item.depth` 存灰階 canvas,裁剪改變不用重算、
  不進專案存檔,`ensureParallaxReady` 在播放/生成前補算);WebGL 位移著色器
  (`drawParallaxItem`,紋理 FLIP_Y、crop 的 y 要換算 `1-(y+h)/h`)依深度讓前景多移
  背景反向,uShift ±0.05、基礎放大 1.06→1.10 蓋邊緣;WebGL 不可用/深度沒 ready/
  模型載入失敗一律靜默退回 zoom(motionSourceRect 把 parallax 當 zoom)。
- 有圖場景:裁剪範圍畫滿畫面 + 運鏡(進度用估計時長算)+
  字幕(主題色字+黑描邊+半透明黑底,每行約 15 字換行,大小/位置/顏色可調;
  `*星號*` 包住的字用強調色,`styledChars`/`plainText` 分離顯示與朗讀/SRT 文字,
  paintLines 以 left-align 分段上色);句間停頓 `settings.scenePad` 可調,
  轉場 `settings.transition`(none/fade/flash)在 drawCurrent 疊場景開頭遮罩;
  無圖場景:hue 漸層背景+置中大字文字卡(字多自動縮小,**不再疊小字幕**,SRT 照出)。
- 圖片 >4000px 先縮到 2560 再用(記憶體);`getVoices()` 要等 `voiceschanged`,
  中文語音排序 zh-TW → zh-Hant → zh-HK → 其他 zh。
- **語音角色系統**:`characters[0]` 固定是「旁白」(不可刪),每個角色有
  語音/語速 0.7–1.4/音調 0.6–1.6/代表色,場景存 `charId`,刪角色時場景自動歸回旁白;
  分析腳本時行首「角色名:」(全形半形冒號)自動建角色(上限 6,滿了退回旁白)
  並去掉字幕前綴;語音清單依名稱對照表標性別(Hanhan/HsiaoChen/Meijia…=女聲,
  Zhiwei/YunJhe/Kangkang/Yunyang=男聲),偵測不到男聲時提示用音調模擬;
  角色設定存進草稿(舊版草稿的全域語音設定會遷移到旁白)。
- 預覽與錄製共用同一個播放引擎(rAF 繪製 + 100ms interval 備援,
  分頁被遮住時 rAF 會停);錄製期間必須保持分頁在前景。
- 文案與設定(語音/語速/字幕樣式)存 localStorage(`script-video-draft-v1`);
  **整包專案另外自動存進 IndexedDB**(獨立資料庫 `script-video-project`,
  **不能動共用的 `video-tools` 資料庫版本**,升級會弄壞其他工具的交接):
  場景素材/音效/BGM/錄音都保留原始 blob(`item.blob`),還原時重新解碼;
  1.5s debounce,開頁時發現存檔會詢問還原。
- **麥克風錄旁白**:`scene.voice{blob,buffer,duration}`,getUserMedia+MediaRecorder
  錄完 decodeAudioData;播放時錄音優先於 TTS、經混音圖(`playVoiceTrack`),
  estDur 用實際長度(分鏡/運鏡更準);全部句子都有錄音時生成免分享分頁
  (`needsTts`),silent-note 只在真的缺 TTS 時顯示。
- **成品出口**:「轉成 MP4」用 ffmpeg.wasm(libx264 veryfast CRF23 + AAC,
  進度用字幕最後一句結束時間估總長);「帶到發佈準備包」走 `video-tools/handoff`
  IndexedDB(key `publish`,`{blob,name,segs,offset}`,segs 直接用 timings)。
  MediaRecorder 的 WebM duration=Infinity,publish.js 用 `ensureFiniteDuration`
  (seek 到 1e9 逼出實際長度)處理封面截圖與進度。

### 發佈準備包(publish.js)的設計

- 交接:合併(key `publish`,只有 blob)與字幕工具(blob+segs+offset)都經
  IndexedDB `handoff` store 帶入 publish.html?from=tool,讀出即刪;
  直接開頁選檔時會用「檔名|大小」去 localStorage 撈字幕草稿補 segs。
- 直式 9:16:目標 1080×1920,來源寬度不足時等比例縮小(取偶數)。
  模糊背景 **用 boxblur=10:2,wasm core 沒有 gblur**;
  filtergraph:`split → bg(scale increase+crop+boxblur)、fg(scale decrease)→ overlay`。
- 封面用 canvas:隱藏 video seek 後 drawImage;直式封面用
  `ctx.filter="blur(24px)"` 畫 cover-fill 背景再疊原比例前景,與直式影片一致;
  無頭瀏覽器解不了 H.264 時縮圖會失敗,屬環境限制。
- 文案提示詞:固定模板 + 帶時間戳的完整字幕,`navigator.clipboard` 失敗時
  退回 textarea+execCommand。

## 測試

無自動化測試框架。手動驗證方式:

```bash
python3 -m http.server 8000   # 開 http://localhost:8000
```

跑完整流程確認:合併(兩支以上、其中一支無聲、調順序、各剪一段 → 輸出 MP4 可播放且有聲音)、
GIF(選檔 → 剪輯 → 轉換 → 產出有效 GIF)、
字幕(辨識 → 編輯 → SRT → 燒錄後畫面下方真的有字)。
若在無法直連 CDN 的環境,可從 registry.npmjs.org 下載上述套件 tarball,
以本機伺服器或 Playwright route 攔截方式代替 CDN 提供檔案;
Hugging Face 連不到時,可用 route 攔截回傳假的 transformers 模組
(export `pipeline`/`env`,回傳固定 chunks)來測整條字幕 UI 流程;
無頭 Chromium 可能無法解碼 H.264,驗證 MP4 請改檢查位元組結構(ftyp/mvhd/trak),
驗證燒錄字幕可用 ffmpeg.wasm 抽單格 PNG、數畫面下緣的亮像素。
