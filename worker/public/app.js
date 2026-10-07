"use strict";

// ---------- palette ----------
const PALETTE = [
  "#000000","#ffffff","#6b6b6b","#c8c8c8","#7a0d1e","#ed1c24","#ff7f27","#ffd400",
  "#0f7a3a","#22b14c","#b5e61d","#0a4fa3","#00a2e8","#99d9ea","#3f48cc","#7092be",
  "#5b2a86","#a349a4","#ffaec9","#ff5c8a","#7a4a21","#b97a57","#e8c07d","#8c6239",
  "#0e5a5a","#00b3a4","#7fdbca","#26324d","#46557a","#8b93b8","#f4e9d8","#5a1f3d",
  // premium (index 32-39)
  "#ff2e63","#08d9d6","#a3f7bf","#f9ed69","#f08a5d","#b83b5e","#6a2c70","#00b8a9"
];
const FREE_COLORS = 32;

// ---------- state ----------
const S = {
  config: null,
  session: localStorage.getItem("mosaic_session") || "",
  me: null,
  view: { x: 5000, y: 5000, scale: 0.05 }, // center coords (canvas px), screen px per canvas px
  overview: null,        // ImageBitmap 1000x1000
  tiles: new Map(),      // "tx,ty" -> ImageBitmap
  tilePending: new Set(),
  tileEpoch: 0,          // reject tile responses from before a remote canvas update
  overviewEpoch: 0,
  selected: null,        // {x,y}
  selectedColor: null,
  historyPixels: null,   // timeline overlay
  histTs: null,
  histogram: [],
};
const CANVAS_SIZE = 10000, TILE = 250, TPS = 40;

const board = document.getElementById("board");
const ctx = board.getContext("2d");
const $ = (id) => document.getElementById(id);

// ---------- helpers ----------
async function api(path, opts = {}) {
  const headers = opts.headers || {};
  if (S.session) headers["authorization"] = "Bearer " + S.session;
  if (opts.body) headers["content-type"] = "application/json";
  const res = await fetch(path, { ...opts, headers });
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("json")) return { status: res.status, data: await res.json() };
  return { status: res.status, data: await res.arrayBuffer() };
}
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function relTime(ts) {
  const d = (Date.now() - new Date(ts).getTime()) / 1000;
  if (d < 60) return "עכשיו";
  if (d < 3600) return "לפני " + Math.floor(d / 60) + " דק׳";
  if (d < 86400) return "לפני " + Math.floor(d / 3600) + " שע׳";
  return new Date(ts).toLocaleDateString("he-IL");
}
function fmtDateTime(ts) {
  return new Date(ts).toLocaleString("he-IL", { dateStyle: "medium", timeStyle: "short" });
}
function nextUtcMidnight() {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() + 1));
}

// ---------- rendering ----------
function resize() {
  const wrap = $("canvas-wrap");
  const dpr = window.devicePixelRatio || 1;
  board.width = wrap.clientWidth * dpr;
  board.height = wrap.clientHeight * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  draw();
}
function viewW() { return board.clientWidth; }
function viewH() { return board.clientHeight; }
function screenToCanvas(sx, sy) {
  return {
    x: S.view.x + (sx - viewW() / 2) / S.view.scale,
    y: S.view.y + (sy - viewH() / 2) / S.view.scale,
  };
}
function canvasToScreen(cx, cy) {
  return {
    x: (cx - S.view.x) * S.view.scale + viewW() / 2,
    y: (cy - S.view.y) * S.view.scale + viewH() / 2,
  };
}
function clampView() {
  S.view.scale = Math.min(60, Math.max(0.03, S.view.scale));
  S.view.x = Math.min(CANVAS_SIZE + 200, Math.max(-200, S.view.x));
  S.view.y = Math.min(CANVAS_SIZE + 200, Math.max(-200, S.view.y));
}

