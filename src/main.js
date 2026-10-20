// Shizu — Vectorization, free dragging, letter splitting, z-index,
// selective glyph extraction, word splitting, revert to text,
// line-height control, caret killer, multi-select + marquee,
// PNG export (matrix-baked), SVG export (lossless), preferences,
// group/ungroup, canvas modes (fluid/A4/A5), document lifecycle (.shizu),
// drag-and-drop .shizu.
//
// P0 hardening:
//   - sanitizeEditorHTML: sanitizes HTML from .shizu files (XSS).
//   - loadShizu: try/finally always resets _suppressDirty.
//   - applyStyle/commitSize: prevents prefs leak on selection styling.
//   - saveShizu: writes editor's actual computed style, not prefs.
//   - revertToText: layer.getText preserves word spacing.
//   - vectorKeysArmed: prevents accidental Backspace after vectorize.
//   - bindHexInput: correct pref fallback (avoid white-on-white).
//   - readonly guard: vectorize/revertToText/applyStyle no-op when locked.
//
// Faz A: gesture leak (AbortController), group hit-test, empty-click caret.
//
// Faz B: line-height default 1.25x with migration, B/I/U + alignment buttons,
//        Ctrl+B/I/U shortcuts, 820px fluid reading column, smart punctuation.
//
// English UI: all user-facing strings are English.

import { captureGlyphs } from "./glyph-capture.js";
import { VectorLayer } from "./vector-layer.js";
import { showMenu } from "./context-menu.js";

const $ = (sel) => document.querySelector(sel);

const workspace = $("#workspace");
const page = $("#page");
const editor = $("#editor");
const fontSelect = $("#font-select");
const sizeInput = $("#size-input");
const sizeDec = $("#size-dec");
const sizeInc = $("#size-inc");
const ruledToggle = $("#ruled-toggle");
const lineInput = $("#line-input");
const lineDec = $("#line-dec");
const lineInc = $("#line-inc");
const vectorizeBtn = $("#vectorize-btn");
const readonlyToggle = $("#readonly-toggle");
const pngBtn = $("#png-btn");
const svgBtn = $("#svg-btn");
const canvasSelect = $("#canvas-select");
const newBtn = $("#new-btn");
const openBtn = $("#open-btn");
const saveBtn = $("#save-btn");
const openFile = $("#open-file");
const bgHex = $("#bg-hex");
const fgHex = $("#fg-hex");
const bgSwatch = $("#bg-swatch");
const fgSwatch = $("#fg-swatch");
const boldBtn = $("#bold-btn");
const italicBtn = $("#italic-btn");
const underlineBtn = $("#underline-btn");
const alignLeftBtn = $("#align-left");
const alignCenterBtn = $("#align-center");
const alignRightBtn = $("#align-right");

const MIN_SIZE = 6;
const MAX_SIZE = 400;
const MIN_LINE = 8;
const MAX_LINE = 200;
const SAVE_FORMAT = "shizu";
const SAVE_VERSION = 1;
const SVG_NS = "http://www.w3.org/2000/svg";

/* =====================================================================
   PREFERENCES
   ===================================================================== */
const PREFS_KEY = "shizu-prefs-v1";
const DEFAULT_PREFS = {
  fontFamily: "Inter",
  fontSize: 18,
  bgColor: "#FFFFFF",
  fgColor: "#000000",
  lineHeight: 23, // 18 * 1.25 = 22.5 → 23
  lineHeightManual: false,
  ruled: false,
  canvas: "fluid",
  textAlign: "left",
};

function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* sessizce geç */
  }
}

let prefs = { ...DEFAULT_PREFS };
try {
  const stored = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
  prefs = { ...DEFAULT_PREFS, ...stored };
} catch {
  /* bozuk veri */
}

// Migration: eski varsayılan 1.8 oranıydı. Kullanıcı satır aralığına
// dokunmadıysa yeni 1.25 oranıyla yeniden hesapla.
if (!prefs.lineHeightManual) {
  const newLH = Math.round(prefs.fontSize * 1.25);
  if (prefs.lineHeight !== newLH) {
    prefs.lineHeight = newLH;
    savePrefs();
  }
}
if (!prefs.textAlign) prefs.textAlign = "left";

let defaultSize = prefs.fontSize;
let lineHeightManual = !!prefs.lineHeightManual;
let currentCanvasMode = prefs.canvas || "fluid";

/* =====================================================================
   DIRTY TRACKING
   ===================================================================== */
let dirty = false;
let _suppressDirty = false;

function markDirty() {
  if (_suppressDirty) return;
  if (dirty) return;
  dirty = true;
  updateTitle();
}

function markClean() {
  dirty = false;
  updateTitle();
}

function updateTitle() {
  document.title = dirty ? "● Shizu" : "Shizu";
}

window.addEventListener("beforeunload", (e) => {
  if (!dirty) return;
  e.preventDefault();
  e.returnValue = "";
});

/* =====================================================================
   LAYER
   ===================================================================== */
const layer = new VectorLayer({
  page,
  back: $("#layer-back"),
  front: $("#layer-front"),
  ui: $("#layer-ui"),
  onCommit: () => markDirty(),
});

/* =====================================================================
   SELECTION TRACKING
   ===================================================================== */
let savedRange = null;
let vectorKeysArmed = false;

function currentEditorRange() {
  const sel = window.getSelection();
  if (!sel.rangeCount || !editor.contains(sel.anchorNode)) return null;
  return sel.getRangeAt(0).cloneRange();
}

function updateVectorizeState() {
  const r = currentEditorRange();
  vectorizeBtn.disabled = !(r && !r.collapsed);
}

document.addEventListener("selectionchange", () => {
  const sel = window.getSelection();
  if (sel.rangeCount && editor.contains(sel.anchorNode)) {
    savedRange = sel.getRangeAt(0).cloneRange();
    syncToolbarFromSelection(sel.anchorNode);
  }
  updateVectorizeState();
  updateFormatButtons();
  updateAlignmentButtons();
});

