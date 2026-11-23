import test from "node:test";
import assert from "node:assert/strict";
import {
  RECOGNITION_WAIT_MS as wait,
  initializeRecognitionRule,
  isRecognizedCorrect,
  latestGradedKind,
  questionProgress,
} from "../assets/numbas/question-progress.js";

const start = Date.UTC(2026, 0, 2);
const event = (kind, offset, questionId) => ({
  kind,
  at: new Date(start + offset).toISOString(),
  ...(questionId === undefined ? {} : { questionId }),
});
const recognized = (records, id = null) => isRecognizedCorrect(records, id, start);

test("最初の正解はすぐ認定し、未回答は認定しない", () => {
  assert.equal(recognized([]), false);
  assert.equal(recognized([event("correct", 1)]), true);
});

test("誤答後は24時間経過してからの正解が必要", () => {
  const wrong = event("wrong", 1);
  const tooEarly = event("correct", wait);
  assert.equal(recognized([wrong, tooEarly]), false);
  // Merely letting time pass does not turn the previous answer into a mark.
  assert.equal(isRecognizedCorrect([wrong, tooEarly], null, start), false);
  assert.equal(recognized([wrong, tooEarly, event("correct", wait + 1)]), true);
});

test("待機中の誤答と解答確認は待機終了時刻を延長しない", () => {
  const records = [event("wrong", 1), event("wrong", 2), event("wrong", 3),
    event("reveal", wait - 1), event("correct", wait + 1)];
  const before = structuredClone(records);
  assert.equal(recognized(records), true);
  assert.deepEqual(records, before);
  assert.equal(records.filter((entry) => entry.kind === "wrong").length, 3);
});

test("正解前の解答確認から24時間待ち、認定後の解答確認では○を維持", () => {
  assert.equal(recognized([event("reveal", 1), event("correct", wait)]), false);
  assert.equal(recognized([event("reveal", 1), event("correct", wait + 1)]), true);
  assert.equal(recognized([event("correct", 1), event("reveal", 2)]), true);
});

test("認定後の誤答で○を外し、新しい待機後の正解で再認定", () => {
  const records = [event("correct", 1), event("wrong", 2)];
  assert.equal(recognized(records), false);
  assert.equal(recognized([...records, event("correct", wait + 1)]), false);
  assert.equal(recognized([...records, event("correct", wait + 2)]), true);
});

test("待機が終わった後の新たな誤答や解答確認は、新しい待機を始める", () => {
  const wrong = [event("wrong", 1), event("wrong", wait + 1)];
  const reveal = [event("wrong", 1), event("reveal", wait + 1)];
  assert.equal(recognized([...wrong, event("correct", wait + 2)]), false);
  assert.equal(recognized([...reveal, event("correct", wait + 2)]), false);
  assert.equal(recognized([...wrong, event("correct", 2 * wait + 1)]), true);
  assert.equal(recognized([...reveal, event("correct", 2 * wait + 1)]), true);
});

test("2問の状態は独立し、古い設問未区別の履歴は混ざらない", () => {
  const records = [event("correct", -1), event("wrong", 1, "q1"),
    event("correct", 2, "q2"), event("reveal", 3, "q1")];
  assert.equal(recognized(records, "q1"), false);
  assert.equal(recognized(records, "q2"), true);
  assert.equal(questionProgress(records, ["q1", "q2"], start), 1);
  records.push(event("correct", wait + 1, "q1"));
  assert.equal(questionProgress(records, ["q1", "q2"], start), 2);
  assert.equal(questionProgress(records, ["q1", "q1"], start), 0);
});

test("導入前の○を維持し、直近の未認定の誤答には待機を引き継ぐ", () => {
  assert.equal(recognized([event("wrong", -100), event("correct", -1)]), true);
  assert.equal(recognized([event("correct", -100), event("reveal", -1)]), true);
  const pending = [event("correct", -100), event("wrong", -1), event("correct", 1)];
  assert.equal(recognized(pending), false);
  assert.equal(recognized([...pending, event("correct", wait - 1)]), true);
  assert.equal(recognized([event("reveal", -1), event("correct", 1)]), false);
});

test("以前の履歴だけなら従来の○表示と一致", () => {
  const kinds = ["wrong", "correct", "reveal"];
  let seed = 42;
  for (let trial = 0; trial < 30000; trial++) {
    const records = [];
    for (let i = 0; i < trial % 9; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      records.push(event(kinds[seed % kinds.length], -10000 + i));
    }
    assert.equal(recognized(records), latestGradedKind(records) === "correct");
  }
  assert.equal(recognized([{ kind: "correct" }]), true);
  assert.equal(recognized([{ kind: "correct" }, { kind: "wrong" }]), false);
});

test("ルールの開始時刻は既存履歴と別に一度だけ保存", () => {
  const values = new Map([["classroom:practice-history:v1:/example", '[{"kind":"correct"}]']]);
  const storage = { getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value) };
  assert.equal(initializeRecognitionRule(storage, start), start);
  assert.equal(initializeRecognitionRule(storage, start + wait), start);
  assert.equal(values.get("classroom:practice-history:v1:/example"), '[{"kind":"correct"}]');
  const blocked = { getItem() { throw new Error("unavailable"); } };
  assert.equal(initializeRecognitionRule(blocked, start), null);
  assert.equal(isRecognizedCorrect([{ kind: "correct" }], null, null), true);
});
