import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createKnowledgeMastery } from "../assets/math-knowledge-map.js";

const map = JSON.parse(await readFile(new URL("../assets/math-knowledge-map.json", import.meta.url), "utf8"));
const assess = createKnowledgeMastery(map);
const leaf = { level: "小項目" };
const required = (source, target) => [source, target, "必須", "未確認"];

test("実データで後続の時限合格からだけ必須前提を何段も遡り、直接習得を優先する", () => {
  const lessons = new Set(map.requiredLessons.M128);
  const states = assess(lessons);
  assert.equal(states.get("M128"), "習得済み");
  assert.equal(states.get("M123"), "推定習得済み");
  assert.equal(states.get("M107"), "推定習得済み"); // M107 → M123 → M128
  for (const id of map.requiredLessons.M123) lessons.add(id);
  assert.equal(assess(lessons).get("M123"), "習得済み");
  lessons.delete("m1-l060");
  assert.equal(assess(lessons).get("M128"), "未習得");
  assert.equal(assess(lessons).get("M107"), "推定習得済み");
  assert.equal(assess(new Set()).get("M107"), "未習得");
});

test("共有する時限と別の推定経路を現在の合格集合ごとに再評価する", () => {
  const lessons = new Set(["m1-l010"]);
  assert.equal(assess(lessons).get("M088"), "推定習得済み"); // M089 is directly mastered.
  lessons.add("m1-l009");
  assert.equal(assess(lessons).get("M088"), "習得済み");
  const twoRoots = new Set([...map.requiredLessons.M125, ...map.requiredLessons.M130]);
  assert.equal(assess(twoRoots).get("M124"), "推定習得済み");
  twoRoots.delete("m1-l051");
  assert.equal(assess(twoRoots).get("M124"), "推定習得済み");
  twoRoots.delete("m2-l018");
  assert.equal(assess(twoRoots).get("M124"), "未習得");
});

test("必須だけを逆に遡り、推奨・関連・順方向を経由しない", () => {
  const evaluate = createKnowledgeMastery({
    nodes: Object.fromEntries(["A", "B", "C", "D", "E", "F", "G"].map(id => [id, leaf])),
    requiredLessons: { D: ["lesson"] },
    prerequisites: [
      required("A", "B"), ["B", "C", "推奨", "確認済"], required("C", "D"),
      required("D", "E"), required("F", "G"),
    ],
    related: [["D", "G"]],
  });
  const states = evaluate(new Set(["lesson"]));
  assert.equal(states.get("C"), "推定習得済み");
  for (const id of ["A", "B", "E", "F", "G"]) assert.equal(states.get(id), "未習得");
});

test("1万段以上の必須関係・重複・循環で打ち切りや無限処理が起きない", () => {
  const ids = Array.from({ length: 12001 }, (_, index) => String(index));
  const edges = ids.slice(1).map((id, i) => required(ids[i], id));
  edges.push(required("1", "0"), required("1", "2"), required("X", "Y"), required("Y", "X"));
  const evaluate = createKnowledgeMastery({
    nodes: Object.fromEntries([...ids, "X", "Y"].map(id => [id, leaf])),
    requiredLessons: { [ids.at(-1)]: ["lesson"] },
    prerequisites: edges,
  });
  const states = evaluate(new Set(["lesson"]));
  assert.equal(states.get(ids.at(-1)), "習得済み");
  assert.ok(ids.slice(0, -1).every(id => states.get(id) === "推定習得済み"));
  assert.equal(states.get("X"), "未習得");
  assert.equal(states.get("Y"), "未習得");
});

test("中・大項目の集計と、上位項目を端点に持つ必須辺を区別する", () => {
  const evaluate = createKnowledgeMastery({
    nodes: {
      big: { level: "大項目" },
      mid: { level: "中項目", parentId: "big" },
      a: { ...leaf, parentId: "mid" },
      b: { ...leaf, parentId: "mid" },
      other: { level: "中項目", parentId: "big" },
      c: { ...leaf, parentId: "other" },
      end: leaf, beforeParent: leaf, beforeBlue: leaf,
      empty: { level: "中項目" },
    },
    requiredLessons: { a: ["la"], b: ["lb"], c: ["lc"], end: ["le"] },
    prerequisites: [
      required("a", "end"), required("mid", "end"),
      required("beforeParent", "mid"), required("beforeBlue", "other"),
    ],
  });
  const onlyEnd = evaluate(new Set(["le"]));
  assert.equal(onlyEnd.get("a"), "推定習得済み");
  assert.equal(onlyEnd.get("beforeParent"), "推定習得済み");
  assert.equal(onlyEnd.get("b"), "未習得"); // An edge to mid does not grant its children.
  assert.equal(onlyEnd.get("mid"), "未習得");
  const mixed = evaluate(new Set(["le", "lb", "lc"]));
  assert.equal(mixed.get("mid"), "推定習得済み");
  assert.equal(mixed.get("big"), "推定習得済み");
  assert.equal(mixed.get("beforeBlue"), "推定習得済み"); // other is blue by aggregation.
  assert.equal(mixed.get("empty"), "未習得");
  const all = evaluate(new Set(["le", "la", "lb", "lc"]));
  assert.equal(all.get("mid"), "習得済み");
  assert.equal(all.get("big"), "習得済み");
});

test("現行の未対応項目と子のない中項目は全時限合格でも灰色", () => {
  const states = assess(new Set(Object.keys(map.lessons)));
  for (const id of ["M186", "M237", "M332", "M333"]) assert.equal(states.get(id), "未習得");
  for (const id of Object.keys(map.requiredLessons)) assert.equal(states.get(id), "習得済み");
});
