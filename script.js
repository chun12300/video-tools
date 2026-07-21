/* ===== 腳本轉影片 =====
 * 純瀏覽器端:文案分句 → 每句配圖 → speechSynthesis 旁白 →
 * canvas(1080×1920)+ MediaRecorder 錄製直式短影片(WebM)+ SRT。
 * TTS 聲音無法直接被 MediaRecorder 擷取,錄音靠 getDisplayMedia
 * 引導使用者分享「目前分頁+分頁音訊」,取音訊軌與 canvas 影像軌合併。
 */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const W = 1080;
  const H = 1920;
  const KEN_BURNS = 0.08;        // 場景內圖片緩慢放大幅度(1.0 → 1.08)
  const SUB_MAX_CHARS = 15;      // 字幕每行最多字數
  const IMG_MAX_DIM = 4000;      // 超過就先縮小,避免記憶體問題
  const IMG_RESIZE_TO = 2560;
  const CROP_RATIO = 9 / 16;     // 裁剪框固定比例(寬/高),與影片畫面一致
  const DRAFT_KEY = "script-video-draft-v1";
  const FONT_STACK = '"Noto Sans TC","PingFang TC","Microsoft JhengHei",system-ui,sans-serif';
  const SUB_SIZES = { large: 76, medium: 60, small: 46 };
  const MAX_CHARS = 6;           // 語音角色上限
  const MAX_MEDIA = 3;           // 每個場景的素材上限
  const SFX_MAX_BYTES = 5 * 1024 * 1024;    // 場景音效上限 5MB
  const BGM_MAX_BYTES = 15 * 1024 * 1024;   // 背景音樂上限 15MB
  const VIDEO_MAX_BYTES = 50 * 1024 * 1024; // 影片素材上限 50MB
  const DUCK_RATIO = 0.4;        // 有語音時 BGM 降到設定音量的 40%
  const MOTIONS = {              // 場景運鏡選項
    zoom: "緩慢放大",
    push: "快速推進",
    pan: "左右橫移",
    shake: "震動",
    parallax: "3D 視差(AI)",
    none: "固定",
  };
  // 3D 視差:瀏覽器內 AI 深度估計(transformers.js + Depth Anything V2 small)
  const TRANSFORMERS_CDN = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1";
  const DEPTH_MODEL = "onnx-community/depth-anything-v2-small";
  const RMBG_MODEL  = "briaai/RMBG-1.4";                       // AI 去背(image-segmentation)
  const KOKORO_CDN  = "https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/+esm"; // Kokoro TTS
  const KOKORO_MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
  const KOKORO_VOICES = [  // 中文語音選項(zf=女聲 zm=男聲)
    { id: "zf_xiaoxiao", label: "小小(女聲,柔和)" },
    { id: "zf_xiaobei",  label: "小北(女聲,溫暖)" },
    { id: "zm_yunxi",    label: "雲希(男聲,自然)" },
    { id: "zm_yunxia",   label: "雲夏(男聲,低沉)" },
  ];
  const TEST_SENTENCE = "你好,這是我的聲音,請問這樣可以嗎?";
  const CHAR_COLORS = ["#5b8cff", "#ff7a7a", "#5ad19a", "#ffc95c", "#c58bff", "#ff9c6e", "#4dd0e1", "#f06292"];
  // 依語音名稱推測性別(常見中文語音對照表,比對時去掉空白與符號)
  const FEMALE_VOICES = ["hanhan", "hsiaochen", "hsiaoyu", "meijia", "yating", "xiaoxiao", "tingting"];
  const MALE_VOICES = ["zhiwei", "yunjhe", "kangkang", "yunyang"];

  // ===== 狀態 =====
  let scenes = [];        // { id, text, image, thumb, hue, crop:{x,y,w,h}(原圖座標), charId }
  let uid = 0;
  let voices = [];        // 下拉選單中的語音(中文優先)
  let characters = [];    // { id, name, voiceURI, rate, pitch, color };[0] 固定是「旁白」,不可刪
  let charUid = 0;
  let maxStep = 1;        // 已到達過的最大步驟(導覽列解鎖用)
  let play = null;        // 播放/錄製狀態,null = 閒置
  let currentUtter = null; // 防止 utterance 被 GC 導致 onend 不觸發
  let lastUrls = [];      // 上一次結果的 object URL,重生成時釋放
  let audioCtx = null;    // 共用的 AudioContext(音效/BGM/錄製混音都用它)
  let sfxPreview = null;  // 進行中的音效試聽
  const bgm = { name: "", buffer: null, blob: null, volume: 0.25 }; // 背景音樂

  const SUB_COLORS = ["#ffffff", "#ffe14d", "#7ef0ff", "#ffb3d9"]; // 字幕顏色主題
  const TRANSITIONS = ["none", "fade", "flash"];                    // 硬切/黑場淡入/白閃
  const SUB_ANIMS  = ["slide", "type", "none"];                    // 字幕入場動畫
  const FILTERS = {                                                // 圖片/影片濾鏡
    none:      "",
    cinematic: "contrast(1.12) saturate(0.82) sepia(0.12)",
    warm:      "sepia(0.18) saturate(1.25) brightness(1.06)",
    vintage:   "sepia(0.45) contrast(1.08) brightness(0.92) saturate(0.75)",
    bw:        "grayscale(1) contrast(1.08)",
  };
  const settings = {
    subSize: "medium",
    subPos: "bottom",
    subColor: "#ffffff",
    subAnim: "slide",    // 字幕入場動畫:slide 上滑 / type 打字機 / none 無
    imageFilter: "none", // 圖片濾鏡
    transition: "none",
    scenePad: 0.4, // 句間停頓(秒)
  };

  const stage = $("stage");
  const ctx = stage.getContext("2d");
  const scriptInput = $("script-input");
  const sceneListEl = $("scene-list");

  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
  const numOr = (v, lo, hi, dflt) => {
    const n = Number(v);
    return Number.isFinite(n) ? clamp(n, lo, hi) : dflt;
  };

  const ttsOk = () => "speechSynthesis" in window;

  // ===== 音訊基礎(單一 AudioContext,三層音源共用)=====
  function getAudioCtx() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
    return audioCtx;
  }

  async function decodeAudioFile(file, maxBytes, label) {
    if (!file.type.startsWith("audio/") && !/\.(mp3|wav|ogg)$/i.test(file.name)) {
      throw new Error("請選擇 mp3 / wav / ogg 音訊檔");
    }
    if (file.size > maxBytes) {
      throw new Error(`${label}檔案不能超過 ${Math.round(maxBytes / 1024 / 1024)} MB`);
    }
    const buf = await file.arrayBuffer();
    try {
      return await getAudioCtx().decodeAudioData(buf);
    } catch (e) {
      throw new Error("瀏覽器無法解碼這個音訊檔");
    }
  }

  // ===== 相容性偵測 =====
  function checkSupport() {
    const missing = [];
    if (!ttsOk()) missing.push("語音合成(speechSynthesis)");
    if (!window.MediaRecorder) missing.push("影片錄製(MediaRecorder)");
    if (!stage.captureStream) missing.push("畫布擷取(canvas.captureStream)");
    const ua = navigator.userAgent;
    const isChromeDesktop = /Chrome\//.test(ua) && !/Edg\/|OPR\/|Mobile/.test(ua);
    const warnEl = $("support-warning");
    if (missing.length) {
      warnEl.textContent =
        `⚠️ 這個瀏覽器不支援:${missing.join("、")}。` +
        "部分功能將無法使用,建議改用「桌面版 Chrome」開啟本頁。";
      warnEl.hidden = false;
    } else if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      warnEl.textContent =
        "⚠️ 這個瀏覽器無法擷取分頁音訊,只能輸出無聲影片。想要有語音旁白,請改用桌面版 Chrome。";
      warnEl.hidden = false;
    } else if (!isChromeDesktop) {
      warnEl.textContent =
        "💡 語音錄製功能以桌面版 Chrome 測試為主,其他瀏覽器可能只能輸出無聲影片。";
      warnEl.hidden = false;
    }
  }

  // ===== 語音角色 =====
  function makeCharacter(name) {
    charUid += 1;
    const used = characters.map((c) => c.color);
    return {
      id: charUid,
      name,
      voiceURI: characters[0] ? characters[0].voiceURI : "", // 沿用旁白的語音當起點
      rate: 1,
      pitch: 1,
      color: CHAR_COLORS.find((c) => !used.includes(c)) || CHAR_COLORS[charUid % CHAR_COLORS.length],
    };
  }

  // characters[0] 必須永遠存在且是「旁白」(預設角色)
  function ensureNarrator() {
    if (!characters.length) characters.push(makeCharacter("旁白"));
  }

  function charById(id) {
    return characters.find((c) => c.id === id) || characters[0];
  }

  function findOrCreateCharacter(name) {
    let c = characters.find((x) => x.name === name);
    if (c) return c;
    if (characters.length >= MAX_CHARS) return characters[0]; // 角色滿了,退回旁白
    c = makeCharacter(name);
    characters.push(c);
    return c;
  }

  // ===== 草稿(只存文字/設定/角色,圖片無法存進 localStorage)=====
  let draftTimer = null;
  function saveDraft() {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
      try {
        const chars = characters.map(({ id, name, voiceURI, rate, pitch, color }) =>
          ({ id, name, voiceURI, rate, pitch, color }));
        localStorage.setItem(DRAFT_KEY, JSON.stringify({ text: scriptInput.value, settings, characters: chars }));
      } catch (e) { /* 空間不足時放棄暫存即可 */ }
      scheduleProjectSave();
    }, 400);
  }
  function restoreDraft() {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (!raw) return;
      const d = JSON.parse(raw);
      if (typeof d.text === "string") scriptInput.value = d.text;
      if (d.settings) {
        settings.subSize = d.settings.subSize || settings.subSize;
        settings.subPos = d.settings.subPos || settings.subPos;
        if (SUB_COLORS.includes(d.settings.subColor)) settings.subColor = d.settings.subColor;
        if (TRANSITIONS.includes(d.settings.transition)) settings.transition = d.settings.transition;
        if (SUB_ANIMS.includes(d.settings.subAnim)) settings.subAnim = d.settings.subAnim;
        if (d.settings.imageFilter in FILTERS) settings.imageFilter = d.settings.imageFilter;
        settings.scenePad = numOr(d.settings.scenePad, 0, 1.5, 0.4);
      }
      if (Array.isArray(d.characters) && d.characters.length) {
        characters = d.characters.slice(0, MAX_CHARS).map((c) => ({
          id: Number(c.id) || 0,
          name: String(c.name || "角色").slice(0, 12),
          voiceURI: typeof c.voiceURI === "string" ? c.voiceURI : "",
          rate: numOr(c.rate, 0.7, 1.4, 1),
          pitch: numOr(c.pitch, 0.6, 1.6, 1),
          color: CHAR_COLORS.includes(c.color) ? c.color : CHAR_COLORS[0],
        }));
        charUid = Math.max(0, ...characters.map((c) => c.id));
      } else if (d.settings && (d.settings.voiceURI || d.settings.rate)) {
        // 舊版草稿:全域語音設定併入預設角色「旁白」
        ensureNarrator();
        characters[0].voiceURI = d.settings.voiceURI || "";
        characters[0].rate = numOr(d.settings.rate, 0.7, 1.4, 1);
      }
    } catch (e) { /* 草稿壞掉就忽略 */ }
  }

  // ===== 專案自動存檔(IndexedDB,含圖片/影片/音訊的原始檔案)=====
  // 注意:用獨立資料庫,不能動共用的 video-tools 資料庫(版本升級會弄壞其他工具)
  function projectDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open("script-video-project", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("project");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  let projectSaveTimer = null;
  function scheduleProjectSave() {
    clearTimeout(projectSaveTimer);
    projectSaveTimer = setTimeout(() => {
      saveProjectNow().catch(() => { /* 空間不足等問題就放棄這次自動存檔 */ });
    }, 1500);
  }

  async function saveProjectNow() {
    if (!scenes.length) return;
    const data = {
      savedAt: Date.now(),
      text: scriptInput.value,
      settings: { ...settings },
      characters: characters.map(({ id, name, voiceURI, rate, pitch, color }) =>
        ({ id, name, voiceURI, rate, pitch, color })),
      bgm: bgm.blob ? { name: bgm.name, volume: bgm.volume, blob: bgm.blob } : null,
      scenes: scenes.map((s) => ({
        text: s.text,
        hue: s.hue,
        motion: s.motion,
        charId: s.charId,
        sfx: (s.sfx && s.sfx.blob) ? { name: s.sfx.name, volume: s.sfx.volume, blob: s.sfx.blob } : null,
        voice: (s.voice && s.voice.blob) ? { blob: s.voice.blob, duration: s.voice.duration } : null,
        media: s.media.filter((m) => m.blob).map((m) => ({ kind: m.kind, crop: m.crop || null, blob: m.blob })),
      })),
    };
    const db = await projectDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction("project", "readwrite");
      tx.objectStore("project").put(data, "current");
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }

  async function loadProjectRecord() {
    const db = await projectDb();
    return await new Promise((resolve) => {
      const tx = db.transaction("project", "readonly");
      const get = tx.objectStore("project").get("current");
      get.onsuccess = () => resolve(get.result || null);
      get.onerror = () => resolve(null);
    });
  }

  async function deleteProjectRecord() {
    const db = await projectDb();
    await new Promise((resolve) => {
      const tx = db.transaction("project", "readwrite");
      tx.objectStore("project").delete("current");
      tx.oncomplete = resolve;
      tx.onerror = resolve;
    });
  }

  // 從存檔重建整個專案(個別素材壞掉就跳過,不讓整包失敗)
  async function restoreProject(data) {
    if (typeof data.text === "string") scriptInput.value = data.text;
    if (data.settings) {
      settings.subSize = data.settings.subSize || settings.subSize;
      settings.subPos = data.settings.subPos || settings.subPos;
    }
    if (Array.isArray(data.characters) && data.characters.length) {
      characters = data.characters.slice(0, MAX_CHARS).map((c) => ({
        id: Number(c.id) || 0,
        name: String(c.name || "角色").slice(0, 12),
        voiceURI: typeof c.voiceURI === "string" ? c.voiceURI : "",
        rate: numOr(c.rate, 0.7, 1.4, 1),
        pitch: numOr(c.pitch, 0.6, 1.6, 1),
        color: CHAR_COLORS.includes(c.color) ? c.color : CHAR_COLORS[0],
      }));
      charUid = Math.max(0, ...characters.map((c) => c.id));
    }
    ensureNarrator();
    if (data.bgm && data.bgm.blob) {
      try {
        bgm.buffer = await getAudioCtx().decodeAudioData(await data.bgm.blob.arrayBuffer());
        bgm.name = data.bgm.name || "背景音樂";
        bgm.blob = data.bgm.blob;
        bgm.volume = numOr(data.bgm.volume, 0, 1, 0.25);
        $("bgm-name").textContent = bgm.name;
        $("bgm-remove").hidden = false;
        $("bgm-volume").value = Math.round(bgm.volume * 100);
        $("bgm-volume-val").textContent = `${Math.round(bgm.volume * 100)}%`;
      } catch (e) { /* BGM 壞了就略過 */ }
    }
    scenes = [];
    for (const s of data.scenes || []) {
      const scene = makeScene(String(s.text || ""),
        characters.some((c) => c.id === s.charId) ? s.charId : undefined);
      scene.hue = Number.isFinite(s.hue) ? s.hue : scene.hue;
      scene.motion = MOTIONS[s.motion] ? s.motion : "zoom";
      for (const m of s.media || []) {
        if (scene.media.length >= MAX_MEDIA || !m.blob) continue;
        try {
          const item = m.kind === "video" ? await loadVideoItem(m.blob) : await loadMediaItem(m.blob);
          if (item.kind === "image" && m.crop) {
            item.crop = m.crop;
            makeThumb(item);
          }
          scene.media.push(item);
        } catch (e) { /* 個別素材壞了就跳過 */ }
      }
      if (s.sfx && s.sfx.blob) {
        try {
          scene.sfx = {
            name: s.sfx.name || "音效",
            buffer: await getAudioCtx().decodeAudioData(await s.sfx.blob.arrayBuffer()),
            volume: numOr(s.sfx.volume, 0, 1, 0.6),
            blob: s.sfx.blob,
          };
        } catch (e) { /* 音效壞了就跳過 */ }
      }
      if (s.voice && s.voice.blob) {
        try {
          const buffer = await getAudioCtx().decodeAudioData(await s.voice.blob.arrayBuffer());
          scene.voice = { blob: s.voice.blob, buffer, duration: buffer.duration };
        } catch (e) { /* 錄音壞了就跳過 */ }
      }
      scenes.push(scene);
    }
  }

  // ===== 步驟導覽 =====
  function gotoStep(n) {
    if (n >= 2 && !scenes.length) {
      showError("step1-error", "請先貼上文案並按「分析腳本」。");
      return;
    }
    if (play) stopPlayback(); // 換步驟時停止播放/錄製
    maxStep = Math.max(maxStep, n);
    for (let i = 1; i <= 4; i++) $(`step-${i}`).hidden = i !== n;
    document.querySelectorAll(".wizard-step").forEach((btn) => {
      const s = Number(btn.dataset.step);
      btn.classList.toggle("is-active", s === n);
      btn.disabled = s > maxStep;
    });
    if (n === 3) refreshVoices();
    if (n === 4) {
      updatePrecheck();
      drawIdle();
    }
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function showError(id, msg) {
    const el = $(id);
    el.textContent = msg;
    el.hidden = !msg;
  }

  // ===== 步驟 1:分句 =====
  // 單行內依標點分句
  function splitSentences(text) {
    const parts = [];
    let buf = "";
    const flush = () => {
      // 去掉句尾的「。」,保留 ! ? 的語氣
      const t = buf.trim().replace(/[。.]+$/, "");
      if (t) parts.push(t);
      buf = "";
    };
    for (const ch of text) {
      buf += ch;
      if ("。!?!?".includes(ch)) flush();
    }
    flush();
    return parts;
  }

  // 逐行解析:行首「角色名:」(全形或半形冒號)把整行台詞指定給該角色,
  // 字幕內容去掉前綴;沒有前綴的句子歸「旁白」
  function parseScript(text) {
    const out = []; // { text, charName|null }
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      let charName = null;
      let rest = line;
      const m = line.match(/^([^::。!?!?\s]{1,12})[::]\s*/);
      if (m) {
        charName = m[1];
        rest = line.slice(m[0].length);
      }
      for (const s of splitSentences(rest)) out.push({ text: s, charName });
    }
    return out;
  }

  function makeScene(text, charId) {
    uid += 1;
    ensureNarrator();
    return {
      id: uid, text, hue: (uid * 53) % 360,
      media: [],          // 1~3 個素材,多個時語音時間平均分配硬切:
                          //   圖片 { id, kind:"image", image, thumb, crop }
                          //   影片 { id, kind:"video", videoEl, videoUrl, thumb }(靜音、cover、不運鏡)
      motion: "zoom",     // 運鏡(套用到該場景所有圖片素材)
      sfx: null,          // 場景音效 { name, buffer(AudioBuffer), volume 0~1 }
      advOpen: false,     // 「素材與運鏡」摺疊狀態(重繪時保留)
      charId: charId || characters[0].id,
    };
  }

  function imgSize(img) {
    return { w: img.width || img.naturalWidth, h: img.height || img.naturalHeight };
  }

  // 置中的最大 9:16 裁剪範圍(橫圖:高度全用;直圖:寬度全用)
  function defaultCrop(w, h) {
    const cw = Math.min(w, h * CROP_RATIO);
    const ch = cw / CROP_RATIO;
    return { x: (w - cw) / 2, y: (h - ch) / 2, w: cw, h: ch };
  }

  function itemCrop(item) {
    if (item.crop) return item.crop;
    const { w, h } = imgSize(item.image);
    return defaultCrop(w, h);
  }

  // 依裁剪範圍重畫素材縮圖(直式 9:16)
  function makeThumb(item) {
    const crop = itemCrop(item);
    const t = document.createElement("canvas");
    t.width = 72;
    t.height = 128;
    t.getContext("2d").drawImage(item.image, crop.x, crop.y, crop.w, crop.h, 0, 0, t.width, t.height);
    item.thumb = t.toDataURL("image/jpeg", 0.75);
  }

  function analyze() {
    showError("step1-error", "");
    const text = scriptInput.value.trim();
    if (!text) {
      showError("step1-error", "請先貼上文案再分析。");
      return;
    }
    if (scenes.length &&
        !confirm("重新分析會清掉目前的場景設定(包括已上傳的圖片),確定要重新分析嗎?")) {
      return;
    }
    const parts = parseScript(text);
    if (!parts.length) {
      showError("step1-error", "分不出任何句子,請確認文案內容。");
      return;
    }
    ensureNarrator();
    const newNames = [];
    scenes = parts.map((p) => {
      let charId;
      if (p.charName) {
        const before = characters.length;
        const c = findOrCreateCharacter(p.charName);
        if (characters.length > before) newNames.push(c.name);
        charId = c.id;
      }
      return makeScene(p.text, charId);
    });
    const resultEl = $("split-result");
    resultEl.textContent = `✅ 已分成 ${scenes.length} 個場景` +
      (newNames.length ? `,自動建立角色:${newNames.join("、")}(可在步驟 3 調整聲音)` : "");
    resultEl.hidden = false;
    saveDraft();
    renderCharacters();
    renderScenes();
    gotoStep(2);
  }

  // ===== 步驟 2:場景列表 =====
  function renderScenes() {
    ensureNarrator();
    sceneListEl.textContent = "";
    scenes.forEach((scene, i) => {
      if (!characters.some((c) => c.id === scene.charId)) scene.charId = characters[0].id;
      const char = charById(scene.charId);
      const li = document.createElement("li");
      li.className = "scene-card";
      li.dataset.id = scene.id;
      li.style.borderLeft = `4px solid ${char.color}`; // 角色代表色色條

      // 主縮圖:第一個素材(或漸層文字卡),點擊展開/收合素材設定
      const thumb = document.createElement("div");
      thumb.className = "scene-thumb";
      if (scene.media.length) {
        const img = document.createElement("img");
        img.src = scene.media[0].thumb;
        img.alt = "場景素材縮圖";
        thumb.appendChild(img);
        if (scene.media.length > 1) {
          const badge = document.createElement("span");
          badge.className = "thumb-crop-badge";
          badge.textContent = `×${scene.media.length}`;
          thumb.appendChild(badge);
        }
        thumb.classList.add("has-img");
      } else {
        thumb.textContent = "文字卡";
        thumb.style.background =
          `linear-gradient(160deg, hsl(${scene.hue},55%,32%), hsl(${scene.hue + 40},65%,14%))`;
      }
      thumb.title = "點擊展開素材與運鏡設定";
      thumb.style.cursor = "pointer";
      thumb.addEventListener("click", () => {
        scene.advOpen = !scene.advOpen;
        renderScenes();
      });

      const body = document.createElement("div");
      body.className = "scene-body";

      const head = document.createElement("div");
      head.className = "scene-head";
      head.innerHTML = `<span class="item-index">${i + 1}</span>` +
        `<span class="scene-kind">${scene.media.length ? `🖼 圖片×${scene.media.length}` : "🎨 漸層文字卡"}</span>`;

      // 這句由哪個角色唸
      const charSel = document.createElement("select");
      charSel.className = "scene-char";
      charSel.title = "這句由哪個角色唸";
      characters.forEach((c) => {
        const opt = document.createElement("option");
        opt.value = c.id;
        opt.textContent = `● ${c.name}`;
        opt.style.color = c.color;
        charSel.appendChild(opt);
      });
      charSel.value = String(scene.charId);
      charSel.style.color = char.color;
      charSel.addEventListener("change", () => {
        scene.charId = Number(charSel.value);
        const c2 = charById(scene.charId);
        li.style.borderLeft = `4px solid ${c2.color}`;
        charSel.style.color = c2.color;
        scheduleProjectSave();
      });
      head.appendChild(charSel);

      const ta = document.createElement("textarea");
      ta.className = "scene-text";
      ta.rows = 2;
      ta.value = scene.text;
      ta.placeholder = "這個場景的文字(同時是字幕)";
      ta.addEventListener("input", () => { scene.text = ta.value; scheduleProjectSave(); });

      const actions = document.createElement("div");
      actions.className = "scene-actions";
      const btn = (act, label, title, disabled) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "btn btn-small";
        b.dataset.act = act;
        b.textContent = label;
        if (title) b.title = title;
        b.disabled = !!disabled;
        return b;
      };
      actions.appendChild(btn("up", "↑", "上移", i === 0));
      actions.appendChild(btn("down", "↓", "下移", i === scenes.length - 1));
      actions.appendChild(btn("merge", "⤵ 併入下一句", "把下一個場景的文字併進這個場景", i === scenes.length - 1));
      actions.appendChild(btn("del", "✕ 刪除"));

      // 素材與運鏡(摺疊收納,保持列表清爽)
      const adv = document.createElement("details");
      adv.className = "scene-adv";
      adv.open = !!scene.advOpen;
      adv.addEventListener("toggle", () => { scene.advOpen = adv.open; });
      const sum = document.createElement("summary");
      sum.textContent = `🎬 素材與運鏡(${scene.media.length ? `圖片×${scene.media.length}` : "文字卡"}・${MOTIONS[scene.motion] || MOTIONS.zoom})`;
      adv.appendChild(sum);

      const mediaRow = document.createElement("div");
      mediaRow.className = "media-row";
      scene.media.forEach((item, mi) => {
        const cell = document.createElement("div");
        cell.className = "media-cell";
        const mimg = document.createElement("img");
        mimg.className = "media-thumb";
        mimg.src = item.thumb;
        if (item.kind === "video") {
          mimg.alt = `素材 ${mi + 1}(影片)`;
          mimg.title = "影片素材:靜音、置中裁滿,不需裁剪;比語音短會循環播放";
          const vbadge = document.createElement("span");
          vbadge.className = "media-video-badge";
          vbadge.textContent = "🎞";
          cell.appendChild(vbadge);
        } else {
          mimg.alt = `素材 ${mi + 1}(點擊裁剪)`;
          mimg.title = "點擊裁剪這張圖";
          mimg.addEventListener("click", () => openCropModal(item));
        }
        const ctrl = document.createElement("div");
        ctrl.className = "media-ctrl";
        const mbtn = (mact, label, title, disabled) => {
          const b = document.createElement("button");
          b.type = "button";
          b.className = "btn btn-small";
          b.dataset.mact = mact;
          b.dataset.mid = item.id;
          b.textContent = label;
          b.title = title;
          b.disabled = !!disabled;
          return b;
        };
        ctrl.appendChild(mbtn("mleft", "◀", "往前移", mi === 0));
        ctrl.appendChild(mbtn("mright", "▶", "往後移", mi === scene.media.length - 1));
        ctrl.appendChild(mbtn("mdel", "✕", "刪除這張圖"));
        if (item.kind === "image") {
          ctrl.appendChild(mbtn("mrmbg", "✂ 去背", "AI 移除圖片背景(純瀏覽器,首次使用需下載模型)"));
        }
        cell.appendChild(mimg);
        cell.appendChild(ctrl);
        mediaRow.appendChild(cell);
      });
      if (scene.media.length < MAX_MEDIA) {
        const addBtn = btn("addimg", "＋ 加素材", `圖片或影片片段(mp4/webm ≤50MB),一個場景最多 ${MAX_MEDIA} 個`);
        addBtn.classList.add("media-add");
        mediaRow.appendChild(addBtn);
      }
      adv.appendChild(mediaRow);
      const advHint = document.createElement("p");
      advHint.className = "list-hint";
      advHint.textContent = "多個素材時,語音時間平均分配、依序硬切(分鏡感);圖片點縮圖可個別裁剪," +
        "影片素材靜音置中裁滿、比語音短會循環、不套運鏡。";
      adv.appendChild(advHint);

      const motionRow = document.createElement("div");
      motionRow.className = "field-row";
      const mLabel = document.createElement("label");
      mLabel.textContent = "運鏡";
      const mSel = document.createElement("select");
      mSel.className = "scene-motion";
      Object.entries(MOTIONS).forEach(([val, name]) => {
        const opt = document.createElement("option");
        opt.value = val;
        opt.textContent = val === "zoom" ? `${name}(預設)` : name;
        mSel.appendChild(opt);
      });
      mSel.value = MOTIONS[scene.motion] ? scene.motion : "zoom";
      const depthStatus = document.createElement("span");
      depthStatus.className = "depth-status";
      const sceneDepthReady = () =>
        scene.media.filter((m) => m.kind === "image").every((m) => m.depth);
      if (scene.motion === "parallax" && scene.media.some((m) => m.kind === "image")) {
        depthStatus.textContent = sceneDepthReady() ? "✅ 深度已分析" : "⏳ 播放前會先做 AI 深度分析";
      }
      mSel.addEventListener("change", async () => {
        scene.motion = mSel.value;
        sum.textContent = `🎬 素材與運鏡(${scene.media.length ? `圖片×${scene.media.length}` : "文字卡"}・${MOTIONS[scene.motion]})`;
        scheduleProjectSave();
        depthStatus.textContent = "";
        // 選 3D 視差就先把這個場景的深度算起來(首次會下載模型)
        if (scene.motion === "parallax") {
          const targets = scene.media.filter((m) => m.kind === "image" && !m.depth);
          if (!targets.length) {
            if (scene.media.some((m) => m.kind === "image")) depthStatus.textContent = "✅ 深度已分析";
            return;
          }
          try {
            for (let k = 0; k < targets.length; k++) {
              depthStatus.textContent = `⏳ AI 深度分析中… ${k + 1}/${targets.length}`;
              await computeItemDepth(targets[k], (msg) => { depthStatus.textContent = `⏳ ${msg}`; });
            }
            depthStatus.textContent = "✅ 深度已分析";
          } catch (e) {
            depthStatus.textContent = "⚠️ 深度分析失敗(需要網路),會改用緩慢放大";
          }
        }
      });
      motionRow.appendChild(mLabel);
      motionRow.appendChild(mSel);
      motionRow.appendChild(depthStatus);
      adv.appendChild(motionRow);

      // 場景音效:場景開始播放、結束停止,與語音/BGM 混音
      const sfxRow = document.createElement("div");
      sfxRow.className = "sfx-row";
      if (scene.sfx) {
        const name = document.createElement("span");
        name.className = "sfx-name";
        name.textContent = `🔊 ${scene.sfx.name}`;
        name.title = scene.sfx.name;
        const vol = document.createElement("input");
        vol.type = "range";
        vol.min = 0;
        vol.max = 100;
        vol.step = 1;
        vol.value = Math.round(scene.sfx.volume * 100);
        vol.className = "sfx-vol";
        vol.title = "音效音量";
        const volVal = document.createElement("span");
        volVal.className = "range-val";
        volVal.textContent = `${Math.round(scene.sfx.volume * 100)}%`;
        vol.addEventListener("input", () => {
          scene.sfx.volume = Number(vol.value) / 100;
          volVal.textContent = `${vol.value}%`;
          scheduleProjectSave();
        });
        sfxRow.appendChild(name);
        sfxRow.appendChild(vol);
        sfxRow.appendChild(volVal);
        sfxRow.appendChild(btn("sfxtest", "▶ 試聽"));
        sfxRow.appendChild(btn("sfxdel", "✕"));
      } else {
        sfxRow.appendChild(btn("addsfx", "🔊 上傳音效", "mp3 / wav / ogg,上限 5MB"));
        const sfxHint = document.createElement("span");
        sfxHint.className = "scene-kind";
        sfxHint.textContent = "場景開始播放、結束自動停止";
        sfxRow.appendChild(sfxHint);
      }
      adv.appendChild(sfxRow);

      // 旁白錄音:有錄音就優先用錄音,沒有才用合成語音
      const voiceRow = document.createElement("div");
      voiceRow.className = "sfx-row";
      if (scene.voice) {
        const vi = document.createElement("span");
        vi.className = "sfx-name";
        vi.textContent = `🎙 已錄旁白(${scene.voice.duration.toFixed(1)} 秒)`;
        vi.title = "生成時會用這段錄音,不用合成語音";
        voiceRow.appendChild(vi);
        voiceRow.appendChild(btn("vtest", "▶ 試聽"));
        voiceRow.appendChild(btn("vrec", "🎙 重錄"));
        voiceRow.appendChild(btn("vdel", "✕"));
      } else {
        voiceRow.appendChild(btn("vrec", "🎙 錄這句", "用麥克風錄自己的聲音取代合成語音"));
        const vHint = document.createElement("span");
        vHint.className = "scene-kind";
        vHint.textContent = "沒錄音就用合成語音";
        voiceRow.appendChild(vHint);
      }
      adv.appendChild(voiceRow);

      body.appendChild(head);
      body.appendChild(ta);
      body.appendChild(adv);
      body.appendChild(actions);
      li.appendChild(thumb);
      li.appendChild(body);
      sceneListEl.appendChild(li);
    });
    scheduleProjectSave(); // 任何結構變動後自動存檔
  }

  let pendingImgSceneId = null;

  sceneListEl.addEventListener("click", (ev) => {
    const li = ev.target.closest("li[data-id]");
    if (!li) return;
    // 素材(多圖)操作
    const mb = ev.target.closest("button[data-mact]");
    if (mb) {
      const scene = scenes.find((s) => s.id === Number(li.dataset.id));
      if (!scene) return;
      const mi = scene.media.findIndex((m) => m.id === Number(mb.dataset.mid));
      if (mi < 0) return;
      const mact = mb.dataset.mact;
      if (mact === "mleft" && mi > 0) {
        [scene.media[mi - 1], scene.media[mi]] = [scene.media[mi], scene.media[mi - 1]];
      } else if (mact === "mright" && mi < scene.media.length - 1) {
        [scene.media[mi + 1], scene.media[mi]] = [scene.media[mi], scene.media[mi + 1]];
      } else if (mact === "mdel") {
        releaseMediaItem(scene.media[mi]);
        scene.media.splice(mi, 1);
      } else if (mact === "mrmbg") {
        mb.disabled = true;
        removeBackground(scene.media[mi], (msg) => { if (!mb.isConnected) return; mb.textContent = msg; })
          .then(() => renderScenes())
          .catch((e) => {
            if (mb.isConnected) { mb.disabled = false; mb.textContent = "✂ 去背"; }
            alert("去背失敗:" + e.message);
          });
        return; // async 完成後才 renderScenes,此處不重繪
      }
      renderScenes();
      return;
    }
    const b = ev.target.closest("button[data-act]");
    if (!b) return;
    const idx = scenes.findIndex((s) => s.id === Number(li.dataset.id));
    if (idx < 0) return;
    const act = b.dataset.act;
    if (act === "addsfx") {
      pendingSfxSceneId = scenes[idx].id;
      $("scene-sfx-input").click();
      return;
    }
    if (act === "sfxtest") {
      playSfxPreview(scenes[idx]);
      return;
    }
    if (act === "sfxdel") {
      scenes[idx].sfx = null;
      renderScenes();
      return;
    }
    if (act === "vrec") {
      toggleMicRecording(scenes[idx], b);
      return;
    }
    if (act === "vtest") {
      playVoicePreview(scenes[idx]);
      return;
    }
    if (act === "vdel") {
      scenes[idx].voice = null;
      renderScenes();
      return;
    }
    if (act === "up" && idx > 0) {
      [scenes[idx - 1], scenes[idx]] = [scenes[idx], scenes[idx - 1]];
    } else if (act === "down" && idx < scenes.length - 1) {
      [scenes[idx + 1], scenes[idx]] = [scenes[idx], scenes[idx + 1]];
    } else if (act === "del") {
      scenes.splice(idx, 1);
    } else if (act === "merge" && idx < scenes.length - 1) {
      scenes[idx].text = `${scenes[idx].text}${scenes[idx + 1].text}`;
      scenes.splice(idx + 1, 1);
    } else if (act === "addimg") {
      pendingImgSceneId = scenes[idx].id;
      $("scene-img-input").click();
      return; // 選完檔案才重繪
    }
    renderScenes();
  });

  $("scene-img-input").addEventListener("change", async (ev) => {
    const file = ev.target.files[0];
    ev.target.value = "";
    const scene = scenes.find((s) => s.id === pendingImgSceneId);
    pendingImgSceneId = null;
    if (!file || !scene) return;
    showError("step2-error", "");
    try {
      if (scene.media.length >= MAX_MEDIA) throw new Error(`一個場景最多 ${MAX_MEDIA} 個素材`);
      const item = file.type.startsWith("video/")
        ? await loadVideoItem(file)
        : await loadMediaItem(file);
      scene.media.push(item);
      scene.advOpen = true; // 加完素材保持展開,方便繼續調整
      renderScenes();
    } catch (e) {
      showError("step2-error", `素材讀取失敗:${e.message || "不明錯誤"},請換一個檔案試試。`);
    }
  });

  // 場景音效上傳
  let pendingSfxSceneId = null;
  $("scene-sfx-input").addEventListener("change", async (ev) => {
    const file = ev.target.files[0];
    ev.target.value = "";
    const scene = scenes.find((s) => s.id === pendingSfxSceneId);
    pendingSfxSceneId = null;
    if (!file || !scene) return;
    showError("step2-error", "");
    try {
      scene.sfx = { name: file.name, buffer: await decodeAudioFile(file, SFX_MAX_BYTES, "音效"), volume: 0.6, blob: file };
      scene.advOpen = true;
      renderScenes();
    } catch (e) {
      showError("step2-error", `音效讀取失敗:${e.message || "不明錯誤"}`);
    }
  });

  // ===== 麥克風錄旁白 =====
  let micRec = null;      // 進行中的錄音 { sceneId, recorder, stream }
  let voicePreview = null;

  async function toggleMicRecording(scene, btnEl) {
    if (micRec) { // 正在錄音:按一下=停止(不論按到哪個場景的按鈕)
      micRec.recorder.stop();
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      alert("這個瀏覽器不支援麥克風錄音,請改用桌面版 Chrome。");
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      alert("無法使用麥克風:請在網址列旁允許麥克風權限後再試一次。");
      return;
    }
    let recorder;
    try {
      recorder = new MediaRecorder(stream);
    } catch (e) {
      stream.getTracks().forEach((t) => t.stop());
      alert("這個瀏覽器無法錄音,請改用桌面版 Chrome。");
      return;
    }
    const chunks = [];
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      micRec = null;
      const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
      try {
        if (!blob.size) throw new Error("沒有錄到聲音");
        const buffer = await getAudioCtx().decodeAudioData(await blob.arrayBuffer());
        if (buffer.duration < 0.3) throw new Error("錄音太短(不到 0.3 秒)");
        scene.voice = { blob, buffer, duration: buffer.duration };
      } catch (e) {
        alert(`錄音失敗:${(e && e.message) || "不明錯誤"},請再試一次。`);
      }
      renderScenes();
    };
    micRec = { sceneId: scene.id, recorder, stream };
    recorder.start();
    btnEl.textContent = "⏹ 停止錄音";
    btnEl.classList.add("rec-live");
  }

  function playVoicePreview(scene) {
    const ctxA = getAudioCtx();
    if (voicePreview) {
      try { voicePreview.stop(); } catch (e) { /* 已停 */ }
      voicePreview = null;
    }
    if (!scene.voice || !scene.voice.buffer) return;
    const src = ctxA.createBufferSource();
    src.buffer = scene.voice.buffer;
    src.connect(ctxA.destination);
    src.start();
    voicePreview = src;
  }

  // 音效試聽(共用 AudioContext,再按一次會蓋掉前一次)
  function playSfxPreview(scene) {
    const ctxA = getAudioCtx();
    if (sfxPreview) {
      try { sfxPreview.stop(); } catch (e) { /* 已停 */ }
      sfxPreview = null;
    }
    if (!scene.sfx || !scene.sfx.buffer) return;
    const src = ctxA.createBufferSource();
    src.buffer = scene.sfx.buffer;
    const g = ctxA.createGain();
    g.gain.value = scene.sfx.volume;
    src.connect(g);
    g.connect(ctxA.destination);
    src.start();
    sfxPreview = src;
  }

  function loadImg(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("瀏覽器無法解讀這個圖片檔"));
      img.src = url;
    });
  }

  let mediaUid = 0;
  async function loadMediaItem(file) {
    if (!file.type.startsWith("image/")) throw new Error("這不是圖片檔");
    const url = URL.createObjectURL(file);
    try {
      const img = await loadImg(url);
      let source = img;
      let w = img.naturalWidth;
      let h = img.naturalHeight;
      if (!w || !h) throw new Error("讀不到圖片尺寸");
      if (Math.max(w, h) > IMG_MAX_DIM) {
        // 過大的圖先縮小再使用,避免吃光記憶體
        const s = IMG_RESIZE_TO / Math.max(w, h);
        const c = document.createElement("canvas");
        c.width = Math.round(w * s);
        c.height = Math.round(h * s);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        source = c;
        w = c.width;
        h = c.height;
      }
      mediaUid += 1;
      const item = { id: mediaUid, kind: "image", image: source, thumb: null, crop: defaultCrop(w, h), blob: file };
      makeThumb(item);
      return item;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  // 影片素材:靜音、cover 置中裁滿、不套運鏡;短於語音會循環、長了會被切掉
  async function loadVideoItem(file) {
    if (file.size > VIDEO_MAX_BYTES) {
      throw new Error(`影片素材不能超過 ${Math.round(VIDEO_MAX_BYTES / 1024 / 1024)} MB`);
    }
    const url = URL.createObjectURL(file); // 素材存活期間都要播放,不 revoke
    const el = document.createElement("video");
    el.muted = true;
    el.playsInline = true;
    el.loop = true;      // 片段比語音短時自動循環補滿
    el.preload = "auto";
    try {
      await new Promise((res, rej) => {
        el.onloadeddata = res;
        el.onerror = () => rej(new Error("瀏覽器無法解碼這個影片(建議用 MP4/H.264 或 WebM)"));
        el.src = url;
      });
      const vw = el.videoWidth;
      const vh = el.videoHeight;
      if (!vw || !vh) throw new Error("讀不到影片畫面尺寸");
      const t = document.createElement("canvas");
      t.width = 72;
      t.height = 128;
      const tc = t.getContext("2d");
      const s = Math.max(t.width / vw, t.height / vh);
      tc.drawImage(el, (t.width - vw * s) / 2, (t.height - vh * s) / 2, vw * s, vh * s);
      mediaUid += 1;
      return { id: mediaUid, kind: "video", videoEl: el, videoUrl: url, thumb: t.toDataURL("image/jpeg", 0.75), blob: file };
    } catch (e) {
      URL.revokeObjectURL(url);
      throw e;
    }
  }

  function releaseMediaItem(item) {
    if (item.kind === "video") {
      item.videoEl.pause();
      item.videoEl.removeAttribute("src");
      URL.revokeObjectURL(item.videoUrl);
    }
  }

  $("add-scene-btn").addEventListener("click", () => {
    scenes.push(makeScene(""));
    renderScenes();
    sceneListEl.lastElementChild.querySelector(".scene-text").focus();
  });

  // 片頭 Hook / 片尾 CTA 模板(插入預填文字的文字卡場景,可再自行編輯)
  $("add-hook-btn").addEventListener("click", () => {
    scenes.unshift(makeScene("*3 秒*看完你就懂!"));
    renderScenes();
    const ta = sceneListEl.firstElementChild.querySelector(".scene-text");
    ta.focus();
    ta.select();
  });
  $("add-cta-btn").addEventListener("click", () => {
    scenes.push(makeScene("覺得實用的話,*追蹤我*看更多!"));
    renderScenes();
    const ta = sceneListEl.lastElementChild.querySelector(".scene-text");
    ta.focus();
    ta.select();
  });

  // ===== AI 腳本提示詞(選一種爆款結構,貼給 Claude 等 AI 生成分鏡腳本)=====
  // 每種範本:一句話說明 + 專屬的結構指示(hook 開頭與節奏)
  const SCRIPT_TEMPLATES = {
    list: {
      desc: "「N 個你不知道的…」條列式,節奏快、資訊密度高,最適合新手起步。",
      guide: [
        "結構:開場拋出「幾個」重點勾起好奇 → 逐點快速講(每點 1~2 句)→ 結尾行動呼籲",
        "第一句用數字+好處當 hook,例如「租屋族必看的 5 個省錢技巧,第 3 個超多人不知道」",
        "每一點開頭可標「第一」「第二」…,一點講完馬上進下一點,不拖泥帶水",
      ],
    },
    howto: {
      desc: "手把手教一件事,步驟清楚,觀眾學得到東西、會收藏。",
      guide: [
        "結構:開場點出痛點或成果 → 依步驟一步步教(每步 1~2 句)→ 結尾提醒重點+行動呼籲",
        "第一句用「只要三步驟就能…」或「原來這樣做就對了」當 hook",
        "步驟之間用「接著」「最後」銜接,講清楚可操作的動作",
      ],
    },
    story: {
      desc: "用第一人稱小故事帶出重點,有情緒起伏,最容易讓人看到最後。",
      guide: [
        "結構:開場丟出衝突或反差 → 經過(鋪陳轉折)→ 結果與體悟 → 行動呼籲",
        "第一句用「我曾經…直到…」或一個意外的結果當 hook,製造懸念",
        "中段保留一個「沒想到」的轉折,結尾給觀眾帶得走的啟發",
      ],
    },
    review: {
      desc: "開箱/評測某個產品或服務,講優缺點與適合誰,帶導購感。",
      guide: [
        "結構:開場講這東西是什麼+為何值得看 → 亮點(2~3 個)→ 缺點/注意事項 → 推薦給誰+行動呼籲",
        "第一句用「這個 X 到底值不值得買?」或一個驚人數據當 hook",
        "優點缺點都要講,結尾明確說「適合…的人」,增加可信度",
      ],
    },
    myth: {
      desc: "破解常見錯誤觀念,「原來一直做錯了」的反差最抓眼球。",
      guide: [
        "結構:開場點名一個大家都信的迷思 → 破解(講出真相與原因)→ 正確做法 → 行動呼籲",
        "第一句用「別再…了!」或「你以為的…其實是錯的」當 hook",
        "先打破舊觀念再給正確做法,結尾呼籲分享給還在做錯的人",
      ],
    },
    plain: {
      desc: "只做基本改寫:分句、加 hook 與行動呼籲,不套特定結構。",
      guide: [
        "結構:開場 hook → 主要內容 → 結尾行動呼籲",
        "第一句要能在 3 秒內抓住人",
      ],
    },
  };

  function currentTemplate() {
    const r = document.querySelector('input[name="tpl"]:checked');
    return (r && SCRIPT_TEMPLATES[r.value]) ? r.value : "plain";
  }

  function updateTplDesc() {
    $("tpl-desc").textContent = SCRIPT_TEMPLATES[currentTemplate()].desc;
  }

  function buildAiPrompt() {
    const tpl = SCRIPT_TEMPLATES[currentTemplate()];
    const topic = $("tpl-topic").value.trim();
    const pasted = scriptInput.value.trim();
    const source = topic || pasted || "(把你的主題或原始文案寫在這裡)";
    return `請幫我把下面的主題或文案,改寫成直式短影片(約 30~60 秒)的分鏡腳本。

${tpl.guide.map((g) => "- " + g).join("\n")}

共同規則:
- 每句一行;有角色的對話在行首標記「角色名:台詞」(冒號用全形),旁白句不用標
- 每句不超過 20 個字,口語化、有節奏
- 想強調的關鍵字用 *星號* 包住(每句最多一個)
- 只輸出腳本文字,不要任何其他說明

主題/文案:
${source}`;
  }

  document.querySelectorAll('input[name="tpl"]').forEach((r) => {
    r.addEventListener("change", updateTplDesc);
  });
  updateTplDesc();

  $("ai-prompt-btn").addEventListener("click", async () => {
    const text = buildAiPrompt();
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch (e) {
      // 剪貼簿 API 失敗時退回 textarea + execCommand
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { ok = document.execCommand("copy"); } catch (e2) { ok = false; }
      ta.remove();
    }
    const msg = $("ai-copy-msg");
    msg.textContent = ok
      ? "✅ 已複製!貼到 Claude 等 AI 聊天工具,生成的腳本直接貼回上面的框框。"
      : "⚠️ 複製失敗,請手動全選複製。";
    msg.hidden = false;
  });

  // ===== 裁剪彈窗 =====
  // 只儲存「裁剪座標」(相對原圖的 x,y,w,h),原圖保留在記憶體中,可隨時重調
  const cropModal = $("crop-modal");
  const cropStage = $("crop-stage");
  const cropCanvas = $("crop-canvas");
  const cropBoxEl = $("crop-box");
  const CROP_MIN_W = 48; // 顯示座標下的裁剪框最小寬度(px)
  let cropState = null;  // { scene, scale, dispW, dispH, box:{x,y,w,h}(顯示座標) }
  let cropDrag = null;   // 進行中的拖曳 { mode:"move"|角落, startX, startY, startBox }

  function openCropModal(item) {
    if (!item || !item.image) return;
    const { w, h } = imgSize(item.image);
    cropModal.hidden = false;
    // 原圖等比縮小到適合彈窗:寬度塞進內容區、高度不超過視窗 55%
    const areaW = Math.max(cropStage.parentElement.clientWidth, 200);
    const maxH = Math.max(240, window.innerHeight * 0.55);
    const scale = Math.min(areaW / w, maxH / h);
    const dispW = Math.max(1, Math.round(w * scale));
    const dispH = Math.max(1, Math.round(h * scale));
    cropCanvas.width = dispW;
    cropCanvas.height = dispH;
    cropCanvas.getContext("2d").drawImage(item.image, 0, 0, dispW, dispH);
    const crop = itemCrop(item); // 從上次的範圍繼續調
    cropState = {
      item, scale, dispW, dispH,
      box: { x: crop.x * scale, y: crop.y * scale, w: crop.w * scale, h: crop.h * scale },
    };
    clampCropBox();
    applyCropBox();
  }

  function closeCropModal() {
    cropModal.hidden = true;
    cropState = null;
    cropDrag = null;
  }

  function clampCropBox() {
    const b = cropState.box;
    b.w = clamp(b.w, Math.min(CROP_MIN_W, cropState.dispW), Math.min(cropState.dispW, cropState.dispH * CROP_RATIO));
    b.h = b.w / CROP_RATIO;
    b.x = clamp(b.x, 0, cropState.dispW - b.w);
    b.y = clamp(b.y, 0, cropState.dispH - b.h);
  }

  function applyCropBox() {
    const b = cropState.box;
    cropBoxEl.style.left = `${b.x}px`;
    cropBoxEl.style.top = `${b.y}px`;
    cropBoxEl.style.width = `${b.w}px`;
    cropBoxEl.style.height = `${b.h}px`;
  }

  cropBoxEl.addEventListener("pointerdown", (ev) => {
    if (!cropState) return;
    ev.preventDefault();
    cropDrag = {
      mode: (ev.target.dataset && ev.target.dataset.corner) || "move",
      startX: ev.clientX,
      startY: ev.clientY,
      startBox: { ...cropState.box },
    };
    cropBoxEl.setPointerCapture(ev.pointerId);
  });

  cropBoxEl.addEventListener("pointermove", (ev) => {
    if (!cropDrag || !cropState) return;
    const b = cropState.box;
    const s = cropDrag.startBox;
    if (cropDrag.mode === "move") {
      b.x = clamp(s.x + (ev.clientX - cropDrag.startX), 0, cropState.dispW - s.w);
      b.y = clamp(s.y + (ev.clientY - cropDrag.startY), 0, cropState.dispH - s.h);
    } else {
      resizeCropBox(cropDrag.mode, ev);
    }
    applyCropBox();
  });

  const endCropDrag = () => { cropDrag = null; };
  cropBoxEl.addEventListener("pointerup", endCropDrag);
  cropBoxEl.addEventListener("pointercancel", endCropDrag);

  // 以對角為錨點縮放,維持 9:16、不超出圖片範圍
  function resizeCropBox(corner, ev) {
    const s = cropDrag.startBox;
    const left = corner.includes("w");   // 往左延伸(錨點在右)
    const up = corner.includes("n");     // 往上延伸(錨點在下)
    const ax = left ? s.x + s.w : s.x;
    const ay = up ? s.y + s.h : s.y;
    const rect = cropStage.getBoundingClientRect();
    const px = ev.clientX - rect.left;
    const py = ev.clientY - rect.top;
    const dx = left ? ax - px : px - ax;
    const dy = up ? ay - py : py - ay;
    const availW = left ? ax : cropState.dispW - ax;
    const availH = up ? ay : cropState.dispH - ay;
    let w = Math.max(dx, dy * CROP_RATIO, CROP_MIN_W);
    w = Math.min(w, availW, availH * CROP_RATIO); // 邊界優先,必要時小於最小尺寸
    const h = w / CROP_RATIO;
    const b = cropState.box;
    b.w = w;
    b.h = h;
    b.x = left ? ax - w : ax;
    b.y = up ? ay - h : ay;
  }

  $("crop-ok").addEventListener("click", () => {
    if (!cropState) return;
    const { item, scale, box } = cropState;
    const { w, h } = imgSize(item.image);
    const crop = { x: box.x / scale, y: box.y / scale, w: box.w / scale, h: box.h / scale };
    // 換算回原圖座標後再收斂一次,避免縮放誤差超出圖片
    crop.w = Math.min(crop.w, w);
    crop.h = crop.w / CROP_RATIO;
    if (crop.h > h) {
      crop.h = h;
      crop.w = crop.h * CROP_RATIO;
    }
    crop.x = clamp(crop.x, 0, w - crop.w);
    crop.y = clamp(crop.y, 0, h - crop.h);
    item.crop = crop;
    makeThumb(item);
    closeCropModal();
    renderScenes();
  });

  $("crop-reset").addEventListener("click", () => {
    if (!cropState) return;
    const { w, h } = imgSize(cropState.item.image);
    const d = defaultCrop(w, h);
    const k = cropState.scale;
    cropState.box = { x: d.x * k, y: d.y * k, w: d.w * k, h: d.h * k };
    clampCropBox();
    applyCropBox();
  });

  $("crop-cancel").addEventListener("click", closeCropModal);
  $("crop-close").addEventListener("click", closeCropModal);
  cropModal.addEventListener("click", (ev) => {
    if (ev.target === cropModal) closeCropModal(); // 點遮罩=取消
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && cropState) closeCropModal();
  });

  // ===== 步驟 3:語音角色管理 =====
  // 依名稱對照表推測性別(對照表以外顯示「未知」)
  function voiceGender(v) {
    const n = (v.name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    if (FEMALE_VOICES.some((h) => n.includes(h))) return "女聲";
    if (MALE_VOICES.some((h) => n.includes(h))) return "男聲";
    return "未知";
  }

  function refreshVoices() {
    if (!ttsOk()) { renderCharacters(); return; }
    const all = speechSynthesis.getVoices();
    const rank = (v) => {
      const l = (v.lang || "").toLowerCase().replace("_", "-");
      if (l === "zh-tw") return 0;
      if (l.startsWith("zh-hant")) return 1;
      if (l === "zh-hk") return 2;
      if (l.startsWith("zh")) return 3;
      return 9;
    };
    voices = all.filter((v) => rank(v) < 9)
      .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
    const warnEl = $("voice-warning");
    warnEl.hidden = true;
    if (!voices.length && all.length) {
      voices = all.slice();
      warnEl.textContent = "⚠️ 找不到中文語音,以下列出系統所有語音;中文內容的發音可能不正確。";
      warnEl.hidden = false;
    }
    // 一個男聲都偵測不到時,提示用音調模擬
    $("male-voice-hint").hidden = !voices.length || voices.some((v) => voiceGender(v) === "男聲");
    renderCharacters();
  }

  function buildVoiceOptions(select, selectedURI) {
    select.textContent = "";
    if (!voices.length) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = (ttsOk() && speechSynthesis.getVoices().length) ? "(無可用語音)" : "(語音清單載入中…)";
      select.appendChild(opt);
      return;
    }
    voices.forEach((v) => {
      const opt = document.createElement("option");
      opt.value = v.voiceURI;
      opt.textContent = `${v.name}(${voiceGender(v)})`;
      select.appendChild(opt);
    });
    const found = voices.find((v) => v.voiceURI === selectedURI);
    select.value = (found || voices[0]).voiceURI;
  }

  function charVoice(char) {
    return voices.find((v) => v.voiceURI === char.voiceURI) || voices[0] || null;
  }

  function fieldRow(labelText) {
    const row = document.createElement("div");
    row.className = "field-row";
    const label = document.createElement("label");
    label.textContent = labelText;
    row.appendChild(label);
    return row;
  }

  function rangeInput(min, max, step, value) {
    const r = document.createElement("input");
    r.type = "range";
    r.min = min;
    r.max = max;
    r.step = step;
    r.value = value;
    return r;
  }

  function renderCharacters() {
    const listEl = $("char-list");
    if (!listEl) return;
    ensureNarrator();
    listEl.textContent = "";
    characters.forEach((char, idx) => {
      const li = document.createElement("li");
      li.className = "char-card";
      li.style.borderLeft = `4px solid ${char.color}`;

      // 名稱列:色點 + 名稱 + 試聽 + 刪除(旁白不可刪)
      const head = document.createElement("div");
      head.className = "char-head";
      const dot = document.createElement("span");
      dot.className = "char-dot";
      dot.style.background = char.color;
      const nameInput = document.createElement("input");
      nameInput.className = "char-name";
      nameInput.maxLength = 12;
      nameInput.value = char.name;
      nameInput.placeholder = "角色名稱";
      nameInput.addEventListener("input", () => {
        if (nameInput.value.trim()) char.name = nameInput.value.trim();
      });
      nameInput.addEventListener("change", () => {
        nameInput.value = char.name; // 空白時還原
        saveDraft();
        renderScenes(); // 場景卡片的角色選單同步新名稱
      });
      const testBtn = document.createElement("button");
      testBtn.type = "button";
      testBtn.className = "btn btn-small";
      testBtn.textContent = "🔊 試聽";
      testBtn.addEventListener("click", () => {
        if (!ttsOk()) {
          alert("這個瀏覽器不支援語音合成,無法試聽。");
          return;
        }
        speechSynthesis.cancel();
        speakText(TEST_SENTENCE, char);
      });
      head.appendChild(dot);
      head.appendChild(nameInput);
      head.appendChild(testBtn);
      if (idx === 0) {
        const tag = document.createElement("span");
        tag.className = "char-tag";
        tag.textContent = "預設";
        tag.title = "「旁白」是預設角色,不可刪除";
        head.appendChild(tag);
      } else {
        const delBtn = document.createElement("button");
        delBtn.type = "button";
        delBtn.className = "btn btn-small";
        delBtn.textContent = "✕ 刪除";
        delBtn.addEventListener("click", () => {
          // 指定給此角色的場景自動改回「旁白」
          scenes.forEach((s) => { if (s.charId === char.id) s.charId = characters[0].id; });
          characters = characters.filter((c) => c.id !== char.id);
          saveDraft();
          renderCharacters();
          renderScenes();
        });
        head.appendChild(delBtn);
      }

      // 語音(含性別標示)
      const voiceRow = fieldRow("語音");
      const sel = document.createElement("select");
      sel.className = "char-voice";
      buildVoiceOptions(sel, char.voiceURI);
      if (voices.length) char.voiceURI = sel.value; // 草稿中的語音不存在時落到第一個
      sel.addEventListener("change", () => { char.voiceURI = sel.value; saveDraft(); });
      voiceRow.appendChild(sel);

      // 語速 0.7x–1.4x
      const rateRow = fieldRow("語速");
      const rate = rangeInput(0.7, 1.4, 0.05, char.rate);
      rate.className = "char-rate";
      const rateVal = document.createElement("span");
      rateVal.className = "range-val";
      rateVal.textContent = `${char.rate}x`;
      rate.addEventListener("input", () => {
        char.rate = Number(rate.value);
        rateVal.textContent = `${char.rate}x`;
        saveDraft();
      });
      rateRow.appendChild(rate);
      rateRow.appendChild(rateVal);

      // 音調 0.6–1.6(調低可模擬低沉聲線)
      const pitchRow = fieldRow("音調");
      const pitch = rangeInput(0.6, 1.6, 0.05, char.pitch);
      pitch.className = "char-pitch";
      const pitchVal = document.createElement("span");
      pitchVal.className = "range-val";
      pitchVal.textContent = `${char.pitch}`;
      pitch.addEventListener("input", () => {
        char.pitch = Number(pitch.value);
        pitchVal.textContent = `${char.pitch}`;
        saveDraft();
      });
      pitchRow.appendChild(pitch);
      pitchRow.appendChild(pitchVal);

      // 代表色
      const colorRow = document.createElement("div");
      colorRow.className = "char-colors";
      const colorLabel = document.createElement("span");
      colorLabel.className = "option-label";
      colorLabel.textContent = "代表色";
      colorRow.appendChild(colorLabel);
      CHAR_COLORS.forEach((c) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "char-swatch" + (c === char.color ? " selected" : "");
        b.style.background = c;
        b.setAttribute("aria-label", "選擇代表色");
        b.addEventListener("click", () => {
          char.color = c;
          saveDraft();
          renderCharacters();
          renderScenes();
        });
        colorRow.appendChild(b);
      });

      li.appendChild(head);
      li.appendChild(voiceRow);
      li.appendChild(rateRow);
      li.appendChild(pitchRow);
      li.appendChild(colorRow);
      listEl.appendChild(li);
    });
  }

  $("add-char-btn").addEventListener("click", () => {
    showError("char-error", "");
    if (characters.length >= MAX_CHARS) {
      showError("char-error", `角色最多 ${MAX_CHARS} 個,請先刪除不用的角色。`);
      return;
    }
    characters.push(makeCharacter(`角色 ${characters.length + 1}`));
    saveDraft();
    renderCharacters();
    renderScenes();
  });

  // 每句語音長度估計(Ken Burns 進度與無聲模式的場景長度用)
  function estimateDur(text, rate) {
    const chars = text.replace(/\s+/g, "").length;
    return Math.max(1.2, (chars * 0.22) / (rate || 1));
  }

  // 用指定角色的語音/語速/音調唸一句
  function speakText(text, char) {
    return new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(text);
      const v = charVoice(char);
      u.lang = v ? v.lang : "zh-TW";
      try {
        if (v) u.voice = v;
      } catch (e) { /* 個別瀏覽器對 voice 指派較嚴格,失敗就用預設語音 */ }
      u.rate = char.rate;
      u.pitch = char.pitch;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(guard);
        resolve();
      };
      u.onend = finish;
      u.onerror = finish;
      // 保險絲:少數語音的 onend 不觸發時,依估計長度放行
      const guard = setTimeout(finish, estimateDur(text, char.rate) * 3000 + 4000);
      currentUtter = u;
      speechSynthesis.speak(u);
    });
  }

  // ===== 背景音樂(BGM)設定 =====
  $("bgm-btn").addEventListener("click", () => $("bgm-input").click());
  $("bgm-input").addEventListener("change", async (ev) => {
    const file = ev.target.files[0];
    ev.target.value = "";
    if (!file) return;
    showError("bgm-error", "");
    try {
      bgm.buffer = await decodeAudioFile(file, BGM_MAX_BYTES, "背景音樂");
      bgm.name = file.name;
      bgm.blob = file;
      $("bgm-name").textContent = file.name;
      $("bgm-remove").hidden = false;
      scheduleProjectSave();
    } catch (e) {
      showError("bgm-error", `背景音樂讀取失敗:${e.message || "不明錯誤"}`);
    }
  });
  $("bgm-remove").addEventListener("click", () => {
    bgm.buffer = null;
    bgm.name = "";
    bgm.blob = null;
    $("bgm-name").textContent = "未設定";
    $("bgm-remove").hidden = true;
    scheduleProjectSave();
  });
  $("bgm-volume").addEventListener("input", () => {
    bgm.volume = Number($("bgm-volume").value) / 100;
    $("bgm-volume-val").textContent = `${$("bgm-volume").value}%`;
    scheduleProjectSave();
  });

  // ===== 混音引擎(音效 + BGM;預覽出喇叭、錄製進 MediaStreamAudioDestinationNode)=====
  function setupAudio(dest) {
    const hasLayers = bgm.buffer ||
      scenes.some((s) => (s.sfx && s.sfx.buffer) || (s.voice && s.voice.buffer));
    if (!hasLayers) return null;
    const ctxA = getAudioCtx();
    const out = ctxA.createGain();
    out.connect(dest || ctxA.destination);
    const a = { ctx: ctxA, out, bgm: null };
    if (bgm.buffer) {
      const src = ctxA.createBufferSource();
      src.buffer = bgm.buffer;
      src.loop = true; // 循環播放直到影片結束
      const g = ctxA.createGain();
      g.gain.value = bgm.volume;
      src.connect(g);
      g.connect(out);
      src.start();
      a.bgm = { src, gain: g };
    }
    return a;
  }

  // 自動閃避:有語音時 BGM 降到 40%,語音結束後 0.5 秒內恢復
  function duckBgm(a, on) {
    if (!a || !a.bgm) return;
    const p = a.bgm.gain.gain;
    const now = a.ctx.currentTime;
    p.cancelScheduledValues(now);
    p.setValueAtTime(p.value, now);
    p.linearRampToValueAtTime(bgm.volume * (on ? DUCK_RATIO : 1), now + (on ? 0.15 : 0.5));
  }

  function startSfx(a, scene) {
    if (!a || !scene.sfx || !scene.sfx.buffer) return null;
    const src = a.ctx.createBufferSource();
    src.buffer = scene.sfx.buffer;
    const g = a.ctx.createGain();
    g.gain.value = scene.sfx.volume;
    src.connect(g);
    g.connect(a.out);
    src.start();
    return src;
  }

  function stopSfx(src) {
    if (!src) return;
    try { src.stop(); } catch (e) { /* 已自然結束 */ }
  }

  function stopAudioNow(a) {
    if (!a) return;
    if (a.bgm) {
      try { a.bgm.src.stop(); } catch (e) { /* 已停 */ }
    }
    try { a.out.disconnect(); } catch (e) { /* 已斷線 */ }
  }

  // 錄好的旁白經混音圖播放(預覽出喇叭、錄製進錄音軌)
  function playVoiceTrack(a, voice) {
    return new Promise((resolve) => {
      if (!a) { resolve(); return; }
      const src = a.ctx.createBufferSource();
      src.buffer = voice.buffer;
      src.connect(a.out);
      src.onended = () => {
        if (play) play.voiceSrc = null;
        resolve();
      };
      if (play) play.voiceSrc = src;
      src.start();
    });
  }

  // 正常結束:BGM 淡出 1 秒再收
  async function finishAudio(a) {
    if (!a) return;
    if (a.bgm) {
      const p = a.bgm.gain.gain;
      const now = a.ctx.currentTime;
      p.cancelScheduledValues(now);
      p.setValueAtTime(p.value, now);
      p.linearRampToValueAtTime(0, now + 1);
      await sleep(1050);
    }
    stopAudioNow(a);
  }

  // ===== 3D 視差運鏡(AI 深度估計 + WebGL 位移)=====
  let depthPipe = null;      // transformers.js 的 depth-estimation pipeline
  let depthLoading = null;   // 載入中的 promise(避免重複載入)
  let parallaxGL;            // WebGL 繪製器;null = 不支援,undefined = 未初始化

  let rmbgPipe = null;       // AI 去背 pipeline
  let rmbgLoading = null;

  let kokoroPipe = null;     // Kokoro TTS pipeline
  let kokoroLoading = null;

  async function getDepthPipeline(onStatus) {
    if (depthPipe) return depthPipe;
    if (!depthLoading) {
      depthLoading = (async () => {
        if (onStatus) onStatus("載入 AI 深度引擎…");
        const mod = await import(TRANSFORMERS_CDN);
        if (mod.env) mod.env.allowLocalModels = false;
        const pipe = await mod.pipeline("depth-estimation", DEPTH_MODEL, {
          progress_callback: (info) => {
            if (info && info.status === "progress" && info.total && onStatus) {
              onStatus(`首次使用需下載 AI 深度模型… ${Math.round((info.loaded / info.total) * 100)}%(之後由瀏覽器快取)`);
            }
          },
        });
        depthPipe = pipe;
        return pipe;
      })().catch((e) => {
        depthLoading = null; // 失敗後允許重試
        throw e;
      });
    }
    return depthLoading;
  }

  // 對單一圖片素材算深度圖(整張原圖,裁剪改變也不用重算);存成灰階 canvas 當紋理
  async function computeItemDepth(item, onStatus) {
    if (item.kind !== "image" || item.depth) return;
    const pipe = await getDepthPipeline(onStatus);
    const { w, h } = imgSize(item.image);
    const s = Math.min(1, 768 / Math.max(w, h)); // 縮小餵模型,省時省記憶體
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(w * s));
    c.height = Math.max(1, Math.round(h * s));
    c.getContext("2d").drawImage(item.image, 0, 0, c.width, c.height);
    const out = await pipe(c.toDataURL("image/jpeg", 0.9));
    const d = out && out.depth;
    if (!d || !d.data || !d.width || !d.height) throw new Error("深度估計結果無效");
    const dc = document.createElement("canvas");
    dc.width = d.width;
    dc.height = d.height;
    const dctx = dc.getContext("2d");
    const idata = dctx.createImageData(d.width, d.height);
    const ch = d.channels || 1;
    for (let i = 0; i < d.width * d.height; i++) {
      const v = d.data[i * ch];
      idata.data[i * 4] = v;
      idata.data[i * 4 + 1] = v;
      idata.data[i * 4 + 2] = v;
      idata.data[i * 4 + 3] = 255;
    }
    dctx.putImageData(idata, 0, 0);
    item.depth = dc;
  }

  // ===== AI 背景去除(RMBG-1.4 via transformers.js,純瀏覽器)=====

  async function getRmbgPipeline(onStatus) {
    if (rmbgPipe) return rmbgPipe;
    if (!rmbgLoading) {
      rmbgLoading = (async () => {
        if (onStatus) onStatus("載入 AI 去背引擎…");
        const mod = await import(TRANSFORMERS_CDN);
        if (mod.env) mod.env.allowLocalModels = false;
        const pipe = await mod.pipeline("image-segmentation", RMBG_MODEL, {
          progress_callback: (info) => {
            if (info && info.status === "progress" && info.total && onStatus) {
              onStatus(`首次使用需下載去背模型… ${Math.round((info.loaded / info.total) * 100)}%(之後由瀏覽器快取)`);
            }
          },
        });
        rmbgPipe = pipe;
        return pipe;
      })().catch((e) => { rmbgLoading = null; throw e; });
    }
    return rmbgLoading;
  }

  async function removeBackground(item, onStatus) {
    const { w, h } = imgSize(item.image);

    // 把原圖畫到 canvas 作為模型輸入
    const inputC = document.createElement("canvas");
    inputC.width = w; inputC.height = h;
    inputC.getContext("2d").drawImage(item.image, 0, 0);

    const pipe = await getRmbgPipeline(onStatus);
    if (onStatus) onStatus("AI 去背中…");
    const result = await pipe(inputC.toDataURL("image/jpeg", 0.92));
    const seg = Array.isArray(result) ? result[0] : result;
    if (!seg || !seg.mask) throw new Error("去背模型回傳結果無效");

    const mask = seg.mask;         // RawImage: { data, width, height, channels }
    const ch = mask.channels || 1;

    // 把 mask 轉成灰階 canvas,再雙線性縮放到原圖尺寸
    const mRaw = document.createElement("canvas");
    mRaw.width = mask.width; mRaw.height = mask.height;
    const mRawCtx = mRaw.getContext("2d");
    const mPixels = mRawCtx.createImageData(mask.width, mask.height);
    for (let i = 0; i < mask.width * mask.height; i++) {
      const v = mask.data[i * ch];
      mPixels.data[i * 4] = mPixels.data[i * 4 + 1] = mPixels.data[i * 4 + 2] = v;
      mPixels.data[i * 4 + 3] = 255;
    }
    mRawCtx.putImageData(mPixels, 0, 0);

    const mScaled = document.createElement("canvas");
    mScaled.width = w; mScaled.height = h;
    const msCtx = mScaled.getContext("2d");
    msCtx.imageSmoothingEnabled = true;
    msCtx.imageSmoothingQuality = "high";
    msCtx.drawImage(mRaw, 0, 0, w, h);
    const alphaPixels = msCtx.getImageData(0, 0, w, h).data;

    // 套用 mask 為原圖的 alpha 通道
    const out = document.createElement("canvas");
    out.width = w; out.height = h;
    const octx = out.getContext("2d");
    octx.drawImage(item.image, 0, 0);
    const imgPixels = octx.getImageData(0, 0, w, h);
    for (let i = 0; i < w * h; i++) {
      imgPixels.data[i * 4 + 3] = alphaPixels[i * 4]; // R channel = alpha
    }
    octx.putImageData(imgPixels, 0, 0);

    item.image = out;
    item.depth = null; // 原深度圖已失效,下次視差才重算
    makeThumb(item);
  }

  // ===== Kokoro TTS(中文 AI 語音,純瀏覽器 WASM)=====

  async function getKokoroPipeline(onStatus) {
    if (kokoroPipe) return kokoroPipe;
    if (!kokoroLoading) {
      kokoroLoading = (async () => {
        if (onStatus) onStatus("載入 Kokoro AI 語音引擎(首次需下載約 82MB,之後快取)…");
        const { KokoroTTS } = await import(KOKORO_CDN);
        const tts = await KokoroTTS.from_pretrained(KOKORO_MODEL, { dtype: "q8" });
        kokoroPipe = tts;
        return tts;
      })().catch((e) => { kokoroLoading = null; throw e; });
    }
    return kokoroLoading;
  }

  async function generateKokoroVoices(voice, onStatus) {
    const pipe = await getKokoroPipeline(onStatus);
    const list = usableScenes().filter((s) => plainText(s.text).trim());
    const actx = getAudioCtx();
    let done = 0;
    for (const scene of list) {
      const spoken = plainText(scene.text).trim();
      if (onStatus) onStatus(`AI 語音生成中… ${done + 1} / ${list.length}`);
      const output = await pipe.generate(spoken, { voice });
      // output.audio: Float32Array, output.sampling_rate: number
      const buffer = actx.createBuffer(1, output.audio.length, output.sampling_rate);
      buffer.getChannelData(0).set(new Float32Array(output.audio));
      scene.voice = { blob: null, buffer, duration: buffer.duration };
      done++;
    }
    return done;
  }

  // 開始播放/生成前,把用到 3D 視差的場景深度都準備好;個別失敗就跳過(播放時退回緩慢放大)
  async function ensureParallaxReady(list, onStatus) {
    const items = [];
    list.forEach((s) => {
      if (s.motion !== "parallax") return;
      s.media.forEach((m) => {
        if (m.kind === "image" && !m.depth) items.push(m);
      });
    });
    if (!items.length) return;
    try {
      for (let i = 0; i < items.length; i++) {
        if (onStatus) onStatus(`AI 深度分析中… ${i + 1} / ${items.length}`);
        await computeItemDepth(items[i], onStatus);
      }
    } catch (e) {
      if (onStatus) onStatus("AI 深度模型載入失敗(需要網路),3D 視差場景改用緩慢放大。");
      await sleep(1200);
    }
  }

  // WebGL 位移著色器:依深度圖讓前景多移、背景反向,產生 2.5D 立體感
  function getParallaxGL() {
    if (parallaxGL !== undefined) return parallaxGL;
    try {
      const canvas = document.createElement("canvas");
      canvas.width = W;
      canvas.height = H;
      const gl = canvas.getContext("webgl", { premultipliedAlpha: false, antialias: false });
      if (!gl) throw new Error("no webgl");
      const compile = (type, src) => {
        const sh = gl.createShader(type);
        gl.shaderSource(sh, src);
        gl.compileShader(sh);
        if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
          throw new Error(gl.getShaderInfoLog(sh) || "shader error");
        }
        return sh;
      };
      const vs = compile(gl.VERTEX_SHADER,
        "attribute vec2 aPos;varying vec2 vUv;void main(){vUv=aPos*0.5+0.5;gl_Position=vec4(aPos,0.,1.);}");
      const fs = compile(gl.FRAGMENT_SHADER, `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uImg;
uniform sampler2D uDepth;
uniform vec4 uCrop;   // 裁剪範圍(原圖 UV:x,y,w,h)
uniform vec2 uShift;  // 視差位移量(crop 比例)
uniform float uZoom;  // 基礎放大(蓋住位移後的邊緣)
void main(){
  vec2 uv = 0.5 + (vUv - 0.5) / uZoom;
  vec2 iuv = uCrop.xy + uv * uCrop.zw;
  float d = texture2D(uDepth, iuv).r;
  vec2 disp = uShift * (d - 0.5) * uCrop.zw;
  vec2 fuv = clamp(iuv + disp, uCrop.xy, uCrop.xy + uCrop.zw);
  gl_FragColor = vec4(texture2D(uImg, fuv).rgb, 1.0);
}`);
      const prog = gl.createProgram();
      gl.attachShader(prog, vs);
      gl.attachShader(prog, fs);
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error("link error");
      gl.useProgram(prog);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const aPos = gl.getAttribLocation(prog, "aPos");
      gl.enableVertexAttribArray(aPos);
      gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
      const makeTex = (unit) => {
        const t = gl.createTexture();
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        return t;
      };
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true); // canvas 紋理(上到下)→ GL(下到上)
      const texImg = makeTex(0);
      const texDepth = makeTex(1);
      gl.uniform1i(gl.getUniformLocation(prog, "uImg"), 0);
      gl.uniform1i(gl.getUniformLocation(prog, "uDepth"), 1);
      parallaxGL = {
        canvas, gl,
        texImg, texDepth,
        uCrop: gl.getUniformLocation(prog, "uCrop"),
        uShift: gl.getUniformLocation(prog, "uShift"),
        uZoom: gl.getUniformLocation(prog, "uZoom"),
        boundId: null,
      };
    } catch (e) {
      parallaxGL = null; // 不支援 WebGL,一律退回緩慢放大
    }
    return parallaxGL;
  }

  // 畫一格 3D 視差;失敗回傳 false 讓呼叫端退回一般運鏡
  function drawParallaxItem(item, p) {
    const glc = getParallaxGL();
    if (!glc || !item.depth) return false;
    const { gl } = glc;
    try {
      if (glc.boundId !== item.id) {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, glc.texImg);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, item.image);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, glc.texDepth);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, item.depth);
        glc.boundId = item.id;
      }
      const { w, h } = imgSize(item.image);
      const crop = itemCrop(item);
      // GL 紋理已上下翻轉,crop 的 y 也要換算
      gl.uniform4f(glc.uCrop, crop.x / w, 1 - (crop.y + crop.h) / h, crop.w / w, crop.h / h);
      const t = p * 2 - 1; // -1 → 1:鏡頭由左往右緩慢移動
      gl.uniform2f(glc.uShift, t * 0.05, t * -0.015);
      gl.uniform1f(glc.uZoom, 1.06 + 0.04 * p);
      gl.viewport(0, 0, W, H);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      ctx.drawImage(glc.canvas, 0, 0, W, H);
      return true;
    } catch (e) {
      return false;
    }
  }

  // ===== 畫面繪製 =====
  function roundRect(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  // 關鍵字標記:*文字* 之間用強調色顯示;星號本身不畫、不唸、不進 SRT
  function styledChars(text) {
    const chars = [];
    let hl = false;
    for (const ch of text) {
      if (ch === "*" || ch === "*") { hl = !hl; continue; }
      chars.push({ ch, hl });
    }
    return chars;
  }

  function plainText(text) {
    return text.replace(/[*＊]/g, "");
  }

  const lineStr = (line) => line.map((c) => c.ch).join("");

  // 逐字換行(帶樣式):同時看字數上限與實際像素寬(中英混排也不爆版)
  function wrapStyled(chars, maxWidth, maxChars) {
    const lines = [];
    let line = [];
    for (const c of chars) {
      const test = lineStr(line) + c.ch;
      if (line.length && (test.length > maxChars || ctx.measureText(test).width > maxWidth)) {
        lines.push(line);
        line = c.ch === " " ? [] : [c];
      } else {
        line.push(c);
      }
    }
    if (lineStr(line).trim()) lines.push(line);
    return lines;
  }

  // 強調色:主色已是亮黃時改用橘紅,其他主題用亮黃
  function highlightColor() {
    return settings.subColor === "#ffe14d" ? "#ff8a5c" : "#ffe14d";
  }

  // 主題色字+黑描邊(+可選半透明黑底);lines 是 wrapStyled 的結果
  function paintLines(lines, centerY, px, withBg) {
    if (!lines.length) return;
    ctx.font = `700 ${px}px ${FONT_STACK}`;
    ctx.textBaseline = "middle";
    const lineH = Math.round(px * 1.42);
    const blockH = lineH * lines.length;
    if (withBg) {
      const widest = Math.max(...lines.map((l) => ctx.measureText(lineStr(l)).width));
      roundRect(ctx, W / 2 - widest / 2 - 30, centerY - blockH / 2 - 22,
        widest + 60, blockH + 44, 18);
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.fill();
    }
    ctx.lineJoin = "round";
    ctx.lineWidth = Math.max(4, Math.round(px * 0.13));
    ctx.strokeStyle = "rgba(0,0,0,0.9)";
    ctx.textAlign = "left"; // 逐段上色需要自己置中排版
    lines.forEach((line, i) => {
      const y = centerY - blockH / 2 + lineH * (i + 0.5);
      let x = W / 2 - ctx.measureText(lineStr(line)).width / 2;
      // 相同顏色的連續字元併成一段畫,避免逐字繪製
      let run = "";
      let runHl = line.length ? line[0].hl : false;
      const flush = () => {
        if (!run) return;
        ctx.strokeText(run, x, y);
        ctx.fillStyle = runHl ? highlightColor() : settings.subColor;
        ctx.fillText(run, x, y);
        x += ctx.measureText(run).width;
        run = "";
      };
      for (const c of line) {
        if (c.hl !== runHl) {
          flush();
          runHl = c.hl;
        }
        run += c.ch;
      }
      flush();
    });
  }

  function drawSubtitle(text, elapsed) {
    const t = text.trim();
    if (!t) return;
    const px = SUB_SIZES[settings.subSize] || SUB_SIZES.medium;
    ctx.font = `700 ${px}px ${FONT_STACK}`;
    let chars = styledChars(t);

    // 打字機:依 elapsed 逐步顯示字元,0.8s 內全部揭完
    if (settings.subAnim === "type") {
      const ratio = Math.min(elapsed / 0.8, 1);
      chars = chars.slice(0, Math.max(1, Math.round(ratio * chars.length)));
    }

    const lines = wrapStyled(chars, W * 0.88, SUB_MAX_CHARS);
    const lineH = Math.round(px * 1.42);
    const blockH = lineH * lines.length;
    const centerY = settings.subPos === "middle" ? H / 2 : H * 0.87 - blockH / 2;

    // 上滑淡入:0.22s ease-out cubic
    if (settings.subAnim === "slide") {
      const a  = Math.min(elapsed / 0.22, 1);
      const ease = 1 - Math.pow(1 - a, 3);
      ctx.save();
      ctx.globalAlpha = ease;
      ctx.translate(0, (1 - ease) * 32);
      paintLines(lines, centerY, px, true);
      ctx.restore();
    } else {
      paintLines(lines, centerY, px, true);
    }
  }

  // 沒有圖片的場景:漸層背景+置中大字文字卡(字太多會自動縮小)
  function drawTextCard(scene) {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, `hsl(${scene.hue},55%,30%)`);
    g.addColorStop(1, `hsl(${scene.hue + 40},65%,13%)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    const t = scene.text.trim();
    if (!t) return;
    let px = 92;
    let lines;
    for (;;) {
      ctx.font = `700 ${px}px ${FONT_STACK}`;
      lines = wrapStyled(styledChars(t), W * 0.84, 12);
      if (px <= 52 || lines.length * px * 1.5 <= H * 0.55) break;
      px -= 8;
    }
    paintLines(lines, H * 0.45, px, false);
  }

  // 依運鏡計算取樣範圍(drawImage 九參數版的 sx,sy,sw,sh):
  // 一律以裁剪範圍為邊界計算,任何運鏡都不會露出圖片外的黑邊
  function motionSourceRect(item, motion, p) {
    const crop = itemCrop(item);
    let s;
    if (motion === "parallax") motion = "zoom"; // 深度沒 ready 時的退路
    switch (motion) {
      case "push": s = 1 + 0.25 * p; break; // 快速推進 1.0 → 1.25
      case "pan": s = 1.12; break;          // 橫移:固定放大以預留左右平移空間
      case "shake": s = 1.05; break;        // 震動:固定放大以預留抖動安全邊距
      case "none": s = 1; break;            // 固定
      default: s = 1 + KEN_BURNS * p;       // 緩慢放大 1.0 → 1.08(預設)
    }
    const sw = crop.w / s;
    const sh = crop.h / s;
    let sx = crop.x + (crop.w - sw) / 2;
    let sy = crop.y + (crop.h - sh) / 2;
    if (motion === "pan") sx = crop.x + (crop.w - sw) * p; // 由左緩慢移到右
    if (motion === "shake") {
      const amp = 6 * (sw / W); // 畫面 ±6px 換算回原圖座標,每一格隨機位移
      sx = clamp(sx + (Math.random() * 2 - 1) * amp, crop.x, crop.x + crop.w - sw);
      sy = clamp(sy + (Math.random() * 2 - 1) * amp, crop.y, crop.y + crop.h - sh);
    }
    return { sx, sy, sw, sh };
  }

  // 影片素材:cover 置中裁滿(不裁剪、不運鏡,本身會動)
  function drawVideoCover(el) {
    const vw = el.videoWidth;
    const vh = el.videoHeight;
    if (!vw || !vh || el.readyState < 2) return; // 還沒解碼好,維持黑畫面
    const s = Math.max(W / vw, H / vh);
    ctx.drawImage(el, (W - vw * s) / 2, (H - vh * s) / 2, vw * s, vh * s);
  }

  function drawScene(scene, progress, elapsed = Infinity) {
    const p = clamp(progress, 0, 1);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, H);
    if (scene.media.length) {
      // 一句多素材:語音時間平均分配、依序硬切,圖片各自跑運鏡
      const n = scene.media.length;
      const idx = Math.min(Math.floor(p * n), n - 1);
      const segP = clamp(p * n - idx, 0, 1);
      const item = scene.media[idx];
      // 圖片/影片濾鏡:僅套在媒體圖層,字幕不受影響
      const flt = FILTERS[settings.imageFilter];
      if (flt) ctx.filter = flt;
      if (item.kind === "video") {
        // 播放中才驅動影片:切到這個素材時從頭播,長了會被切、短了 loop 補滿
        if (play && play.running && play.activeVideo !== item) {
          if (play.activeVideo) play.activeVideo.videoEl.pause();
          try { item.videoEl.currentTime = 0; } catch (e) { /* 尚未可 seek */ }
          item.videoEl.play().catch(() => {});
          play.activeVideo = item;
        }
        drawVideoCover(item.videoEl);
      } else {
        if (play && play.activeVideo) {
          play.activeVideo.videoEl.pause();
          play.activeVideo = null;
        }
        // 3D 視差:深度圖與 WebGL 都就緒才走,否則退回一般運鏡(緩慢放大)
        const usedParallax = scene.motion === "parallax" && drawParallaxItem(item, segP);
        if (!usedParallax) {
          const r = motionSourceRect(item, scene.motion, segP);
          ctx.drawImage(item.image, r.sx, r.sy, r.sw, r.sh, 0, 0, W, H);
        }
      }
      if (flt) ctx.filter = "none"; // 重設,避免影響字幕
      drawSubtitle(scene.text, elapsed);
    } else {
      drawTextCard(scene);
    }
  }

  function usableScenes() {
    return scenes.filter((s) => s.text.trim() || s.media.length);
  }

  function drawIdle() {
    const list = usableScenes();
    if (list.length) {
      drawScene(list[0], 0);
      return;
    }
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, H);
    ctx.font = `700 56px ${FONT_STACK}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#9aa5b5";
    ctx.fillText("尚無場景內容", W / 2, H / 2);
  }

  // ===== 播放引擎(預覽與錄製共用)=====
  function drawCurrent() {
    if (!play || !play.scene) return;
    const elapsed = (performance.now() - play.sceneStart) / 1000;
    drawScene(play.scene, elapsed / play.estDur, elapsed);
    // 場景開頭轉場遮罩(第一個場景不套)
    if (settings.transition !== "none" && play.sceneIndex > 0) {
      const dur = settings.transition === "flash" ? 0.18 : 0.3;
      if (elapsed < dur) {
        const alpha = (1 - elapsed / dur).toFixed(3);
        ctx.fillStyle = settings.transition === "flash"
          ? `rgba(255,255,255,${alpha})`
          : `rgba(0,0,0,${alpha})`;
        ctx.fillRect(0, 0, W, H);
      }
    }
  }

  function beginPlay(mode, silent) {
    play = {
      running: true, mode, silent,
      scene: null, sceneStart: 0, estDur: 1, t0: 0, sceneIndex: 0,
      audio: null,        // setupAudio() 的混音狀態(音效/BGM)
      activeVideo: null,  // 正在播放的影片素材
    };
    const tick = () => {
      if (!play) return;
      drawCurrent();
      play.raf = requestAnimationFrame(tick);
    };
    play.raf = requestAnimationFrame(tick);
    // rAF 在分頁被遮住時會停,補一個 interval 當備援
    play.timer = setInterval(drawCurrent, 100);
    $("preview-btn").disabled = true;
    $("generate-btn").disabled = true;
    $("stop-btn").hidden = false;
  }

  function endPlay() {
    if (!play) return;
    cancelAnimationFrame(play.raf);
    clearInterval(play.timer);
    play = null;
    // 停掉所有影片素材,避免背景繼續播放
    scenes.forEach((s) => s.media.forEach((m) => {
      if (m.kind === "video") m.videoEl.pause();
    }));
    $("preview-btn").disabled = false;
    $("generate-btn").disabled = false;
    $("stop-btn").hidden = true;
    $("gen-progress").hidden = true;
    drawIdle();
  }

  function stopPlayback() {
    if (!play) return;
    play.running = false;
    if (ttsOk()) speechSynthesis.cancel(); // 讓進行中的 utterance 立刻 onend/onerror
    if (play.voiceSrc) {
      try { play.voiceSrc.stop(); } catch (e) { /* 已停 */ } // onended 會 resolve
    }
  }

  async function abortableSleep(ms) {
    const until = performance.now() + ms;
    while (play && play.running && performance.now() < until) {
      await sleep(Math.min(100, until - performance.now()));
    }
  }

  // 逐場景播放:回傳每句字幕的實際起訖秒數(相對 play.t0)
  async function runShow(list, onSceneStart) {
    const timings = [];
    for (let i = 0; i < list.length; i++) {
      if (!play || !play.running) break;
      const scene = list[i];
      const char = charById(scene.charId); // 每句用指定角色的語音/語速/音調
      const voice = (scene.voice && scene.voice.buffer) ? scene.voice : null;
      const spoken = plainText(scene.text).trim(); // 關鍵字星號不唸、不進 SRT
      play.scene = scene;
      play.sceneIndex = i; // 轉場用(第一個場景不套轉場)
      play.sceneStart = performance.now();
      // 有錄音時用實際長度,分鏡切換與運鏡進度都更準
      play.estDur = voice ? voice.duration : estimateDur(spoken || "  ", char ? char.rate : 1);
      onSceneStart(i, list.length);
      const start = (performance.now() - play.t0) / 1000;
      const sfxSrc = startSfx(play.audio, scene); // 場景開始播音效
      if (voice) {
        duckBgm(play.audio, true);
        await playVoiceTrack(play.audio, voice); // 錄音優先於合成語音
        duckBgm(play.audio, false);
      } else if (spoken && !play.silent && ttsOk() && char) {
        duckBgm(play.audio, true); // 有語音時 BGM 自動閃避
        await speakText(spoken, char);
        duckBgm(play.audio, false);
      } else {
        // 無聲模式(或沒有文字的純圖場景):用估計長度撐場
        await abortableSleep((spoken ? play.estDur : 2) * 1000);
      }
      const end = (performance.now() - play.t0) / 1000;
      if (spoken) timings.push({ text: spoken, start, end });
      await abortableSleep(settings.scenePad * 1000); // 句間停頓(可調)
      stopSfx(sfxSrc); // 場景結束就停,音效較長會被截斷
    }
    return timings;
  }

  function setStatus(msg) {
    $("play-status").textContent = msg;
  }

  // 生成前檢查:預估總長度、提醒沒素材/要用合成語音的場景
  function updatePrecheck() {
    const el = $("precheck");
    const list = usableScenes();
    if (!list.length) {
      el.textContent = "";
      return;
    }
    let total = 0.35; // 片頭空白
    for (const s of list) {
      const spoken = plainText(s.text).trim();
      const char = charById(s.charId);
      total += (s.voice && s.voice.buffer)
        ? s.voice.duration
        : (spoken ? estimateDur(spoken, char ? char.rate : 1) : 2);
      total += settings.scenePad;
    }
    if (bgm.buffer) total += 1; // 結尾 BGM 淡出
    const m = Math.floor(total / 60);
    const sec = Math.round(total % 60);
    const noMedia = list.filter((s) => !s.media.length).length;
    const useTts = list.filter((s) => plainText(s.text).trim() && !(s.voice && s.voice.buffer)).length;
    let msg = `📋 共 ${list.length} 個場景,預估長度約 ${m ? `${m} 分 ` : ""}${sec} 秒`;
    if (noMedia) msg += `;${noMedia} 個場景沒有素材(用文字卡呈現)`;
    msg += useTts ? `;${useTts} 句使用合成語音(需分享分頁音訊)` : ";全部使用錄音,生成免分享分頁";
    el.textContent = msg;
  }

  // ===== 預覽 =====
  // 初始化 Kokoro 語音選單
  const kokoroSel = $("kokoro-voice");
  if (kokoroSel) {
    KOKORO_VOICES.forEach(({ id, label }) => {
      const opt = document.createElement("option");
      opt.value = id; opt.textContent = label;
      kokoroSel.appendChild(opt);
    });
  }

  $("kokoro-btn").addEventListener("click", async () => {
    const btn = $("kokoro-btn");
    const statusEl = $("kokoro-status");
    const voice = ($("kokoro-voice") || {}).value || KOKORO_VOICES[0].id;
    btn.disabled = true;
    statusEl.hidden = false;
    try {
      const n = await generateKokoroVoices(voice, (msg) => { statusEl.textContent = msg; });
      statusEl.textContent = `✓ 已生成 ${n} 句 Kokoro AI 語音,生成影片時無需分享分頁音訊。`;
      renderScenes();
    } catch (e) {
      statusEl.textContent = "Kokoro 語音生成失敗:" + e.message;
    } finally {
      btn.disabled = false;
    }
  });

  $("preview-btn").addEventListener("click", async () => {
    const list = usableScenes();
    if (!list.length) {
      setStatus("沒有可播放的場景,請先在步驟 2 加入內容。");
      return;
    }
    await ensureParallaxReady(list, setStatus); // 3D 視差場景先把深度備好
    if (ttsOk()) speechSynthesis.cancel();
    beginPlay("preview", !ttsOk());
    const audio = setupAudio(null); // 預覽也能聽到音效+BGM 混音
    play.audio = audio;
    play.t0 = performance.now();
    await runShow(list, (i, n) => setStatus(`預覽中:第 ${i + 1} / ${n} 個場景`));
    if (!play || !play.running) stopAudioNow(audio);
    else await finishAudio(audio); // BGM 淡出 1 秒
    setStatus("預覽結束。");
    endPlay();
  });

  $("stop-btn").addEventListener("click", stopPlayback);

  // ===== 生成影片 =====
  function pickMime() {
    const candidates = [
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm",
    ];
    return candidates.find((m) => MediaRecorder.isTypeSupported(m)) || "";
  }

  function fmtSize(bytes) {
    if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${Math.round(bytes / 1024)} KB`;
  }

  function srtTime(sec) {
    const t = Math.max(0, sec);
    const h = String(Math.floor(t / 3600)).padStart(2, "0");
    const m = String(Math.floor((t % 3600) / 60)).padStart(2, "0");
    const s = String(Math.floor(t % 60)).padStart(2, "0");
    const ms = String(Math.round((t % 1) * 1000)).padStart(3, "0");
    return `${h}:${m}:${s},${ms}`;
  }

  function buildSrt(timings) {
    return timings.map((t, i) =>
      `${i + 1}\n${srtTime(t.start)} --> ${srtTime(Math.max(t.end, t.start + 0.5))}\n${t.text}\n`
    ).join("\n");
  }

  function setProgress(i, n) {
    $("gen-progress").hidden = false;
    $("gen-progress-text").textContent = `正在錄製第 ${i + 1} / ${n} 個場景…請保持此分頁在最前面`;
    $("gen-progress-bar").style.width = `${Math.round((i / n) * 100)}%`;
  }

  // 取得分頁音訊軌;回傳 { audioTrack, displayStream, silent },中止回傳 null
  async function acquireTabAudio() {
    if (!ttsOk()) return { audioTrack: null, displayStream: null, silent: true };
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      if (!confirm("這個瀏覽器不支援擷取分頁音訊,只能輸出「無聲版本」(有畫面和字幕)。\n\n要繼續嗎?")) return null;
      return { audioTrack: null, displayStream: null, silent: true };
    }
    let displayStream;
    try {
      displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
        preferCurrentTab: true,        // Chrome:預選「目前分頁」
        selfBrowserSurface: "include",
        systemAudio: "include",
      });
    } catch (e) {
      if (!confirm("已取消畫面分享,無法錄到語音。\n\n按「確定」改輸出無聲版本,按「取消」中止後可重試。")) return null;
      return { audioTrack: null, displayStream: null, silent: true };
    }
    const audioTrack = displayStream.getAudioTracks()[0] || null;
    if (!audioTrack) {
      displayStream.getTracks().forEach((t) => t.stop());
      if (!confirm("沒有取得音訊——分享時要勾選左下角的「同時分享分頁音訊」。\n\n按「確定」改輸出無聲版本,按「取消」中止後可重試。")) return null;
      return { audioTrack: null, displayStream: null, silent: true };
    }
    return { audioTrack, displayStream, silent: false };
  }

  $("generate-btn").addEventListener("click", async () => {
    showError("gen-error", "");
    const list = usableScenes();
    if (!list.length) {
      showError("gen-error", "沒有可輸出的場景,請先在步驟 2 加入內容。");
      return;
    }
    if (!window.MediaRecorder || !stage.captureStream) {
      showError("gen-error", "這個瀏覽器不支援影片錄製,請改用桌面版 Chrome。");
      return;
    }

    await ensureParallaxReady(list, setStatus); // 3D 視差場景先把深度備好(在跳分享視窗前)

    // 只有「還有句子要用合成語音」時才需要分享分頁音訊;
    // 全部句子都錄好旁白的話,直接用錄音混音,免分享
    const needsTts = list.some((s) => s.text.trim() && !(s.voice && s.voice.buffer));
    let audio;
    if (needsTts) {
      const genBtn = $("generate-btn");
      genBtn.disabled = true;
      setStatus("等待你選擇要分享的畫面…(請選「Chrome 分頁」並勾選「同時分享分頁音訊」)");
      try {
        audio = await acquireTabAudio();
      } finally {
        genBtn.disabled = false;
      }
      if (!audio) { // 使用者中止
        setStatus("已中止,可再按一次「生成影片」重試。");
        return;
      }
      setStatus("");
    } else {
      audio = { audioTrack: null, displayStream: null, silent: true }; // silent 只代表不用 TTS
    }
    const { audioTrack, displayStream, silent } = audio;

    const canvasStream = stage.captureStream(30);
    const tracks = [...canvasStream.getVideoTracks()];
    // 有音效/BGM 時:分頁音訊(TTS)與 WebAudio 三層混進同一條音軌
    // (MediaRecorder 只錄第一條音軌,不能直接放兩條)
    const useMix = !!(bgm.buffer ||
      scenes.some((s) => (s.sfx && s.sfx.buffer)) ||
      list.some((s) => s.voice && s.voice.buffer));
    let recDest = null;
    if (useMix) {
      const ctxA = getAudioCtx();
      recDest = ctxA.createMediaStreamDestination();
      if (audioTrack) {
        ctxA.createMediaStreamSource(new MediaStream([audioTrack])).connect(recDest);
      }
      tracks.push(...recDest.stream.getAudioTracks());
    } else if (audioTrack) {
      tracks.push(audioTrack);
    }
    const stream = new MediaStream(tracks);

    let rec;
    try {
      rec = new MediaRecorder(stream, {
        mimeType: pickMime() || undefined,
        videoBitsPerSecond: 8_000_000,
      });
    } catch (e) {
      stream.getTracks().forEach((t) => t.stop());
      if (displayStream) displayStream.getTracks().forEach((t) => t.stop());
      showError("gen-error", "無法建立錄影器,請改用桌面版 Chrome 再試一次。");
      return;
    }

    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    const stopped = new Promise((res) => { rec.onstop = res; });

    if (ttsOk()) speechSynthesis.cancel();
    $("result-area").hidden = true;
    beginPlay("record", silent);
    const mixAudio = setupAudio(recDest); // 錄製時音效/BGM 只進錄音軌,不出喇叭(避免被分頁音訊重複收音)
    play.audio = mixAudio;
    rec.onerror = () => stopPlayback(); // 編碼失敗時中止,避免卡死
    try {
      // 不等 onstart:掛在 DOM 上的 canvas 要有新畫面提交,錄影事件才會動起來,
      // 等 onstart 而不畫畫面會互相等待。start() 之後狀態即為 recording。
      rec.start(1000);
    } catch (e) {
      endPlay();
      stream.getTracks().forEach((t) => t.stop());
      if (displayStream) displayStream.getTracks().forEach((t) => t.stop());
      showError("gen-error", "無法開始錄影,請改用桌面版 Chrome 再試一次。");
      return;
    }
    play.t0 = performance.now();
    // 片頭先畫第一格並留一小段空白,避免第一句被切頭
    play.scene = list[0];
    play.sceneStart = performance.now();
    play.estDur = estimateDur(list[0].text || "  ");
    await sleep(350);

    const timings = await runShow(list, setProgress);
    const cancelled = !play || !play.running;

    if (cancelled) stopAudioNow(mixAudio);
    else await finishAudio(mixAudio); // BGM 淡出 1 秒(會錄進影片結尾)
    await sleep(200); // 收尾,讓最後一格畫面確實錄進去
    if (rec.state !== "inactive") rec.stop();
    await stopped;
    stream.getTracks().forEach((t) => t.stop());
    if (displayStream) displayStream.getTracks().forEach((t) => t.stop());
    endPlay();

    if (cancelled) {
      setStatus("已取消生成。");
      return;
    }
    setStatus("");
    // 全部用錄音時不算無聲版本(影片有旁白)
    showResult(new Blob(chunks, { type: rec.mimeType || "video/webm" }), timings, silent && needsTts);
  });

  let lastResult = null; // { blob, timings } 供 MP4 轉檔與發佈準備包交接使用

  function showResult(blob, timings, silent) {
    lastUrls.forEach((u) => URL.revokeObjectURL(u));
    lastUrls = [];
    if (!blob.size) {
      showError("gen-error", "錄製結果是空的,請重試一次(錄製期間請保持分頁在最前面)。");
      return;
    }
    lastResult = { blob, timings };
    $("download-mp4").hidden = true; // 新結果要重新轉檔
    $("mp4-btn").disabled = false;
    showError("mp4-error", "");
    const videoUrl = URL.createObjectURL(blob);
    lastUrls.push(videoUrl);
    $("result-video").src = videoUrl;
    $("download-video").href = videoUrl;
    $("result-size").textContent = fmtSize(blob.size);
    $("silent-note").hidden = !silent;

    const srtLink = $("download-srt");
    if (timings.length) {
      // 加 BOM,部分播放器才能正確以 UTF-8 讀取
      const srtBlob = new Blob(["\uFEFF" + buildSrt(timings)], { type: "text/plain;charset=utf-8" });
      const srtUrl = URL.createObjectURL(srtBlob);
      lastUrls.push(srtUrl);
      srtLink.href = srtUrl;
      srtLink.hidden = false;
    } else {
      srtLink.hidden = true;
    }
    const area = $("result-area");
    area.hidden = false;
    area.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  // ===== MP4 轉檔(ffmpeg.wasm)=====
  let ffmpeg = null; // 實例可重複使用;失敗 terminate 後設 null 重新載入

  $("mp4-btn").addEventListener("click", async () => {
    if (!lastResult) return;
    if (!window.FFmpegLoader) {
      showError("mp4-error", "轉換引擎載入失敗,請重新整理頁面再試。");
      return;
    }
    const btn = $("mp4-btn");
    btn.disabled = true;
    showError("mp4-error", "");
    $("mp4-progress").hidden = false;
    const setP = (r, t) => {
      $("mp4-progress-bar").style.width = `${Math.round(clamp(r, 0, 1) * 100)}%`;
      if (t) $("mp4-progress-text").textContent = t;
    };
    // 用字幕最後一句的結束時間估總長,換算轉檔進度
    const t = lastResult.timings;
    const totalDur = t.length ? t[t.length - 1].end + 1.5 : 0;
    try {
      if (!ffmpeg || !ffmpeg.loaded) {
        ffmpeg = await window.FFmpegLoader.createLoadedFFmpeg((msg) => setP(0, msg));
      }
      const ff = ffmpeg;
      setP(0.02, "正在讀取影片…");
      await ff.writeFile("in.webm", new Uint8Array(await lastResult.blob.arrayBuffer()));
      const onProgress = ({ time }) => {
        const ratio = totalDur ? Math.min(1, time / 1e6 / totalDur) : 0;
        setP(0.05 + ratio * 0.9, `轉換中… ${Math.round(ratio * 100)}%(單執行緒轉檔較慢,請耐心等候)`);
      };
      ff.on("progress", onProgress);
      try {
        const ret = await ff.exec([
          "-i", "in.webm",
          "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
          "-c:a", "aac", "-b:a", "128k",
          "-movflags", "+faststart",
          "out.mp4",
        ]);
        if (ret !== 0) throw new Error("ffmpeg 轉換失敗(exit code " + ret + ")");
      } finally {
        ff.off("progress", onProgress);
      }
      setP(0.97, "正在產生 MP4…");
      const data = await ff.readFile("out.mp4");
      await ff.deleteFile("in.webm").catch(() => {});
      await ff.deleteFile("out.mp4").catch(() => {});
      const mp4Blob = new Blob([data.buffer], { type: "video/mp4" });
      const url = URL.createObjectURL(mp4Blob);
      lastUrls.push(url);
      const a = $("download-mp4");
      a.href = url;
      a.textContent = `⬇ 下載 MP4(${fmtSize(mp4Blob.size)})`;
      a.hidden = false;
      $("mp4-progress").hidden = true;
    } catch (err) {
      $("mp4-progress").hidden = true;
      showError("mp4-error",
        "轉換失敗:" + ((err && err.message) || err) +
        "\n可能是網路連不上 CDN 或記憶體不足;WebM 檔仍可直接下載使用。");
      try { ffmpeg && ffmpeg.terminate(); } catch (e) { /* 已失效 */ }
      ffmpeg = null;
    } finally {
      btn.disabled = false;
    }
  });

  // ===== 帶到發佈準備包(IndexedDB 交接,與合併/字幕工具同一機制)=====
  $("publish-btn").addEventListener("click", async () => {
    if (!lastResult) return;
    try {
      const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open("video-tools", 1);
        req.onupgradeneeded = () => req.result.createObjectStore("handoff");
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      await new Promise((resolve, reject) => {
        const tx = db.transaction("handoff", "readwrite");
        tx.objectStore("handoff").put({
          blob: lastResult.blob,
          name: "script-video.webm",
          segs: lastResult.timings,
          offset: 0,
          savedAt: Date.now(),
        }, "publish");
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      location.href = "publish.html?from=tool";
    } catch (e) {
      showError("mp4-error", `交接失敗:${(e && e.message) || e},請改用下載檔案的方式。`);
    }
  });

  // ===== 事件與初始化 =====
  document.querySelectorAll(".wizard-step").forEach((btn) => {
    btn.addEventListener("click", () => gotoStep(Number(btn.dataset.step)));
  });
  document.querySelectorAll("[data-goto]").forEach((btn) => {
    btn.addEventListener("click", () => gotoStep(Number(btn.dataset.goto)));
  });

  $("analyze-btn").addEventListener("click", analyze);
  scriptInput.addEventListener("input", saveDraft);

  document.querySelectorAll('input[name="sub-size"]').forEach((r) => {
    r.addEventListener("change", () => { settings.subSize = r.value; saveDraft(); });
  });
  document.querySelectorAll('input[name="sub-pos"]').forEach((r) => {
    r.addEventListener("change", () => { settings.subPos = r.value; saveDraft(); });
  });
  document.querySelectorAll('input[name="sub-color"]').forEach((r) => {
    r.addEventListener("change", () => { settings.subColor = r.value; saveDraft(); });
  });
  document.querySelectorAll('input[name="sub-anim"]').forEach((r) => {
    r.addEventListener("change", () => { settings.subAnim = r.value; saveDraft(); });
  });
  document.querySelectorAll('input[name="img-filter"]').forEach((r) => {
    r.addEventListener("change", () => { settings.imageFilter = r.value; drawIdle(); saveDraft(); });
  });
  document.querySelectorAll('input[name="transition"]').forEach((r) => {
    r.addEventListener("change", () => { settings.transition = r.value; saveDraft(); });
  });
  const padRange = $("pad-range");
  padRange.addEventListener("input", () => {
    settings.scenePad = Number(padRange.value);
    $("pad-value").textContent = `${settings.scenePad} 秒`;
    saveDraft();
  });

  restoreDraft();
  ensureNarrator(); // 首次使用自動建立預設角色「旁白」
  // 把還原的設定套回表單
  const sizeRadio = document.querySelector(`input[name="sub-size"][value="${settings.subSize}"]`);
  if (sizeRadio) sizeRadio.checked = true;
  const posRadio = document.querySelector(`input[name="sub-pos"][value="${settings.subPos}"]`);
  if (posRadio) posRadio.checked = true;
  const colorRadio = document.querySelector(`input[name="sub-color"][value="${settings.subColor}"]`);
  if (colorRadio) colorRadio.checked = true;
  const transRadio = document.querySelector(`input[name="transition"][value="${settings.transition}"]`);
  if (transRadio) transRadio.checked = true;
  const animRadio = document.querySelector(`input[name="sub-anim"][value="${settings.subAnim}"]`);
  if (animRadio) animRadio.checked = true;
  const filterRadio = document.querySelector(`input[name="img-filter"][value="${settings.imageFilter}"]`);
  if (filterRadio) filterRadio.checked = true;
  padRange.value = settings.scenePad;
  $("pad-value").textContent = `${settings.scenePad} 秒`;

  checkSupport();
  if (ttsOk()) {
    refreshVoices(); // 內含 renderCharacters()
    // 部分瀏覽器第一次 getVoices() 是空的,要等 voiceschanged
    speechSynthesis.addEventListener("voiceschanged", refreshVoices);
  } else {
    renderCharacters();
  }
  drawIdle();

  // 專案還原:找到上次自動存檔就詢問是否繼續編輯
  (async () => {
    try {
      const proj = await loadProjectRecord();
      if (!proj || !Array.isArray(proj.scenes) || !proj.scenes.length) return;
      const when = proj.savedAt ? new Date(proj.savedAt).toLocaleString("zh-TW") : "";
      if (!confirm(`找到上次自動儲存的專案(${proj.scenes.length} 個場景${when ? ",存於 " + when : ""})。\n\n按「確定」還原繼續編輯,按「取消」丟棄並重新開始。`)) {
        await deleteProjectRecord();
        return;
      }
      await restoreProject(proj);
      renderCharacters();
      renderScenes();
      const resultEl = $("split-result");
      resultEl.textContent = `✅ 已還原上次的專案(${scenes.length} 個場景)`;
      resultEl.hidden = false;
      gotoStep(2);
    } catch (e) { /* 還原失敗就維持全新開始 */ }
  })();
})();
