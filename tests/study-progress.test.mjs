import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { examQuestions, questionIds } from '../assets/numbas/question-progress.js';

const commonSource = await readFile(new URL('../assets/curriculum-page.js', import.meta.url), 'utf8');
const loaderSource = await readFile(new URL('../assets/numbas/loader.js', import.meta.url), 'utf8');
const SETTINGS = 'classroom-study-home-settings';

function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

function common({ settings = {}, ids = ['s1-l027', 's1-l028', 's1-l050'], order = ['s1-l027', 's1-l050', 's1-l028'], waitForList } = {}) {
  const localStorage = storage({ [SETTINGS]: JSON.stringify(settings) });
  const sessionStorage = storage();
  const rows = ids.map((id, index) => ({ dataset: { lessonId: id, seq: String(index + 1) } }));
  const context = {
    URL, localStorage, sessionStorage,
    location: new URL('https://example.test/learning-platform/study-home/'),
    DOMParser: class { parseFromString() { return { querySelectorAll: () => rows }; } },
    fetch: async (url) => {
      if (String(url).endsWith('/science/')) {
        if (waitForList) await waitForList;
        return { ok: true, text: async () => '<main></main>' };
      }
      if (String(url).endsWith('junior-high-grade-1-timing.json')) return {
        ok: true,
        json: async () => ({ version: 1, school: 'junior-high', grade: 1,
          days: order.map((id, index) => ({ dateNumber: index + 1, science: [id] })) }),
      };
      throw new Error('unexpected fetch: ' + url);
    },
  };
  vm.runInNewContext(commonSource, context, { filename: 'curriculum-page.js' });
  return { api: context.ClassroomStudyProgress, localStorage, sessionStorage };
}

test('明示した授業選択はその科目だけを更新し、既存設定を保持する', () => {
  const { api } = common({ settings: { lessons: { '1:math': 'm1-l025', '1:science': 's1-l027' },
    startModes: { '1:math': 'list' }, destination: 'summary', anotherSetting: { keep: true } } });
  assert.equal(api.chooseLesson('1', 'math', 'm1-l026', 'questions'), true);
  const result = api.read();
  assert.equal(result.lessons['1:math'], 'm1-l026');
  assert.equal(result.lessons['1:science'], 's1-l027');
  assert.equal(result.startModes['1:math'], 'lesson');
  assert.equal(result.destination, 'summary');
  assert.equal(result.anotherSetting.keep, true);
});

test('一覧の通常閲覧では位置を変えず、選び直し操作の次の選択だけを保存する', () => {
  const { api } = common({ settings: { lessons: { '1:math': 'm1-l025' }, startModes: { '1:math': 'lesson' } } });
  assert.equal(api.consumeListChoice('1', 'math', 'm1-l010', 'summary'), false);
  assert.equal(api.read().lessons['1:math'], 'm1-l025');
  assert.equal(api.beginListChoice('1', 'math'), true);
  assert.equal(api.consumeListChoice('1', 'science', 's1-l001', 'summary'), false);
  assert.equal(api.consumeListChoice('1', 'math', 'm1-l010', 'summary'), true);
  assert.equal(api.read().lessons['1:math'], 'm1-l010');
  assert.equal(api.read().startModes['1:math'], 'lesson');
  assert.equal(api.read().destination, 'summary');
  assert.equal(api.consumeListChoice('1', 'math', 'm1-l011', 'questions'), false);
});

test('授業を選ばず一覧から離れた後の復習では位置を変えない', () => {
  const location = new URL('https://example.test/learning-platform/junior-high/grade-1/math/');
  const listeners = {};
  const window = { location, addEventListener: (name, callback) => { listeners[name] = callback; } };
  const localStorage = storage({ [SETTINGS]: JSON.stringify({ lessons: { '1:math': 'm1-l025' } }) });
  const context = { URL, location, window, localStorage, sessionStorage: storage(),
    document: { currentScript: null, querySelectorAll: () => [], querySelector: () => null, getElementById: () => null } };
  vm.runInNewContext(commonSource, context);
  const api = context.ClassroomStudyProgress;
  assert.equal(api.beginListChoice('1', 'math'), true);
  listeners.pagehide();
  assert.equal(api.consumeListChoice('1', 'math', 'm1-l010', 'summary'), false);
  assert.equal(api.read().lessons['1:math'], 'm1-l025');
});

