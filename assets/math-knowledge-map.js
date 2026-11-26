import { readLessonPass } from "./numbas/lesson-pass.js";

const difficultySlots = ["basic", "standard", "advanced"].map(level => ({ level, questionId: null }));
const everyRequired = (items, predicate) => items.length > 0 && items.every(predicate);
const stateName = mastered => mastered ? "習得済み" : "未習得";

// The snapshot contains teaching references as well as assessed lessons. Only
// requiredLessons was exported from confirmed small-item rows with the exact marker.
function curriculum(data, base) {
  const children = new Map();
  for (const [id, node] of Object.entries(data.nodes)) {
    if (node.parentId) {
      if (!children.has(node.parentId)) children.set(node.parentId, []);
      children.get(node.parentId).push(id);
    }
  }
  const descriptors = new Map();
  for (const id of new Set(Object.values(data.requiredLessons).flat())) {
    const lesson = data.lessons[id];
    const slots = lesson.mainIds ? lesson.mainIds.map(questionId => ({ level: "basic", questionId })) : difficultySlots;
    if (!lesson.materials.questions) throw new Error("Missing published lesson");
    descriptors.set(id, { lessonId: id, pathname: new URL(lesson.materials.questions, base).pathname, slots });
  }
  function readMastery() {
    const passed = new Set();
    let unreadable = false;
    for (const [id, descriptor] of descriptors) {
      const current = readLessonPass(descriptor).currentlyPassed;
      if (current === true) passed.add(id);
      if (current === null) unreadable = true;
    }
    const mastered = new Map();
    function isMastered(id) {
      if (!mastered.has(id)) {
        const value = data.nodes[id].level === "小項目"
          ? everyRequired(data.requiredLessons[id] || [], lesson => passed.has(lesson))
          : everyRequired(children.get(id) || [], isMastered);
        mastered.set(id, value);
      }
      return mastered.get(id);
    }
    return { isMastered, unreadable };
  }
  function pathTo(id) {
    const path = [];
    for (let at = id; at && data.nodes[at].level !== "分野"; at = data.nodes[at].parentId) path.unshift(at);
    return path;
  }
  return { data, readMastery, pathTo };
}

function element(tag, className, text) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text !== undefined) item.textContent = text;
  return item;
}

function button(text, action) {
  const item = element("button", "", text);
  item.type = "button";
  item.addEventListener("click", action);
  return item;
}

function routeFor(path) {
  return ["#map-cylinder", ...path].join("/");
}

function parseRoute(hash, model) {
  if (hash === "#map-bar") return { mode: "bar", path: [] };
  const [root, ...path] = hash.split("/");
  if (root !== "#map-cylinder" || path.length > 3) return null;
  const nodes = model.data.nodes;
  const valid = path.every((id, index) => {
    const node = nodes[id];
    return /^M\d{3}$/.test(id) && node?.school === "中" &&
      (index === 0 ? model.data.domains.includes(node.parentId) : node.parentId === path[index - 1]);
  });
  return valid ? { mode: "cylinder", path } : null;
}

// Each SVG belongs to its HTML button. It never intercepts pointer or keyboard input.
function rim(top) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("class", top ? "map-cap" : "map-seam");
  svg.setAttribute("viewBox", "0 0 100 12");
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const shape = document.createElementNS(ns, top ? "ellipse" : "path");
  const attrs = top ? { cx: 50, cy: 5.6, rx: 49.6, ry: 5.4, fill: "white", "fill-opacity": ".12" }
    : { d: "M0 2 Q50 18 100 2", fill: "none" };
  for (const [name, value] of Object.entries(attrs)) shape.setAttribute(name, value);
  shape.setAttribute("stroke", "white");
  shape.setAttribute("stroke-opacity", ".48");
  shape.setAttribute("vector-effect", "non-scaling-stroke");
  svg.append(shape);
  return svg;
}

function cylinder(ids, model, single = false) {
  const { data } = model;
  const stack = element("div", single ? "map-stack map-single" : "map-stack");
  stack.style.setProperty("--slices", ids.length);
  // The authoritative array is bottom first. DOM and keyboard order are top first.
  [...ids].reverse().forEach((id, index) => {
    const name = data.nodes[id].name;
    const level = data.nodes[id].level;
    const action = data.orderByParent[id]?.length ? (level === "大項目" ? "中項目を表示" : "小項目を表示") : "対応する教材を表示";
    const band = button("", () => { location.hash = routeFor(model.pathTo(id)); });
    band.className = "map-band";
    band.dataset.node = id;
    band.title = name + "・" + action;
    if (index === 0) band.append(rim(true));
    band.append(element("span", "", name), rim(false));
    stack.append(band);
  });
  return stack;
}