async function loadOverview() {
  const epoch = ++S.overviewEpoch;
  const { data } = await api("/api/overview", { cache: "no-store" });
  const bytes = new Uint8Array(data);
  const img = new ImageData(1000, 1000);
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    const o = i * 4;
    if (b === 0) { img.data[o + 3] = 0; continue; }
    const hex = PALETTE[b - 1] || "#ff00ff";
    img.data[o] = parseInt(hex.slice(1, 3), 16);
    img.data[o + 1] = parseInt(hex.slice(3, 5), 16);
    img.data[o + 2] = parseInt(hex.slice(5, 7), 16);
    img.data[o + 3] = 255;
  }
  const bitmap = await createImageBitmap(img);
  if (epoch !== S.overviewEpoch) { bitmap.close(); return; }
  if (S.overview) S.overview.close();
  S.overview = bitmap;
  draw();
}
async function loadTile(tx, ty) {
  const key = tx + "," + ty;
  if (S.tiles.has(key) || S.tilePending.has(key)) return;
  S.tilePending.add(key);
  const epoch = S.tileEpoch;
  try {
    const { data } = await api("/api/tile/" + tx + "/" + ty, { cache: "no-store" });
    const bytes = new Uint8Array(data);
    const img = new ImageData(TILE, TILE);
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      const o = i * 4;
      if (b === 0) { img.data[o + 3] = 0; continue; }
      const hex = PALETTE[b - 1] || "#ff00ff";
      img.data[o] = parseInt(hex.slice(1, 3), 16);
      img.data[o + 1] = parseInt(hex.slice(3, 5), 16);
      img.data[o + 2] = parseInt(hex.slice(5, 7), 16);
      img.data[o + 3] = 255;
    }
    const bitmap = await createImageBitmap(img);
    if (epoch === S.tileEpoch) { S.tiles.set(key, bitmap); draw(); }
    else bitmap.close();
  } catch (e) { /* retry next frame */ }
  if (epoch === S.tileEpoch) S.tilePending.delete(key);
}

function draw() {
  const w = viewW(), h = viewH();
  ctx.clearRect(0, 0, w, h);

  // world background border
  const tl = canvasToScreen(0, 0), br = canvasToScreen(CANVAS_SIZE, CANVAS_SIZE);
  ctx.fillStyle = "#10131f";
  ctx.fillRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);

  const useTiles = S.view.scale >= 2.5;
  if (useTiles) {
    const c0 = screenToCanvas(0, 0), c1 = screenToCanvas(w, h);
    const tx0 = Math.max(0, Math.floor(c0.x / TILE)), ty0 = Math.max(0, Math.floor(c0.y / TILE));
    const tx1 = Math.min(TPS - 1, Math.floor(c1.x / TILE)), ty1 = Math.min(TPS - 1, Math.floor(c1.y / TILE));
    ctx.imageSmoothingEnabled = false;
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const bmp = S.tiles.get(tx + "," + ty);
        if (bmp) {
          const p = canvasToScreen(tx * TILE, ty * TILE);
          const s = TILE * S.view.scale;
          ctx.drawImage(bmp, p.x, p.y, s, s);
        } else {
          loadTile(tx, ty);
        }
      }
    }
    // grid
    if (S.view.scale >= 8) {
      ctx.strokeStyle = "rgba(120,130,170,0.25)";
      ctx.lineWidth = 1;
      const gx0 = Math.max(0, Math.floor(c0.x)), gy0 = Math.max(0, Math.floor(c0.y));
      const gx1 = Math.min(CANVAS_SIZE, Math.ceil(c1.x)), gy1 = Math.min(CANVAS_SIZE, Math.ceil(c1.y));
      ctx.beginPath();
      for (let gx = gx0; gx <= gx1; gx++) {
        const sx = Math.round(canvasToScreen(gx, 0).x) + 0.5;
        ctx.moveTo(sx, Math.max(0, tl.y)); ctx.lineTo(sx, Math.min(h, br.y));
      }
      for (let gy = gy0; gy <= gy1; gy++) {
        const sy = Math.round(canvasToScreen(0, gy).y) + 0.5;
        ctx.moveTo(Math.max(0, tl.x), sy); ctx.lineTo(Math.min(w, br.x), sy);
      }
      ctx.stroke();
    }
  } else if (S.overview) {
    ctx.imageSmoothingEnabled = S.view.scale < 0.8;
    ctx.drawImage(S.overview, tl.x, tl.y, br.x - tl.x, br.y - tl.y);
  }

  // timeline overlay
  if (S.historyPixels) {
    ctx.imageSmoothingEnabled = false;
    const size = Math.max(1.5, S.view.scale);
    for (const p of S.historyPixels) {
      const s = canvasToScreen(p.x, p.y);
      if (s.x < -size || s.y < -size || s.x > w + size || s.y > h + size) continue;
      ctx.fillStyle = PALETTE[p.color] || "#ff00ff";
      ctx.fillRect(s.x - size / 2, s.y - size / 2, size, size);
    }
  }

  // selection marker
  if (S.selected) {
    const p = canvasToScreen(S.selected.x, S.selected.y);
    const s = Math.max(S.view.scale, 6);
    ctx.strokeStyle = "#ffcf40";
    ctx.lineWidth = 2;
    ctx.strokeRect(p.x, p.y, S.view.scale, S.view.scale);
    if (S.selectedColor != null) {
      ctx.fillStyle = PALETTE[S.selectedColor];
      ctx.globalAlpha = 0.7;
      ctx.fillRect(p.x, p.y, Math.max(S.view.scale, 1), Math.max(S.view.scale, 1));
      ctx.globalAlpha = 1;
    }
    $("coords-chip").classList.remove("hidden");
    $("coords-chip").textContent = "משבצת " + S.selected.x + ", " + S.selected.y;
  } else {
    $("coords-chip").classList.add("hidden");
  }

  // world border
  ctx.strokeStyle = "#2c3560";
  ctx.lineWidth = 2;
  ctx.strokeRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);

  board.classList.toggle("placing", S.view.scale >= 4);
}

