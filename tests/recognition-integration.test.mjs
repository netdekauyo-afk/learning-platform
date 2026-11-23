import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { examQuestions, questionIds, RECOGNITION_WAIT_MS as wait } from "../assets/numbas/question-progress.js";

const start = Date.UTC(2026, 0, 2);
const event = (kind, offset, questionId) => ({
  kind,
  at: new Date(start + offset).toISOString(),
  ...(questionId ? { questionId } : {}),
});

class Element {
  constructor() { this.dataset = {}; this.children = []; this.attributes = {}; this.hidden = false; this.textContent = ""; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  append(...items) { this.children.push(...items); }
  after(item) { this.nextElement = item; }
}

class Row {
  constructor(target, exam) {
    this.link = new Element();
    this.link.dataset = { target, published: "true" };
    this.actions = new Element();
    this.dataset = { progressExam: exam };
  }
  querySelector(selector) {
    if (selector.includes('data-kind="questions"')) return this.link;
    if (selector === ".lesson-links") return this.actions;
    return null;
  }
  insertBefore(child) { this.progress = child; }
}

async function withList({ href, rows, difficulty, records, examRaw }, run) {
  const values = new Map(Object.entries({ "classroom:recognition-rule-start:v1": String(start), ...records }));
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)) };
  const listeners = new Map();
  const replacements = {
    localStorage: storage,
    location: { href },
    window: { addEventListener(type, fn) { const group = listeners.get(type) || []; group.push(fn); listeners.set(type, group); } },
    document: {
      body: { hasAttribute: (name) => difficulty && name === "data-difficulty-progress" },
      createElement: () => new Element(),
      querySelectorAll: (selector) => selector === "[data-progress-exam]" ? (difficulty ? [] : rows) :
        selector === ".lesson-item[data-lesson-id]" ? (difficulty ? rows : []) : [],
    },
    fetch: async () => ({ ok: true, text: async () => examRaw }),
  };
  const old = Object.fromEntries(Object.keys(replacements).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(replacements)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  try {
    const moduleFile = new URL("../assets/numbas/lesson-progress.js", import.meta.url);
    const dependency = new URL("../assets/numbas/question-progress.js?v=20261123-recognition", import.meta.url).href;
    const source = (await readFile(moduleFile, "utf8")).replace("./question-progress.js?v=20261123-recognition", dependency);
    await import("data:text/javascript;base64," + Buffer.from(source).toString("base64") + "#" + Math.random());
    const settle = async (ready = () => true) => {
      for (let i = 0; i < 200 && !ready(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
      assert.ok(ready(), "一覧の非同期更新が完了しませんでした");
    };
    await settle();
    await run({ values, listeners, settle });
  } finally {
    for (const [key, descriptor] of Object.entries(old)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}

test("数学の難易度別の○は、それぞれの履歴と24時間判定を使う", async () => {
  const row = new Row("lessons/m1-l001/questions.html");
  const path = "/learning-platform/junior-high/grade-1/math/lessons/m1-l001/questions.html";
  const key = "classroom:practice-history:v1:" + path;
  const basic = [event("wrong", 1), event("correct", 2)];
  await withList({ href: "https://example.test/learning-platform/junior-high/grade-1/math/index.html", rows: [row], difficulty: true,
    records: { [key]: JSON.stringify(basic), [key + ":standard"]: JSON.stringify([event("correct", 2)]),
      [key + ":advanced"]: JSON.stringify([event("wrong", -100), event("correct", -1)]) } }, async ({ values, listeners }) => {
    assert.deepEqual(row.progress.children.map((mark) => mark.textContent), ["", "○", "○"]);
    assert.equal(values.get(key), JSON.stringify(basic));
    values.set(key, JSON.stringify([...basic, event("correct", wait + 1)]));
    for (const callback of listeners.get("pageshow") || []) callback();
    assert.deepEqual(row.progress.children.map((mark) => mark.textContent), ["○", "○", "○"]);
  });
});

test("国語の実教材の2問は、別々の結果を◯・◎へ反映する", async () => {
  const examRaw = await readFile(new URL("../junior-high/grade-1/japanese/lessons/j1-l001/j1-l001.exam", import.meta.url), "utf8");
  const exam = JSON.parse(examRaw.replace(/^\s*\/\/[^\n]*\r?\n/, ""));
  const ids = await questionIds(examQuestions(exam));
  assert.equal(ids.length, 2);
  const row = new Row("lessons/j1-l001/questions.html", "lessons/j1-l001/j1-l001.exam");
  const path = "/learning-platform/junior-high/grade-1/japanese/lessons/j1-l001/questions.html";
  const key = "classroom:practice-history:v1:" + path;
  const records = [event("wrong", 1, ids[0]), event("correct", 2, ids[0]), event("correct", 3, ids[1]), event("reveal", 4, ids[1])];
  await withList({ href: "https://example.test/learning-platform/junior-high/grade-1/japanese/index.html", rows: [row], difficulty: false,
    records: { [key]: JSON.stringify(records) }, examRaw }, async ({ values, listeners, settle }) => {
    const mark = row.link.nextElement;
    await settle(() => mark.textContent === "◯");
    assert.equal(mark.textContent, "◯");
    assert.equal(mark.hidden, false);
    values.set(key, JSON.stringify([...records, event("correct", wait + 1, ids[0])]));
    for (const callback of listeners.get("pageshow") || []) callback();
    await settle(() => mark.textContent === "◎");
    assert.equal(mark.textContent, "◎");
    values.set(key, JSON.stringify([...records, event("correct", wait + 1, ids[0]), event("wrong", wait + 2, ids[1])]));
    for (const callback of listeners.get("pageshow") || []) callback();
    await settle(() => mark.textContent === "◯");
    assert.equal(mark.textContent, "◯");
  });
});
