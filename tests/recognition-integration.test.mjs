import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { examQuestions, questionIds, mainQuestionSet, RECOGNITION_WAIT_MS as wait } from "../assets/numbas/question-progress.js";

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
        selector === ".lesson-item[data-lesson-id]" ? (difficulty ? rows : []) :
        selector === ".lesson-item[data-main-question-set]" ? rows.filter((row) => row.dataset.mainQuestionSet) : [],
    },
    fetch: async () => ({ ok: true, text: async () => examRaw }),
  };
  const old = Object.fromEntries(Object.keys(replacements).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(replacements)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  try {
    const moduleFile = new URL("../assets/numbas/lesson-progress.js", import.meta.url);
    const source = (await readFile(moduleFile, "utf8")).replace(
      /from "(\.\/question-progress\.js[^"]*)"/, (_, dependency) => 'from "' + new URL(dependency, moduleFile).href + '"'
    );
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

test("固定ID式の一覧は教材にある数と種類を使い、補助・旧正答を数えない", async () => {
  const raw = await readFile(new URL("../junior-high/grade-1/math/lessons/m1-l009/m1-l009.exam", import.meta.url), "utf8");
  const exam = JSON.parse(raw.slice(raw.indexOf("\n") + 1));
  const set = mainQuestionSet(exam);
  const row = new Row("lessons/m1-l009/questions.html");
  row.dataset.lessonId = set.lessonId;
  row.dataset.mainQuestionSet = "lessons/m1-l009/m1-l009.exam";
  const key = "classroom:practice-history:v1:/learning-platform/junior-high/grade-1/math/" + row.link.dataset.target;
  const [a, b, c] = set.ids;
  await withList({ href: "https://example.test/learning-platform/junior-high/grade-1/math/", rows: [row], difficulty: true, examRaw: raw,
    records: { [key]: JSON.stringify([event("correct", 1), event("wrong", 2, a), event("correct", 3, b), event("correct", 4, a)]),
      [key + ":support"]: JSON.stringify([event("correct", 4, a + "-S1"), event("wrong", 4, b + "-S3"), event("correct", 5, c + "-S2")]) } },
  async ({ settle }) => {
    await settle(() => !!row.progress);
    assert.deepEqual(row.progress.children.map((mark) => mark.textContent), ["", "○", ""]);
    assert.equal(row.progress.attributes["aria-label"], "確認未正解、文章題正解、使い分け未正解");
  });
});

test("別の授業では固定ID、主問題数、補助問題数をその教材から決定する", () => {
  const part = (customName) => ({ useCustomName: true, customName, marks: 1 });
  const q = (name, names) => ({ name, partsMode: "explore", parts: names.map(part) });
  const questions = [q("M8 読み取り", ["geo-X-M8"]), q("M2 比較", ["geo-X-M2", "geo-X-M2-S7"])];
  const exam = { name: "geo-X 別科目", question_groups: [{ questions }] };
  assert.deepEqual(mainQuestionSet(exam).ids, ["geo-X-M8", "geo-X-M2"]);
  assert.deepEqual(mainQuestionSet(exam).mains.map((m) => m.label), ["読み取り", "比較"]);
  questions[1].parts[1].customName = "geo-X-M8-S7";
  assert.throws(() => mainQuestionSet(exam));
});

test("科目の標準名は教材の種類名を優先し、固定ID・実問数・従来の履歴IDを保つ", async () => {
  const { subjectQuestionTypes, questionTypeLabel } = await import("../assets/numbas/question-progress.js");
  const math = subjectQuestionTypes("/junior-high/grade-2/math/lessons/any/questions.html");
  const social = subjectQuestionTypes("/junior-high/grade-1/social/");
  assert.deepEqual(math, ["確認", "文章題", "使い分け"]);
  assert.deepEqual(social, ["知識", "理解", "資料読解"]);
  const part = (id) => ({ marks: 1, useCustomName: true, customName: id });
  const q = (name, id) => ({ name, partsMode: "explore", parts: [part(id)] });
  const exam = { name: "ex-A 地域のくらし", question_groups: [{ questions: [
    q("地域のくらし", "ex-A-M3"), q("M1 史料の比較", "ex-A-M1")
  ] }] };
  const ids = await questionIds(examQuestions(exam));
  const set = mainQuestionSet(exam, social);
  assert.deepEqual(set.mains.map((m) => m.label), ["資料読解", "史料の比較"]);
  assert.deepEqual(set.ids, ["ex-A-M3", "ex-A-M1"]);
  assert.equal(questionTypeLabel({ name: "地域のくらし（地図）" }, 0, false, { defaults: social }), "地図");
  assert.equal(questionTypeLabel({ name: "観察" }, 1, false, { defaults: social, examName: exam.name }), "観察");
  assert.equal(questionTypeLabel({ name: "" }, 1, false, { defaults: social }), "理解");
  assert.equal(questionTypeLabel({ name: "" }, 3, false, { defaults: social }), "問題4");
  assert.deepEqual(subjectQuestionTypes("/junior-high/grade-1/japanese/"), []);
  assert.equal(questionTypeLabel({ name: "漢字" }, 1, false, { defaults: [] }), "漢字");
  exam.question_groups[0].questionNames = ["史料の比較と根拠の説明", ""];
  assert.deepEqual(mainQuestionSet(exam, social).mains.map((m) => m.label), ["史料の比較と根拠の説明", "史料の比較"]);
  assert.deepEqual(await questionIds(examQuestions(exam)), ids);
});