// ---------- pan / zoom ----------
const pointers = new Map();
let lastPinch = 0;
board.addEventListener("pointerdown", (e) => {
  board.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
});
board.addEventListener("pointermove", (e) => {
  if (!pointers.has(e.pointerId)) return;
  const prev = pointers.get(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 1) {
    const rect = board.getBoundingClientRect();
    S.view.x -= (e.clientX - prev.x) / S.view.scale;
    S.view.y -= (e.clientY - prev.y) / S.view.scale;
    clampView(); draw();
  } else if (pointers.size === 2) {
    const pts = [...pointers.values()];
    const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    if (lastPinch > 0) {
      const rect = board.getBoundingClientRect();
      const cx = (pts[0].x + pts[1].x) / 2 - rect.left;
      const cy = (pts[0].y + pts[1].y) / 2 - rect.top;
      zoomAt(cx, cy, dist / lastPinch);
    }
    lastPinch = dist;
  }
});
function endPointer(e) {
  pointers.delete(e.pointerId);
  if (pointers.size < 2) lastPinch = 0;
}
board.addEventListener("pointerup", endPointer);
board.addEventListener("pointercancel", endPointer);
board.addEventListener("wheel", (e) => {
  e.preventDefault();
  const rect = board.getBoundingClientRect();
  zoomAt(e.clientX - rect.left, e.clientY - rect.top, e.deltaY < 0 ? 1.25 : 0.8);
}, { passive: false });
function zoomAt(sx, sy, factor) {
  const before = screenToCanvas(sx, sy);
  S.view.scale *= factor;
  clampView();
  const after = screenToCanvas(sx, sy);
  S.view.x += before.x - after.x;
  S.view.y += before.y - after.y;
  clampView(); draw();
}
$("zoom-in").onclick = () => zoomAt(viewW() / 2, viewH() / 2, 1.6);
$("zoom-out").onclick = () => zoomAt(viewW() / 2, viewH() / 2, 0.625);
$("zoom-world").onclick = () => { fitWorld(); draw(); };
function fitWorld() {
  S.view.scale = Math.min(viewW(), viewH()) / CANVAS_SIZE * 0.95;
  S.view.x = CANVAS_SIZE / 2; S.view.y = CANVAS_SIZE / 2;
  clampView();
}
function flyTo(x, y, scale = 14) {
  S.view.x = x + 0.5; S.view.y = y + 0.5; S.view.scale = scale;
  clampView(); draw();
}

