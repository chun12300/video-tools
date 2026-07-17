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
  const SCENE_PAD_MS = 400;      // 每句語音結束後的緩衝
  const KEN_BURNS = 0.08;        // 場景內圖片緩慢放大幅度(1.0 → 1.08)
  const SUB_MAX_CHARS = 15;      // 字幕每行最多字數
  const IMG_MAX_DIM = 4000;      // 超過就先縮小,避免記憶體問題
  const IMG_RESIZE_TO = 2560;
  const CROP_RATIO = 9 / 16;     // 裁剪框固定比例(寬/高),與影片畫面一致
  const DRAFT_KEY = "script-video-draft-v1";
  const FONT_STACK = '"Noto Sans TC","PingFang TC","Microsoft JhengHei",system-ui,sans-serif';
  const SUB_SIZES = { large: 76, medium: 60, small: 46 };
  const MAX_CHARS = 6;           // 語音角色上限
  const MAX_MEDIA = 3;           // 每個場景的素材(圖片)上限
  const MOTIONS = {              // 場景運鏡選項
    zoom: "緩慢放大",
    push: "快速推進",
    pan: "左右橫移",
    shake: "震動",
    none: "固定",
  };
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

  const settings = { subSize: "medium", subPos: "bottom" };

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
    if (n === 4) drawIdle();
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
      media: [],          // 1~3 個素材 { id, image, thumb, crop },多張時語音時間平均分配硬切
      motion: "zoom",     // 運鏡(套用到該場景所有素材)
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
      });
      head.appendChild(charSel);

      const ta = document.createElement("textarea");
      ta.className = "scene-text";
      ta.rows = 2;
      ta.value = scene.text;
      ta.placeholder = "這個場景的文字(同時是字幕)";
      ta.addEventListener("input", () => { scene.text = ta.value; });

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
        mimg.alt = `素材 ${mi + 1}(點擊裁剪)`;
        mimg.title = "點擊裁剪這張圖";
        mimg.addEventListener("click", () => openCropModal(item));
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
        cell.appendChild(mimg);
        cell.appendChild(ctrl);
        mediaRow.appendChild(cell);
      });
      if (scene.media.length < MAX_MEDIA) {
        const addBtn = btn("addimg", "＋ 加圖片", `一個場景最多 ${MAX_MEDIA} 張圖`);
        addBtn.classList.add("media-add");
        mediaRow.appendChild(addBtn);
      }
      adv.appendChild(mediaRow);
      const advHint = document.createElement("p");
      advHint.className = "list-hint";
      advHint.textContent = "多張圖時,該句語音時間平均分給每張、依序硬切(分鏡感);點縮圖可個別裁剪。";
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
      mSel.addEventListener("change", () => {
        scene.motion = mSel.value;
        sum.textContent = `🎬 素材與運鏡(${scene.media.length ? `圖片×${scene.media.length}` : "文字卡"}・${MOTIONS[scene.motion]})`;
      });
      motionRow.appendChild(mLabel);
      motionRow.appendChild(mSel);
      adv.appendChild(motionRow);

      body.appendChild(head);
      body.appendChild(ta);
      body.appendChild(adv);
      body.appendChild(actions);
      li.appendChild(thumb);
      li.appendChild(body);
      sceneListEl.appendChild(li);
    });
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
        scene.media.splice(mi, 1);
      }
      renderScenes();
      return;
    }
    const b = ev.target.closest("button[data-act]");
    if (!b) return;
    const idx = scenes.findIndex((s) => s.id === Number(li.dataset.id));
    if (idx < 0) return;
    const act = b.dataset.act;
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
      if (scene.media.length >= MAX_MEDIA) throw new Error(`一個場景最多 ${MAX_MEDIA} 張圖`);
      scene.media.push(await loadMediaItem(file));
      scene.advOpen = true; // 加完圖保持展開,方便繼續調整
      renderScenes();
    } catch (e) {
      showError("step2-error", `圖片讀取失敗:${e.message || "不明錯誤"},請換一張圖片試試。`);
    }
  });

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
      const item = { id: mediaUid, image: source, thumb: null, crop: defaultCrop(w, h) };
      makeThumb(item);
      return item;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  $("add-scene-btn").addEventListener("click", () => {
    scenes.push(makeScene(""));
    renderScenes();
    sceneListEl.lastElementChild.querySelector(".scene-text").focus();
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

  // 逐字換行:同時看字數上限與實際像素寬(中英混排也不爆版)
  function wrapText(text, maxWidth, maxChars) {
    const lines = [];
    let line = "";
    for (const ch of text) {
      const test = line + ch;
      if (line && (test.length > maxChars || ctx.measureText(test).width > maxWidth)) {
        lines.push(line);
        line = ch === " " ? "" : ch;
      } else {
        line = test;
      }
    }
    if (line.trim()) lines.push(line);
    return lines;
  }

  // 白字+黑描邊(+可選半透明黑底),lines 需在同一 font 下先 wrap 好
  function paintLines(lines, centerY, px, withBg) {
    if (!lines.length) return;
    ctx.font = `700 ${px}px ${FONT_STACK}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const lineH = Math.round(px * 1.42);
    const blockH = lineH * lines.length;
    if (withBg) {
      const widest = Math.max(...lines.map((l) => ctx.measureText(l).width));
      roundRect(ctx, W / 2 - widest / 2 - 30, centerY - blockH / 2 - 22,
        widest + 60, blockH + 44, 18);
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.fill();
    }
    ctx.lineJoin = "round";
    ctx.lineWidth = Math.max(4, Math.round(px * 0.13));
    ctx.strokeStyle = "rgba(0,0,0,0.9)";
    ctx.fillStyle = "#fff";
    lines.forEach((l, i) => {
      const y = centerY - blockH / 2 + lineH * (i + 0.5);
      ctx.strokeText(l, W / 2, y);
      ctx.fillText(l, W / 2, y);
    });
  }

  function drawSubtitle(text) {
    const t = text.trim();
    if (!t) return;
    const px = SUB_SIZES[settings.subSize] || SUB_SIZES.medium;
    ctx.font = `700 ${px}px ${FONT_STACK}`;
    const lines = wrapText(t, W * 0.88, SUB_MAX_CHARS);
    const lineH = Math.round(px * 1.42);
    const blockH = lineH * lines.length;
    const centerY = settings.subPos === "middle" ? H / 2 : H * 0.87 - blockH / 2;
    paintLines(lines, centerY, px, true);
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
      lines = wrapText(t, W * 0.84, 12);
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

  function drawScene(scene, progress) {
    const p = clamp(progress, 0, 1);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, H);
    if (scene.media.length) {
      // 一句多圖:語音時間平均分給每張、依序硬切,每張各自跑運鏡
      const n = scene.media.length;
      const idx = Math.min(Math.floor(p * n), n - 1);
      const segP = clamp(p * n - idx, 0, 1);
      const item = scene.media[idx];
      const r = motionSourceRect(item, scene.motion, segP);
      ctx.drawImage(item.image, r.sx, r.sy, r.sw, r.sh, 0, 0, W, H);
      drawSubtitle(scene.text);
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
    const p = (performance.now() - play.sceneStart) / 1000 / play.estDur;
    drawScene(play.scene, p);
  }

  function beginPlay(mode, silent) {
    play = { running: true, mode, silent, scene: null, sceneStart: 0, estDur: 1, t0: 0 };
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
      play.scene = scene;
      play.sceneStart = performance.now();
      play.estDur = estimateDur(scene.text || "  ", char ? char.rate : 1);
      onSceneStart(i, list.length);
      const text = scene.text.trim();
      const start = (performance.now() - play.t0) / 1000;
      if (text && !play.silent && ttsOk() && char) {
        await speakText(text, char);
      } else {
        // 無聲模式(或沒有文字的純圖場景):用估計長度撐場
        await abortableSleep((text ? play.estDur : 2) * 1000);
      }
      const end = (performance.now() - play.t0) / 1000;
      if (text) timings.push({ text, start, end });
      await abortableSleep(SCENE_PAD_MS);
    }
    return timings;
  }

  function setStatus(msg) {
    $("play-status").textContent = msg;
  }

  // ===== 預覽 =====
  $("preview-btn").addEventListener("click", async () => {
    const list = usableScenes();
    if (!list.length) {
      setStatus("沒有可播放的場景,請先在步驟 2 加入內容。");
      return;
    }
    if (ttsOk()) speechSynthesis.cancel();
    beginPlay("preview", !ttsOk());
    play.t0 = performance.now();
    await runShow(list, (i, n) => setStatus(`預覽中:第 ${i + 1} / ${n} 個場景`));
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

    const genBtn = $("generate-btn");
    genBtn.disabled = true;
    setStatus("等待你選擇要分享的畫面…(請選「Chrome 分頁」並勾選「同時分享分頁音訊」)");
    let audio;
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
    const { audioTrack, displayStream, silent } = audio;

    const canvasStream = stage.captureStream(30);
    const tracks = [...canvasStream.getVideoTracks()];
    if (audioTrack) tracks.push(audioTrack);
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
    showResult(new Blob(chunks, { type: rec.mimeType || "video/webm" }), timings, silent);
  });

  function showResult(blob, timings, silent) {
    lastUrls.forEach((u) => URL.revokeObjectURL(u));
    lastUrls = [];
    if (!blob.size) {
      showError("gen-error", "錄製結果是空的,請重試一次(錄製期間請保持分頁在最前面)。");
      return;
    }
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

  restoreDraft();
  ensureNarrator(); // 首次使用自動建立預設角色「旁白」
  // 把還原的設定套回表單
  const sizeRadio = document.querySelector(`input[name="sub-size"][value="${settings.subSize}"]`);
  if (sizeRadio) sizeRadio.checked = true;
  const posRadio = document.querySelector(`input[name="sub-pos"][value="${settings.subPos}"]`);
  if (posRadio) posRadio.checked = true;

  checkSupport();
  if (ttsOk()) {
    refreshVoices(); // 內含 renderCharacters()
    // 部分瀏覽器第一次 getVoices() 是空的,要等 voiceschanged
    speechSynthesis.addEventListener("voiceschanged", refreshVoices);
  } else {
    renderCharacters();
  }
  drawIdle();
})();
