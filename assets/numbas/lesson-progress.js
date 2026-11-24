import { examQuestions, questionIds, questionProgress, isRecognizedCorrect, initializeRecognitionRule, readExamSource, mainQuestionSet } from "./question-progress.js?v=fixed-parts-1";

const prefix = "classroom:practice-history:v1:";
const marks = Object.freeze({ single: "○", oneOfTwo: "◯", both: "◎" });
const recognitionStartedAt = initializeRecognitionRule();

function prepareProgress(row) {
  const link = row.querySelector('[data-kind="questions"][data-published="true"]');
  if (!link?.dataset.target) return;
  const key = prefix + new URL(link.dataset.target, location.href).pathname;
  const mark = document.createElement("span");
  mark.className = "lesson-progress-mark";
  mark.hidden = true;
  link.after(mark);
  let idsPromise;
  let updateSequence = 0;

  function loadQuestionIds() {
    if (!idsPromise) {
      idsPromise = (async () => {
        const response = await fetch(new URL(row.dataset.progressExam, location.href));
        if (!response.ok) throw new Error("問題データを読み込めませんでした。");
        const raw = await response.text();
        const exam = JSON.parse(raw.replace(/^\s*\/\/[^\n]*\r?\n/, ""));
        const questions = examQuestions(exam);
        // These markers represent two independently marked, single-part questions.
        if (questions.length !== 2 || questions.some(({ question }) => question.parts?.length !== 1)) return null;
        const ids = await questionIds(questions);
        return new Set(ids).size === 2 ? ids : null;
      })().catch((error) => {
        idsPromise = undefined;
        throw error;
      });
    }
    return idsPromise;
  }

  const update = () => {
    const sequence = ++updateSequence;
    let records;
    try {
      records = JSON.parse(localStorage.getItem(key) || "[]");
      if (!Array.isArray(records)) records = [];
    } catch {
      mark.hidden = true;
      return;
    }
    // Do not fetch 120 exams for lessons with no identifiable marked answer.
    if (!records.some((record) => record?.questionId && (record.kind === "correct" || record.kind === "wrong"))) {
      mark.hidden = true;
      return;
    }
    void loadQuestionIds().then((ids) => {
      if (sequence !== updateSequence) return;
      const count = ids ? questionProgress(records, ids, recognitionStartedAt) : 0;
      mark.hidden = count === 0;
      mark.textContent = count === 2 ? marks.both : count === 1 ? marks.oneOfTwo : "";
      const description = "基礎問題2問中" + count + "問正解";
      mark.setAttribute("aria-label", description);
      mark.title = description;
    }).catch((error) => {
      if (sequence === updateSequence) mark.hidden = true;
      console.error("学習状況を表示できませんでした。", error);
    });
  };
  update();
  window.addEventListener("pageshow", update);
  window.addEventListener("storage", (event) => {
    if (event.key === key || event.key === null) update();
  });
}

// Some one-question lesson lists show a separate mark for each difficulty.
// Keep the existing lesson-level history keys and mark appearance unchanged.
function prepareDifficultyProgress() {
  const levels = [
    { id: "basic", label: "基礎" },
    { id: "standard", label: "標準" },
    { id: "advanced", label: "発展" },
  ];
  const rows = [];
  document.querySelectorAll(".lesson-item[data-lesson-id]").forEach((row) => {
    if (row.dataset.mainQuestionSet) return;
    const questionLink = row.querySelector('a[data-kind="questions"]');
    const actions = row.querySelector(".lesson-links");
    if (!actions || !questionLink || questionLink.dataset.published !== "true") return;
    const pathname = new URL(questionLink.dataset.target, location.href).pathname;
    const progress = document.createElement("span");
    progress.className = "difficulty-progress";
    progress.setAttribute("role", "img");
    const levelMarks = levels.map((level) => {
      const mark = document.createElement("span");
      mark.className = "difficulty-progress-mark";
      mark.dataset.level = level.id;
      mark.setAttribute("aria-hidden", "true");
      progress.append(mark);
      return { id: level.id, label: level.label, node: mark };
    });
    row.insertBefore(progress, actions);
    rows.push({ progress, marks: levelMarks, pathname });
  });

  function refreshDifficultyProgress() {
    rows.forEach((row) => {
      const labels = [];
      row.marks.forEach((mark) => {
        const key = prefix + row.pathname + (mark.id === "basic" ? "" : ":" + mark.id);
        let correct = false;
        try {
          const history = JSON.parse(localStorage.getItem(key) || "[]");
          correct = isRecognizedCorrect(history, null, recognitionStartedAt);
        } catch (error) { /* A missing or unreadable record leaves the slot blank. */ }
        mark.node.textContent = correct ? marks.single : "";
        labels.push(mark.label + (correct ? "正解" : "未正解"));
      });
      row.progress.setAttribute("aria-label", labels.join("、"));
    });
  }
  refreshDifficultyProgress();
  window.addEventListener("pageshow", refreshDifficultyProgress);
}

// The course row opts in with the source URL. Its exam supplies all names and IDs.
async function prepareMainMarks(row) {
  const link = row.querySelector('a[data-kind="questions"][data-published="true"]');
  const actions = row.querySelector(".lesson-links");
  if (!link?.dataset.target || !actions) return;
  const set = mainQuestionSet(await readExamSource(new URL(row.dataset.mainQuestionSet, location.href)));
  if (set.lessonId !== row.dataset.lessonId) throw new Error("授業と教材のIDが一致しません。");
  const key = prefix + new URL(link.dataset.target, location.href).pathname;
  const progress = document.createElement("span");
  progress.className = "difficulty-progress";
  progress.setAttribute("role", "img");
  const palette = ["basic", "standard", "advanced"];
  const nodes = set.mains.map((_, index) => {
    const node = document.createElement("span");
    node.className = "difficulty-progress-mark";
    node.dataset.level = palette[index % palette.length];
    node.setAttribute("aria-hidden", "true");
    progress.append(node);
    return node;
  });
  row.insertBefore(progress, actions);
  function update() {
    let records = [];
    try { records = JSON.parse(localStorage.getItem(key) || "[]"); } catch { /* Unavailable history. */ }
    const labels = set.mains.map(({ id, label }, index) => {
      const recognized = isRecognizedCorrect(records, id, recognitionStartedAt);
      nodes[index].textContent = recognized ? marks.single : "";
      return label + (recognized ? "正解" : "未正解");
    });
    progress.setAttribute("aria-label", labels.join("、"));
  }
  update();
  window.addEventListener("pageshow", update);
  window.addEventListener("storage", (event) => { if (event.key === key || event.key === null) update(); });
}

for (const row of document.querySelectorAll(".lesson-item[data-main-question-set]")) {
  void prepareMainMarks(row).catch((error) => console.error("主問題の学習状況を表示できませんでした。", error));
}

for (const row of document.querySelectorAll("[data-progress-exam]")) {
  if (row.dataset.mainQuestionSet) continue;
  try {
    prepareProgress(row);
  } catch (error) {
    console.error("学習状況を表示できませんでした。", error);
  }
}

if (document.body?.hasAttribute("data-difficulty-progress")) {
  try {
    prepareDifficultyProgress();
  } catch (error) {
    console.error("学習状況を表示できませんでした。", error);
  }
}
