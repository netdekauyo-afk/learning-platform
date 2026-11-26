import test from "node:test";
import assert from "node:assert/strict";
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

test("再挑戦で正解したら補助を先に生成し、正解した主問題を表示したまま待機を始める", (t) => {
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
      branch.instance = { index: branch.index };
      question.setCurrentPart(branch.instance); // Native Explore selects every newly created part.
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
  function submit(choice, score) {
    Object.assign(main, { answered: true, score, credit: score, ticks: [0, 1, 2].map((i) => [i === choice]),
      marking_values: { interpreted_answer: choice } });
    main.events.trigger("post-submit");
  }
  submit(0, 0);
  submit(1, 0);
  assert.deepEqual(whenReady, []);
  submit(2, 1);
  assert.ok(branches.every((branch) => branch.instance));
  assert.equal(question.currentPart, main);
  assert.deepEqual(whenReady, [main]);
  assert.equal(attempt.next().index, s1.index);
  const saved = JSON.parse([...storage.values()][0]);
  assert.equal(saved.current, parent);
  assert.deepEqual(saved.visited, []);
});
