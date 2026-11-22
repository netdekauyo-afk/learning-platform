import { examQuestions, questionIds, questionProgress } from "./question-progress.js?v=20261122-question-history";

const prefix = "classroom:practice-history:v1:";

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
      const count = ids ? questionProgress(records, ids) : 0;
      mark.hidden = count === 0;
      mark.textContent = count === 2 ? "◎" : count === 1 ? "◯" : "";
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

for (const row of document.querySelectorAll("[data-progress-exam]")) {
  try {
    prepareProgress(row);
  } catch (error) {
    console.error("学習状況を表示できませんでした。", error);
  }
}
