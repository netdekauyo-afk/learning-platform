import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createLessonPassTracker, lessonHistoryKey, readLessonPass } from "../assets/numbas/lesson-pass.js";
import { isRecognizedCorrect, mainQuestionSet, RECOGNITION_WAIT_MS as wait } from "../assets/numbas/question-progress.js";

const start = Date.UTC(2026, 10, 26);
const ruleKey = "classroom:recognition-rule-start:v1";
const exam = await readFile(new URL("../junior-high/grade-1/math/lessons/m1-l009/m1-l009.exam", import.meta.url), "utf8");
const { lessonId, ids } = mainQuestionSet(JSON.parse(exam.replace(/^\s*\/\/[^\n]*\r?\n/, "")));
const lesson = {
  lessonId,
  pathname: "/learning-platform/junior-high/grade-1/math/lessons/m1-l009/questions.html",
  slots: ids.map((questionId) => ({ level: "basic", questionId })),
};
const legacy = {
  lessonId: "m1-l001",
  pathname: lesson.pathname.replace(lessonId, "m1-l001"),
  slots: ["basic", "standard", "advanced"].map((level) => ({ level, questionId: null })),
};
const key = (descriptor = lesson, level = "basic") => lessonHistoryKey(descriptor.pathname, level);
const passKey = (descriptor = lesson) => "classroom:lesson-pass:v1:" + descriptor.pathname.replace(/\/questions\.html$/, "");
const at = (offset) => new Date(start + offset).toISOString();
const event = (kind, offset, questionId) => ({ kind, at: at(offset), ...(questionId ? { questionId } : {}) });
const threeMains = () => ids.map((id, index) => event("correct", index + 1, id));

function fixture({ descriptor = lesson, initial = {}, locks = { request: async (_, save) => save() } } = {}) {
  const values = new Map(Object.entries({ [ruleKey]: String(start), ...initial }));
  const writes = [];
  const storage = {
    getItem: (k) => values.get(k) ?? null,
    setItem(k, value) {
      writes.push(k);
      values.set(k, String(value));
    },
  };
  const options = { storage, locks };
  const tracker = createLessonPassTracker(descriptor, options);
  return {
    values, writes, storage, options, tracker,
    put: (rows, level = "basic") => values.set(key(descriptor, level), JSON.stringify(rows)),
    read: (input = descriptor) => readLessonPass(input, options),
    record: () => JSON.parse(values.get(passKey(descriptor)) ?? "null"),
    async submit(row, level = "basic", betweenReads = () => {}) {
      const before = tracker.capture();
      const source = key(descriptor, level);
      const records = [...JSON.parse(storage.getItem(source) ?? "[]"), row];
      storage.setItem(source, JSON.stringify(records));
      betweenReads();
      return tracker.afterSave(before, { key: source, level, records });
    },
  };
}

test("第9時限の認定を0〜3枠まで計算し、3つ目を保存した時刻だけ記録する", async () => {
  const f = fixture();
  f.put([
    event("correct", -10),
    { ...event("correct", -9, ids[1]), lessonId: "m1-l032" },
    { ...event("correct", -8, ids[2]), role: "supplement" },
  ]);
  f.values.set(key() + ":support", JSON.stringify([event("correct", -1, ids[2] + "-S1")]));
  assert.equal(f.read().recognizedCount, 0);
  assert.equal(await f.tracker.restore(), false);

  // A fresh history gives a provable first pass.
  f.values.delete(key());
  for (const [index, row] of threeMains().entries()) {
    assert.equal(await f.submit(row), index === 2);
    const state = f.read();
    assert.equal(state.lessonId, "m1-l009");
    assert.equal(state.recognizedCount, index + 1);
    assert.equal(state.currentlyPassed, index === 2);
    assert.equal(state.hasPassed, index === 2);
    assert.equal(state.firstPassedAt, index === 2 ? row.at : null);
  }
  assert.deepEqual(f.record(), { firstPassedAt: at(3), historyHeads: { basic: [at(1), "correct", ids[0]] } });
  assert.deepEqual(JSON.parse(f.storage.getItem(key())), threeMains());
  assert.equal(f.writes.filter((k) => k === passKey()).length, 1);
});