function syncToolbarFromSelection(node) {
  const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  if (!el) return;
  const cs = getComputedStyle(el);

  const size = Math.round(parseFloat(cs.fontSize));
  if (document.activeElement !== sizeInput) sizeInput.value = size;

  const first = cs.fontFamily.split(",")[0].replace(/["']/g, "").trim();
  if ([...fontSelect.options].some((o) => o.value === first)) {
    fontSelect.value = first;
  }
}

function applyStyle(styles) {
  if (!editor.isContentEditable) return false;

  const range = savedRange;
  const isSelection =
    range &&
    !range.collapsed &&
    editor.contains(range.commonAncestorContainer);

  if (isSelection) {
    const span = document.createElement("span");
    Object.assign(span.style, styles);
    span.appendChild(range.extractContents());
    span.querySelectorAll("*").forEach((el) => {
      for (const key of Object.keys(styles)) el.style[key] = "";
    });
    range.insertNode(span);
    const sel = window.getSelection();
    const next = document.createRange();
    next.selectNodeContents(span);
    sel.removeAllRanges();
    sel.addRange(next);
    savedRange = next.cloneRange();
  } else {
    Object.assign(editor.style, styles);
    if (styles.fontSize) {
      defaultSize = parseFloat(styles.fontSize);
      updateLineHeight();
    }
  }
  if (editor.isContentEditable) editor.focus();
  markDirty();
  return !!isSelection;
}

/* =====================================================================
   FONT / SIZE
   ===================================================================== */
fontSelect.addEventListener("change", () => {
  const wasSelection = applyStyle({
    fontFamily: `"${fontSelect.value}", sans-serif`,
  });
  if (!wasSelection) {
    prefs.fontFamily = fontSelect.value;
    savePrefs();
  }
});

function clampSize(v) {
  return Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.round(v)));
}

function commitSize(value) {
  const n = parseFloat(value);
  if (Number.isNaN(n)) {
    sizeInput.value = defaultSize;
    return;
  }
  const size = clampSize(n);
  sizeInput.value = size;
  const wasSelection = applyStyle({ fontSize: `${size}px` });
  if (!wasSelection) {
    prefs.fontSize = size;
    savePrefs();
  }
}

sizeInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    commitSize(sizeInput.value);
  }
});
sizeInput.addEventListener("change", () => commitSize(sizeInput.value));
sizeInput.addEventListener("focus", () => sizeInput.select());

/* =====================================================================
   B / I / U ve ALIGNMENT
   ===================================================================== */
function execFormat(cmd) {
  if (!editor.isContentEditable) return;
  const range = savedRange;
  if (range && editor.contains(range.commonAncestorContainer)) {
    try {
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } catch {
      /* stale range */
    }
  }
  try {
    document.execCommand(cmd, false, null);
  } catch (err) {
    console.warn("execCommand failed:", cmd, err);
  }
  const sel = window.getSelection();
  if (sel.rangeCount && editor.contains(sel.anchorNode)) {
    savedRange = sel.getRangeAt(0).cloneRange();
  } else {
    savedRange = null;
  }
  if (editor.isContentEditable) editor.focus();
  markDirty();
  updateFormatButtons();
}

boldBtn.addEventListener("click", () => execFormat("bold"));
italicBtn.addEventListener("click", () => execFormat("italic"));
underlineBtn.addEventListener("click", () => execFormat("underline"));

function execAlign(align) {
  if (!editor.isContentEditable) return;
  const range = savedRange;
  const isSelection =
    range &&
    !range.collapsed &&
    editor.contains(range.commonAncestorContainer);

  if (!isSelection) {
    editor.style.textAlign = align;
    prefs.textAlign = align;
    savePrefs();
    if (editor.isContentEditable) editor.focus();
    markDirty();
    updateAlignmentButtons();
    return;
  }

  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  let success = false;
  try {
    if (align === "left") success = document.execCommand("justifyLeft");
    else if (align === "center") success = document.execCommand("justifyCenter");
    else if (align === "right") success = document.execCommand("justifyRight");
  } catch {
    success = false;
  }

  if (!success) {
    let node = range.startContainer;
    if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
    while (
      node &&
      node !== editor &&
      getComputedStyle(node).display === "inline"
    ) {
      node = node.parentElement;
    }
    if (node && node !== editor) {
      node.style.textAlign = align;
    } else {
      const div = document.createElement("div");
      div.style.textAlign = align;
      div.appendChild(range.extractContents());
      range.insertNode(div);
    }
  }

  if (sel.rangeCount && editor.contains(sel.anchorNode)) {
    savedRange = sel.getRangeAt(0).cloneRange();
  }
  if (editor.isContentEditable) editor.focus();
  markDirty();
  updateAlignmentButtons();
}

alignLeftBtn.addEventListener("click", () => execAlign("left"));
alignCenterBtn.addEventListener("click", () => execAlign("center"));
alignRightBtn.addEventListener("click", () => execAlign("right"));

function updateFormatButtons() {
  const sel = window.getSelection();
  let node = null;
  if (sel.rangeCount && editor.contains(sel.anchorNode)) {
    node = sel.anchorNode;
  } else if (savedRange && editor.contains(savedRange.startContainer)) {
    node = savedRange.startContainer;
  }
  if (!node) return;

  let el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  if (!el) return;

  const cs = getComputedStyle(el);
  const weight = parseInt(cs.fontWeight) || 400;
  boldBtn.setAttribute("aria-pressed", String(weight >= 600));
  italicBtn.setAttribute("aria-pressed", String(cs.fontStyle === "italic"));
  underlineBtn.setAttribute(
    "aria-pressed",
    String(cs.textDecorationLine.includes("underline"))
  );
}

function updateAlignmentButtons() {
  const sel = window.getSelection();
  let node = null;
  if (sel.rangeCount && editor.contains(sel.anchorNode)) {
    node = sel.anchorNode;
  } else if (savedRange && editor.contains(savedRange.startContainer)) {
    node = savedRange.startContainer;
  }

  let align = "left";
  if (node) {
    let el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    while (el && el !== editor) {
      const cs = getComputedStyle(el);
      const ta = cs.textAlign;
      if (ta && ta !== "start" && ta !== "left") {
        align = ta;
        break;
      }
      el = el.parentElement;
    }
    if (align === "start" || !align) align = "left";
  }
  if (!["left", "center", "right"].includes(align)) {
    align = getComputedStyle(editor).textAlign;
    if (align === "start" || !align) align = "left";
    if (!["left", "center", "right"].includes(align)) align = "left";
  }

  alignLeftBtn.setAttribute("aria-pressed", String(align === "left"));
  alignCenterBtn.setAttribute("aria-pressed", String(align === "center"));
  alignRightBtn.setAttribute("aria-pressed", String(align === "right"));
}

