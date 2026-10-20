// Shizu — Vektör nesne katmanı.
//
// FAZ A: gesture leak koruması (AbortController), glif-bazlı grup hit-test.
//
// _bounds() getBBox() + getCTM() ile SVG kullanıcı uzayında hesaplanır
// (scroll, A4/A5 ortalama, sub-pixel yuvarlama bağımsız).
//
// _groupByWords() üç sinyalle kelime sınırı tespit eder:
//   1) Dikey baseline sıçraması (satır sonu)
//   2) Yatay geri sarma (satır kaydırma)
//   3) Aynı satırdaki yatay boşluk (DOM rect'leri ile)
//
// getText() kelime sınırlarını koruyarak metne geri döndürür.
// deserialize() tip doğrulamalıdır — bozuk dosyalar uygulamayı kilitlemez.
//
// runGesture(): tüm sürükleme/resize/marquee işlemleri için tek giriş noktası.
//   - AbortController ile eski listener'lar otomatik temizlenir.
//   - mouseup, blur veya buttons===0 → cleanup (body.dragging sıfırlanır).
//   - Yeni gesture başlarken eskisi commit edilir (onEnd çağrılır).
//   - Böylece alt-tab / pencere dışı mouseup kazaları state bozmaz.

const SVG_NS = "http://www.w3.org/2000/svg";
const TEXT = "TEXT";
const HIT_PAD = 3;
const HANDLE_SIZE = 8;
const MIN_SCALE = 0.05;

