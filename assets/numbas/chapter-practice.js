import { examQuestions, questionIds, readExamSource } from "./question-progress.js?v=fixed-parts-1";
import { exerciseSettings } from "./exercise-settings.js?v=continuous-1";

const host = document.getElementById("numbas-host");
const status = document.getElementById("numbas-status");
const counter = document.getElementById("question-progress");
const continuous = host.dataset.exerciseMode === "continuous";
const previous = continuous ? makeArrow("back", "前の問題へ") : document.getElementById("question-previous");
const next = continuous ? makeArrow("forward", "次の問題へ") : document.getElementById("question-next");
let current = -1;
let busy = false;

function makeArrow(direction, label) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "classroom-arrow " + direction;
  button.setAttribute("aria-label", label);
  const triangle = document.createElement("span");
  triangle.setAttribute("aria-hidden", "true");
  button.append(triangle);
  return button;
}

function mountProgress(questions, show) {
  const progress = document.createElement("div");
  progress.className = "continuous-progress";
  const line = document.createElement("div");
  line.className = "continuous-progress-line";
  const score = document.createElement("span");
  score.className = "continuous-score";
  score.textContent = `0 / ${questions.length}問 正解`;
  const meter = document.createElement("progress");
  meter.max = questions.length;
  meter.value = 0;
  meter.setAttribute("aria-label", "セットで正解した問題の数");
  counter.before(progress);
  line.append(counter, score);
  progress.append(line, meter);

  const groupStarts = new Map();
  for (const [index, { group }] of questions.entries()) {
    if (!groupStarts.has(group)) groupStarts.set(group, index);
  }
  const tabs = new Map();
  if (groupStarts.size > 1) {
    const tabList = document.createElement("div");
    tabList.className = "question-type-tabs";
    tabList.setAttribute("role", "tablist");
    host.setAttribute("role", "tabpanel");
    for (const [group, index] of groupStarts) {
      const tab = document.createElement("button");
      tab.type = "button";
      tab.id = `chapter-practice-tab-${tabs.size + 1}`;
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-controls", host.id);
      tab.textContent = group.name;
      tab.addEventListener("click", () => { void show(index); });
      tabs.set(group, tab);
      tabList.append(tab);
    }
    progress.before(tabList);
  }
  return { score, meter, tabs };
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
  if (continuous && questions.some(({ question }) => question.parts?.length !== 1 ||
      !["numberentry", "1_n_2"].includes(question.parts[0].type))) {
    throw new Error("連続練習には数値入力か単一選択の問題を1問ずつ指定してください。");
  }
  const ids = await questionIds(questions);
  if (new Set(ids).size !== ids.length) throw new Error("問題の識別が重複しています。");
  const urls = questions.map(({ group, question }) => URL.createObjectURL(new Blob([
    JSON.stringify({ ...data, question_groups: [{ ...group, questionNames: [""], variable_overrides: [], questions: [question] }] })
  ], { type: "application/json" })));
  const { prepareRuntime, bootExam } = await import("./loader.js?v=continuous-2");
  await prepareRuntime();
  const progress = continuous ? mountProgress(questions, show) : null;
  const correctIds = new Set();
  let advanceTimer;
  const cancelAdvance = () => clearTimeout(advanceTimer);

  function canMove(offset) {
    const target = questions[current + offset];
    return !busy && target && (!continuous || target.group === questions[current].group);
  }

  function updateControls() {
    counter.textContent = `もんだい ${current + 1} / ${questions.length}`;
    previous.disabled = !canMove(-1);
    next.disabled = !canMove(1);
    if (!progress) return;
    for (const [group, tab] of progress.tabs) {
      const selected = group === questions[current].group;
      tab.setAttribute("aria-selected", String(selected));
      tab.disabled = busy;
      if (selected) host.setAttribute("aria-labelledby", tab.id);
    }
  }

  async function connectQuestion(exam, index, focusPrompt) {
    const part = exam.exam.questionList[0].parts[0];
    const section = await part.display.html_promise;
    section.append(previous, next);
    const questionId = ids[index];
    const group = questions[index].group;
    const isCurrent = () => !busy && !exam.inert && exam.isConnected && host.dataset.historyQuestionId === questionId;
    const input = section.querySelector("input.numberentry");
    input?.addEventListener("input", cancelAdvance);
    input?.addEventListener("compositionstart", cancelAdvance);
    part.events.on("pre-submit", cancelAdvance);
    part.events.on("post-submit", () => {
      if (!isCurrent()) return;
      cancelAdvance();
      if (!part.answered || part.isDirty || !(part.marks > 0 && part.score >= part.marks)) return;
      if (!correctIds.has(questionId)) {
        correctIds.add(questionId);
        progress.meter.value = correctIds.size;
        progress.score.textContent = `${correctIds.size} / ${questions.length}問 正解`;
      }
      const following = questions[index + 1];
      if (!following || correctIds.size === questions.length) return;
      if (following.group !== group && questions.some((item, offset) =>
        item.group === group && !correctIds.has(ids[offset]))) return;
      advanceTimer = setTimeout(() => {
        if (isCurrent() && !part.isDirty) void show(index + 1);
      }, exerciseSettings.continuousAdvanceDelayMs);
    });

    if (focusPrompt) requestAnimationFrame(() => {
      if (!isCurrent()) return;
      const prompt = section.querySelector(".classroom-question-card > .prompt");
      prompt.tabIndex = -1;
      prompt.focus({ preventScroll: true });
      const top = prompt.getBoundingClientRect().top;
      if (top < 0 || top >= window.innerHeight) prompt.scrollIntoView({ block: "start", behavior: "instant" });
    });
  }

  async function show(index) {
    if (busy || index < 0 || index >= questions.length) return;
    cancelAdvance();
    const focusPrompt = current !== -1;
    busy = true;
    current = index;
    updateControls();
    if (continuous && host.firstElementChild) host.firstElementChild.inert = true;
    status.textContent = "もんだいを よみこんでいます。";
    host.dataset.examSource = urls[index];
    host.dataset.historyQuestionId = ids[index];
    host.dataset.historyQuestionNumber = String(index + 1);
    host.dataset.historyQuestionIds = JSON.stringify(ids);
    try {
      await bootExam(host, status, "basic", false);
      const exam = host.querySelector("numbas-exam");
      await waitForControls(exam);
      if (continuous) await connectQuestion(exam, index, focusPrompt);
      status.textContent = "";
    } catch (error) {
      console.error(error);
      status.textContent = "もんだいを ひょうじできませんでした。";
    } finally {
      busy = false;
      updateControls();
    }
  }
  previous.addEventListener("click", () => { if (canMove(-1)) void show(current - 1); });
  next.addEventListener("click", () => { if (canMove(1)) void show(current + 1); });
  if (continuous) window.addEventListener("pagehide", cancelAdvance);
  await show(0);
} catch (error) {
  console.error(error);
  status.textContent = "もんだいを よみこめませんでした。";
}
