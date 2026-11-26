import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { choiceRetryAttempt, nextOptionalBranch, requiredBranches } from "../assets/numbas/explore-navigation.js";

// The definition order, branch order and numeric ID order all differ.
const parent = "sample-M7";
const parts = [parent, parent + "-S2", parent + "-S10", parent + "-S1"]
  .map((customName) => ({ customName }));
const s1 = { index: 3, label: "同じ見出し" };
const s2 = { index: 1, label: "同じ見出し" };
const s10 = { index: 2, label: "同じ見出し" };

test("任意閲覧は固定IDの数値順に進み、最後から先頭へ戻る", () => {
  const available = Object.freeze([s10, s1, s2]);
  let last = "";
  for (const expected of [s1, s2, s10, s1]) {
    const next = nextOptionalBranch(available, parts, last);
    assert.equal(next, expected);
    last = parts[next.index].customName;
  }
});

test("利用できる分岐が変わっても、直前の固定IDから続きを選ぶ", () => {
  assert.equal(nextOptionalBranch([s10, s1], parts, parent + "-S2"), s10);
  assert.equal(nextOptionalBranch([s2], parts, parent + "-S10"), s2);
  assert.equal(nextOptionalBranch([], parts, parent + "-S1"), undefined);
});

test("今回の誤答だけを固定ID順に生成し、誤答順や同じ分岐先の重複に依存しない", () => {
  const available = [s10, s2, s1];
  const mistake = (branch) => ({ supportId: parts[branch.index].customName });
  assert.deepEqual(requiredBranches(available, parts, []), []);
  assert.deepEqual(requiredBranches(available, parts, [mistake(s2)]), [s2]);
  assert.deepEqual(requiredBranches(available, parts, [mistake(s10), mistake(s1), mistake(s10)]), [s1, s10]);
  assert.deepEqual(requiredBranches(available, parts, [mistake(s2), mistake(s10), mistake(s1)]), [s1, s2, s10]);
  assert.deepEqual(requiredBranches([s1, { ...s1 }, s2], parts, [mistake(s1), mistake(s2)]), [s1, s2]);
});

function retryQuestion(t) {
  const storage = new Map();
  for (const [name, value] of Object.entries({
    location: new URL("https://example.test/questions.html"), window: new EventTarget(),
    sessionStorage: { getItem: (key) => storage.get(key), setItem: (key, data) => storage.set(key, data) },
    Numbas: { jme: { unwrapValue: (answer) => answer } },
  })) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => { if (original) Object.defineProperty(globalThis, name, original); else delete globalThis[name]; });
  }
  function events() {
    const target = new EventTarget();
    return {
      on: (name, fn) => target.addEventListener(name, (event) => fn(event.detail)),
      trigger: (name, detail) => target.dispatchEvent(new CustomEvent(name, { detail })),
    };
  }
  const branches = [{ ...s2 }, { ...s1 }];
  const main = {
    index: 0, type: "1_n_2", shuffleAnswers: [0, 1, 2], numAnswers: 3, marks: 1,
    events: events(), nextParts: branches, getScope: () => ({ getVariable: () => undefined }),
    availableNextParts() { return this.score ? branches : [branches[this.marking_values.interpreted_answer]]; },
    makeNextPart(branch) {
      branch.instance = { index: branch.index, type: "1_n_2", marks: 1, shuffleAnswers: [0, 1, 2],
        previousPart: this, events: events() };
      question.parts.push(branch.instance);
      question.setCurrentPart(branch.instance); // Native Explore selects every newly created part.
      question.events.trigger("addExtraPart", branch.instance);
    },
  };
  const question = {
    parts: [main], currentPart: main, events: events(), exam: { events: events() },
    setCurrentPart(part) { this.currentPart = part; this.events.trigger("setCurrentPart", part); },
  };
  const attempt = choiceRetryAttempt(question, parts, () => false, () => false);
  const whenReady = [];
  question.events.on("classroom:required-parts-ready", () => whenReady.push(question.currentPart));
  attempt.connect();
  function submit(part, choice, score) {
    Object.assign(part, { answered: true, score, credit: score, ticks: [0, 1, 2].map((i) => [i === choice]),
      marking_values: { interpreted_answer: choice } });
    part.events.trigger("post-submit");
  }
  return { storage, branches, main, question, attempt, whenReady, submit };
}

test("再挑戦で正解したら補助を先に生成し、正解した主問題を表示したまま待機を始める", (t) => {
  const { storage, branches, main, question, attempt, whenReady, submit } = retryQuestion(t);
  submit(main, 0, 0);
  submit(main, 1, 0);
  assert.deepEqual(whenReady, []);
  submit(main, 2, 1);
  assert.ok(branches.every((branch) => branch.instance));
  assert.equal(question.currentPart, main);
  assert.deepEqual(whenReady, [main]);
  assert.equal(attempt.next().index, s1.index);
  const saved = JSON.parse([...storage.values()][0]);
  assert.equal(saved.current, parent);
  assert.deepEqual(saved.visited, []);
});

test("補助の誤答はその補助の挑戦にだけ残り、親と別の補助の状態を変えない", (t) => {
  const { branches, main, question, attempt, whenReady, submit } = retryQuestion(t);
  submit(main, 0, 0);
  submit(main, 2, 1);
  const required = branches[0].instance;
  attempt.open(branches[1]);
  const optional = branches[1].instance;
  submit(required, 1, 0);
  // An open support from an older release has only its last marked answer.
  delete attempt.card(required).mistakes;
  assert.equal(attempt.hasMistake(required, 1), true);
  submit(required, 0, 0);
  submit(required, 0, 0);
  assert.deepEqual(attempt.card(required).mistakes, [{ choice: 1 }, { choice: 0 }]);
  assert.equal(attempt.hasMistake(optional, 0), false);
  submit(required, 2, 1);
  submit(optional, 2, 0);
  submit(optional, 1, 1);
  // Explicitly answering an unused choice after completion restarts only this support.
  submit(optional, 0, 0);
  assert.deepEqual(attempt.card(optional).mistakes, [{ choice: 0 }]);
  assert.equal(attempt.hasMistake(required, 0), true);
  assert.deepEqual(attempt.mistakes, [{ choice: 0, supportId: parts[s2.index].customName }]);
  assert.deepEqual(whenReady, [main]);
  assert.equal(question.parts.length, 3);
  assert.equal(main.score, 1);
});

test("第9時限の補助9問は、正解を含まない誤答別の説明を持つ", async () => {
  const url = new URL("../junior-high/grade-1/math/lessons/m1-l009/m1-l009.exam", import.meta.url);
  const raw = await readFile(url, "utf8");
  const exam = JSON.parse(raw.slice(raw.indexOf("\n") + 1));
  const supports = exam.question_groups.flatMap((group) => group.questions.flatMap((q) => q.parts.slice(1)));
  assert.equal(supports.length, 9);
  for (const part of supports) {
    const answer = part.choices[part.matrix.indexOf(1)];
    const wrong = part.distractors.filter((_, i) => part.matrix[i] === 0);
    assert.equal(new Set(wrong).size, 2, part.customName);
    for (const message of wrong) {
      assert.ok(message.startsWith("誤答です。") && message.length > "誤答です。".length, part.customName);
      assert.ok(!message.includes("正解は") && !message.includes(answer), part.customName);
    }
  }
});