test('壊れた設定を空データで上書きしない', () => {
  const { api, localStorage } = common();
  localStorage.setItem(SETTINGS, '{broken');
  assert.equal(api.chooseLesson('1', 'math', 'm1-l026'), false);
  assert.equal(localStorage.getItem(SETTINGS), '{broken');
});

test('正答後は一覧順ではなく日付対応表の順に進む', async () => {
  const key = '1:science';
  const { api } = common({ settings: { lessons: { [key]: 's1-l027' }, startModes: { [key]: 'lesson' },
    studyProgressV1: { [key]: { revision: 4, pending: { revision: 4 } } } } });
  assert.equal(await api.resolvePending('1', 'science'), true);
  assert.equal(api.read().lessons[key], 's1-l050');
  assert.equal(api.read().studyProgressV1[key].pending, null);
  assert.equal(await api.resolvePending('1', 'science'), false);
  assert.equal(api.read().lessons[key], 's1-l050');
});

test('更新中に本人が変更した位置を古い正答で上書きしない', async () => {
  let unblock;
  const waitForList = new Promise((resolve) => { unblock = resolve; });
  const key = '1:science';
  const { api } = common({ waitForList, settings: { lessons: { [key]: 's1-l027' },
    studyProgressV1: { [key]: { revision: 2, pending: { revision: 2 } } } } });
  const resolving = api.resolvePending('1', 'science');
  assert.equal(api.chooseLesson('1', 'science', 's1-l028'), true);
  unblock();
  assert.equal(await resolving, false);
  assert.equal(api.read().lessons[key], 's1-l028');
});

test('最後の授業は保持し、順番が不明なら勝手に進めない', async () => {
  const key = '1:science';
  const initial = (id) => ({ lessons: { [key]: id }, studyProgressV1: { [key]: { revision: 0, pending: { revision: 0 } } } });
  const last = common({ settings: initial('s1-l028') });
  assert.equal(await last.api.resolvePending('1', 'science'), true);
  assert.equal(last.api.read().lessons[key], 's1-l028');
  assert.equal(last.api.read().studyProgressV1[key].completed, true);
  const incomplete = common({ settings: initial('s1-l027'), order: ['s1-l027', 's1-l050'] });
  assert.equal(await incomplete.api.resolvePending('1', 'science'), true);
  assert.equal(incomplete.api.read().lessons[key], 's1-l027');
  assert.equal(incomplete.api.read().studyProgressV1[key].needsChoice, true);
});

test('実際の国語教材の設問IDと２問構成を確認してから進む', async () => {
  const raw = await readFile(new URL('../junior-high/grade-1/japanese/lessons/j1-l001/j1-l001.exam', import.meta.url), 'utf8');
  const exam = JSON.parse(raw.replace(/^\s*\/\/[^\n]*\r?\n/, ''));
  const ids = await questionIds(examQuestions(exam));
  const key = '1:japanese';
  const settings = { lessons: { [key]: 'j1-l001' }, studyProgressV1: { [key]: { revision: 1, pending: {
    revision: 1, ids, source: 'https://example.test/learning-platform/junior-high/grade-1/japanese/lessons/j1-l001/j1-l001.exam',
  } } } };
  const localStorage = storage({ [SETTINGS]: JSON.stringify(settings) });
  const rows = ['j1-l001', 'j1-l002'].map((id, index) => ({ dataset: { lessonId: id, seq: String(index + 1) } }));
  const context = { URL, localStorage, sessionStorage: storage(), __questionModule: async () => ({ examQuestions, questionIds }),
    location: new URL('https://example.test/learning-platform/study-home/'),
    DOMParser: class { parseFromString() { return { querySelectorAll: () => rows }; } },
    fetch: async (url) => {
      if (String(url).endsWith('.exam')) return { ok: true, text: async () => raw };
      if (String(url).endsWith('/japanese/')) return { ok: true, text: async () => '<main></main>' };
      if (String(url).endsWith('junior-high-grade-1-timing.json')) return { ok: true, json: async () => ({
        version: 1, school: 'junior-high', grade: 1, days: [
          { dateNumber: 1, japanese: ['j1-l001'] }, { dateNumber: 2, japanese: ['j1-l002'] },
        ],
      }) };
      throw Error('unexpected fetch ' + url);
    },
  };
  const source = commonSource.replace('await import(new URL("assets/numbas/question-progress.js?v=20261123-shared", root).href)', 'await globalThis.__questionModule()');
  vm.runInNewContext(source, context);
  assert.equal(await context.ClassroomStudyProgress.resolvePending('1', 'japanese'), true);
  assert.equal(context.ClassroomStudyProgress.read().lessons[key], 'j1-l002');
});