export class VectorLayer {
  constructor({ page, back, front, ui, onCommit }) {
    this.page = page;
    this.back = back;
    this.front = front;
    this.ui = ui;
    this.onCommit = onCommit ?? (() => {});

    this.stack = [TEXT];
    this.objects = new Map();
    this.selection = new Set();
    this.nextId = 1;

    // Aktif gesture state (runGesture tarafından yönetilir)
    this._gestureAC = null;
    this._gestureOnEnd = null;

    this.selBox = document.createElementNS(SVG_NS, "rect");
    this.selBox.setAttribute("class", "sel-box");
    this.selBox.style.display = "none";
    ui.appendChild(this.selBox);

    this.handles = {};
    for (const corner of ["tl", "tr", "bl", "br"]) {
      const h = document.createElementNS(SVG_NS, "rect");
      h.dataset.corner = corner;
      h.setAttribute("rx", "2");
      h.setAttribute("ry", "2");
      h.style.display = "none";
      h.style.fill = "#fff";
      h.style.stroke = "#0b57d0";
      h.style.strokeWidth = "1.5";
      h.style.pointerEvents = "auto";
      h.style.cursor =
        corner === "tl" || corner === "br" ? "nwse-resize" : "nesw-resize";
      h.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.startResize(corner, e.clientX, e.clientY);
      });
      ui.appendChild(h);
      this.handles[corner] = h;
    }

    this.marquee = document.createElementNS(SVG_NS, "rect");
    this.marquee.setAttribute("class", "marquee-box");
    this.marquee.style.display = "none";
    ui.appendChild(this.marquee);

    if (document.fonts?.ready) {
      document.fonts.ready
        .then(() => this.updateSelection())
        .catch(() => {});
    }
    window.addEventListener("resize", () => this.updateSelection());
  }

  get selectedId() {
    return this.selection.size === 1 ? [...this.selection][0] : null;
  }

  isInSelection(id) {
    return this.selection.has(id);
  }

  isGroup(id) {
    const obj = this.objects.get(id);
    return !!(obj && obj.isGroup);
  }

  refreshSelection() {
    this.updateSelection();
  }

  /* ---------- Gesture yönetimi ---------- */

  // Ortak gesture girişi. main.js marquee da bunu kullanır.
  // Önceki gesture varsa önce onEnd'i çağırıp sonra abort eder — commit kaybolmaz.
  runGesture(onMove, onEnd) {
    if (this._gestureAC) {
      const prevEnd = this._gestureOnEnd;
      const prevAC = this._gestureAC;
      this._gestureAC = null;
      this._gestureOnEnd = null;
      try {
        prevAC.abort();
      } catch {
        /* yoksay */
      }
      if (prevEnd) {
        try {
          prevEnd();
        } catch (e) {
          console.error(e);
        }
      }
      document.body.classList.remove("dragging");
    }

    const ac = new AbortController();
    this._gestureAC = ac;
    this._gestureOnEnd = onEnd ?? null;

    const cleanup = () => {
      if (ac.signal.aborted) return;
      try {
        ac.abort();
      } catch {
        /* yoksay */
      }
      if (this._gestureAC === ac) {
        this._gestureAC = null;
        this._gestureOnEnd = null;
      }
      document.body.classList.remove("dragging");
      if (onEnd) {
        try {
          onEnd();
        } catch (e) {
          console.error(e);
        }
      }
    };

    window.addEventListener(
      "mousemove",
      (e) => {
        if (e.buttons === 0) {
          cleanup();
          return;
        }
        try {
          onMove(e);
        } catch (err) {
          console.error(err);
          cleanup();
        }
      },
      { signal: ac.signal }
    );
    window.addEventListener("mouseup", cleanup, { signal: ac.signal });
    window.addEventListener("blur", cleanup, { signal: ac.signal });

    return ac;
  }

  /* ---------- Selection box gizleme ---------- */

  _hideSelection() {
    this.selBox.style.display = "none";
    this.selBox.setAttribute("x", 0);
    this.selBox.setAttribute("y", 0);
    this.selBox.setAttribute("width", 0);
    this.selBox.setAttribute("height", 0);
    for (const h of Object.values(this.handles)) {
      h.style.display = "none";
      h.setAttribute("x", 0);
      h.setAttribute("y", 0);
    }
  }

  /* ---------- Reset ---------- */

  reset() {
    if (this._gestureAC) {
      try {
        this._gestureAC.abort();
      } catch {
        /* yoksay */
      }
      this._gestureAC = null;
      this._gestureOnEnd = null;
      document.body.classList.remove("dragging");
    }
    for (const o of this.objects.values()) o.el.remove();
    this.objects.clear();
    this.stack = [TEXT];
    this.selection.clear();
    this.nextId = 1;
    this._hideSelection();
    this.marquee.style.display = "none";
  }

  /* ---------- Oluşturma / silme ---------- */

  create(glyphs) {
    if (!glyphs || glyphs.length === 0) return null;
    const o = glyphs[0];
    const obj = this._make(
      o.x,
      o.y,
      glyphs.map((g) => ({ ...g, x: g.x - o.x, y: g.y - o.y }))
    );
    this.stack.push(obj);
    this.selection = new Set([obj.id]);
    this.render();
    return obj;
  }

  remove(id) {
    const obj = this.objects.get(id);
    if (!obj) return;
    this.stack = this.stack.filter((s) => s !== obj);
    this.objects.delete(id);
    obj.el.remove();
    this.selection.delete(id);
    this.render();
  }

  removeSelected() {
    for (const id of [...this.selection]) this.remove(id);
  }

  split(id) {
    const obj = this.objects.get(id);
    if (!obj || obj.glyphs.length < 2) return false;
    const idx = this.stack.indexOf(obj);
    const parts = obj.glyphs.map((g) =>
      this._make(
        obj.x + g.x * obj.scaleX,
        obj.y + g.y * obj.scaleY,
        [{ ...g, x: 0, y: 0 }],
        obj.scaleX,
        obj.scaleY
      )
    );
    this.stack.splice(idx, 1, ...parts);
    obj.el.remove();
    this.objects.delete(id);
    this.selection.clear();
    this.render();
    return true;
  }

  extractGlyph(objId, clientX, clientY) {
    const obj = this.objects.get(objId);
    if (!obj || obj.glyphs.length < 2) return null;
    const idx = this._glyphIndexAt(obj, clientX, clientY);
    if (idx < 0) return null;
    const g = obj.glyphs[idx];
    obj.glyphs.splice(idx, 1);
    if (obj.el.children[idx]) obj.el.children[idx].remove();
    const newObj = this._make(
      obj.x + g.x * obj.scaleX,
      obj.y + g.y * obj.scaleY,
      [{ ...g, x: 0, y: 0 }],
      obj.scaleX,
      obj.scaleY
    );
    const parentIdx = this.stack.indexOf(obj);
    this.stack.splice(parentIdx + 1, 0, newObj);
    this.render();
    return newObj.id;
  }

  // Kelime ayrıştırma — çok satırlı seçimleri doğru böler.
  splitWords(id) {
    const obj = this.objects.get(id);
    if (!obj || obj.glyphs.length < 2) return false;

    const groups = this._groupByWords(obj);
    if (groups.length <= 1) return false;

    const idx = this.stack.indexOf(obj);
    const parts = groups.map((group) => {
      const origin = group[0];
      return this._make(
        obj.x + origin.x * obj.scaleX,
        obj.y + origin.y * obj.scaleY,
        group.map((g) => ({ ...g, x: g.x - origin.x, y: g.y - origin.y })),
        obj.scaleX,
        obj.scaleY
      );
    });

    this.stack.splice(idx, 1, ...parts);
    obj.el.remove();
    this.objects.delete(id);
    this.selection.clear();
    this.render();
    return true;
  }

  hasMultipleWords(id) {
    const obj = this.objects.get(id);
    if (!obj || obj.glyphs.length < 2) return false;
    return this._groupByWords(obj).length > 1;
  }

  // Metne geri dönüş — kelime sınırları korunur (tek boşluk ile birleştirilir).
  // Grup nesneleri için null döner (grup geri metne çevrilemez).
  getText(id) {
    const obj = this.objects.get(id);
    if (!obj || obj.isGroup || !obj.glyphs || obj.glyphs.length === 0) {
      return null;
    }
    if (obj.glyphs.length === 1) return obj.glyphs[0].ch;
    const groups = this._groupByWords(obj);
    return groups.map((g) => g.map((x) => x.ch).join("")).join(" ");
  }

  /* ---------- Grup / Ungroup ---------- */

  group() {
    if (this.selection.size < 2) return false;
    const selected = this.stack.filter(
      (s) => s !== TEXT && this.selection.has(s.id)
    );
    if (selected.length < 2) return false;

    let bboxL = Infinity;
    let bboxT = Infinity;
    for (const obj of selected) {
      const b = this._bounds(obj);
      if (!b) continue;
      bboxL = Math.min(bboxL, b.l);
      bboxT = Math.min(bboxT, b.t);
    }
    if (!Number.isFinite(bboxL) || !Number.isFinite(bboxT)) return false;

    const compound = {
      id: this.nextId++,
      x: bboxL,
      y: bboxT,
      scaleX: 1,
      scaleY: 1,
      glyphs: [],
      isGroup: true,
      children: [],
      el: null,
    };

    for (const obj of selected) {
      compound.children.push({
        x: obj.x - compound.x,
        y: obj.y - compound.y,
        scaleX: obj.scaleX,
        scaleY: obj.scaleY,
        glyphs: obj.glyphs,
        isGroup: !!obj.isGroup,
        children: obj.children || [],
      });
    }

    compound.el = this._buildEl(compound);

    const indices = selected
      .map((s) => this.stack.indexOf(s))
      .sort((a, b) => a - b);
    const insertAt = indices[indices.length - 1];
    const before = indices.filter((i) => i < insertAt).length;

    this.stack = this.stack.filter((s) => !selected.includes(s));
    this.stack.splice(insertAt - before, 0, compound);

    for (const obj of selected) {
      obj.el.remove();
      this.objects.delete(obj.id);
    }

    this.objects.set(compound.id, compound);
    this.selection = new Set([compound.id]);
    this.render();
    return true;
  }

  ungroup(id) {
    const obj = this.objects.get(id);
    if (!obj || !obj.isGroup) return false;
    const idx = this.stack.indexOf(obj);
    if (idx < 0) return false;

    const parts = obj.children.map((child) => {
      const absX = obj.x + child.x * obj.scaleX;
      const absY = obj.y + child.y * obj.scaleY;
      const absScaleX = child.scaleX * obj.scaleX;
      const absScaleY = child.scaleY * obj.scaleY;
      if (child.isGroup) {
        const nested = {
          id: this.nextId++,
          x: absX,
          y: absY,
          scaleX: absScaleX,
          scaleY: absScaleY,
          glyphs: [],
          isGroup: true,
          children: child.children,
          el: null,
        };
        nested.el = this._buildEl(nested);
        this.objects.set(nested.id, nested);
        return nested;
      }
      return this._make(absX, absY, child.glyphs, absScaleX, absScaleY);
    });

    this.stack.splice(idx, 1, ...parts);
    obj.el.remove();
    this.objects.delete(id);
    this.selection = new Set(parts.map((p) => p.id));
    this.render();
    return true;
  }

  _make(x, y, glyphs, scaleX = 1, scaleY = 1) {
    const obj = {
      id: this.nextId++,
      x,
      y,
      scaleX,
      scaleY,
      glyphs,
      el: null,
    };
    obj.el = this._buildEl(obj);
    this.objects.set(obj.id, obj);
    return obj;
  }

  _buildEl(obj) {
    const g = document.createElementNS(SVG_NS, "g");
    g.dataset.id = String(obj.id);
    g.setAttribute(
      "transform",
      `translate(${obj.x} ${obj.y}) scale(${obj.scaleX} ${obj.scaleY})`
    );
    if (obj.isGroup) {
      for (const child of obj.children) g.appendChild(this._buildChildEl(child));
    } else {
      this._appendGlyphsTo(g, obj.glyphs);
    }
    return g;
  }

  _buildChildEl(child) {
    const g = document.createElementNS(SVG_NS, "g");
    g.setAttribute(
      "transform",
      `translate(${child.x} ${child.y}) scale(${child.scaleX} ${child.scaleY})`
    );
    if (child.isGroup) {
      for (const sub of child.children) g.appendChild(this._buildChildEl(sub));
    } else {
      this._appendGlyphsTo(g, child.glyphs);
    }
    return g;
  }

  _appendGlyphsTo(parent, glyphs) {
    for (const glyph of glyphs) {
      const t = document.createElementNS(SVG_NS, "text");
      t.setAttribute("x", glyph.x);
      t.setAttribute("y", glyph.y);
      t.setAttribute("class", "vglyph");
      t.style.fontFamily = glyph.fontFamily;
      t.style.fontSize = `${glyph.fontSize}px`;
      t.style.fontWeight = glyph.fontWeight;
      t.style.fontStyle = glyph.fontStyle;
      t.style.fill = glyph.fill;
      t.textContent = glyph.ch;
      parent.appendChild(t);
    }
  }

  _applyTransform(obj) {
    obj.el.setAttribute(
      "transform",
      `translate(${obj.x} ${obj.y}) scale(${obj.scaleX} ${obj.scaleY})`
    );
  }

  /* ---------- Snapshot ---------- */

  serialize() {
    return {
      stack: this.stack.map((s) => (s === TEXT ? TEXT : s.id)),
      objects: [...this.objects.values()].map((o) => this._serializeObj(o)),
      nextId: this.nextId,
    };
  }

  // Bozuk veriye karşı savunmalı: her nesne tip/aralık doğrulamasından geçer.
  // Hatalı bir nesne varsa atlanır — diğerleri yüklenmeye devam eder.
  // nextId ve TEXT marker'ı her koşulda tutarlı bırakılır.
  deserialize(data) {
    if (!data || !Array.isArray(data.objects) || !Array.isArray(data.stack)) {
      throw new Error("Bozuk vektör verisi");
    }

    for (const o of this.objects.values()) o.el.remove();
    this.objects.clear();
    this._hideSelection();

    const map = new Map();
    let maxId = 0;

    for (const objData of data.objects) {
      if (!objData || typeof objData !== "object") continue;
      if (!Array.isArray(objData.glyphs)) continue;
      if (!Number.isFinite(objData.x) || !Number.isFinite(objData.y)) continue;
      if (
        !Number.isFinite(objData.scaleX) ||
        !Number.isFinite(objData.scaleY) ||
        objData.scaleX === 0 ||
        objData.scaleY === 0
      ) {
        continue;
      }
      if (!Number.isFinite(objData.id)) continue;

      const obj = {
        id: objData.id,
        x: objData.x,
        y: objData.y,
        scaleX: objData.scaleX,
        scaleY: objData.scaleY,
        glyphs: objData.glyphs
          .filter(
            (g) =>
              g &&
              typeof g.ch === "string" &&
              Number.isFinite(g.x) &&
              Number.isFinite(g.y) &&
              Number.isFinite(g.fontSize)
          )
          .map((g) => ({ ...g })),
        isGroup: !!objData.isGroup,
        children: [],
        el: null,
      };
      if (obj.glyphs.length === 0 && !obj.isGroup) continue;
      if (obj.isGroup) {
        if (!Array.isArray(objData.children)) continue;
        try {
          obj.children = objData.children.map((c) => this._deserializeChild(c));
        } catch {
          continue;
        }
      }
      obj.el = this._buildEl(obj);
      this.objects.set(obj.id, obj);
      map.set(obj.id, obj);
      if (obj.id > maxId) maxId = obj.id;
    }

    this.stack = data.stack
      .map((s) => (s === TEXT ? TEXT : map.get(s)))
      .filter((s) => s !== undefined);
    if (!this.stack.includes(TEXT)) {
      this.stack.unshift(TEXT);
    }

    this.nextId = Math.max(maxId + 1, Number(data.nextId) || 0, 1);
    this.selection.clear();
    this.render();
  }

  _serializeObj(obj) {
    const base = {
      id: obj.id,
      x: obj.x,
      y: obj.y,
      scaleX: obj.scaleX,
      scaleY: obj.scaleY,
      glyphs: obj.glyphs.map((g) => ({ ...g })),
      isGroup: !!obj.isGroup,
    };
    if (obj.isGroup) {
      base.children = obj.children.map((c) => this._serializeChild(c));
    }
    return base;
  }

  _serializeChild(c) {
    const base = {
      x: c.x,
      y: c.y,
      scaleX: c.scaleX,
      scaleY: c.scaleY,
      glyphs: c.glyphs.map((g) => ({ ...g })),
      isGroup: !!c.isGroup,
    };
    if (c.isGroup) {
      base.children = c.children.map((sc) => this._serializeChild(sc));
    }
    return base;
  }

  _deserializeChild(data) {
    if (!data || typeof data !== "object") {
      throw new Error("Bozuk child");
    }
    if (!Array.isArray(data.glyphs)) {
      throw new Error("Bozuk child glyphs");
    }
    const c = {
      x: Number.isFinite(data.x) ? data.x : 0,
      y: Number.isFinite(data.y) ? data.y : 0,
      scaleX: Number.isFinite(data.scaleX) && data.scaleX !== 0 ? data.scaleX : 1,
      scaleY: Number.isFinite(data.scaleY) && data.scaleY !== 0 ? data.scaleY : 1,
      glyphs: data.glyphs
        .filter(
          (g) =>
            g &&
            typeof g.ch === "string" &&
            Number.isFinite(g.x) &&
            Number.isFinite(g.y) &&
            Number.isFinite(g.fontSize)
        )
        .map((g) => ({ ...g })),
      isGroup: !!data.isGroup,
      children: [],
    };
    if (c.isGroup) {
      if (!Array.isArray(data.children)) {
        throw new Error("Bozuk child children");
      }
      c.children = data.children.map((sc) => this._deserializeChild(sc));
    }
    return c;
  }

  /* ---------- Çizim / z-index ---------- */

  render() {
    const textIdx = this.stack.indexOf(TEXT);
    this.stack.forEach((item, i) => {
      if (item === TEXT) return;
      (i < textIdx ? this.back : this.front).appendChild(item.el);
    });
    this.updateSelection();
  }

  info(id) {
    const obj = this.objects.get(id);
    const i = this.stack.indexOf(obj);
    return {
      layer: i < this.stack.indexOf(TEXT) ? "back" : "front",
      atTop: i === this.stack.length - 1,
      atBottom: i === 0,
    };
  }

  bringToFront(id) {
    const obj = this.objects.get(id);
    this.stack = this.stack.filter((s) => s !== obj);
    this.stack.push(obj);
    this.render();
  }

  sendToBack(id) {
    const obj = this.objects.get(id);
    this.stack = this.stack.filter((s) => s !== obj);
    this.stack.unshift(obj);
    this.render();
  }

  forward(id) {
    const i = this.stack.indexOf(this.objects.get(id));
    if (i < 0 || i >= this.stack.length - 1) return;
    [this.stack[i], this.stack[i + 1]] = [this.stack[i + 1], this.stack[i]];
    this.render();
  }

  backward(id) {
    const i = this.stack.indexOf(this.objects.get(id));
    if (i <= 0) return;
    [this.stack[i], this.stack[i - 1]] = [this.stack[i - 1], this.stack[i]];
    this.render();
  }

  /* ---------- Seçim ---------- */

  select(id) {
    this.selection = new Set([id]);
    this.updateSelection();
  }

  selectMany(ids) {
    this.selection = new Set(ids);
    this.updateSelection();
  }

  deselect() {
    this.selection.clear();
    this._hideSelection();
  }

  /* ---------- BOUNDS ---------- */

  _bounds(obj) {
    const el = obj && obj.el;
    if (!el || !el.isConnected) return null;

    let bbox;
    try {
      bbox = el.getBBox();
    } catch {
      return null;
    }
    if (!bbox) return null;
    if (
      !Number.isFinite(bbox.x) ||
      !Number.isFinite(bbox.y) ||
      !Number.isFinite(bbox.width) ||
      !Number.isFinite(bbox.height)
    ) {
      return null;
    }
    if (bbox.width <= 0 && bbox.height <= 0) return null;

    let ctm;
    try {
      ctm = el.getCTM();
    } catch {
      return null;
    }
    if (!ctm) return null;

    const corners = [
      [bbox.x, bbox.y],
      [bbox.x + bbox.width, bbox.y],
      [bbox.x, bbox.y + bbox.height],
      [bbox.x + bbox.width, bbox.y + bbox.height],
    ];
    let l = Infinity;
    let t = Infinity;
    let r = -Infinity;
    let b = -Infinity;
    for (const [x, y] of corners) {
      const px = ctm.a * x + ctm.c * y + ctm.e;
      const py = ctm.b * x + ctm.d * y + ctm.f;
      if (px < l) l = px;
      if (py < t) t = py;
      if (px > r) r = px;
      if (py > b) b = py;
    }

    if (
      !Number.isFinite(l) ||
      !Number.isFinite(t) ||
      !Number.isFinite(r) ||
      !Number.isFinite(b)
    ) {
      return null;
    }
    if (r <= l || b <= t) return null;

    return { l, t, r, b };
  }

  updateSelection() {
    if (this.selection.size === 0) {
      this._hideSelection();
      return;
    }

    let l = Infinity;
    let t = Infinity;
    let r = -Infinity;
    let b = -Infinity;
    let found = false;

    for (const id of this.selection) {
      const obj = this.objects.get(id);
      if (!obj) continue;
      const bd = this._bounds(obj);
      if (!bd) continue;
      found = true;
      if (bd.l < l) l = bd.l;
      if (bd.t < t) t = bd.t;
      if (bd.r > r) r = bd.r;
      if (bd.b > b) b = bd.b;
    }

    if (!found) {
      this._hideSelection();
      return;
    }

    const pad = 4;
    this.selBox.setAttribute("x", l - pad);
    this.selBox.setAttribute("y", t - pad);
    this.selBox.setAttribute("width", Math.max(0, r - l + pad * 2));
    this.selBox.setAttribute("height", Math.max(0, b - t + pad * 2));
    this.selBox.style.display = "";

    if (this.selection.size === 1) {
      const hs = HANDLE_SIZE;
      const corners = {
        tl: [l - pad, t - pad],
        tr: [r + pad, t - pad],
        bl: [l - pad, b + pad],
        br: [r + pad, b + pad],
      };
      for (const [corner, [cx, cy]] of Object.entries(corners)) {
        const h = this.handles[corner];
        h.setAttribute("x", cx - hs / 2);
        h.setAttribute("y", cy - hs / 2);
        h.setAttribute("width", hs);
        h.setAttribute("height", hs);
        h.style.display = "";
      }
    } else {
      for (const h of Object.values(this.handles)) h.style.display = "none";
    }
  }

  /* ---------- Marquee ---------- */

  showMarquee(l, t, w, h) {
    this.marquee.setAttribute("x", l);
    this.marquee.setAttribute("y", t);
    this.marquee.setAttribute("width", w);
    this.marquee.setAttribute("height", h);
    this.marquee.style.display = "";
  }

  hideMarquee() {
    this.marquee.style.display = "none";
  }

  hitTestRect(l, t, r, b) {
    const ids = [];
    const pr = this.page.getBoundingClientRect();
    for (const obj of this.objects.values()) {
      for (const node of obj.el.querySelectorAll("text")) {
        const rc = node.getBoundingClientRect();
        const gl = rc.left - pr.left;
        const gt = rc.top - pr.top;
        const gr = rc.right - pr.left;
        const gb = rc.bottom - pr.top;
        if (gr >= l && gl <= r && gb >= t && gt <= b) {
          ids.push(obj.id);
          break;
        }
      }
    }
    return ids;
  }

  /* ---------- Hit-test ve sürükleme ---------- */

  // FAZ A: grup nesneleri için de glif-bazlı isabet testi.
  // Grup bbox'ının boş kısımlarına tıklamak altındaki metne imleç konmasını
  // engellemez; kullanıcı yalnızca gerçek bir glifin üstüne tıklayınca grubu
  // yakalar.
  hitTest(clientX, clientY, { includeBack = false } = {}) {
    const textIdx = this.stack.indexOf(TEXT);
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const obj = this.stack[i];
      if (obj === TEXT) continue;
      if (i < textIdx && !includeBack && !this.selection.has(obj.id)) continue;

      if (obj.isGroup) {
        for (const node of obj.el.querySelectorAll("text")) {
          const r = node.getBoundingClientRect();
          if (
            clientX >= r.left - HIT_PAD &&
            clientX <= r.right + HIT_PAD &&
            clientY >= r.top - HIT_PAD &&
            clientY <= r.bottom + HIT_PAD
          ) {
            return obj;
          }
        }
      } else {
        for (const node of obj.el.children) {
          const r = node.getBoundingClientRect();
          if (
            clientX >= r.left - HIT_PAD &&
            clientX <= r.right + HIT_PAD &&
            clientY >= r.top - HIT_PAD &&
            clientY <= r.bottom + HIT_PAD
          ) {
            return obj;
          }
        }
      }
    }
    return null;
  }

  hitHandle(clientX, clientY) {
    for (const [corner, h] of Object.entries(this.handles)) {
      if (h.style.display === "none") continue;
      const r = h.getBoundingClientRect();
      if (
        clientX >= r.left &&
        clientX <= r.right &&
        clientY >= r.top &&
        clientY <= r.bottom
      ) {
        return corner;
      }
    }
    return null;
  }

  _glyphIndexAt(obj, clientX, clientY) {
    for (let i = 0; i < obj.el.children.length; i++) {
      const r = obj.el.children[i].getBoundingClientRect();
      if (
        clientX >= r.left - HIT_PAD &&
        clientX <= r.right + HIT_PAD &&
        clientY >= r.top - HIT_PAD &&
        clientY <= r.bottom + HIT_PAD
      ) {
        return i;
      }
    }
    return -1;
  }

  _groupByWords(obj) {
    const glyphs = obj.glyphs;
    if (!glyphs || glyphs.length === 0) return [];
    if (glyphs.length === 1) return [glyphs.slice()];

    const children = [...obj.el.children];
    const absSx = Math.abs(obj.scaleX) || 1;

    const groups = [];
    let current = [glyphs[0]];

    for (let i = 1; i < glyphs.length; i++) {
      const prev = glyphs[i - 1];
      const cur = glyphs[i];

      const fontForLine = cur.fontSize || prev.fontSize || 16;
      const dy = Math.abs(cur.y - prev.y);
      const isVerticalBreak = dy > fontForLine * 0.5;

      const dx = cur.x - prev.x;
      const isHorizontalWrap = dx < 0;

      let isGap = false;
      if (!isVerticalBreak && !isHorizontalWrap) {
        const prevRect = children[i - 1]?.getBoundingClientRect?.();
        const curRect = children[i]?.getBoundingClientRect?.();
        const visualFontSize = (cur.fontSize || 16) * absSx;
        const spaceThreshold = visualFontSize * 0.2;

        if (prevRect && curRect && prevRect.width > 0 && curRect.width > 0) {
          const gap = curRect.left - prevRect.right;
          isGap = gap > spaceThreshold;
        } else {
          const estimatedPrevWidth = (prev.fontSize || 16) * absSx * 0.6;
          isGap = dx - estimatedPrevWidth > spaceThreshold;
        }
      }

      if (isVerticalBreak || isHorizontalWrap || isGap) {
        groups.push(current);
        current = [];
      }
      current.push(cur);
    }
    groups.push(current);
    return groups;
  }

  /* ---------- Sürükleme / resize (runGesture tabanlı) ---------- */

  startDrag(id, startX, startY) {
    const ids =
      this.selection.has(id) && this.selection.size > 1
        ? [...this.selection]
        : [id];
    const drags = [];
    for (const oid of ids) {
      const obj = this.objects.get(oid);
      if (obj) drags.push({ obj, ox: obj.x, oy: obj.y });
    }
    if (drags.length === 0) return;

    document.body.classList.add("dragging");

    const move = (e) => {
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      for (const d of drags) {
        d.obj.x = d.ox + dx;
        d.obj.y = d.oy + dy;
        this._applyTransform(d.obj);
      }
      this.updateSelection();
    };
    const up = () => {
      this.onCommit();
    };

    this.runGesture(move, up);
  }

  startResize(corner, startX, startY) {
    const obj = this.objects.get(this.selectedId);
    if (!obj) return;

    const bounds = this._bounds(obj);
    if (!bounds) return;
    const oldWidth = bounds.r - bounds.l;
    const oldHeight = bounds.b - bounds.t;
    if (oldWidth <= 0 || oldHeight <= 0) return;

    const oldX = obj.x;
    const oldY = obj.y;
    const oldSx = obj.scaleX;
    const oldSy = obj.scaleY;

    let anchorX;
    let anchorY;
    if (corner === "br") {
      anchorX = bounds.l;
      anchorY = bounds.t;
    } else if (corner === "bl") {
      anchorX = bounds.r;
      anchorY = bounds.t;
    } else if (corner === "tr") {
      anchorX = bounds.l;
      anchorY = bounds.b;
    } else {
      anchorX = bounds.r;
      anchorY = bounds.b;
    }

    const alx = (anchorX - oldX) / oldSx;
    const aly = (anchorY - oldY) / oldSy;

    document.body.classList.add("dragging");

    const move = (e) => {
      const pr = this.page.getBoundingClientRect();
      const mx = e.clientX - pr.left;
      const my = e.clientY - pr.top;
      const newWidth = corner.includes("r") ? mx - anchorX : anchorX - mx;
      const newHeight = corner.includes("b") ? my - anchorY : anchorY - my;
      if (newWidth <= 0 || newHeight <= 0) return;

      const newSx = Math.max(MIN_SCALE, oldSx * (newWidth / oldWidth));
      const newSy = Math.max(MIN_SCALE, oldSy * (newHeight / oldHeight));

      obj.x = anchorX - alx * newSx;
      obj.y = anchorY - aly * newSy;
      obj.scaleX = newSx;
      obj.scaleY = newSy;

      this._applyTransform(obj);
      this.updateSelection();
    };
    const up = () => {
      this.onCommit();
    };

    this.runGesture(move, up);
  }
}