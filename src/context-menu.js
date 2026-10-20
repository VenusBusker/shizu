// Shizu — Sağ tık bağlam menüsü (tek örnek, dinamik içerik)
//
// items: [{ label, action, disabled }, { separator: true }, { label, header: true }]

let menu = null;

function ensureMenu() {
  if (menu) return menu;

  menu = document.createElement("div");
  menu.id = "ctx-menu";
  menu.style.display = "none";
  document.body.appendChild(menu);

  menu.addEventListener("mousedown", (e) => e.preventDefault());
  menu.addEventListener("contextmenu", (e) => e.preventDefault());

  document.addEventListener(
    "mousedown",
    (e) => {
      if (menu.style.display !== "none" && !menu.contains(e.target)) hideMenu();
    },
    true
  );
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideMenu();
  });
  window.addEventListener("blur", hideMenu);
  window.addEventListener("resize", hideMenu);
  window.addEventListener("wheel", hideMenu, { passive: true });

  return menu;
}

export function hideMenu() {
  if (menu) menu.style.display = "none";
}

export function showMenu(x, y, items) {
  const el = ensureMenu();
  el.replaceChildren();

  for (const item of items) {
    if (item.separator) {
      const sep = document.createElement("div");
      sep.className = "ctx-sep";
      el.appendChild(sep);
      continue;
    }

    if (item.header) {
      const h = document.createElement("div");
      h.className = "ctx-header";
      h.textContent = item.label;
      el.appendChild(h);
      continue;
    }

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ctx-item";
    btn.textContent = item.label;
    btn.disabled = !!item.disabled;
    btn.addEventListener("click", () => {
      hideMenu();
      item.action?.();
    });
    el.appendChild(btn);
  }

  el.style.visibility = "hidden";
  el.style.display = "block";
  const { width, height } = el.getBoundingClientRect();
  el.style.left = `${Math.max(4, Math.min(x, window.innerWidth - width - 4))}px`;
  el.style.top = `${Math.max(4, Math.min(y, window.innerHeight - height - 4))}px`;
  el.style.visibility = "visible";
}