function loaderHarness({ subject = 'math', lessonId = 'm1-l025', level = 'basic', sequence = false, explore = false } = {}) {
  const key = `1:${subject}`;
  const localStorage = storage({ [SETTINGS]: JSON.stringify({ lessons: { [key]: lessonId }, startModes: { [key]: 'lesson' } }) });
  const historyKey = 'classroom:practice-history:v1:/learning-platform/junior-high/grade-1/' + subject + '/lessons/' + lessonId + '/questions.html' + (level === 'basic' ? '' : ':' + level);
  const host = { dataset: sequence ? { sequenceSource: './' + lessonId + '.exam', historyQuestionIds: JSON.stringify(['q1', 'q2']) } : {},
    dispatchEvent: () => true, contains: () => true };
  let resolved = 0;
  const stub = {
    initializeRecognitionRule: () => 0, canRecordRepeatedCorrect: () => false,
    bindSelectedChoiceRetry: () => {}, prepareAnswerControl: () => {}, hasCheckedAnswer: () => false,
    setExerciseLanguage: () => {}, createDifficultyTabs: () => {}, applyExerciseSettings: () => {},
    latestGradedKind: (records, id) => records.filter((r) => r.questionId === id && ['correct', 'wrong'].includes(r.kind)).at(-1)?.kind || null,
  };
  let source = loaderSource.replace(/^import .*;\s*$/gm, '');
  source = source.replace(/const studyProgressReady = import\([\s\S]*?return null; \}\);/, 'const studyProgressReady = Promise.resolve({ resolvePending: () => { globalThis.__resolved++; } });');
  source = source.replaceAll('import.meta.url', "'https://example.test/learning-platform/assets/numbas/loader.js'");
  source = source.slice(0, source.lastIndexOf('\nboot().catch'));
  source = 'const { initializeRecognitionRule, canRecordRepeatedCorrect, bindSelectedChoiceRetry, latestGradedKind, prepareAnswerControl, hasCheckedAnswer, setExerciseLanguage, createDifficultyTabs, applyExerciseSettings } = globalThis.__stub;\n' + source;
  source = source.replace('export async function bootExam', 'async function bootExam') + '\nglobalThis.__install = installPracticeReview;';
  const context = { URL, localStorage, __stub: stub, __resolved: 0, CustomEvent: class {},
    location: new URL('https://example.test/learning-platform/junior-high/grade-1/' + subject + '/lessons/' + lessonId + '/questions.html'),
    document: { querySelector: () => null, getElementById: () => null, createElement: () => ({}) },
    fetch: async () => ({ ok: false }), console, setTimeout, clearTimeout,
  };
  vm.runInNewContext(source, context, { filename: 'loader-test.js' });
  async function part(questionId) {
    host.dataset.historyQuestionId = questionId || '';
    function makePart(path) {
      const handlers = {};
      const value = { type: 'test', path, marks: 1, answered: true, score: 0,
        display: { studentAnswer: () => 'answer' }, events: { on: (event, callback) => { (handlers[event] ||= []).push(callback); } } };
      return { value, submit(score) { value.score = score; for (const fn of handlers['post-submit'] || []) fn(); } };
    }
    const primary = makePart('p0');
    const questionEvents = {};
    const question = { parts: [primary.value], partsMode: explore ? 'explore' : 'all',
      events: { on: (event, callback) => { questionEvents[event] = callback; } } };
    const exam = { exam: { questionList: [question] } };
    await context.__install(exam, host, historyKey, level);
    return { submit: primary.submit, addSupport() {
      const support = makePart('p1');
      question.parts.push(support.value);
      questionEvents.addExtraPart(support.value);
      return support;
    } };
  }
  return { key, host, localStorage, historyKey, part, context };
}