// tap = select (only when zoomed in enough and barely moved)
let tapStart = null;
board.addEventListener("pointerdown", (e) => { tapStart = { x: e.clientX, y: e.clientY, t: Date.now() }; });
board.addEventListener("pointerup", async (e) => {
  if (!tapStart) return;
  const moved = Math.hypot(e.clientX - tapStart.x, e.clientY - tapStart.y);
  const dt = Date.now() - tapStart.t;
  tapStart = null;
  if (moved > 8 || dt > 500) return;
  const rect = board.getBoundingClientRect();
  const c = screenToCanvas(e.clientX - rect.left, e.clientY - rect.top);
  if (c.x < 0 || c.y < 0 || c.x >= CANVAS_SIZE || c.y >= CANVAS_SIZE) { S.selected = null; draw(); return; }
  const px = Math.floor(c.x), py = Math.floor(c.y);
  if (S.view.scale < 4) { flyTo(px, py, 14); return; }
  S.selected = { x: px, y: py };
  draw();
  updatePlaceState();
  const { data } = await api("/api/at/" + px + "/" + py);
  if (data.pixel) showPixelInfo(data.pixel);
});

// ---------- auth ----------
function setupGoogle() {
  if (!S.config || !S.config.googleClientId) {
    $("google-btn").innerHTML = '<span class="muted">התחברות תופעל בקרוב</span>';
    return;
  }
  if (typeof google === "undefined" || !google.accounts) { setTimeout(setupGoogle, 500); return; }
  google.accounts.id.initialize({
    client_id: S.config.googleClientId,
    callback: onGoogleCredential,
  });
  google.accounts.id.renderButton($("google-btn"), { theme: "filled_black", size: "medium", text: "signin_with", locale: "he" });
}
async function onGoogleCredential(resp) {
  const { status, data } = await api("/api/auth/verify", { method: "POST", body: JSON.stringify({ credential: resp.credential }) });
  if (status === 200 && data.token) {
    S.session = data.token;
    localStorage.setItem("mosaic_session", S.session);
    await loadMe();
  } else {
    $("daily-status").textContent = "שגיאת התחברות: " + (data.error || status);
  }
}
async function loadMe() {
  const { data } = await api("/api/me");
  S.me = data.user;
  renderAuth();
  updatePlaceState();
}
$("logout-btn").onclick = () => {
  S.session = ""; localStorage.removeItem("mosaic_session");
  S.me = null; renderAuth(); updatePlaceState();
};
function renderAuth() {
  if (S.me) {
    $("google-btn").classList.add("hidden");
    $("me-chip").classList.remove("hidden");
    $("me-pic").src = S.me.picture || "";
    $("me-name").textContent = S.me.name || "משתמש";
    $("me-name").style.cursor = "pointer";
    $("me-name").onclick = () => showProfile(S.me.id);
  } else {
    $("google-btn").classList.remove("hidden");
    $("me-chip").classList.add("hidden");
  }
}

// ---------- daily pixel ----------
function updatePlaceState() {
  const box = $("palette-box");
  if (!S.me) {
    $("daily-status").textContent = "נכנסים עם גוגל כדי להניח פיקסל";
    box.classList.add("hidden");
    return;
  }
  box.classList.remove("hidden");
  if (S.me.placed_today) {
    $("daily-status").textContent = "הפיקסל של היום כבר הונח ✔ (" + S.me.total_pixels + " בסך הכל)";
    $("place-btn").disabled = true;
  } else {
    $("daily-status").textContent = "יש לך פיקסל אחד להיום";
    $("place-btn").disabled = !(S.selected && S.selectedColor != null);
  }
}
setInterval(() => {
  if (!S.me || !S.me.placed_today) { $("daily-countdown").textContent = ""; return; }
  const ms = nextUtcMidnight() - Date.now();
  const hh = Math.floor(ms / 3600000), mm = Math.floor((ms % 3600000) / 60000);
  $("daily-countdown").textContent = "הפיקסל הבא בעוד " + hh + " שעות ו-" + mm + " דקות (חצות UTC)";
}, 1000);