/* =====================================================================
   LINE HEIGHT (1.25x ratio)
   ===================================================================== */
function setLineHeight(px, { manual = true } = {}) {
  const v = Math.min(MAX_LINE, Math.max(MIN_LINE, Math.round(px)));
  document.documentElement.style.setProperty("--line-h", `${v}px`);
  if (document.activeElement !== lineInput) lineInput.value = v;
  if (manual) {
    lineHeightManual = true;
    prefs.lineHeightManual = true;
  }
  prefs.lineHeight = v;
  savePrefs();
  markDirty();
  return v;
}

function updateLineHeight() {
  if (lineHeightManual) return;
  const v = Math.min(
    MAX_LINE,
    Math.max(MIN_LINE, Math.round(defaultSize * 1.25))
  );
  document.documentElement.style.setProperty("--line-h", `${v}px`);
  if (document.activeElement !== lineInput) lineInput.value = v;
  prefs.lineHeight = v;
  savePrefs();
}

function commitLineHeight(value) {
  const n = parseFloat(value);
  if (Number.isNaN(n)) {
    lineInput.value = getComputedStyle(document.documentElement)
      .getPropertyValue("--line-h")
      .trim()
      .replace("px", "");
    return;
  }
  setLineHeight(n);
}

lineInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    commitLineHeight(lineInput.value);
  }
});
lineInput.addEventListener("change", () => commitLineHeight(lineInput.value));
lineInput.addEventListener("focus", () => lineInput.select());

ruledToggle.addEventListener("click", () => {
  const on = page.classList.toggle("ruled");
  ruledToggle.setAttribute("aria-pressed", String(on));
  prefs.ruled = on;
  savePrefs();
  markDirty();
});

/* =====================================================================
   CANVAS MODE
   ===================================================================== */
function setCanvasMode(mode, { silent = false } = {}) {
  if (!["fluid", "a4", "a5"].includes(mode)) mode = "fluid";
  currentCanvasMode = mode;
  page.setAttribute("data-canvas", mode);
  document.body.classList.toggle("canvas-fixed", mode !== "fluid");
  canvasSelect.value = mode;
  prefs.canvas = mode;
  savePrefs();
  if (!silent) markDirty();
  layer.refreshSelection();
}

canvasSelect.addEventListener("change", () => {
  setCanvasMode(canvasSelect.value);
});

/* =====================================================================
   CARET LOCK (READ-ONLY)
   ===================================================================== */
function setReadonly(locked) {
  readonlyToggle.setAttribute("aria-pressed", String(locked));
  readonlyToggle.title = "Toggle read-only (Caret Lock)";
  readonlyToggle.setAttribute("aria-label", readonlyToggle.title);
  editor.setAttribute("contenteditable", locked ? "false" : "true");

  if (locked) {
    const sel = window.getSelection();
    if (sel) sel.removeAllRanges();
    savedRange = null;
    editor.blur();
  } else {
    editor.focus();
  }
  updateVectorizeState();
}

readonlyToggle.addEventListener("click", () => {
  const locked = readonlyToggle.getAttribute("aria-pressed") === "true";
  setReadonly(!locked);
});

[
  sizeDec,
  sizeInc,
  lineDec,
  lineInc,
  ruledToggle,
  vectorizeBtn,
  readonlyToggle,
  pngBtn,
  svgBtn,
  newBtn,
  openBtn,
  saveBtn,
  boldBtn,
  italicBtn,
  underlineBtn,
  alignLeftBtn,
  alignCenterBtn,
  alignRightBtn,
].forEach((b) => b.addEventListener("mousedown", (e) => e.preventDefault()));

sizeDec.addEventListener("click", () =>
  commitSize(clampSize(parseFloat(sizeInput.value) - 1))
);
sizeInc.addEventListener("click", () =>
  commitSize(clampSize(parseFloat(sizeInput.value) + 1))
);
lineDec.addEventListener("click", () =>
  setLineHeight(parseFloat(lineInput.value) - 1)
);
lineInc.addEventListener("click", () =>
  setLineHeight(parseFloat(lineInput.value) + 1)
);

/* =====================================================================
   HEX COLORS
   ===================================================================== */
function normalizeHex(raw) {
  let v = raw.trim();
  if (!v.startsWith("#")) v = "#" + v;
  if (/^#[0-9a-fA-F]{3}$/.test(v)) {
    v = "#" + [...v.slice(1)].map((c) => c + c).join("");
  }
  return /^#[0-9a-fA-F]{6}$/.test(v) ? v.toUpperCase() : null;
}

function bindHexInput(input, swatch, cssVar, prefKey) {
  const initial =
    normalizeHex(prefs[prefKey]) || DEFAULT_PREFS[prefKey] || "#FFFFFF";
  input.value = initial;

  const apply = (hex, opts = {}) => {
    document.documentElement.style.setProperty(cssVar, hex);
    swatch.style.background = hex;
    prefs[prefKey] = hex;
    savePrefs();
    if (!opts.silent) markDirty();
  };

  apply(initial, { silent: true });

  input.addEventListener("input", () => {
    const hex = normalizeHex(input.value);
    const complete = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(
      input.value.trim()
    );
    input.classList.toggle("invalid", !hex && input.value.trim() !== "");
    if (hex && complete) apply(hex);
  });

  const finalize = () => {
    const hex = normalizeHex(input.value);
    if (hex) {
      input.value = hex;
      input.classList.remove("invalid");
      apply(hex);
    } else {
      input.value = getComputedStyle(document.documentElement)
        .getPropertyValue(cssVar)
        .trim()
        .toUpperCase();
      input.classList.remove("invalid");
    }
  };

  input.addEventListener("blur", finalize);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      finalize();
      if (editor.isContentEditable) editor.focus();
    }
  });
}

bindHexInput(bgHex, bgSwatch, "--bg", "bgColor");
bindHexInput(fgHex, fgSwatch, "--fg", "fgColor");

/* =====================================================================
   VECTORIZE
   ===================================================================== */