function materials(container, id, model) {
  const { data } = model;
  const lessons = (data.materialLessons[id] || []).filter(key => Object.keys(data.lessons[key].materials).length);
  if (!lessons.length) container.append(element("p", "", "この項目に対応する教材はまだ登録されていません"));
  else {
    const list = element("ul", "map-materials");
    for (const key of lessons) {
      const lesson = data.lessons[key];
      const row = element("li");
      row.append(element("span", "", "中" + lesson.grade + " 第" + Number(key.split("-l")[1]) + "時限　" + lesson.name));
      const links = element("span", "map-links");
      for (const [kind, name] of [["summary", "要約"], ["questions", "問題"], ["lesson", "動画"]]) {
        if (!lesson.materials[kind]) continue;
        const link = element("a", "", name);
        link.href = lesson.materials[kind];
        link.setAttribute("aria-label", lesson.name + "・" + name);
        links.append(link);
      }
      row.append(links);
      list.append(row);
    }
    container.append(list);
  }

  function knowledgeLinks(heading, ids) {
    const list = element("ul", "map-cross");
    for (const next of new Set(ids)) {
      const node = data.nodes[next];
      if (node.school !== "中") {
        // Elementary prerequisites may only open an existing published resource.
        for (const key of data.materialLessons[next] || []) {
          const href = data.lessons[key].materials.summary;
          if (href) addLink(node.name, href);
        }
      } else addLink(node.name, routeFor(model.pathTo(next)));
    }
    function addLink(name, href) {
      const row = element("li");
      const anchor = element("a", "", name);
      anchor.href = href.startsWith("#") ? new URL(href, location.href).href : href;
      row.append(anchor);
      list.append(row);
    }
    if (list.childElementCount) container.append(element("h3", "", heading), list);
  }
  knowledgeLinks("関連知識", data.related.flatMap(([a, b]) => a === id ? [b] : b === id ? [a] : []));
  knowledgeLinks("復習", data.prerequisites.filter(([, target]) => target === id).map(([source]) => source));
}

function cylinderView(content, route, model) {
  const { data } = model;
  const { path } = route;
  if (!path.length) {
    const pillars = element("div", "map-pillars");
    for (const id of data.domains) {
      const section = element("section", "map-pillar");
      section.append(element("h2", "", data.nodes[id].name), cylinder(data.orderByParent[id], model));
      pillars.append(section);
    }
    content.append(pillars);
    return;
  }
  const id = path.at(-1);
  const domain = data.nodes[path[0]].parentId;
  const heading = element("h2", "map-path", [domain, ...path].map(key => data.nodes[key].name).join(" › "));
  heading.tabIndex = -1;
  const back = element("div", "map-back");
  back.append(button("一つ上", () => { location.hash = routeFor(path.slice(0, -1)); }),
    button("4分野へ", () => { location.hash = routeFor([]); }));
  content.append(heading, back);
  const ids = data.orderByParent[id];
  if (ids?.length) content.append(cylinder(ids, model, true));
  else materials(content, id, model);
}

function barView(content, data) {
  for (const id of data.domains) {
    const row = element("section", "map-bar-row");
    const name = data.nodes[id].name;
    row.append(element("h2", "", name));
    const track = element("div", "map-track");
    track.setAttribute("role", "group");
    track.setAttribute("aria-label", name);
    data.barUnits.forEach((unit, index) => {
      if (unit.domain !== id) return;
      const slice = element("span", "map-unit");
      slice.setAttribute("role", "img");
      slice.tabIndex = track.childElementCount ? -1 : 0;
      slice.dataset.unit = index;
      track.append(slice);
    });
    row.append(track);
    content.append(row);
  }
}