// palette UI
function buildPalette() {
  const el = $("palette");
  el.innerHTML = "";
  PALETTE.forEach((hex, i) => {
    const d = document.createElement("div");
    d.className = "swatch" + (i >= FREE_COLORS ? " locked" : "");
    d.style.background = hex;
    d.title = i >= FREE_COLORS ? "צבע פרימיום" : "צבע " + (i + 1);
    d.onclick = () => {
      if (i >= FREE_COLORS && !(S.me && S.me.is_premium)) return;
      S.selectedColor = i;
      [...el.children].forEach((c, j) => c.classList.toggle("selected", j === i));
      updatePlaceState();
      draw();
    };
    el.appendChild(d);
  });
}

$("place-btn").onclick = async () => {
  if (!S.selected || S.selectedColor == null) return;
  $("place-error").textContent = "";
  $("place-btn").disabled = true;
  const { status, data } = await api("/api/place", {
    method: "POST",
    body: JSON.stringify({ x: S.selected.x, y: S.selected.y, color: S.selectedColor }),
  });
  if (status === 200) {
    S.me.placed_today = true;
    S.me.total_pixels = (S.me.total_pixels || 0) + 1;
    const { x, y } = S.selected;
    const tileKey = Math.floor(x / TILE) + "," + Math.floor(y / TILE);
    if (S.tiles.has(tileKey)) { S.tiles.get(tileKey).close(); S.tiles.delete(tileKey); }
    loadOverview();
    refreshFeed(); refreshStats();
    S.selected = null; S.selectedColor = null;
    [...$("palette").children].forEach((c) => c.classList.remove("selected"));
    $("daily-status").textContent = "הפיקסל הונח! 🎉 מספר #" + data.pixel.id;
    draw();
  } else {
    const map = {
      "already placed today": "כבר הנחת פיקסל היום. מחר יש עוד אחד.",
      "pixel taken": "המשבצת הזו כבר תפוסה - בחר אחרת.",
      "premium color": "הצבע הזה שמור לפרימיום.",
      "not signed in": "צריך להתחבר קודם.",
    };
    $("place-error").textContent = map[data.error] || ("שגיאה: " + (data.error || status));
  }
  updatePlaceState();
};

// ---------- stats / feed ----------
async function refreshStats() {
  const { data } = await api("/api/stats");
  if (!data.total_pixels && data.total_pixels !== 0) return;
  $("stats-grid").innerHTML =
    stat(data.total_pixels.toLocaleString("he"), "פיקסלים הונחו") +
    stat(data.total_users.toLocaleString("he"), "יוצרים") +
    stat(data.today.toLocaleString("he"), "הונחו היום") +
    stat((data.fill_pct || 0) + "%", "מהקנבס מכוסה");
}
const stat = (v, l) => '<div class="stat-box"><b>' + v + '</b><span>' + l + "</span></div>";

let latestFeedId = null;
async function refreshFeed() {
  const { data } = await api("/api/feed");
  if (!data.feed) return;
  // The server's tile/overview cache is brief, but our in-page bitmap cache was
  // permanent. When another player places a pixel, drop it so their art appears.
  const newestId = data.feed.length ? data.feed[0].id : 0;
  if (latestFeedId !== null && newestId !== latestFeedId) {
    S.tileEpoch++;
    for (const bitmap of S.tiles.values()) bitmap.close();
    S.tiles.clear();
    S.tilePending.clear();
    loadOverview();
    draw();
  }
  latestFeedId = newestId;
  $("feed").innerHTML = data.feed.map((p) =>
    '<div class="feed-row" data-x="' + p.x + '" data-y="' + p.y + '">' +
    '<span class="feed-swatch" style="background:' + (PALETTE[p.color] || "#000") + '"></span>' +
    "<span><b>" + esc(p.name) + "</b> הניח/ה פיקסל #" + p.id + "</span>" +
    '<span class="meta">' + relTime(p.ts) + "</span></div>"
  ).join("") || '<span class="muted">עוד אין פיקסלים. שלך יכול להיות הראשון.</span>';
  document.querySelectorAll(".feed-row").forEach((r) => {
    r.onclick = () => flyTo(+r.dataset.x, +r.dataset.y);
  });
}
// Free-tier friendly: idle background tabs need no live feed/stats polling.
// Refresh on return so the canvas catches up without a constant request stream.
const REFRESH_MS = 60000;
setInterval(() => {
  if (document.visibilityState === "visible") { refreshFeed(); refreshStats(); }
}, REFRESH_MS);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") { refreshFeed(); refreshStats(); }
});