function vectorize(range) {
  if (!editor.isContentEditable) return;
  if (!range || range.collapsed) return;
  if (!editor.contains(range.commonAncestorContainer)) return;

  const raw = captureGlyphs(range, editor, page.getBoundingClientRect());
  const glyphs = raw.filter(
    (g) =>
      g &&
      typeof g.ch === "string" &&
      g.ch.trim() !== "" &&
      Number.isFinite(g.x) &&
      Number.isFinite(g.y) &&
      Number.isFinite(g.fontSize) &&
      g.fontSize > 0
  );
  if (glyphs.length === 0) return;

  range.deleteContents();
  range.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  layer.create(glyphs);
  vectorKeysArmed = false;
  updateVectorizeState();
  markDirty();
}

vectorizeBtn.addEventListener("click", () => {
  vectorize(currentEditorRange() ?? savedRange);
});

/* =====================================================================
   REVERT TO TEXT
   ===================================================================== */
function revertToText(objId) {
  if (!editor.isContentEditable) return;
  const obj = layer.objects.get(objId);
  if (!obj || obj.isGroup) return;

  const text = layer.getText(objId);
  if (text === null) return;
  const first = obj.glyphs[0];
  if (!first) return;

  const span = document.createElement("span");
  span.style.fontFamily = first.fontFamily;
  span.style.fontSize = `${first.fontSize * obj.scaleY}px`;
  span.style.fontWeight = first.fontWeight;
  span.style.fontStyle = first.fontStyle;
  if (first.fill && !first.fill.startsWith("var(")) {
    span.style.color = first.fill;
  }
  span.textContent = text;

  const sel = window.getSelection();
  let range;
  if (sel.rangeCount && editor.contains(sel.anchorNode)) {
    range = sel.getRangeAt(0).cloneRange();
    range.collapse(false);
  } else if (savedRange && editor.contains(savedRange.commonAncestorContainer)) {
    range = savedRange.cloneRange();
    range.collapse(false);
  } else {
    range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
  }
  range.insertNode(span);

  const after = document.createRange();
  after.setStartAfter(span);
  after.collapse(true);
  sel.removeAllRanges();
  sel.addRange(after);
  savedRange = after.cloneRange();

  layer.remove(objId);
  if (editor.isContentEditable) editor.focus();
  updateVectorizeState();
  markDirty();
}

/* =====================================================================
   CONTEXT MENU
   ===================================================================== */
function pointInRange(range, x, y) {
  for (const r of range.getClientRects()) {
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return true;
  }
  return false;
}

function selectWordAt(x, y) {
  const caret = document.caretRangeFromPoint?.(x, y);
  if (!caret || caret.startContainer.nodeType !== Node.TEXT_NODE) return null;
  if (!editor.contains(caret.startContainer)) return null;
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(caret);
  sel.modify("move", "backward", "word");
  sel.modify("extend", "forward", "word");
  const r = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
  if (r && !r.collapsed && pointInRange(r, x, y)) return r;
  sel.removeAllRanges();
  sel.addRange(caret);
  return null;
}

function vectorMenu(obj, x, y) {
  const isMulti = layer.selection.size > 1 && layer.isInSelection(obj.id);
  if (isMulti) {
    return [
      { label: `${layer.selection.size} objects selected`, header: true },
      {
        label: "Merge / Group",
        action: () => {
          layer.group();
          markDirty();
        },
      },
      { separator: true },
      {
        label: "Delete",
        action: () => {
          layer.removeSelected();
          markDirty();
        },
      },
    ];
  }

  const info = layer.info(obj.id);
  const items = [
    {
      label:
        info.layer === "back"
          ? "Layer: Behind text"
          : "Layer: In front of text",
      header: true,
    },
    {
      label: "Bring to Front",
      disabled: info.atTop,
      action: () => {
        layer.bringToFront(obj.id);
        markDirty();
      },
    },
    {
      label: "Bring Forward",
      disabled: info.atTop,
      action: () => {
        layer.forward(obj.id);
        markDirty();
      },
    },
    {
      label: "Send Backward",
      disabled: info.atBottom,
      action: () => {
        layer.backward(obj.id);
        markDirty();
      },
    },
    {
      label: "Send to Back",
      disabled: info.atBottom,
      action: () => {
        layer.sendToBack(obj.id);
        markDirty();
      },
    },
    { separator: true },
  ];

  if (obj.isGroup) {
    items.push({
      label: "Ungroup",
      action: () => {
        layer.ungroup(obj.id);
        markDirty();
      },
    });
    items.push({ separator: true });
  } else if (obj.glyphs.length > 1) {
    const glyphIdx = layer._glyphIndexAt(obj, x, y);
    if (glyphIdx >= 0) {
      items.push({
        label: "Separate this letter",
        action: () => {
          const newId = layer.extractGlyph(obj.id, x, y);
          if (newId !== null) layer.select(newId);
          markDirty();
        },
      });
    }
    items.push({
      label: "Split into Letters",
      action: () => {
        layer.split(obj.id);
        markDirty();
      },
    });
    if (layer.hasMultipleWords(obj.id)) {
      items.push({
        label: "Split into Words",
        action: () => {
          layer.splitWords(obj.id);
          markDirty();
        },
      });
    }
    items.push({ separator: true });
  }

  if (!obj.isGroup) {
    items.push({
      label: "Revert to Text",
      action: () => revertToText(obj.id),
    });
    items.push({ separator: true });
  }

  items.push({
    label: "Delete",
    action: () => {
      layer.remove(obj.id);
      markDirty();
    },
  });
  return items;
}

/* =====================================================================
   TEXT DETECTION (for marquee)
   ===================================================================== */
function isTextAt(x, y) {
  const caret = document.caretRangeFromPoint?.(x, y);
  if (!caret || caret.startContainer.nodeType !== Node.TEXT_NODE) return false;
  if (!editor.contains(caret.startContainer)) return false;
  const node = caret.startContainer;
  const text = node.data;
  if (!text) return false;
  const off = Math.max(0, Math.min(caret.startOffset, text.length - 1));
  const range = document.createRange();
  range.setStart(node, off);
  range.setEnd(node, Math.min(off + 1, text.length));

  const editorRect = editor.getBoundingClientRect();
  const cs = getComputedStyle(editor);
  const padL = parseFloat(cs.paddingLeft) || 0;
  const padR = parseFloat(cs.paddingRight) || 0;
  const contentLeft = editorRect.left + padL;
  const contentRight = editorRect.right - padR;

  for (const r of range.getClientRects()) {
    if (
      y >= r.top - 3 &&
      y <= r.bottom + 3 &&
      x >= contentLeft - 4 &&
      x <= contentRight + 4
    ) {
      return true;
    }
  }
  return false;
}

