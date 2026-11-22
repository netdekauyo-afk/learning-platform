import { examQuestions, questionIds, questionProgress } from "./question-progress.js?v=20261122-question-history";

const prefix = "classroom:practice-history:v1:";

async function prepareProgress(row) {
  const link = row.querySelector('[data-kind="questions"][data-published="true"]');
  if (!link?.dataset.target) return;
  const response = await fetch(new URL(row.dataset.progressExam, location.href));
  if (!response.ok) return;
  const raw = await response.text();
  const exam = JSON.parse(raw.replace(/^\s*\/\/[^\n]*\r?\n/, ""));
  const questions = examQuestions(exam);
  // These markers represent exactly two independently marked, single-part questions.
  if (questions.length !== 2 || questions.some(({ question }) => question.parts?.length !== 1)) return;
  const ids = await questionIds(questions);
  if (new Set(ids).size !== 2) return;
  const key = prefix + new URL(link.dataset.target, location.href).pathname;
  const mark = document.createElement("span");
  mark.className = "lesson-progress-mark";
  mark.hidden = true;
  link.after(mark);

  const update = () => {
    try {
      const records = JSON.parse(localStorage.getItem(key) || "[]");
      const count = questionProgress(records, ids);
      mark.hidden = count === 0;
      mark.textContent = count === 2 ? "◎" : count === 1 ? "◯" : "";
      const description = "基礎問題2問中" + count + "問正解";
      mark.setAttribute("aria-label", description);
      mark.title = description;
    } catch {
      // An unavailable history must never stop the course links from working.
      mark.hidden = true;
    }
  };
  update();
  window.addEventListener("pageshow", update);
  window.addEventListener("storage", (event) => {
    if (event.key === key || event.key === null) update();
  });
}

for (const row of document.querySelectorAll("[data-progress-exam]")) {
  void prepareProgress(row).catch((error) => console.error("学習状況を表示できませんでした。", error));
}
