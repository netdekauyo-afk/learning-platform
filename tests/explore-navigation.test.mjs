import test from "node:test";
import assert from "node:assert/strict";
import { nextOptionalBranch, requiredBranches } from "../assets/numbas/explore-navigation.js";

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