function placeCaretAt(clientX, clientY) {
  if (!editor.isContentEditable) return;
  editor.focus();

  const sel = window.getSelection();
  sel.removeAllRanges();

  const caret = document.caretRangeFromPoint?.(clientX, clientY);
  if (caret && editor.contains(caret.startContainer)) {
    sel.addRange(caret);
    savedRange = caret.cloneRange();
    return;
  }

  const r = document.createRange();
  r.selectNodeContents(editor);
  r.collapse(false);
  sel.addRange(r);
  savedRange = r.cloneRange();
}

/* =====================================================================
   SMART PUNCTUATION
   -- → —   and   " → " / "   and   ' → ' / '
   Only on beforeinput + insertText; IME/paste skipped.
   ===================================================================== */
const OPEN_CONTEXT = /[\s(\[{«¡¿\-—]/;

editor.addEventListener("beforeinput", (e) => {
  if (!editor.isContentEditable) return;
  if (e.inputType !== "insertText") return;
  const data = e.data;
  if (!data || data.length !== 1) return;

  const sel = window.getSelection();
  if (!sel.rangeCount || !sel.isCollapsed) return;
  const range = sel.getRangeAt(0);
  if (!editor.contains(range.startContainer)) return;
  if (range.startContainer.nodeType !== Node.TEXT_NODE) return;

  const textNode = range.startContainer;
  const offset = range.startOffset;
  const before = textNode.data.slice(0, offset);
  const lastChar = before.slice(-1);

  let replacement = null;
  let charsToDelete = 0;

  if (data === "-" && lastChar === "-") {
    replacement = "\u2014";
    charsToDelete = 1;
  } else if (data === '"') {
    const isOpening = !lastChar || OPEN_CONTEXT.test(lastChar);
    replacement = isOpening ? "\u201C" : "\u201D";
  } else if (data === "'") {
    const isOpening = !lastChar || OPEN_CONTEXT.test(lastChar);
    replacement = isOpening ? "\u2018" : "\u2019";
  }

  if (!replacement) return;

  e.preventDefault();

  try {
    if (charsToDelete > 0) {
      const delRange = document.createRange();
      delRange.setStart(textNode, Math.max(0, offset - charsToDelete));
      delRange.setEnd(textNode, offset);
      delRange.deleteContents();
      const newSel = window.getSelection();
      newSel.removeAllRanges();
      newSel.addRange(delRange);
    }

    const curSel = window.getSelection();
    if (!curSel.rangeCount) return;
    const curRange = curSel.getRangeAt(0);
    if (!curRange.collapsed) return;

    const newTextNode = document.createTextNode(replacement);
    curRange.insertNode(newTextNode);

    const newRange = document.createRange();
    newRange.setStartAfter(newTextNode);
    newRange.collapse(true);
    curSel.removeAllRanges();
    curSel.addRange(newRange);
    savedRange = newRange.cloneRange();
    markDirty();
    updateVectorizeState();
  } catch (err) {
    console.warn("Smart punctuation failed:", err);
  }
});

/* =====================================================================
   MOUSE INTERACTIONS
   ===================================================================== */
let ctxRange = null;

workspace.addEventListener("mousedown", (e) => {
  if (e.button === 2) {
    ctxRange = null;
    const r = currentEditorRange();
    if (r && !r.collapsed && pointInRange(r, e.clientX, e.clientY)) {
      ctxRange = r;
      e.preventDefault();
    }
    return;
  }
  if (e.button !== 0) return;

  const obj = layer.hitTest(e.clientX, e.clientY, { includeBack: e.altKey });

  if (!obj) {
    if (!isTextAt(e.clientX, e.clientY)) {
      e.preventDefault();

      const pr = page.getBoundingClientRect();
      const startClientX = e.clientX;
      const startClientY = e.clientY;
      const startX = startClientX - pr.left;
      const startY = startClientY - pr.top;
      let active = false;
      let rect = null;

      const move = (ev) => {
        const p = page.getBoundingClientRect();
        const curX = ev.clientX - p.left;
        const curY = ev.clientY - p.top;
        const dx = Math.abs(curX - startX);
        const dy = Math.abs(curY - startY);
        if (!active && (dx > 4 || dy > 4)) active = true;
        if (!active) return;
        const l = Math.min(startX, curX);
        const t = Math.min(startY, curY);
        const w = Math.abs(curX - startX);
        const h = Math.abs(curY - startY);
        layer.showMarquee(l, t, w, h);
        rect = { l, t, r: l + w, b: t + h };
      };

      const up = () => {
        layer.hideMarquee();

        if (active && rect) {
          const ids = layer.hitTestRect(rect.l, rect.t, rect.r, rect.b);
          layer.selectMany(ids);
          vectorKeysArmed = true;
        } else {
          layer.deselect();
          vectorKeysArmed = false;
          placeCaretAt(startClientX, startClientY);
        }
      };

      layer.runGesture(move, up);
      return;
    }

    layer.deselect();
    vectorKeysArmed = false;
    return;
  }

  e.preventDefault();

  if ((e.ctrlKey || e.metaKey) && obj.glyphs.length > 1) {
    const newId = layer.extractGlyph(obj.id, e.clientX, e.clientY);
    if (newId !== null) {
      layer.select(newId);
      vectorKeysArmed = true;
      layer.startDrag(newId, e.clientX, e.clientY);
      markDirty();
      return;
    }
  }

  if (!layer.isInSelection(obj.id)) {
    layer.select(obj.id);
  }
  vectorKeysArmed = true;
  layer.startDrag(obj.id, e.clientX, e.clientY);
});

workspace.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  const { clientX: x, clientY: y } = e;

  let range = ctxRange;
  ctxRange = null;

  if (!range) {
    const obj = layer.hitTest(x, y, { includeBack: true });
    if (obj) {
      if (!layer.isInSelection(obj.id)) {
        layer.select(obj.id);
      }
      showMenu(x, y, vectorMenu(obj, x, y));
      return;
    }
    const cur = currentEditorRange();
    range =
      cur && !cur.collapsed && pointInRange(cur, x, y)
        ? cur
        : selectWordAt(x, y);
  }

  layer.deselect();
  vectorKeysArmed = false;
  showMenu(x, y, [
    { label: "Vectorize", disabled: !range, action: () => vectorize(range) },
  ]);
});

workspace.addEventListener("dblclick", (e) => {
  const obj = layer.hitTest(e.clientX, e.clientY, { includeBack: e.altKey });
  if (obj && obj.glyphs.length > 1) {
    e.preventDefault();
    layer.split(obj.id);
    markDirty();
  }
});

let hoverQueued = false;
workspace.addEventListener("mousemove", (e) => {
  if (hoverQueued || document.body.classList.contains("dragging")) return;
  hoverQueued = true;
  const { clientX, clientY, altKey, ctrlKey, metaKey } = e;
  requestAnimationFrame(() => {
    hoverQueued = false;
    const obj = layer.hitTest(clientX, clientY, { includeBack: altKey });
    if (!obj) {
      editor.style.cursor = "";
      return;
    }
    if ((ctrlKey || metaKey) && obj.glyphs.length > 1) {
      editor.style.cursor = "copy";
    } else {
      editor.style.cursor = "move";
    }
  });
});

document.addEventListener("keydown", (e) => {
  if (layer.selection.size === 0) return;
  if (e.target.closest("input, select, textarea")) return;
  if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return;

  if (e.key === "Delete" || (e.key === "Backspace" && vectorKeysArmed)) {
    e.preventDefault();
    layer.removeSelected();
    vectorKeysArmed = false;
    markDirty();
  } else if (e.key === "Escape") {
    layer.deselect();
    vectorKeysArmed = false;
  } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
    layer.deselect();
    vectorKeysArmed = false;
  }
});

