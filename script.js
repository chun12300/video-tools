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
  const DRAFT_KEY = "script-video-draft-v1";
  const FONT_STACK = '"Noto Sans TC","PingFang TC","Microsoft JhengHei",system-ui,sans-serif';
  const SUB_SIZES = { large: 76, medium: 60, small: 46 };

  // ===== 狀態 =====
  let scenes = [];        // { id, text, image, thumb, hue }
  let uid = 0;
  let voices = [];        // 下拉選單中的語音(中文優先)
  let maxStep = 1;        // 已到達過的最大步驟(導覽列解鎖用)
  let play = null;        // 播放/錄製狀態,null = 閒置
  let currentUtter = null; // 防止 utterance 被 GC 導致 onend 不觸發
  let lastUrls = [];      // 上一次結果的 object URL,重生成時釋放

  const settings = { voiceURI: "", rate: 1, subSize: "medium", subPos: "bottom" };

  const stage = $("stage");
  const ctx = stage.getContext("2d");
  const scriptInput = $("script-input");
  const sceneListEl = $("scene-list");
  const voiceSelect = $("voice-select");

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

  // ===== 草稿(只存文字與設定,圖片無法存進 localStorage)=====
  let draftTimer = null;
  function saveDraft() {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
      try {
        localStorage.setItem(DRAFT_KEY, JSON.stringify({ text: scriptInput.value, settings }));
      } catch (e) { /* 空間不足時放棄暫存即可 */ }
    }, 400);
  }
  function restoreDraft() {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (!raw) return;
      const d = JSON.parse(raw);
      if (typeof d.text === "string") scriptInput.value = d.text;
      if (d.settings) Object.assign(settings, d.settings);
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
  function splitScript(text) {
    const parts = [];
    let buf = "";
    const flush = () => {
      // 去掉句尾的「。」,保留 ! ? 的語氣
      const t = buf.trim().replace(/[。.]+$/, "");
      if (t) parts.push(t);
      buf = "";
    };
    for (const ch of text) {
      if (ch === "\n" || ch === "\r") { flush(); continue; }
      buf += ch;
      if ("。!?!?".includes(ch)) flush();
    }
    flush();
    return parts;
  }

  function makeScene(text) {
    uid += 1;
    return { id: uid, text, image: null, thumb: null, hue: (uid * 53) % 360 };
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
    const parts = splitScript(text);
    if (!parts.length) {
      showError("step1-error", "分不出任何句子,請確認文案內容。");
      return;
    }
    scenes = parts.map(makeScene);
    const resultEl = $("split-result");
    resultEl.textContent = `✅ 已分成 ${scenes.length} 個場景`;
    resultEl.hidden = false;
    renderScenes();
    gotoStep(2);
  }

  // ===== 步驟 2:場景列表 =====
  function renderScenes() {
    sceneListEl.textContent = "";
    scenes.forEach((scene, i) => {
      const li = document.createElement("li");
      li.className = "scene-card";
      li.dataset.id = scene.id;

      const thumb = document.createElement("div");
      thumb.className = "scene-thumb";
      if (scene.thumb) {
        const img = document.createElement("img");
        img.src = scene.thumb;
        img.alt = "場景圖片縮圖";
        thumb.appendChild(img);
      } else {
        thumb.textContent = "文字卡";
        thumb.style.background =
          `linear-gradient(160deg, hsl(${scene.hue},55%,32%), hsl(${scene.hue + 40},65%,14%))`;
      }

      const body = document.createElement("div");
      body.className = "scene-body";

      const head = document.createElement("div");
      head.className = "scene-head";
      head.innerHTML = `<span class="item-index">${i + 1}</span>` +
        `<span class="scene-kind">${scene.image ? "🖼 圖片背景" : "🎨 漸層文字卡"}</span>`;

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
      actions.appendChild(btn("img", scene.image ? "🖼 換圖片" : "🖼 上傳圖片"));
      if (scene.image) actions.appendChild(btn("rmimg", "移除圖片"));
      actions.appendChild(btn("merge", "⤵ 併入下一句", "把下一個場景的文字併進這個場景", i === scenes.length - 1));
      actions.appendChild(btn("del", "✕ 刪除"));

      body.appendChild(head);
      body.appendChild(ta);
      body.appendChild(actions);
      li.appendChild(thumb);
      li.appendChild(body);
      sceneListEl.appendChild(li);
    });
  }

  let pendingImgSceneId = null;

  sceneListEl.addEventListener("click", (ev) => {
    const b = ev.target.closest("button[data-act]");
    if (!b) return;
    const li = ev.target.closest("li[data-id]");
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
    } else if (act === "img") {
      pendingImgSceneId = scenes[idx].id;
      $("scene-img-input").click();
      return; // 選完檔案才重繪
    } else if (act === "rmimg") {
      scenes[idx].image = null;
      scenes[idx].thumb = null;
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
      await loadSceneImage(file, scene);
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

  async function loadSceneImage(file, scene) {
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
      scene.image = source;
      // 縮圖(直式 9:16,cover 裁切)
      const t = document.createElement("canvas");
      t.width = 72;
      t.height = 128;
      const tc = t.getContext("2d");
      const s = Math.max(t.width / w, t.height / h);
      tc.drawImage(source, (t.width - w * s) / 2, (t.height - h * s) / 2, w * s, h * s);
      scene.thumb = t.toDataURL("image/jpeg", 0.75);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  $("add-scene-btn").addEventListener("click", () => {
    scenes.push(makeScene(""));
    renderScenes();
    sceneListEl.lastElementChild.querySelector(".scene-text").focus();
  });

  // ===== 步驟 3:語音 =====
  function refreshVoices() {
    if (!ttsOk()) return;
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
    voiceSelect.textContent = "";
    if (!voices.length) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = all.length ? "(無可用語音)" : "(語音清單載入中…)";
      voiceSelect.appendChild(opt);
      return;
    }
    voices.forEach((v) => {
      const opt = document.createElement("option");
      opt.value = v.voiceURI;
      opt.textContent = `${v.name}(${v.lang})`;
      voiceSelect.appendChild(opt);
    });
    const saved = voices.find((v) => v.voiceURI === settings.voiceURI);
    voiceSelect.value = (saved || voices[0]).voiceURI;
    settings.voiceURI = voiceSelect.value;
  }

  function getSelectedVoice() {
    return voices.find((v) => v.voiceURI === settings.voiceURI) || voices[0] || null;
  }

  // 每句語音長度估計(Ken Burns 進度與無聲模式的場景長度用)
  function estimateDur(text) {
    const chars = text.replace(/\s+/g, "").length;
    return Math.max(1.2, (chars * 0.22) / settings.rate);
  }

  function speakText(text) {
    return new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(text);
      const v = getSelectedVoice();
      if (v) { u.voice = v; u.lang = v.lang; } else { u.lang = "zh-TW"; }
      u.rate = settings.rate;
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
      const guard = setTimeout(finish, estimateDur(text) * 3000 + 4000);
      currentUtter = u;
      speechSynthesis.speak(u);
    });
  }

  $("voice-test-btn").addEventListener("click", () => {
    if (!ttsOk()) {
      alert("這個瀏覽器不支援語音合成,無法試聽。");
      return;
    }
    speechSynthesis.cancel();
    const first = scenes.find((s) => s.text.trim());
    speakText(first ? first.text.trim() : "你好,這是語音試聽,現在的語速聽起來像這樣。");
  });

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

  // 圖片 cover 置中裁切,scale 疊加 Ken Burns 放大
  function drawCover(img, scale) {
    const iw = img.width || img.naturalWidth;
    const ih = img.height || img.naturalHeight;
    const s = Math.max(W / iw, H / ih) * scale;
    ctx.drawImage(img, (W - iw * s) / 2, (H - ih * s) / 2, iw * s, ih * s);
  }

  function drawScene(scene, progress) {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, H);
    if (scene.image) {
      drawCover(scene.image, 1 + KEN_BURNS * Math.min(Math.max(progress, 0), 1));
      drawSubtitle(scene.text);
    } else {
      drawTextCard(scene);
    }
  }

  function usableScenes() {
    return scenes.filter((s) => s.text.trim() || s.image);
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
      play.scene = scene;
      play.sceneStart = performance.now();
      play.estDur = estimateDur(scene.text || "  ");
      onSceneStart(i, list.length);
      const text = scene.text.trim();
      const start = (performance.now() - play.t0) / 1000;
      if (text && !play.silent && ttsOk()) {
        await speakText(text);
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

  voiceSelect.addEventListener("change", () => {
    settings.voiceURI = voiceSelect.value;
    saveDraft();
  });
  const rateRange = $("rate-range");
  const syncRate = () => {
    settings.rate = Number(rateRange.value);
    $("rate-value").textContent = `${settings.rate}x`;
    saveDraft();
  };
  rateRange.addEventListener("input", syncRate);

  document.querySelectorAll('input[name="sub-size"]').forEach((r) => {
    r.addEventListener("change", () => { settings.subSize = r.value; saveDraft(); });
  });
  document.querySelectorAll('input[name="sub-pos"]').forEach((r) => {
    r.addEventListener("change", () => { settings.subPos = r.value; saveDraft(); });
  });

  restoreDraft();
  // 把還原的設定套回表單
  rateRange.value = settings.rate;
  $("rate-value").textContent = `${settings.rate}x`;
  const sizeRadio = document.querySelector(`input[name="sub-size"][value="${settings.subSize}"]`);
  if (sizeRadio) sizeRadio.checked = true;
  const posRadio = document.querySelector(`input[name="sub-pos"][value="${settings.subPos}"]`);
  if (posRadio) posRadio.checked = true;

  checkSupport();
  if (ttsOk()) {
    refreshVoices();
    // 部分瀏覽器第一次 getVoices() 是空的,要等 voiceschanged
    speechSynthesis.addEventListener("voiceschanged", refreshVoices);
  }
  drawIdle();
})();