test('基礎の誤答では進まず、正答した場合だけ更新を予約する', async () => {
  const h = loaderHarness();
  const p = await h.part();
  p.submit(0);
  assert.equal(JSON.parse(h.localStorage.getItem(SETTINGS)).studyProgressV1, undefined);
  p.submit(1);
  assert.equal(JSON.parse(h.localStorage.getItem(SETTINGS)).studyProgressV1[h.key].pending.revision, 0);
  assert.deepEqual(JSON.parse(h.localStorage.getItem(h.historyKey)).map((r) => r.kind), ['wrong', 'correct']);
});

test('標準問題の正答では共通の再開位置を進めない', async () => {
  const h = loaderHarness({ level: 'standard' });
  const p = await h.part();
  p.submit(1);
  assert.equal(JSON.parse(h.localStorage.getItem(SETTINGS)).studyProgressV1, undefined);
  assert.equal(JSON.parse(h.localStorage.getItem(h.historyKey))[0].kind, 'correct');
});

test('補助問題の正答では進まず、主問題の正答は補助問題の誤答に妨げられない', async () => {
  const h = loaderHarness({ explore: true });
  const primary = await h.part();
  primary.submit(0);
  const support = primary.addSupport();
  support.submit(1);
  assert.equal(JSON.parse(h.localStorage.getItem(SETTINGS)).studyProgressV1, undefined);
  assert.equal(JSON.parse(h.localStorage.getItem(h.historyKey))[0].kind, 'wrong');
  assert.equal(JSON.parse(h.localStorage.getItem(h.historyKey + ':support'))[0].kind, 'correct');

  const another = loaderHarness({ explore: true });
  const main = await another.part();
  main.submit(0);
  main.addSupport().submit(0);
  main.submit(1);
  assert.equal(JSON.parse(another.localStorage.getItem(SETTINGS)).studyProgressV1[another.key].pending.revision, 0);
  assert.equal(JSON.parse(another.localStorage.getItem(another.historyKey + ':support'))[0].kind, 'wrong');
});

test('再開位置より前の問題を復習して正解しても位置を変えない', async () => {
  const h = loaderHarness();
  const settings = JSON.parse(h.localStorage.getItem(SETTINGS));
  settings.lessons[h.key] = 'm1-l026';
  h.localStorage.setItem(SETTINGS, JSON.stringify(settings));
  const p = await h.part();
  p.submit(1);
  assert.equal(JSON.parse(h.localStorage.getItem(SETTINGS)).lessons[h.key], 'm1-l026');
  assert.equal(JSON.parse(h.localStorage.getItem(SETTINGS)).studyProgressV1, undefined);
});

test('国語は２問の最新正答が必要で、誤答後の再正答で進む', async () => {
  const h = loaderHarness({ subject: 'japanese', lessonId: 'j1-l001', sequence: true });
  const first = await h.part('q1');
  first.submit(1);
  first.submit(0);
  const second = await h.part('q2');
  second.submit(1);
  assert.equal(JSON.parse(h.localStorage.getItem(SETTINGS)).studyProgressV1, undefined);
  const firstAgain = await h.part('q1');
  firstAgain.submit(1);
  const pending = JSON.parse(h.localStorage.getItem(SETTINGS)).studyProgressV1[h.key].pending;
  assert.deepEqual(pending.ids, ['q1', 'q2']);
  assert.deepEqual(JSON.parse(h.localStorage.getItem(h.historyKey)).map((r) => r.kind), ['correct', 'wrong', 'correct', 'correct']);
});
