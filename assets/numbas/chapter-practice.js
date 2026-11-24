import { examQuestions, questionIds, readExamSource } from "./question-progress.js?v=fixed-parts-1";

const host = document.getElementById("numbas-host");
const status = document.getElementById("numbas-status");
const counter = document.getElementById("question-progress");
const previous = document.getElementById("question-previous");
const next = document.getElementById("question-next");
let current = 0;
let busy = true;
let urls = [];

function controls(count) {
  counter.textContent = `もんだい ${current + 1} / ${count}`;
  previous.disabled = busy || current === 0;
  next.disabled = busy || current === count - 1;
}

async function waitForControls(exam) {
  if (exam.shadowRoot.querySelector(".check-answers")) return;
  await new Promise((resolve, reject) => {
    const observer = new MutationObserver(() => {
      if (exam.shadowRoot.querySelector(".check-answers")) {
        observer.disconnect();
        clearTimeout(timeout);
        resolve();
      }
    });
    const timeout = setTimeout(() => { observer.disconnect(); reject(new Error("入力欄を準備できませんでした。")); }, 15000);
    observer.observe(exam.shadowRoot, { childList: true, subtree: true });
  });
}

try {
  const original = host.dataset.examSource;
  const data = await readExamSource(original);
  const questions = examQuestions(data);
  if (!questions.length) throw new Error("問題がありません。");
  const ids = await questionIds(questions);
  if (new Set(ids).size !== ids.length) throw new Error("問題の識別が重複しています。");
  urls = questions.map(({ group, question }) => URL.createObjectURL(new Blob([
    JSON.stringify({ ...data, question_groups: [{ ...group, questionNames: [""], variable_overrides: [], questions: [question] }] })
  ], { type: "application/json" })));
  const { prepareRuntime, bootExam } = await import("./loader.js?v=20261124-chapter-practice");
  await prepareRuntime();

  async function show(index) {
    if (index < 0 || index >= questions.length) return;
    busy = true;
    current = index;
    controls(questions.length);
    status.textContent = "もんだいを よみこんでいます。";
    host.dataset.examSource = urls[index];
    host.dataset.historyQuestionId = ids[index];
    host.dataset.historyQuestionNumber = String(index + 1);
    host.dataset.historyQuestionIds = JSON.stringify(ids);
    try {
      await bootExam(host, status, "basic", false);
      await waitForControls(host.querySelector("numbas-exam"));
      status.textContent = "";
    } catch (error) {
      console.error(error);
      status.textContent = "もんだいを ひょうじできませんでした。";
    } finally {
      busy = false;
      controls(questions.length);
    }
  }
  previous.addEventListener("click", () => { if (!busy) void show(current - 1); });
  next.addEventListener("click", () => { if (!busy) void show(current + 1); });
  await show(0);
} catch (error) {
  console.error(error);
  status.textContent = "もんだいを よみこめませんでした。";
}