test("重複正答や補助だけで別の枠を満たさず、2問・章練習・不正な授業IDは対象外", async () => {
  const f = fixture();
  f.put(Array(3).fill(event("correct", 1, ids[0])));
  f.values.set(key() + ":support", JSON.stringify(threeMains()));
  assert.equal(f.read().recognizedCount, 1);
  assert.equal(await f.tracker.afterSave(f.tracker.capture(), {
    key: key() + ":support", level: "basic", records: threeMains(),
  }), false);
  for (const descriptor of [
    { ...lesson, slots: lesson.slots.slice(0, 2) },
    { ...lesson, slots: Array(3).fill(lesson.slots[0]) },
    { ...lesson, pathname: lesson.pathname.replace("/lessons/", "/chapters/") },
    { ...lesson, lessonId: "m1-l010" },
    { ...lesson, slots: [lesson.slots[0], lesson.slots[1], { level: "basic", questionId: "m1-l010-M3" }] },
  ]) {
    assert.equal(f.read(descriptor).status, "out-of-scope");
    assert.equal(createLessonPassTracker(descriptor, f.options), null);
  }
  assert.equal(f.record(), null);
});

test("旧難易度の3枠は別々の既存キーで認定を読み、同じ時限に1件だけ保存する", async () => {
  const f = fixture({ descriptor: legacy });
  for (const [index, { level }] of legacy.slots.entries()) {
    assert.equal(f.read().recognizedCount, index);
    assert.equal(f.read().currentlyPassed, false);
    assert.equal(await f.submit(event("correct", index + 1), level), index === 2);
  }
  assert.deepEqual(f.record(), {
    firstPassedAt: at(3),
    historyHeads: { basic: [at(1), "correct", null], standard: [at(2), "correct", null], advanced: [at(3), "correct", null] },
  });
  assert.equal(f.read().currentlyPassed, true);
  assert.equal(f.read(lesson).hasPassed, false);
});

test("別タブの更新をまたいで読んだ難易度の○を同時成立と扱わない", async () => {
  const f = fixture({ descriptor: legacy });
  f.put([event("correct", 1)]);
  f.put([event("correct", 2)], "standard");
  const getItem = f.storage.getItem;
  f.storage.getItem = (name) => {
    if (name === key(legacy, "advanced")) {
      f.put([event("correct", 1), event("wrong", 3)]);
      f.put([event("correct", 4)], "advanced");
    }
    return getItem(name);
  };
  assert.equal(await f.tracker.restore(), false);
  assert.equal(f.record(), null);
  assert.equal(f.read().recognizedCount, 2);
});

test("誤答で現在の合格が崩れても、再読込みと24時間後の再認定で初回実績を保持する", async () => {
  const f = fixture();
  for (const row of threeMains()) await f.submit(row);
  const original = f.record();
  await f.submit(event("wrong", 10, ids[2]));
  await f.submit(event("reveal", 11, ids[2]));
  await f.submit(event("correct", wait + 9, ids[2]));
  assert.equal(f.read().recognizedCount, 2);
  assert.equal(f.read().currentlyPassed, false);
  assert.equal(f.read().hasPassed, true);
  assert.equal(readLessonPass(lesson, { ...f.options, now: start + wait + 100 }).currentlyPassed, false);
  assert.equal(await createLessonPassTracker(lesson, f.options).restore(), false);
  await f.submit(event("correct", wait + 10, ids[2]));
  await f.submit(event("reveal", wait + 11, ids[2]));
  assert.equal(f.read().currentlyPassed, true);
  assert.deepEqual(f.record(), original);
  assert.equal(f.writes.filter((k) => k === passKey()).length, 1);
});

test("待機中の正解は数えず、認定が一度も成立していない枠の再送で初回日時を確定できる", async () => {
  const f = fixture();
  await f.submit(event("reveal", 10, ids[2]));
  await f.submit(event("wrong", 11, ids[2]));
  await f.submit(event("correct", 12, ids[2]));
  await f.submit(event("correct", 13, ids[0]));
  await f.submit(event("correct", 14, ids[1]));
  assert.equal(f.read().recognizedCount, 2);
  assert.equal(f.record(), null);
  assert.equal(await f.submit(event("correct", 10 + wait, ids[2])), true);
  assert.equal(f.record().firstPassedAt, at(10 + wait));
});

