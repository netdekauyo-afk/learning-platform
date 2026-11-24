import {
  examQuestions, questionIds, questionTypeLabel, mainQuestionSet, readExamSource,
  definitionId, isRecognizedCorrect, initializeRecognitionRule
} from "./question-progress.js?v=fixed-parts-1";

try {
  const host = document.getElementById("numbas-host");
  const source = host?.dataset.sequenceSource;
  if (!source) throw new Error("問題データの参照先が設定されていません。");
  const examData = await readExamSource(source);
  const set = host.hasAttribute("data-main-question-set") ? mainQuestionSet(examData) : null;
  const questions = examQuestions(examData);
  if (!questions.length) throw new Error("問題が見つかりません。");
  const recognitionStartedAt = initializeRecognitionRule();
  let ids = [];
  try {
    ids = set ? set.ids : await questionIds(questions);
    if (new Set(ids).size !== ids.length) throw new Error("設問を識別できません。");
  } catch (error) {
    console.error(error);
    ids = [];
    const warning = document.createElement("p");
    warning.setAttribute("role", "status");
    warning.textContent = "設問ごとの学習記録を準備できませんでした。問題は解くことができます。";
    document.getElementById("question-progress").after(warning);
  }

  const sources = set ? [] : questions.map(({ group, question }) => URL.createObjectURL(new Blob([
    JSON.stringify({ ...examData, question_groups: [{ ...group, questions: [question] }] })
  ], { type: "application/json" })));
  const requested = Number(new URLSearchParams(location.search).get("question") || 1);
  let current = Number.isInteger(requested) && requested >= 1 && requested <= questions.length ? requested - 1 : 0;
  let switching = true;
  let bootExam;
  let runningExam;
  const status = document.getElementById("numbas-status");
  const progress = document.getElementById("question-progress");
  const previous = document.getElementById("question-previous");
  const next = document.getElementById("question-next");
  const historyKey = "classroom:practice-history:v1:" + location.pathname;

  const stylesheet = document.createElement("link");
  stylesheet.rel = "stylesheet";
  stylesheet.href = new URL("./question-tabs.css?v=explore-layout-1", import.meta.url).href;
  document.head.append(stylesheet);
  const tabs = document.createElement("div");
  tabs.className = "question-type-tabs";
  tabs.setAttribute("role", "tablist");
  tabs.setAttribute("aria-label", "基本問題の種類");
  const panel = document.createElement("div");
  panel.id = "question-type-panel";
  panel.setAttribute("role", "tabpanel");

  const labels = questions.map(({ question }, index) => set ? set.mains[index].label : questionTypeLabel(question, index));
  const buttons = labels.map((label, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.id = "question-type-tab-" + (index + 1);
    button.setAttribute("role", "tab");
    button.setAttribute("aria-controls", panel.id);
    const title = document.createElement("span");
    title.textContent = label;
    const mark = document.createElement("span");
    mark.className = "question-type-mark";
    mark.setAttribute("aria-hidden", "true");
    button.append(title, mark);
    button.addEventListener("click", () => { void showQuestion(index); });
    button.addEventListener("keydown", (event) => {
      let target;
      if (event.key === "ArrowRight") target = (index + 1) % buttons.length;
      else if (event.key === "ArrowLeft") target = (index + buttons.length - 1) % buttons.length;
      else if (event.key === "Home") target = 0;
      else if (event.key === "End") target = buttons.length - 1;
      else return;
      event.preventDefault();
      if (!switching) {
        buttons[target].focus();
        void showQuestion(target);
      }
    });
    tabs.append(button);
    return button;
  });
  function setQuestionSource() {
    host.dataset.examSource = set ? source : sources[current];
    host.dataset.historyQuestionId = ids[current] || "";
    host.dataset.historyQuestionNumber = String(current + 1);
    host.dataset.historyQuestionIds = JSON.stringify(ids);
  }
  function refreshMarks() {
    let records = [];
    try {
      const saved = JSON.parse(localStorage.getItem(historyKey) || "[]");
      if (Array.isArray(saved)) records = saved;
    } catch { /* Unavailable history leaves the marks unrecognized. */ }
    buttons.forEach((button, index) => {
      const recognized = !!ids[index] && isRecognizedCorrect(records, ids[index], recognitionStartedAt);
      button.querySelector(".question-type-mark").classList.toggle("is-recognized", recognized);
      button.setAttribute("aria-label", labels[index] + (recognized ? "、正解認定済み" : "、未認定"));
    });
  }
  function updateControls() {
    progress.textContent = "問題 " + (current + 1) + " / " + questions.length;
    previous.disabled = switching || current === 0;
    next.disabled = switching || current === questions.length - 1;
    buttons.forEach((button, index) => {
      button.setAttribute("aria-selected", String(index === current));
      button.tabIndex = index === current ? 0 : -1;
    });
    tabs.setAttribute("aria-busy", String(switching));
    panel.setAttribute("aria-labelledby", buttons[current].id);
    refreshMarks();
  }
  function bindExam(exam) {
    const index = current;
    exam.addEventListener("numbas:loaded", () => {
      if (host.querySelector("numbas-exam") !== exam || index !== current) return;
      if (set) {
        runningExam = exam.exam;
        runningExam.signals.on("begin", () => {
          switching = false;
          selectRunningQuestion(current);
          updateControls();
        });
        // The standalone exam offers its own menu. Here the visible tablist is that menu.
        exam.addEventListener("click", (event) => {
          if (event.composedPath().some((node) => node.hasAttribute?.("data-classroom-menu"))) {
            event.stopPropagation();
            buttons[current].focus();
          }
        }, true);
        return;
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

  function selectRunningQuestion(index) {
    const target = runningExam.questionList.findIndex((q) => definitionId(q.parts[0]) === ids[index]);
    if (target < 0) throw new Error("表示する主問題が見つかりません。");
    runningExam.tryChangeQuestion(target);
    return runningExam.currentQuestion === runningExam.questionList[target];
  }

  async function showQuestion(index) {
    if (switching || index < 0 || index >= questions.length || index === current) return;
    if (set && !selectRunningQuestion(index)) return;
    switching = !set;
    current = index;
    updateControls();
    setQuestionSource();
    const currentUrl = new URL(location.href);
    currentUrl.searchParams.set("question", String(current + 1));
    history.replaceState(history.state, "", currentUrl);
    if (set) return;
    status.textContent = "問題を読み込んでいます。";
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
  host.addEventListener("classroom:history-changed", refreshMarks);
  window.addEventListener("pageshow", refreshMarks);
  window.addEventListener("storage", (event) => {
    if (event.key === historyKey || event.key === null) refreshMarks();
  });

  setQuestionSource();
  updateControls();
  ({ bootExam } = await import("./loader.js?v=explore-layout-1"));
  const basicPanel = set ? host.parentElement : document.getElementById("difficulty-basic-panel");
  if (!basicPanel) throw new Error("基礎問題を準備できませんでした。");
  basicPanel.insertBefore(tabs, status);
  basicPanel.insertBefore(panel, status);
  panel.append(progress, status, host, document.getElementById("question-switcher"));
  if (set) {
    await bootExam(host, status, "basic", true, { examData, set });
  } else {
    const examName = new URL(source, location.href).pathname.split("/").pop().replace(/\.exam$/, "");
    for (const [level, suffix] of [["standard", "-s"], ["advanced", "-a"]]) {
      const levelHost = document.querySelector("#difficulty-" + level + "-panel .numbas-difficulty-host");
      if (!levelHost) throw new Error("難易度の表示を準備できませんでした。");
      levelHost.dataset.examSource = "./" + examName + suffix + ".exam";
    }
  }
} catch (error) {
  console.error(error);
  document.getElementById("numbas-status").textContent = "問題を読み込めませんでした。";
}