/* =====================================================================
   PNG EXPORT (matrix-baked)
   ===================================================================== */
function resolveFallbackFill(fill, fallback) {
  if (!fill) return fallback;
  if (fill === "var(--fg)" || fill.startsWith("var(")) return fallback;
  return fill;
}

function drawEditorText(ctx, glyphs, fallbackFill, scale) {
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  for (const g of glyphs) {
    const fill = resolveFallbackFill(g.fill, fallbackFill);
    ctx.save();
    ctx.font = `${g.fontStyle} ${g.fontWeight} ${g.fontSize}px ${g.fontFamily}`;
    ctx.fillStyle = fill;
    ctx.fillText(g.ch, g.x, g.y);
    ctx.restore();
  }
}

function drawSVGObject(ctx, obj, pageRect, fallbackFill, scale) {
  const texts = obj.el.querySelectorAll("text");
  if (!texts.length) return;
  for (const t of texts) {
    let ctm = null;
    try {
      ctm = t.getScreenCTM();
    } catch {
      ctm = null;
    }
    if (!ctm) continue;

    const l2pA = ctm.a;
    const l2pB = ctm.b;
    const l2pC = ctm.c;
    const l2pD = ctm.d;
    const l2pE = ctm.e - pageRect.left;
    const l2pF = ctm.f - pageRect.top;
    const fa = scale * l2pA;
    const fb = scale * l2pB;
    const fc = scale * l2pC;
    const fd = scale * l2pD;
    const fe = scale * l2pE;
    const ff = scale * l2pF;

    const lx = parseFloat(t.getAttribute("x")) || 0;
    const ly = parseFloat(t.getAttribute("y")) || 0;

    const cs = getComputedStyle(t);
    let fill = cs.fill;
    if (!fill || fill === "none" || fill === "rgba(0, 0, 0, 0)") {
      fill = resolveFallbackFill(t.style.fill, fallbackFill);
    }
    const fontStr = `${cs.fontStyle || "normal"} ${cs.fontWeight || "400"} ${
      cs.fontSize || "16px"
    } ${cs.fontFamily || "sans-serif"}`;

    ctx.save();
    ctx.setTransform(fa, fb, fc, fd, fe, ff);
    ctx.font = fontStr;
    ctx.fillStyle = fill;
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";
    ctx.fillText(t.textContent || "", lx, ly);
    ctx.restore();
  }
}

async function exportPNG() {
  const pr = page.getBoundingClientRect();
  const W = Math.ceil(pr.width);
  const H = Math.ceil(pr.height);
  if (W <= 0 || H <= 0) return;

  const dpr = window.devicePixelRatio || 1;
  const MAX_SIDE = 16384;
  const MAX_PIXELS = 100_000_000;
  let scale = dpr * 2;
  const maxDim = Math.max(W, H);
  if (maxDim * scale > MAX_SIDE) scale = MAX_SIDE / maxDim;
  if (W * H * scale * scale > MAX_PIXELS) {
    scale = Math.sqrt(MAX_PIXELS / (W * H));
  }

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(W * scale));
  canvas.height = Math.max(1, Math.round(H * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not get Canvas 2D context.");

  const rootStyles = getComputedStyle(document.documentElement);
  const bg = rootStyles.getPropertyValue("--bg").trim() || "#FFFFFF";
  const fg = rootStyles.getPropertyValue("--fg").trim() || "#000000";
  try {
    await document.fonts.ready;
  } catch {
    /* yoksay */
  }

  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  if (page.classList.contains("ruled")) {
    const lineH = parseFloat(rootStyles.getPropertyValue("--line-h")) || 23;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.save();
    ctx.globalAlpha = 0.16;
    ctx.fillStyle = fg;
    for (let y = lineH - 1; y < H; y += lineH) ctx.fillRect(0, y, W, 1);
    ctx.restore();
  }

  let editorGlyphs = [];
  try {
    const fullRange = document.createRange();
    fullRange.selectNodeContents(editor);
    editorGlyphs = captureGlyphs(fullRange, editor, pr);
  } catch (err) {
    console.warn("Could not collect editor text:", err);
  }

  for (const item of layer.stack) {
    if (item === "TEXT") {
      drawEditorText(ctx, editorGlyphs, fg, scale);
    } else {
      drawSVGObject(ctx, item, pr, fg, scale);
    }
  }

  await new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) return reject(new Error("Could not generate PNG."));
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `shizu-${stamp()}.png`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
        resolve();
      },
      "image/png"
    );
  });
}