test("旧履歴の3つの○は読取時に導出し、復元しても日時は推測しない", async () => {
  const f = fixture();
  f.values.delete(ruleKey);
  const old = ids.map((id) => ({ questionId: id, kind: "correct" }));
  f.put(old);
  assert.deepEqual(f.read(), {
    lessonId, status: "ok", recognizedCount: 3, currentlyPassed: true,
    hasPassed: true, firstPassedAt: null, persisted: false,
  });
  assert.equal(f.values.has(ruleKey), false);
  assert.equal(f.writes.length, 0);
  assert.equal(await f.tracker.restore(), true);
  assert.equal(f.read().persisted, true);
  assert.equal(f.record().firstPassedAt, null);
  assert.deepEqual(JSON.parse(f.storage.getItem(key())), old);
  assert.equal(f.values.has(ruleKey), false);
  assert.equal(await createLessonPassTracker(lesson, f.options).restore(), false);
  assert.equal(f.writes.filter((k) => k === passKey()).length, 1);
});

test("復元前に誤答を保存したときは、保存直前にすでに揃っていた3枠を記録する", async () => {
  const f = fixture();
  f.put(threeMains());
  assert.equal(await f.submit(event("wrong", 10, ids[0])), true);
  assert.equal(f.read().currentlyPassed, false);
  assert.equal(f.read().hasPassed, true);
  assert.equal(f.record().firstPassedAt, null);
});

test("過去の認定、別方式の履歴、他の難易度の同時更新があれば日時を確定しない", async () => {
  const earlier = fixture();
  earlier.put([...threeMains(), event("wrong", 10, ids[2])]);
  assert.equal(await earlier.submit(event("correct", wait + 10, ids[2])), true);
  assert.equal(earlier.record().firstPassedAt, null);

  const previousMode = fixture();
  previousMode.put(threeMains().slice(0, 2));
  previousMode.put([event("correct", -5)], "standard");
  assert.equal(await previousMode.submit(threeMains()[2]), true);
  assert.equal(previousMode.record().firstPassedAt, null);

  const timed = fixture({ descriptor: legacy });
  timed.put([event("correct", 1)]);
  timed.put([event("correct", 2)], "standard");
  assert.equal(await timed.submit(event("correct", 3), "advanced", () => {
    timed.put([event("correct", 2), event("correct", 3)], "standard");
  }), true);
  assert.equal(timed.record().firstPassedAt, null);
});

test("壊れた履歴は取得不可、不正な認定開始時刻は既存の読取と一致する", async () => {
  const f = fixture();
  assert.equal(f.read().recognizedCount, 0);
  assert.equal(f.read().hasPassed, false);
  f.values.set(key(), "{broken");
  assert.equal(f.read().status, "unavailable");
  assert.equal(f.read().recognizedCount, null);
  assert.equal(f.read().hasPassed, null);
  assert.equal(await f.tracker.restore(), false);
  const history = [...threeMains(), event("wrong", 10, ids[2]), event("correct", 11, ids[2])];
  f.put(history);
  f.values.set(ruleKey, "bad start");
  const expected = ids.filter((id) => isRecognizedCorrect(history, id, null)).length;
  assert.equal(f.read().recognizedCount, expected);
  assert.equal(await f.tracker.restore(), true);
  const receipt = f.storage.getItem(passKey());
  f.values.set(key(), "{}");
  assert.equal(f.read().hasPassed, null);
  assert.equal(await f.tracker.restore(), false);
  assert.equal(f.storage.getItem(passKey()), receipt);
  assert.equal(readLessonPass(lesson, { storage: { getItem() { throw Error("access denied"); } } }).status, "unavailable");
});