// ---------- search ----------
let searchTimer = null;
let searchEpoch = 0;
$("search-results").setAttribute("aria-live", "polite");
$("search-input").addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  const epoch = ++searchEpoch;
  const q = e.target.value.trim();
  const out = $("search-results");
  out.innerHTML = "";
  if (!q) return;
  out.innerHTML = '<span class="muted">מחפש…</span>';
  searchTimer = setTimeout(async () => {
    try {
      const { status, data } = await api("/api/search?q=" + encodeURIComponent(q));
      if (epoch !== searchEpoch) return;
      if (status !== 200 || !data || !data.type) throw new Error("search unavailable");
      if (data.type === "pixel") {
        out.innerHTML = data.pixel
          ? '<button type="button" class="search-row" data-x="' + data.pixel.x + '" data-y="' + data.pixel.y + '">פיקסל #' + data.pixel.id + " של " + esc(data.pixel.name) + " (" + data.pixel.x + "," + data.pixel.y + ")</button>"
          : '<span class="muted">לא נמצא פיקסל עם המספר הזה</span>';
      } else if (data.type === "region") {
        out.innerHTML = '<button type="button" class="search-row" data-x="' + data.x + '" data-y="' + data.y + '">קפיצה לאזור ' + data.x + "," + data.y + "</button>";
      } else if (data.type === "users" && Array.isArray(data.users)) {
        out.innerHTML = data.users.map((u) =>
          '<button type="button" class="search-row" data-uid="' + u.id + '">' +
          (u.picture ? '<img alt="" src="' + esc(u.picture) + '">' : "") +
          "<b>" + esc(u.name) + "</b><span class='muted'>" + u.pixels + " פיקסלים</span></button>"
        ).join("") || '<span class="muted">לא נמצאו משתמשים</span>';
      } else throw new Error("invalid search response");
      out.querySelectorAll(".search-row").forEach((r) => {
        r.onclick = () => {
          if (r.dataset.uid) showProfile(+r.dataset.uid);
          else flyTo(+r.dataset.x, +r.dataset.y);
        };
      });
    } catch (error) {
      if (epoch === searchEpoch) out.innerHTML = '<span class="muted">החיפוש לא זמין כרגע. נסה שוב בעוד רגע.</span>';
    }
  }, 350);
});

// ---------- modal (pixel info + profile) ----------
function openModal(html) {
  $("modal-content").innerHTML = html;
  $("modal-backdrop").classList.remove("hidden");
}
$("modal-close").onclick = () => $("modal-backdrop").classList.add("hidden");
$("modal-backdrop").onclick = (e) => { if (e.target === $("modal-backdrop")) $("modal-backdrop").classList.add("hidden"); };

function showPixelInfo(p) {
  openModal(
    '<div class="profile-head">' +
    (p.picture ? '<img src="' + esc(p.picture) + '">' : "") +
    "<div><h2>פיקסל #" + p.id + "</h2><div class='muted'>(" + p.x + ", " + p.y + ")</div></div></div>" +
    '<div class="pixel-row"><span class="feed-swatch" style="background:' + (PALETTE[p.color] || "#000") + '"></span>' +
    "הונח על ידי <b>" + esc(p.name) + "</b></div>" +
    '<div class="muted" style="margin-top:8px">' + fmtDateTime(p.ts) + "</div>" +
    '<div class="muted" style="margin-top:4px">פיקסלים הם קבועים - אי אפשר להזיז, למחוק או לשנות.</div>' +
    '<button class="search-row" style="margin-top:10px;width:100%" id="modal-profile-link">פרופיל של ' + esc(p.name) + "</button>"
  );
  $("modal-profile-link").onclick = () => showProfile(p.uid);
}

