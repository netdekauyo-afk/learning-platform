import { examQuestions, questionIds } from "./question-progress.js?v=20261123-shared";

const AUTO_ADVANCE_MS = 2000;

try {
  const source = document.getElementById("numbas-host")?.dataset.sequenceSource;
  if (!source) throw new Error("問題データの参照先が設定されていません。");
  const response = await fetch(source);
  if (!response.ok) throw new Error("問題データを読み込めませんでした。");
  const raw = await response.text();
  const examData = JSON.parse(raw.replace(/^\s*\/\/[^\n]*\r?\n/, ""));
  const questions = examQuestions(examData);
  if (!questions.length) throw new Error("問題が見つかりません。");
  let ids = [];
  try {
    ids = await questionIds(questions);
    if (new Set(ids).size !== ids.length) throw new Error("設問を識別できません。");
  } catch (error) {
    console.error(error);
    ids = [];
    const warning = document.createElement("p");
    warning.setAttribute("role", "status");
    warning.textContent = "設問ごとの学習記録を準備できませんでした。問題は解くことができます。";
    document.getElementById("question-progress").after(warning);
  }

  // Keep the original file intact and reuse the existing one-question renderer.
  const sources = questions.map(({ group, question }) => URL.createObjectURL(new Blob([
    JSON.stringify({ ...examData, question_groups: [{ ...group, questions: [question] }] })
  ], { type: "application/json" })));
  const requested = Number(new URLSearchParams(location.search).get("question") || 1);
  let current = Number.isInteger(requested) && requested >= 1 && requested <= questions.length ? requested - 1 : 0;
  let switching = true;
  let autoAdvance;
  let bootExam;
  const host = document.getElementById("numbas-host");
  const status = document.getElementById("numbas-status");
  const progress = document.getElementById("question-progress");
  const previous = document.getElementById("question-previous");
  const next = document.getElementById("question-next");

  function setQuestionSource() {
    host.dataset.examSource = sources[current];
    host.dataset.historyQuestionId = ids[current] || "";
    host.dataset.historyQuestionNumber = String(current + 1);
    host.dataset.historyQuestionIds = JSON.stringify(ids);
  }

  function cancelAutoAdvance() {
    if (autoAdvance !== undefined) clearTimeout(autoAdvance);
    autoAdvance = undefined;
  }
  function updateControls() {
    progress.textContent = "問題 " + (current + 1) + " / " + questions.length;
    previous.disabled = switching || current === 0;
    next.disabled = switching || current === questions.length - 1;
  }
  function bindExam(exam) {
    const index = current;
    exam.addEventListener("numbas:loaded", () => {
      if (host.querySelector("numbas-exam") !== exam || index !== current) return;
      const question = exam.exam?.questionList?.[0];
      const parts = question?.parts?.filter((part) => Number(part.marks) > 0) || [];
      if (!parts.length) {
        switching = false;
        updateControls();
        return;
      }
      for (const part of parts) {
        part.events.on("post-submit", () => {
          if (host.querySelector("numbas-exam") !== exam || index !== current) return;
          cancelAutoAdvance();
          const correct = parts.every((item) =>
            item.answered && Number.isFinite(Number(item.score)) &&
            Number(item.score) >= Number(item.marks)
          );
          const answerOpen = host.querySelector(".practice-answer:not([hidden])");
          if (correct && !answerOpen && index < questions.length - 1) {
            autoAdvance = setTimeout(() => {
              autoAdvance = undefined;
              const basicPanel = document.getElementById("difficulty-basic-panel");
              if (index === current && !switching && basicPanel && !basicPanel.hidden) {
                void showQuestion(index + 1);
              }
            }, AUTO_ADVANCE_MS);
          }
        });
      }
      switching = false;
      updateControls();
    }, { once: true });
  }
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE && node.localName === "numbas-exam") bindExam(node);
      }
    }
  });
  observer.observe(host, { childList: true });

  async function showQuestion(index) {
    cancelAutoAdvance();
    if (switching || index < 0 || index >= questions.length || index === current) return;
    switching = true;
    current = index;
    updateControls();
    status.textContent = "問題を読み込んでいます。";
    setQuestionSource();
    const currentUrl = new URL(location.href);
    currentUrl.searchParams.set("question", String(current + 1));
    history.replaceState(history.state, "", currentUrl);
    try {
      await bootExam(host, status, "basic", true);
    } catch (error) {
      console.error(error);
      status.textContent = "問題を表示できませんでした。";
      switching = false;
      updateControls();
    }
  }
  previous.addEventListener("click", () => { void showQuestion(current - 1); });
  next.addEventListener("click", () => { void showQuestion(current + 1); });
  // When a learner opens a hint, answer or history, let them finish reading.
  host.addEventListener("click", (event) => {
    if (event.composedPath().some((node) => node instanceof Element &&
        node.matches(".practice-reveal-button, .stepsBtn, .practice-history summary"))) {
      cancelAutoAdvance();
    }
  });

  setQuestionSource();
  updateControls();
  ({ bootExam } = await import("./loader.js?v=20261122-question-history"));
  const basicPanel = document.getElementById("difficulty-basic-panel");
  if (!basicPanel) throw new Error("基礎問題を準備できませんでした。");
  basicPanel.insertBefore(progress, status);
  basicPanel.append(document.getElementById("question-switcher"));
  const tablist = document.querySelector(".difficulty-tabs");
  tablist?.addEventListener("click", (event) => {
    if (event.target.closest('[role="tab"]')?.id !== "difficulty-basic-tab") cancelAutoAdvance();
  });
  tablist?.addEventListener("keydown", (event) => {
    if (["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) cancelAutoAdvance();
  });
  // The basic exam uses a blob URL; unpublished levels keep their own paths.
  for (const [level, suffix] of [["standard", "-s"], ["advanced", "-a"]]) {
    const levelHost = document.querySelector("#difficulty-" + level + "-panel .numbas-difficulty-host");
    if (!levelHost) throw new Error("難易度の表示を準備できませんでした。");
    const examName = new URL(source, location.href).pathname.split("/").pop().replace(/\.exam$/, "");
    levelHost.dataset.examSource = "./" + examName + suffix + ".exam";
  }
} catch (error) {
  console.error(error);
  document.getElementById("numbas-status").textContent = "問題を読み込めませんでした。";
}