pngBtn.addEventListener("click", async () => {
  try {
    pngBtn.disabled = true;
    await exportPNG();
  } catch (err) {
    console.error(err);
    alert("PNG export failed: " + err.message);
  } finally {
    pngBtn.disabled = false;
  }
});

/* =====================================================================
   SVG EXPORT (lossless, self-contained)
   ===================================================================== */
async function exportSVG() {
  const pr = page.getBoundingClientRect();
  const W = Math.ceil(pr.width);
  const H = Math.ceil(pr.height);
  if (W <= 0 || H <= 0) return;

  const rootStyles = getComputedStyle(document.documentElement);
  const bg = rootStyles.getPropertyValue("--bg").trim() || "#FFFFFF";
  const fg = rootStyles.getPropertyValue("--fg").trim() || "#000000";

  try {
    await document.fonts.ready;
  } catch {
    /* yoksay */
  }

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("xmlns", SVG_NS);
  svg.setAttribute("width", String(W));
  svg.setAttribute("height", String(H));
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);

  const bgRect = document.createElementNS(SVG_NS, "rect");
  bgRect.setAttribute("x", "0");
  bgRect.setAttribute("y", "0");
  bgRect.setAttribute("width", String(W));
  bgRect.setAttribute("height", String(H));
  bgRect.setAttribute("fill", bg);
  svg.appendChild(bgRect);

  if (page.classList.contains("ruled")) {
    const lineH = parseFloat(rootStyles.getPropertyValue("--line-h")) || 23;
    const g = document.createElementNS(SVG_NS, "g");
    g.setAttribute("stroke", fg);
    g.setAttribute("stroke-opacity", "0.16");
    g.setAttribute("stroke-width", "1");
    for (let y = lineH - 1; y < H; y += lineH) {
      const line = document.createElementNS(SVG_NS, "line");
      line.setAttribute("x1", "0");
      line.setAttribute("y1", String(y + 0.5));
      line.setAttribute("x2", String(W));
      line.setAttribute("y2", String(y + 0.5));
      g.appendChild(line);
    }
    svg.appendChild(g);
  }

  let editorGlyphs = [];
  try {
    const fullRange = document.createRange();
    fullRange.selectNodeContents(editor);
    editorGlyphs = captureGlyphs(fullRange, editor, pr);
  } catch (err) {
    console.warn("Could not collect editor text:", err);
  }

  for (const item of layer.stack) {
    if (item === "TEXT") {
      if (editorGlyphs.length === 0) continue;
      const g = document.createElementNS(SVG_NS, "g");
      g.setAttribute("class", "editor-text");
      for (const glyph of editorGlyphs) {
        const t = document.createElementNS(SVG_NS, "text");
        t.setAttribute("x", String(glyph.x));
        t.setAttribute("y", String(glyph.y));
        t.setAttribute("font-family", glyph.fontFamily);
        t.setAttribute("font-size", String(glyph.fontSize));
        t.setAttribute("font-weight", glyph.fontWeight);
        t.setAttribute("font-style", glyph.fontStyle);
        const fill =
          glyph.fill &&
          glyph.fill !== "var(--fg)" &&
          !glyph.fill.startsWith("var(")
            ? glyph.fill
            : fg;
        t.setAttribute("fill", fill);
        t.textContent = glyph.ch;
        g.appendChild(t);
      }
      svg.appendChild(g);
    } else {
      const cloned = item.el.cloneNode(true);
      const origTexts = item.el.querySelectorAll("text");
      const clonedTexts = cloned.querySelectorAll("text");
      origTexts.forEach((origText, i) => {
        const cs = getComputedStyle(origText);
        const ct = clonedTexts[i];
        ct.removeAttribute("class");
        ct.removeAttribute("style");
        ct.setAttribute("fill", cs.fill);
        ct.setAttribute("font-family", cs.fontFamily);
        ct.setAttribute("font-size", cs.fontSize);
        ct.setAttribute("font-weight", cs.fontWeight);
        ct.setAttribute("font-style", cs.fontStyle);
      });
      svg.appendChild(cloned);
    }
  }

  const serializer = new XMLSerializer();
  let svgStr = serializer.serializeToString(svg);
  if (!svgStr.startsWith("<?xml")) {
    svgStr = '<?xml version="1.0" encoding="UTF-8"?>\n' + svgStr;
  }

  const blob = new Blob([svgStr], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `shizu-${stamp()}.svg`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

svgBtn.addEventListener("click", async () => {
  try {
    svgBtn.disabled = true;
    await exportSVG();
  } catch (err) {
    console.error(err);
    alert("SVG export failed: " + err.message);
  } finally {
    svgBtn.disabled = false;
  }
});

/* =====================================================================
   HELPER: TIMESTAMP
   ===================================================================== */
function stamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

/* =====================================================================
   HTML SANITIZER — for editorHTML from .shizu files (XSS defense)
   ===================================================================== */
const OK_TAGS = new Set([
  "SPAN",
  "B",
  "I",
  "U",
  "STRONG",
  "EM",
  "BR",
  "DIV",
  "P",
]);
const OK_STYLE = new Set([
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "color",
  "text-decoration",
  "text-decoration-line",
  "text-align",
]);

function sanitizeEditorHTML(html) {
  const doc = new DOMParser().parseFromString(
    `<body>${html}</body>`,
    "text/html"
  );
  const walk = (n) => {
    for (const c of [...n.childNodes]) {
      if (c.nodeType === Node.TEXT_NODE) continue;
      if (c.nodeType !== Node.ELEMENT_NODE || !OK_TAGS.has(c.tagName)) {
        c.remove();
        continue;
      }
      for (const a of [...c.attributes]) {
        if (a.name !== "style") c.removeAttribute(a.name);
      }
      for (const p of [...c.style]) {
        if (!OK_STYLE.has(p)) c.style.removeProperty(p);
      }
      walk(c);
    }
  };
  walk(doc.body);
  return doc.body.innerHTML;
}

/* =====================================================================
   DOCUMENT LIFECYCLE (.shizu only)
   ===================================================================== */
function confirmDiscard(message = "You have unsaved changes. Continue anyway?") {
  if (!dirty) return true;
  return confirm(message);
}

function newDocument() {
  if (!confirmDiscard("You have unsaved changes. Create a new document anyway?"))
    return;
  _suppressDirty = true;
  try {
    layer.reset();
    editor.innerHTML = "";
    editor.style.textAlign = prefs.textAlign || "left";
    savedRange = null;
    vectorKeysArmed = false;
    setCanvasMode("fluid", { silent: true });
    setReadonly(false);
    updateVectorizeState();
  } finally {
    _suppressDirty = false;
  }
  markClean();
  editor.focus();
}

newBtn.addEventListener("click", newDocument);

openBtn.addEventListener("click", () => {
  if (!confirmDiscard("You have unsaved changes. Open another document anyway?"))
    return;
  openFile.click();
});

openFile.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  openFile.value = "";
  if (!file) return;

  if (!file.name.toLowerCase().endsWith(".shizu")) {
    alert("Only .shizu files are supported.");
    return;
  }

  try {
    const text = await file.text();
    loadShizu(JSON.parse(text));
  } catch (err) {
    console.error(err);
    alert("Could not open file: " + err.message);
  }
});

