import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { representativeProblem, planCandidateWindow } from '../assets/numbas/lesson-preview.js';

async function exam(path) {
  return JSON.parse((await readFile(new URL('../' + path, import.meta.url), 'utf8')).replace(/^\s*\/\/[^\n]*\r?\n/, ''));
}

test('固定IDの教材は最初の主問題を使い、補助・ヒント・正解を混ぜない', async () => {
  const data = await exam('junior-high/grade-1/math/lessons/m1-l009/m1-l009.exam');
  const result = representativeProblem(data, true);
  assert.match(result.prompt, /2本目の矢印/);
  assert.doesNotMatch(result.prompt, /主問題の結果|正解は|ヒント/);
  assert.deepEqual(result.choices, data.question_groups[0].questions[0].parts[0].choices);
});

test('小学算数の固定ID教材と従来の数学の数値問題を表示する', async () => {
  const elementary = representativeProblem(await exam('elementary/grade-2/math/lessons/em2-l001/em2-l001.exam'), true);
  const junior = representativeProblem(await exam('junior-high/grade-1/math/lessons/m1-l001/m1-l001.exam'));
  assert.match(elementary.prompt, /46＋30/);
  assert.equal(elementary.choices.length, 4);
  assert.match(junior.prompt, /5×1/);
  assert.deepEqual(junior.choices, []);
});

test('図・実行時変数・前提となる表が必要な問題は授業名に切り替える', () => {
  const data = (prompt, variables = {}) => ({ question_groups: [{ questions: [{ variables, parts: [{ type: 'numberentry', prompt }] }] }] });
  assert.equal(representativeProblem(data('<p><img src="figure.png"></p>')), null);
  assert.equal(representativeProblem(data('<p>\\(\\var{x} + 1\\)</p>', { x: {} })), null);
  assert.equal(representativeProblem(data('<p>{x} + 1</p>', { x: {} })), null);
  assert.equal(representativeProblem(data('<p>この表の合計を求める。</p>')), null);
  assert.equal(representativeProblem(data('<p data-jme-visible="x">問題</p>')), null);
  assert.equal(representativeProblem(data('<p>問題</p><span hidden>正解は 2</span>')), null);
  assert.equal(representativeProblem(data('<p>このデータの平均を求めなさい。</p>')), null);
});

test('日付表を進行順に並べ、今日を含む前後の授業範囲を選ぶ', () => {
  const lessons = ['a', 'b', 'c', 'd'].map((id) => ({ id }));
  const days = [
    { isoDate: '2026-09-01', dateNumber: 1 }, { isoDate: '2026-10-01', dateNumber: 2 },
    { isoDate: '2026-11-01', dateNumber: 3 }, { isoDate: '2026-12-01', dateNumber: 4 },
  ];
  const schedule = { days, lessons: [
    { id: 'a', startDateNumber: 1, endDateNumber: 1, basis: 'grade-date-number-table' },
    { id: 'b', startDateNumber: 3, endDateNumber: 3, basis: 'grade-date-number-table' },
    { id: 'c', startDateNumber: 2, endDateNumber: 2, basis: 'grade-date-number-table' },
    { id: 'd', startDateNumber: 4, endDateNumber: 4, basis: 'grade-date-number-table' },
  ] };
  const plan = planCandidateWindow(lessons, schedule, { isoDate: '2026-11-01' });
  assert.deepEqual(plan.items.map((item) => item.lesson.id), ['a', 'c', 'b', 'd']);
  assert.equal(plan.items[plan.target].lesson.id, 'b');
  assert.deepEqual(plan.items.slice(plan.start, plan.end + 1).map((item) => item.lesson.id), ['c', 'b', 'd']);
});

test('小学校の月情報は一覧順を守り、日付のない場合も授業を消さない', () => {
  const lessons = ['a', 'b', 'c'].map((id) => ({ id }));
  const schedule = { days: [{ isoDate: '2026-11-01', dateNumber: 1 }, { isoDate: '2026-11-20', dateNumber: 2 }],
    lessons: lessons.map(({ id }) => ({ id, startDateNumber: 1, endDateNumber: 2, basis: 'existing-lesson-month' })) };
  const plan = planCandidateWindow(lessons, schedule, { isoDate: '2026-11-10' });
  assert.deepEqual(plan.items.map((item) => item.lesson.id), ['a', 'b', 'c']);
  assert.equal(plan.items[plan.target].lesson.id, 'b');
  assert.equal(plan.label, '今月ごろの目安');
  assert.equal(planCandidateWindow(lessons, null, null).items.length, 3);
});