async function showProfile(uid) {
  const { data } = await api("/api/user/" + uid);
  if (!data.user) return;
  const u = data.user, px = data.pixels || [];
  let mini = "";
  if (px.length) {
    mini = '<canvas id="user-minimap" width="440" height="220"></canvas>';
  }
  openModal(
    '<div class="profile-head">' + (u.picture ? '<img src="' + esc(u.picture) + '">' : "") +
    "<div><h2>" + esc(u.name) + (u.is_premium ? " ✦" : "") + "</h2>" +
    "<div class='muted'>" + px.length + " פיקסלים · מצטרף/ת " + new Date(u.created_at).toLocaleDateString("he-IL") + "</div></div></div>" +
    mini +
    '<div class="pixel-list">' + px.slice(-50).reverse().map((p) =>
      '<div class="pixel-row" data-x="' + p.x + '" data-y="' + p.y + '">' +
      '<span class="feed-swatch" style="background:' + (PALETTE[p.color] || "#000") + '"></span>' +
      "#" + p.id + " · (" + p.x + ", " + p.y + ")<span class='meta' style='margin-inline-start:auto;color:var(--muted);font-size:11px'>" + relTime(p.ts) + "</span></div>"
    ).join("") + "</div>"
  );
  if (px.length) {
    const c = $("user-minimap"), cx = c.getContext("2d");
    const xs = px.map((p) => p.x), ys = px.map((p) => p.y);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const sx = c.width / Math.max(1, x1 - x0 + 1), sy = c.height / Math.max(1, y1 - y0 + 1);
    const s = Math.max(2, Math.min(sx, sy));
    const ox = (c.width - (x1 - x0 + 1) * s) / 2, oy = (c.height - (y1 - y0 + 1) * s) / 2;
    for (const p of px) {
      cx.fillStyle = PALETTE[p.color] || "#ff00ff";
      cx.fillRect(ox + (p.x - x0) * s, oy + (p.y - y0) * s, s, s);
    }
  }
  document.querySelectorAll(".pixel-row[data-x]").forEach((r) => {
    r.onclick = () => { $("modal-backdrop").classList.add("hidden"); flyTo(+r.dataset.x, +r.dataset.y); };
  });
}

// ---------- timeline ----------
async function loadHistogram() {
  const { data } = await api("/api/histogram");
  S.histogram = data.days || [];
}
$("timeline").addEventListener("change", async (e) => {
  const v = +e.target.value;
  if (v >= 100 || !S.histogram.length) {
    S.historyPixels = null; S.histTs = null;
    $("timeline-label").textContent = "הווה";
    draw(); return;
  }
  const first = new Date(S.histogram[0].day + "T00:00:00Z").getTime();
  const now = Date.now();
  const t = new Date(first + (now - first) * (v / 100));
  const iso = t.toISOString();
  S.histTs = iso;
  $("timeline-label").textContent = "עד " + t.toLocaleString("he-IL", { dateStyle: "medium", timeStyle: "short" });
  const { data } = await api("/api/history?to=" + encodeURIComponent(iso));
  if (S.histTs !== iso) return;
  S.historyPixels = data.pixels || [];
  $("timeline-label").textContent += " · " + (data.total || 0).toLocaleString("he") + " פיקסלים";
  draw();
});

// ---------- boot ----------
(async function boot() {
  const { data: cfg } = await api("/api/config");
  S.config = cfg;
  buildPalette();
  renderAuth();
  resize();
  fitWorld();
  loadOverview();
  refreshStats();
  refreshFeed();
  loadHistogram();
  if (S.session) loadMe();
  setupGoogle();
  window.addEventListener("resize", resize);
})();