document.addEventListener("dragover", (e) => {
  if (!e.dataTransfer) return;
  const types = Array.from(e.dataTransfer.types || []);
  if (!types.includes("Files")) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "copy";
});

document.addEventListener("drop", async (e) => {
  if (!e.dataTransfer) return;
  const types = Array.from(e.dataTransfer.types || []);
  if (!types.includes("Files")) return;
  e.preventDefault();

  const file = e.dataTransfer.files?.[0];
  if (!file) return;

  if (!file.name.toLowerCase().endsWith(".shizu")) {
    alert("Only .shizu files are supported.");
    return;
  }

  if (
    !confirmDiscard("You have unsaved changes. Open another document anyway?")
  )
    return;

  try {
    const text = await file.text();
    loadShizu(JSON.parse(text));
  } catch (err) {
    console.error(err);
    alert("Could not open file: " + err.message);
  }
});

function loadShizu(data) {
  if (!data || typeof data !== "object") {
    throw new Error("Invalid .shizu file");
  }
  if (data.format !== SAVE_FORMAT || data.version !== SAVE_VERSION) {
    throw new Error("Unsupported .shizu format or version");
  }

  _suppressDirty = true;
  try {
    editor.innerHTML = sanitizeEditorHTML(data.editorHTML || "");

    if (data.prefs && typeof data.prefs === "object") {
      Object.assign(prefs, data.prefs);
    }
    applyPrefsToUI();

    if (data.canvas) setCanvasMode(data.canvas, { silent: true });

    try {
      if (data.vector) {
        layer.deserialize(data.vector);
      } else {
        layer.reset();
      }
    } catch (err) {
      console.error("Corrupted vector data:", err);
      layer.reset();
      throw new Error("Corrupted vector data");
    }

    savedRange = null;
    vectorKeysArmed = false;
    setReadonly(false);
    updateVectorizeState();
  } finally {
    _suppressDirty = false;
  }

  markClean();
  editor.focus();
}

function saveShizu() {
  const cs = getComputedStyle(editor);
  const docFamily = cs.fontFamily.split(",")[0].replace(/["']/g, "").trim();
  const docSize = parseFloat(cs.fontSize) || prefs.fontSize;

  const data = {
    format: SAVE_FORMAT,
    version: SAVE_VERSION,
    canvas: currentCanvasMode,
    prefs: {
      bgColor: prefs.bgColor,
      fgColor: prefs.fgColor,
      fontFamily: docFamily,
      fontSize: docSize,
      lineHeight: prefs.lineHeight,
      lineHeightManual: prefs.lineHeightManual,
      ruled: prefs.ruled,
      textAlign: prefs.textAlign,
    },
    editorHTML: editor.innerHTML,
    vector: layer.serialize(),
  };
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `shizu-${stamp()}.shizu`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  markClean();
}

saveBtn.addEventListener("click", saveShizu);

/* =====================================================================
   KEYBOARD SHORTCUTS (document + B/I/U)
   ===================================================================== */
document.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  const key = e.key.toLowerCase();

  if (key === "s") {
    e.preventDefault();
    saveShizu();
  } else if (key === "o") {
    e.preventDefault();
    if (
      confirmDiscard("You have unsaved changes. Open another document anyway?")
    )
      openFile.click();
  } else if (key === "n") {
    e.preventDefault();
    newDocument();
  } else if (key === "b") {
    if (!editor.isContentEditable) return;
    e.preventDefault();
    execFormat("bold");
  } else if (key === "i") {
    if (!editor.isContentEditable) return;
    e.preventDefault();
    execFormat("italic");
  } else if (key === "u") {
    if (!editor.isContentEditable) return;
    e.preventDefault();
    execFormat("underline");
  }
});

/* =====================================================================
   TEXT CHANGES → dirty
   ===================================================================== */
editor.addEventListener("input", () => {
  markDirty();
  updateVectorizeState();
});

/* =====================================================================
   INITIALIZATION
   ===================================================================== */
function applyPrefsToUI() {
  document.documentElement.style.setProperty("--bg", prefs.bgColor);
  document.documentElement.style.setProperty("--fg", prefs.fgColor);
  bgSwatch.style.background = prefs.bgColor;
  fgSwatch.style.background = prefs.fgColor;
  bgHex.value = prefs.bgColor;
  fgHex.value = prefs.fgColor;

  defaultSize = prefs.fontSize;
  sizeInput.value = prefs.fontSize;
  editor.style.fontSize = `${prefs.fontSize}px`;
  editor.style.textAlign = prefs.textAlign || "left";

  editor.style.fontFamily = `"${prefs.fontFamily}", sans-serif`;
  if ([...fontSelect.options].some((o) => o.value === prefs.fontFamily)) {
    fontSelect.value = prefs.fontFamily;
  }

  lineHeightManual = !!prefs.lineHeightManual;
  document.documentElement.style.setProperty(
    "--line-h",
    `${prefs.lineHeight}px`
  );
  lineInput.value = prefs.lineHeight;

  if (prefs.ruled) page.classList.add("ruled");
  else page.classList.remove("ruled");
  ruledToggle.setAttribute("aria-pressed", String(prefs.ruled));

  setCanvasMode(prefs.canvas || "fluid", { silent: true });
}

_suppressDirty = true;
applyPrefsToUI();
_suppressDirty = false;

updateFormatButtons();
updateAlignmentButtons();
markClean();
updateVectorizeState();
editor.focus();