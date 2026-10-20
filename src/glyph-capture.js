// Shizu — DOM seçimini (Range), sayfa koordinatlarında harf betimleyicilerine çevirir.
//
// Her harf için tarayıcının KENDİ yerleşimini (Range.getClientRects) okuruz;
// böylece vektör, metnin bulunduğu yerde birebir aynı konumda ve aynı
// kerning ile belirir. Her harf bağımsız bir betimleyicidir:
//   { ch, x, y, fontFamily, fontSize, fontWeight, fontStyle, fill }
// (x, y = harfin taban çizgisi başlangıcı, sayfa koordinatı)
//
// Not: Adım 3'te harfleri gerçek SVG <path> eğrilerine çevirirken (opentype.js)
// bu betimleyici aynen kalacak; yalnızca çizim katmanı değişecek.

const measureCtx = document.createElement("canvas").getContext("2d");

function ascentOf(cs) {
  measureCtx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  const m = measureCtx.measureText("Hg");
  return m.fontBoundingBoxAscent ?? parseFloat(cs.fontSize) * 0.8;
}

function collectTextNodes(range, editor) {
  const root = range.commonAncestorContainer;
  if (root.nodeType === Node.TEXT_NODE) return editor.contains(root) ? [root] : [];

  const nodes = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) {
    if (editor.contains(n) && range.intersectsNode(n)) nodes.push(n);
  }
  return nodes;
}

export function captureGlyphs(range, editor, pageRect) {
  const editorColor = getComputedStyle(editor).color;
  const probe = document.createRange();
  const glyphs = [];

  for (const node of collectTextNodes(range, editor)) {
    const el = node.parentElement;
    if (!el) continue;

    const cs = getComputedStyle(el);
    const ascent = ascentOf(cs);
    // Varsayılan yazı rengindeki harfler tema rengini (--fg) takip etsin
    const fill = cs.color === editorColor ? "var(--fg)" : cs.color;

    const text = node.data;
    const start = node === range.startContainer ? range.startOffset : 0;
    const end = node === range.endContainer ? range.endOffset : text.length;

    let i = start;
    while (i < end) {
      const len = text.codePointAt(i) > 0xffff ? 2 : 1; // emoji vb. (surrogate pair)
      const from = i;
      i += len;

      const ch = text.slice(from, i);
      if (/\s/.test(ch)) continue; // boşluk/satır sonu vektör olmaz

      probe.setStart(node, from);
      probe.setEnd(node, i);
      const rect = probe.getClientRects()[0];
      if (!rect || (!rect.width && !rect.height)) continue;

      glyphs.push({
        ch,
        x: rect.left - pageRect.left,
        y: rect.top - pageRect.top + ascent,
        fontFamily: cs.fontFamily,
        fontSize: parseFloat(cs.fontSize),
        fontWeight: cs.fontWeight,
        fontStyle: cs.fontStyle,
        fill,
      });
    }
  }

  return glyphs;
}