// The four tracks are read-only. A tooltip is transient and never changes the URL.
function barTooltips(root, getModel) {
  let active, tip, touch;
  let keyboard = false;
  function hide() {
    active = null;
    tip?.remove();
    tip = null;
  }
  function show(slice) {
    if (slice === active) return;
    hide();
    active = slice;
    const row = slice.closest(".map-bar-row");
    tip = element("span", "map-tip", getModel().data.barUnits[slice.dataset.unit].name);
    tip.setAttribute("aria-hidden", "true");
    row.append(tip);
    const rect = slice.getBoundingClientRect();
    const center = rect.left - row.getBoundingClientRect().left + rect.width / 2;
    tip.style.left = Math.max(0, Math.min(row.clientWidth - tip.offsetWidth, center - tip.offsetWidth / 2)) + "px";
  }
  root.addEventListener("pointerover", event => {
    const slice = event.target.closest(".map-unit");
    if (event.pointerType === "mouse" && slice) show(slice);
  });
  root.addEventListener("pointerout", event => {
    if (event.pointerType === "mouse" && active && !active.contains(event.relatedTarget) && !tip?.contains(event.relatedTarget)) hide();
  });
  document.addEventListener("pointerdown", event => {
    keyboard = false;
    const slice = event.target.closest(".map-unit");
    touch = slice && event.pointerType !== "mouse" ? { slice, id: event.pointerId, x: event.clientX, y: event.clientY } : null;
    if (!slice && !tip?.contains(event.target)) hide();
  });
  root.addEventListener("pointercancel", () => { touch = null; });
  root.addEventListener("pointerup", event => {
    if (touch?.id === event.pointerId && touch.slice === event.target.closest(".map-unit") &&
      Math.hypot(event.clientX - touch.x, event.clientY - touch.y) < 10) show(touch.slice);
    touch = null;
  });
  document.addEventListener("keydown", event => {
    keyboard = true;
    if (event.key === "Escape") hide();
  }, true);
  root.addEventListener("focusin", event => {
    if (keyboard && event.target.matches(".map-unit")) show(event.target);
  });
  root.addEventListener("focusout", event => { if (active === event.target) hide(); });
  root.addEventListener("keydown", event => {
    const slice = event.target.closest(".map-unit");
    if (!slice) return;
    if (["Enter", " "].includes(event.key)) { event.preventDefault(); return; }
    if (!["ArrowRight", "ArrowLeft"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "ArrowRight" ? slice.nextElementSibling : slice.previousElementSibling;
    if (!next) return;
    slice.tabIndex = -1;
    next.tabIndex = 0;
    next.focus();
  });
  return hide;
}

export function mountMap(root) {
  const hub = document.getElementById("grade-selection");
  const title = root.querySelector("h1");
  const content = root.querySelector("[data-map-content]");
  const notice = root.querySelector("[data-notice]");
  let model, request, route, mastery, lastCylinder = [], frame = 0;
  const hideTip = barTooltips(root, () => model);
  function note(text) {
    notice.hidden = !text;
    notice.textContent = text;
  }
  async function loadModel() {
    if (model) return model;
    if (!request) request = (async () => {
      const response = await fetch(root.dataset.source);
      if (!response.ok) throw new Error("Curriculum unavailable");
      const data = await response.json();
      if (data.formatVersion !== 1) throw new Error("Unknown curriculum format");
      model = curriculum(data, document.baseURI);
      return model;
    })().finally(() => { request = null; });
    return request;
  }
  function paint() {
    for (const band of content.querySelectorAll("[data-node]")) {
      const mastered = mastery.isMastered(band.dataset.node);
      band.dataset.mastered = mastered;
      band.setAttribute("aria-label", band.title + "・" + stateName(mastered));
    }
    for (const slice of content.querySelectorAll("[data-unit]")) {
      const unit = model.data.barUnits[slice.dataset.unit];
      const mastered = everyRequired(unit.knowledgeIds, mastery.isMastered);
      slice.dataset.mastered = mastered;
      slice.setAttribute("aria-label", [model.data.nodes[unit.domain].name, unit.name, stateName(mastered)].join("・"));
    }
    note(mastery.unreadable ? "一部の学習履歴を読み取れないため、達成状態を判定できない項目があります。" : "");
  }
  function refresh() {
    if (!model || root.hidden || frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (root.hidden) return;
      mastery = model.readMastery();
      paint();
    });
  }
  async function navigate() {
    const hash = location.hash;
    const open = hash.startsWith("#map-");
    root.hidden = !open;
    hub.hidden = open;
    document.getElementById("math-home").hidden = !open;
    document.getElementById("math-crumb").hidden = open;
    hideTip();
    if (!open) {
      if (route) document.getElementById("map-entry").focus();
      route = mastery = null;
      return;
    }
    try {
      await loadModel();
    } catch {
      if (hash === location.hash) note("達成度のデータを読み込めませんでした。");
      return;
    }
    if (hash !== location.hash) return;
    const previous = route;
    route = parseRoute(hash, model);
    if (!route) {
      history.replaceState(history.state, "", new URL("#map-cylinder", location.href));
      route = { mode: "cylinder", path: [] };
    }
    if (route.mode === "cylinder") lastCylinder = route.path;
    for (const mode of root.querySelectorAll("[data-mode]")) mode.setAttribute("aria-pressed", mode.dataset.mode === route.mode);
    content.replaceChildren();
    if (route.mode === "cylinder") cylinderView(content, route, model);
    else barView(content, model.data);
    mastery ??= model.readMastery();
    paint();
    const returning = previous?.mode === "cylinder" && route.mode === "cylinder" &&
      previous.path.length > route.path.length && route.path.every((id, pos) => id === previous.path[pos]);
    const selected = returning ? content.querySelector('[data-node="' + previous.path[route.path.length] + '"]') : null;
    (selected || content.querySelector(".map-path") || title).focus();
  }

  for (const toggle of root.querySelectorAll("[data-mode]")) toggle.addEventListener("click", () => {
    const hash = toggle.dataset.mode === "bar" ? "#map-bar" : routeFor(lastCylinder);
    if (hash !== location.hash) location.hash = hash;
    else if (!model) void navigate();
  });
  window.addEventListener("hashchange", navigate);
  window.addEventListener("pageshow", refresh);
  window.addEventListener("storage", event => {
    if (!event.key || event.key === "classroom:recognition-rule-start:v1" ||
      event.key.startsWith("classroom:practice-history:v1:") || event.key.startsWith("classroom:lesson-pass:v1:")) refresh();
  });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
  document.addEventListener("classroom:history-changed", refresh);
  void navigate();
}
