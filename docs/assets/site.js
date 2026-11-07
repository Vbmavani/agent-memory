// Shared nav and previous/next links for every page of the Agent Memory site.
// Load it as the first thing in <body>: the nav is written in place, so it shows with the page.
// To add a page, add it to PAGES in reading order.
(() => {
  const PAGES = [
    { path: "", label: "Overview", title: "Agent memory, step by step" },
    { path: "learn/", label: "How I learned it", title: "How I learned agent memory" },
    { path: "reference/memory-lab.html", label: "Memory Lab", title: "Agent Memory Lab: types, operations, 12 labs" },
    { path: "reference/words-into-numbers.html", label: "Words → numbers", title: "Words Into Numbers: how text becomes vectors" },
    { path: "reference/how-claude-remembers.html", label: "Memory components", title: "How Claude Remembers: the components of agent memory" },
    { path: "artifacts.html", label: "All artifacts", title: "Every artifact and page from the journey" },
  ];
  const EXTRA = [
    { href: "https://vbmavani.github.io/vector-visuals/", label: "Vector visuals ↗" },
    { href: "https://github.com/Vbmavani/agent-memory", label: "GitHub ↗" },
  ];

  const me = document.currentScript;
  const root = me.src.replace(/assets\/site\.js(\?.*)?$/, "");
  const here = location.href.split(/[?#]/)[0].replace(/index\.html$/, "");
  const url = (p) => root + p;
  const current = PAGES.findIndex((p) => url(p.path) === here);

  const el = (tag, attrs, text) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, v);
    if (text != null) n.textContent = text;
    return n;
  };

  const nav = el("nav", { class: "tk-nav", "aria-label": "Agent Memory pages" });
  const inner = el("div", { class: "tk-nav-in" });
  inner.append(el("a", { class: "tk-brand", href: url("") }, "agent-memory · learning site"));
  const links = el("div", { class: "tk-links" });
  PAGES.forEach((p, i) => {
    const a = el("a", { class: "tk-link", href: url(p.path) }, p.label);
    if (i === current) a.setAttribute("aria-current", "page");
    links.append(a);
  });
  EXTRA.forEach((x) => links.append(el("a", { class: "tk-link", href: x.href }, x.label)));
  inner.append(links);
  nav.append(inner);
  me.after(nav);
  const cur = links.querySelector('[aria-current="page"]');
  if (cur) requestAnimationFrame(() => { links.scrollLeft = cur.offsetLeft - 16; });

  if (current < 0) return;
  const pager = el("nav", { class: "tk-pager", "aria-label": "Previous and next page" });
  const side = (i, dir) => {
    if (i < 0 || i >= PAGES.length) return el("span");
    const a = el("a", { class: "tk-step tk-" + dir, href: url(PAGES[i].path), rel: dir });
    a.append(el("small", null, (dir === "prev" ? "← Previous · " : "Next · ") + (i + 1) + " of " + PAGES.length),
             el("span", null, PAGES[i].title + (dir === "next" ? " →" : "")));
    return a;
  };
  pager.append(side(current - 1, "prev"), side(current + 1, "next"));
  const place = () => document.body.append(pager);
  document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", place) : place();
})();