test("履歴の先頭が残る一部欠損と、対象キーの空・置換・全消去を区別する", async () => {
  const f = fixture();
  f.put(threeMains());
  await f.tracker.restore();
  f.put(threeMains().slice(0, 1));
  assert.equal(f.read().currentlyPassed, false);
  assert.equal(f.read().hasPassed, true);
  assert.equal(f.read({ ...lesson, slots: lesson.slots.slice(0, 2) }).hasPassed, true);
  f.values.delete(key());
  assert.equal(f.read().hasPassed, false);
  f.put([]);
  assert.equal(f.read().hasPassed, false);
  for (const [index, id] of ids.entries()) await f.submit(event("correct", 101 + index, id));
  assert.equal(f.record().firstPassedAt, at(103));
  f.values.clear();
  assert.equal(f.read().hasPassed, false);
  assert.equal(f.record(), null);
});

test("旧難易度の実績は固定IDへの切替で保持し、根拠キーを消去すると失効する", async () => {
  const f = fixture({ descriptor: legacy });
  for (const [index, { level }] of legacy.slots.entries()) f.put([event("correct", index + 1)], level);
  await f.tracker.restore();
  const converted = { ...legacy, slots: ids.map((_, index) => ({ level: "basic", questionId: `m1-l001-M${index + 1}` })) };
  assert.equal(f.read(converted).recognizedCount, 0);
  assert.equal(f.read(converted).hasPassed, true);
  f.values.delete(key(legacy, "advanced"));
  assert.equal(f.read(converted).hasPassed, false);
});

test("同時に復元しても1件だけ保存し、履歴の消去後に古い処理から復活しない", async () => {
  const f = fixture();
  f.put(threeMains());
  let grant;
  const delayed = createLessonPassTracker(lesson, { ...f.options, locks: {
    request: (_, save) => new Promise((resolve) => { grant = () => resolve(save()); }),
  } });
  let pending = delayed.restore();
  await Promise.resolve();
  assert.equal(typeof grant, "function");
  assert.equal(await f.tracker.restore(), true);
  grant();
  assert.equal(await pending, false);
  assert.equal(f.writes.filter((k) => k === passKey()).length, 1);

  f.values.delete(passKey());
  pending = delayed.restore();
  await Promise.resolve();
  f.values.clear();
  grant();
  assert.equal(await pending, false);
  assert.equal(f.record(), null);
});

test("ロック待ちに誤答が追記されても、保存済みの成立履歴が残れば初回を保存する", async () => {
  let grant;
  const f = fixture({ locks: {
    request: (_, save) => new Promise((resolve) => { grant = () => resolve(save()); }),
  } });
  f.put(threeMains().slice(0, 2));
  const pending = f.submit(threeMains()[2]);
  await Promise.resolve();
  f.put([...threeMains(), event("wrong", 4, ids[2])]);
  assert.equal(typeof grant, "function");
  grant();
  assert.equal(await pending, true);
  assert.equal(f.read().currentlyPassed, false);
  assert.equal(f.record().firstPassedAt, at(3));
});

test("ロックが使えない環境と実績の保存失敗では既存の○と履歴を保つ", async () => {
  const fallback = fixture({ locks: null });
  fallback.put(threeMains().slice(0, 2));
  assert.equal(await fallback.submit(threeMains()[2]), true);
  assert.equal(fallback.record().firstPassedAt, null);
  const failing = fixture();
  failing.put(threeMains());
  const setItem = failing.storage.setItem;
  failing.storage.setItem = () => { throw Error("quota exceeded"); };
  assert.equal(await failing.tracker.restore(), false);
  assert.equal(failing.read().currentlyPassed, true);
  assert.equal(failing.record(), null);
  failing.storage.setItem = setItem;
  assert.equal(await failing.tracker.restore(), true);
  assert.equal(failing.record().firstPassedAt, null);
});

test("授業パス・ブラウザーごとの実績は独立し、学習ホーム設定を参照しない", async () => {
  const f = fixture();
  f.values.set("classroom-study-home-settings", JSON.stringify({ selected: "m1-l001" }));
  f.put(threeMains());
  await f.tracker.restore();
  const separateInstallation = { ...lesson, pathname: lesson.pathname.replace("/learning-platform/", "/different-installation/") };
  assert.equal(f.read(separateInstallation).hasPassed, false);
  assert.equal(fixture().read().hasPassed, false);
  f.values.delete("classroom-study-home-settings");
  assert.equal(f.read().hasPassed, true);
  assert.equal(f.writes.includes("classroom-study-home-settings"), false);
});
