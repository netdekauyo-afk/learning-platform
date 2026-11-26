import { prepareAnswerControl, hasCheckedAnswer, setExerciseLanguage } from "./worksheet-controls.js?v=continuous-1";
import { createDifficultyTabs } from "./difficulty-tabs.js?v=shared-design-1";
import { exerciseSettings, applyExerciseSettings } from "./exercise-settings.js?v=shared-design-1";
import { initializeRecognitionRule, isRecognizedCorrect, canRecordRepeatedCorrect, bindSelectedChoiceRetry, latestGradedKind, definitionId, allMainAnswersCorrect, readExerciseText } from "./question-progress.js?v=continuous-3";
/* One source of Numbas bootstrapping for all Classroom exercise pages. */
const host = document.querySelector("#numbas-host");
const status = document.querySelector("#numbas-status");
const engine = new URL("./engine/", import.meta.url);
const resource = (path) => new URL(path, engine).href;
const stylesheetURLs = [
  resource("numbas-runtime/numbas.css"),
  new URL("./theme.css?v=continuous-1", import.meta.url).href,
];

// Load the shared home/list storage helper without delaying or changing Numbas.
const studyProgressReady = import(new URL("../curriculum-page.js?v=fixed-parts-1", import.meta.url).href)
  .then(() => globalThis.ClassroomStudyProgress || null)
  .catch((error) => { console.error("進み具合の準備に失敗しました。", error); return null; });

function lessonContext() {
  const match = location.pathname.match(/^(.*\/)(elementary|junior-high)\/grade-(\d+)\/(math|science|english|social|japanese|information)\/lessons\/([^/]+)\/questions\.html$/);
  if (!match) return null;
  const number = Number(match[3]);
  if ((match[2] === "elementary" && (number < 1 || number > 6)) ||
      (match[2] === "junior-high" && (number < 1 || number > 3))) return null;
  return { root: match[1], grade: match[2] === "elementary" ? "e" + number : String(number),
    subject: match[4], lessonId: match[5] };
}

// All entry points use the same page frame. A chapter practice has a grade
// and a subject picker, but no lesson number or study-home lesson progress.
function preparePageFrame() {
  if (!host) return;
  const sheet = document.createElement("link");
  sheet.rel = "stylesheet";
  sheet.href = new URL("./question-tabs.css?v=continuous-1", import.meta.url).href;
  document.head.append(sheet);

  const lesson = location.pathname.match(/\/lessons\/[^/]+-l(\d+)\/questions\.html$/);
  const heading = document.querySelector(".site-shell > main h1");
  if (lesson && heading && !/^第\d+(?:時限|回)/.test(heading.textContent.trim())) {
    const prefix = "第" + Number(lesson[1]) + "時限 ";
    (heading.querySelector("a") || heading).prepend(prefix);
    if (!document.title.startsWith(prefix)) document.title = prefix + document.title;
  }
  const course = location.pathname.match(/^(.*\/)(elementary|junior-high)\/grade-(\d+)\//);
  if (!course) return;
  const url = new URL(course[1] + "study-home/", location.origin);
  url.searchParams.set("grade", (course[2] === "elementary" ? "e" : "") + course[3]);
  url.searchParams.set("screen", "subjects");
  const link = document.createElement("a");
  link.id = "other-subject-link";
  link.href = url.href;
  link.textContent = "別の科目を見る";
  link.slot = "review-actions";
  host.after(link);
  function placeLink() {
    const exam = Array.from(document.querySelectorAll("numbas-exam")).find((item) => !item.closest("[hidden]"));
    // Until a difficulty's exam loads (or if it is unpublished), keep the link available.
    const target = exam || document.querySelector(".site-shell > main");
    if (target && target !== link.parentElement) target.append(link);
  }
  document.addEventListener("classroom:panel-change", placeLink);
  document.addEventListener("numbas:loaded", placeLink, true);
}

// Persist the qualifying answer synchronously, so closing the page while the
// lesson schedule loads does not lose the update. This does not alter history.
function queueStudyAdvance(context, ids, source, mainSetReady) {
  try {
    const raw = localStorage.getItem("classroom-study-home-settings");
    if (!raw) return false;
    const settings = JSON.parse(raw);
    const object = (value) => value && typeof value === "object" && !Array.isArray(value);
    if (!object(settings) || !object(settings.lessons) ||
        (settings.studyProgressV1 !== undefined && !object(settings.studyProgressV1))) return false;
    const key = context.grade + ":" + context.subject;
    if (settings.lessons[key] !== context.lessonId) return false;
    const old = settings.studyProgressV1?.[key];
    if (old !== undefined && !object(old)) return false;
    if (old?.completed || old?.needsChoice) return false;
    let revision = Number.isSafeInteger(old?.revision) && old.revision >= 0 ? old.revision : 0;
    let pending = null;
    if (mainSetReady === false) {
      if (!old?.pending) return false;
      revision++;
    } else {
      if (old?.pending?.revision === revision) {
        if (mainSetReady === undefined || (old.pending.mode === "main-set" &&
            old.pending.source === source && JSON.stringify(old.pending.ids) === JSON.stringify(ids))) return true;
        revision++;
      }
      pending = { revision };
      if (ids) { pending.ids = ids; pending.source = source; }
      if (mainSetReady) pending.mode = "main-set";
    }
    settings.studyProgressV1 = { ...settings.studyProgressV1, [key]: { ...old, revision, pending } };
    localStorage.setItem("classroom-study-home-settings", JSON.stringify(settings));
    return pending !== null;
  } catch (_) { return false; }
}

// Start the rule before any answer or reveal can be added to the history.
const recognitionStartedAt = initializeRecognitionRule();

/* A non-locking answer view and a local practice history. The original .exam files
   and the Numbas score calculation are deliberately left unchanged. */
const practiceHistoryPrefix = "classroom:practice-history:v1:";

function practiceHistoryKey(level = "basic", pathname = location.pathname) {
  const base = practiceHistoryPrefix + pathname;
  return level === "basic" ? base : base + ":" + level;
}

function readPracticeHistory(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function appendPracticeHistory(key, entry) {
  try {
    const history = readPracticeHistory(key);
    history.push({ ...entry, at: new Date().toISOString() });
    localStorage.setItem(key, JSON.stringify(history));
    return true;
  } catch {
    return false;
  }
}

function readPartAnswer(part) {
  if (part.type === "numberentry" && typeof part.displayAnswer === "string") {
    // Numbas may store a display answer as a quoted JME string literal.
    try {
      const literal = JSON.parse(part.displayAnswer);
      if (typeof literal === "string") return literal;
    } catch {
      // Keep ordinary numbers and other JME expressions unchanged.
    }
    return part.displayAnswer;
  }
  if (part.type === "1_n_2" && Array.isArray(part.choices) && Array.isArray(part.matrix)) {
    const choices = part.choices.filter((_, index) => Number(part.matrix[index]) > 0);
    if (choices.length === 1) return choices[0];
  }
  return null;
}

function readPracticeAnswers(examData) {
  const groups = examData.question_groups || [];
  const questions = groups.flatMap((group) => group.questions || []);
  if (questions.length !== 1 || !questions[0].parts?.length) return null;
  const definitions = questions[0].partsMode === "explore"
    ? questions[0].parts.slice(0, 1) : questions[0].parts;
  const answers = definitions.map(readPartAnswer);
  return answers.every((answer) => typeof answer === "string" && answer.length) ? answers : null;
}

// The standalone Explore preamble exposes its attempts and already handles selection, branches and initial hints.
function hasAuthoredExploreControls(question) {
  return Array.isArray(question.classroomAttempts);
}

async function installPracticeReview(examElement, examHost, historyKey, level, {
  set = null, main = null, question = examElement.exam?.questionList?.[0], retry = null
} = {}) {
  if (!question?.parts?.length) return;
  // Some lesson pages replace the card in place. Capture its identity now,
  // before the shared host is pointed at the next question.
  const supportLabels = new Map();
  for (const edge of main?.parts[0].nextParts || []) {
    const id = main.parts[edge.otherPart]?.customName;
    if (id && edge.label && edge.label !== id) supportLabels.set(id, edge.label);
  }
  const questionId = main?.id || examHost.dataset.historyQuestionId || "";
  const questionNumber = set ? set.ids.indexOf(questionId) + 1 : examHost.dataset.historyQuestionNumber || "";
  const previousPage = examHost.dataset.previousHistoryPage;
  const previousKey = previousPage && practiceHistoryKey(level, new URL(previousPage, location.href).pathname);

  // A moved question keeps its content ID. Read its old attempts in place;
  // new attempts belong to this page, and unrelated questions stay separate.
  function questionHistory(records) {
    if (!questionId) return records;
    const current = records.filter((item) => item?.questionId === questionId);
    if (!previousKey || previousKey === historyKey) return current;
    const earlier = readPracticeHistory(previousKey).filter((item) => item?.questionId === questionId);
    return earlier.concat(current).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  }

  const explore = question.partsMode === "explore";
  const authoredControls = set && hasAuthoredExploreControls(question);
  const primaryPart = question.parts[0];
  const showsAnswerOnCard = (part) => (set || part.answered) && part.type === "1_n_2" && part.settings.displayType === "radiogroup";
  // Keep auxiliary answers out of the existing main-question progress history.
  const supportHistoryKey = historyKey + ":support";
  let activeQuestionIds = [];
  try {
    activeQuestionIds = JSON.parse(examHost.dataset.historyQuestionIds || "[]");
    if (!Array.isArray(activeQuestionIds)) activeQuestionIds = [];
  } catch {
    activeQuestionIds = [];
  }

  // Record each submitted answer after Numbas has marked it. Wrong answers remain
  // recorded even if the learner later submits a correct answer.
  const lastSubmission = new WeakMap();
  const routes = new WeakMap();
  const updateViews = [];
  const refresh = () => updateViews.forEach((fn) => fn());
  const save = (entry, messageElement, support = false, part = primaryPart) => {
    const key = support ? supportHistoryKey : historyKey;
    if (set) {
      entry = { ...entry, lessonId: set.lessonId, questionId: definitionId(part),
        parentId: support ? questionId : null, role: support ? "supplement" : "main",
        route: support ? routes.get(part) : "main" };
    } else if (questionId) entry = { ...entry, questionId };
    if (!appendPracticeHistory(key, entry)) {
      messageElement.textContent = "このブラウザでは学習履歴を保存できません。";
      messageElement.hidden = false;
      return false;
    }
    refresh();
    examHost.dispatchEvent(new CustomEvent("classroom:history-changed", { bubbles: true }));
    return true;
  };

  const notice = document.createElement("p");
  notice.className = "practice-save-warning";
  notice.hidden = true;

  const boundParts = new WeakSet();
  function bindPart(part) {
    if (boundParts.has(part)) return;
    boundParts.add(part);
    const support = explore && part !== primaryPart;
    const defined = main?.parts[part.index];
    if (set && (!defined || defined.customName !== definitionId(part))) return;
    if (set && support) {
      const fromWrong = part.getScope().getVariable("from_wrong")?.value ??
        (part.previousPart?.answered && Number(part.previousPart.score) < Number(part.previousPart.marks));
      routes.set(part, fromWrong ? "wrong" : "optional");
    }
    const repeatCanCount = () => !support && canRecordRepeatedCorrect(
      questionHistory(readPracticeHistory(historyKey)), questionId || null, recognitionStartedAt
    );
    part.events.on("post-submit", () => {
      if (!part.answered || !Number.isFinite(Number(part.score)) ||
          (set && (part.resuming || question.exam.loading || question.exam.mode === "review"))) return;
      const score = Number(part.score);
      const maximum = Number(part.marks);
      if (!Number.isFinite(maximum) || maximum <= 0) return;
      const choiceIndex = defined && part.type === "1_n_2" ? part.ticks.findIndex((row) => row[0]) : -1;
      let answer = String(part.display?.studentAnswer?.() ?? "");
      if (choiceIndex >= 0) {
        const label = document.createElement("template");
        label.innerHTML = defined.choices[choiceIndex];
        answer = label.content.textContent.trim();
      }
      if (!answer.trim()) return;
      const signature = JSON.stringify([part.path, answer, score, maximum, retry?.round]);
      const kind = score >= maximum ? "correct" : "wrong";
      if (lastSubmission.get(part) === signature && !(score >= maximum && repeatCanCount()) &&
          (!set || support || latestGradedKind(readPracticeHistory(historyKey), questionId) === kind)) return;
      const saved = save({
        kind,
        part: String(part.path),
        answer,
        score,
        maximum,
        ...(choiceIndex >= 0 ? { choiceIndex } : {}),
      }, notice, support, part);
      if (saved) lastSubmission.set(part, signature);
      if (set && !support && (saved || score < maximum)) {
        const context = lessonContext();
        if (context && context.lessonId === set.lessonId) {
          const ready = saved && score >= maximum && allMainAnswersCorrect(readPracticeHistory(historyKey), set.ids);
          const source = new URL(examHost.dataset.sequenceSource, location.href).href;
          if (queueStudyAdvance(context, set.ids, source, ready)) {
            void studyProgressReady.then((api) => api?.resolvePending(context.grade, context.subject));
          }
        }
      }
    });

    // Older unlabelled Explore files keep native navigation. Only follow a
    // unique remedial path while the same graded part is still on screen.
    if (!set && explore && !support && typeof part.availableNextParts === "function") {
      let pending;
      const cancel = () => clearTimeout(pending);
      part.events.on("pre-submit", cancel);
      question.events.on("setCurrentPart", cancel);
      examHost.ownerDocument.addEventListener("classroom:panel-change", cancel);
      window.addEventListener("pagehide", cancel);
      part.events.on("post-submit", () => {
        if (!part.answered || part.score >= part.marks || part.availableNextParts().length !== 1) return;
        pending = setTimeout(() => {
          if (!examElement.isConnected || examElement.closest("[hidden]") || question.currentPart !== part ||
              part.isDirty || part.score >= part.marks) return;
          const options = part.availableNextParts();
          if (options.length !== 1) return;
          if (options[0].instance) question.setCurrentPart(options[0].instance);
          else part.makeNextPart(options[0]);
        }, exerciseSettings.supportDelayMs);
      });
    }

    // Immediate correctness advances only the currently selected basic lesson.
    // Explore support parts have their own history and do not affect progress.
    // This listener is independent of history deduplication and 24-hour marks.
    if (!set && level === "basic" && !support) part.events.on("post-submit", () => {
      try {
        const context = lessonContext();
        const parts = (explore ? [primaryPart] : question.parts).filter((item) => Number(item.marks) > 0);
        if (!context || examElement.exam?.questionList?.length !== 1 || !parts.length ||
            !parts.every((item) => item.answered && Number.isFinite(Number(item.score)) &&
              Number(item.score) >= Number(item.marks) && String(item.display?.studentAnswer?.() ?? "").trim())) return;
        let ids = null;
        let source = null;
        if (examHost.dataset.sequenceSource) {
          // Existing Japanese sequences provide stable IDs for two questions.
          // Validate the original question structure before advancing.
          if (parts.length !== 1 || !questionId || activeQuestionIds.length !== 2 ||
              new Set(activeQuestionIds).size !== 2 || !activeQuestionIds.includes(questionId)) return;
          const other = activeQuestionIds.find((id) => id !== questionId);
          if (latestGradedKind(readPracticeHistory(historyKey), other) !== "correct") return;
          ids = activeQuestionIds.slice();
          source = new URL(examHost.dataset.sequenceSource, location.href).href;
        } else if (questionId || activeQuestionIds.length) return;
        if (!queueStudyAdvance(context, ids, source)) return;
        void studyProgressReady.then((api) => api?.resolvePending(context.grade, context.subject));
      } catch (error) { console.error("進み具合を更新できませんでした。", error); }
    });

    // Mark a single-choice answer as soon as Numbas has stored the selection.
    if (part.type === "1_n_2") {
      if (!authoredControls) part.events.on("storeAnswer", () => {
        const selected = Array.isArray(part.stagedAnswer) &&
          part.stagedAnswer.some((row) => Array.isArray(row) && row[0] === true);
        if (selected) part.submit();
      });
      if (retry && !support) return;
      void part.display?.html_promise?.then((section) => {
        if (!examHost.contains(examElement)) return;
        bindSelectedChoiceRetry(section, () =>
          Number(part.score) >= Number(part.marks) && !part.locked && !part.submitting && repeatCanCount(),
        () => part.submit());
      }).catch((error) => console.error("再回答の準備に失敗しました。", error));
    }
  }
  question.parts.forEach(bindPart);
  if (explore) question.events.on("addExtraPart", bindPart);

  // Unlike Numbas' own "Reveal answer", the separate view below never calls
  // revealAnswer(), so the existing input fields remain editable.
  let examData;
  if (!set) {
    const response = await fetch(new URL(examHost.dataset.examSource, location.href));
    if (!response.ok) return;
    const raw = await response.text();
    examData = JSON.parse(raw.replace(/^\s*\/\/[^\n]*\r?\n/, ""));
  }
  // A replaced card must not append its review controls to the new card.
  const questionContent = set ? await question.display.html_promise : examElement.shadowRoot;
  if (!examHost.contains(examElement)) return examData;
  const answers = set ? [readPartAnswer(main.parts[0])] : readPracticeAnswers(examData);
  if (!answers) return;

  const section = document.createElement("section");
  section.className = "practice-panel";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "practice-reveal-button";
  const answerId = questionId ? "practice-answer-" + questionId : level === "basic" ? "practice-answer" : "practice-answer-" + level;
  button.setAttribute("aria-controls", answerId);

  const answerBox = document.createElement("div");
  answerBox.className = "practice-answer";
  answerBox.id = answerId;
  answerBox.hidden = true;
  const heading = document.createElement("h2");
  heading.textContent = "正しい答え";
  answerBox.append(heading);
  answers.forEach((answer, index) => {
    const p = document.createElement("p");
    p.textContent = answers.length === 1 ? answer : (index + 1) + ". " + answer;
    answerBox.append(p);
  });

  const details = document.createElement("details");
  details.className = "practice-history";
  const summary = document.createElement("summary");
  const list = document.createElement("ul");
  list.className = "practice-history-list";
  details.append(summary, list);

  const olderDetails = document.createElement("details");
  olderDetails.className = "practice-history";
  const olderSummary = document.createElement("summary");
  const olderList = document.createElement("ul");
  olderList.className = "practice-history-list";
  olderDetails.append(olderSummary, olderList);

  const supportDetails = document.createElement("details");
  supportDetails.className = "practice-history";
  const supportSummary = document.createElement("summary");
  const supportList = document.createElement("ul");
  supportList.className = "practice-history-list";
  supportDetails.append(supportSummary, supportList);

  function renderHistory(target, history) {
    target.replaceChildren();
    const recent = history.slice(-10).reverse();
    if (!recent.length) {
      const item = document.createElement("li");
      item.textContent = "まだ記録はありません。";
      target.append(item);
    }
    for (const record of recent) {
      const item = document.createElement("li");
      const label = record.kind === "wrong" ? "✕ 誤答" :
        record.kind === "correct" ? "○ 正解" : "答えを確認";
      const time = new Date(record.at);
      const when = Number.isNaN(time.valueOf()) ? "" : time.toLocaleString("ja-JP");
      const branch = record.role === "supplement" ? (supportLabels.get(record.questionId) || "補助問題") +
        (record.route === "wrong" ? "（誤答から）" : "（任意）") + "　" : "";
      item.textContent = branch + label + (record.answer ? "（" + record.answer + "）" : "") +
        (when ? "　" + when : "");
      target.append(item);
    }
  }
  updateViews.push(() => {
    const allHistory = readPracticeHistory(historyKey);
    const history = questionHistory(allHistory);
    const wrong = history.filter((item) => item.kind === "wrong").length;
    const reveals = history.filter((item) => item.kind === "reveal").length;
    const prefix = questionId ? "設問" + questionNumber + "の学習履歴：" : "学習履歴：";
    const revealCount = reveals > 0 || !showsAnswerOnCard(primaryPart) ? "・解答確認" + reveals + "回" : "";
    summary.textContent = prefix + "誤答" + wrong + "回" + revealCount;
    renderHistory(list, history);
    if (questionId) {
      const older = allHistory.filter((item) => !item.questionId || !activeQuestionIds.includes(item.questionId));
      if (set) {
        for (const level of ["standard", "advanced"]) older.push(...readPracticeHistory(practiceHistoryKey(level)));
        older.push(...readPracticeHistory(supportHistoryKey).filter((item) => !activeQuestionIds.includes(item.parentId)));
        older.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
      }
      olderDetails.hidden = older.length === 0;
      olderSummary.textContent = "以前の履歴（旧問題・設問未区別）：" + older.length + "件";
      renderHistory(olderList, older);
    }
    if (explore) {
      const supportHistory = readPracticeHistory(supportHistoryKey)
        .filter((item) => set ? item.parentId === questionId : !questionId || item.questionId === questionId);
      supportDetails.hidden = supportHistory.length === 0;
      supportSummary.textContent = "補助問題の学習履歴：" + supportHistory.length + "件";
      renderHistory(supportList, supportHistory);
    }
  });
  refresh();

  button.addEventListener("click", () => {
    const show = answerBox.hidden;
    const inSupport = explore && question.currentPart !== primaryPart;
    if (show && inSupport) {
      const parts = main?.parts || examData.question_groups?.[0]?.questions?.[0]?.parts;
      const defined = parts?.[question.currentPart?.index];
      const value = defined && readPartAnswer(defined);
      const p = document.createElement("p");
      p.textContent = value || "この補助問題の答えは表示できません。";
      answerBox.replaceChildren(heading, p);
    } else if (show && typeof question.display?.hasAdvice === "function" &&
        question.display.hasAdvice()) {
      // Reuse Numbas' rendered advice, including its formatting and variables.
      const advice = questionContent?.querySelector(".adviceDisplay");
      if (advice) answerBox.replaceChildren(heading, advice.cloneNode(true));
    } else if (show) {
      const nodes = answers.map((answer, index) => {
        const p = document.createElement("p");
        p.textContent = answers.length === 1 ? answer : (index + 1) + ". " + answer;
        return p;
      });
      answerBox.replaceChildren(heading, ...nodes);
    }
    answerBox.hidden = !show;
    button.setAttribute("aria-expanded", String(show));
    button.textContent = show ? "答えを隠す" : "答えを見る";
    if (show) save({ kind: "reveal" }, notice, inSupport, question.currentPart || primaryPart);
  });
  function updateAnswerReview(part) {
    if (showsAnswerOnCard(part)) {
      button.remove();
      answerBox.remove();
      section.setAttribute("aria-label", "学習履歴");
      return;
    }
    section.setAttribute("aria-label", "解答の確認と学習履歴");
    answerBox.hidden = true;
    button.setAttribute("aria-expanded", "false");
    button.textContent = "答えを見る";
    if (button.parentElement !== section) section.prepend(button, answerBox);
  }
  section.append(details);
  if (questionId) section.append(olderDetails);
  if (explore) section.append(supportDetails);
  section.append(notice);
  updateAnswerReview(question.currentPart || primaryPart);
  if (explore) question.events.on("setCurrentPart", updateAnswerReview);
  if (!set && primaryPart.type === "1_n_2" && question.parts.length === 1) {
    primaryPart.events.on("post-submit", () => updateAnswerReview(primaryPart));
  }
  if (set) {
    const sync = () => { section.hidden = examElement.exam.currentQuestion !== question; };
    sync();
    examElement.exam.events.on("changeQuestion", sync);
  }
  if (examElement.shadowRoot.querySelector('slot[name="classroom-review"]')) {
    section.slot = "classroom-review";
    examElement.append(section);
  } else {
    examHost.append(section);
  }

  // The card or the review panel now supplies the correct answer.
  const style = document.createElement("style");
  style.textContent = ".revealBtn { display: none !important; }";
  examElement.shadowRoot.append(style);
  return examData;
}


/* Adapt the working Sites answer, hint and keypad controls to a static page.
   Numbas stays responsible for scoring; the existing practice handler records it. */
async function installWorksheetControls(examElement, examData) {
  const question = examElement.exam?.questionList?.[0];
  const definedParts = examData?.question_groups?.[0]?.questions?.[0]?.parts;
  if (!question?.parts?.length || question.parts.length !== definedParts?.length) return;
  const continuous = examElement.dataset.exerciseMode === "continuous";

  // Sites waits until Numbas has attached the part HTML before decorating it.
  await new Promise((resolve) => setTimeout(resolve, 0));
  const controls = [];
  let submit;
  try {
    for (const [index, part] of question.parts.entries()) {
      const steps = definedParts[index].steps || [];
      const hintMarkup = steps.filter((step) => step.type === "information")
        .map((step) => step.prompt || "").filter(Boolean).join("");
      const control = await prepareAnswerControl(part, index, hintMarkup, continuous);
      controls.push(control);
      const section = await part.display.html_promise;
      const prompt = section.querySelector(":scope > .prompt");
      arrangeQuestionCard(part, question, section, prompt);
      if (continuous && control.hintPanel) prompt.after(control.hintPanel);
    }

    const form = controls[0]?.form;
    if (!form) throw new Error("Numbasの入力フォームが見つかりません。");
    if (continuous) await installNumericAutoSubmit(examElement, question);
    submit = document.createElement("button");
    submit.type = "submit";
    submit.className = "check-answers";
    submit.textContent = controls.length > 1 ? "まとめて答え合わせ" : "答え合わせ";
    const singleCard = controls.length === 1 && form.querySelector(".classroom-question-card");
    (singleCard || form).append(submit);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!controls.every((control) => control.validate())) return;
      form.classList.add("turn-on-check");
      submit.disabled = true;
      try {
        if (!question.parts.every(hasCheckedAnswer)) question.submit();
        controls.forEach((control) => control.showResult());
        status.textContent = "";
      } catch (error) {
        console.error(error);
        status.textContent = "答え合わせに失敗しました。";
      } finally {
        submit.disabled = false;
      }
    });

    // Worksheets without continuous practice keep the hint in the footer slot.
    const panels = controls.map((control) => control.hintPanel).filter(Boolean);
    if (panels.length) {
      if (!continuous) {
        const external = document.createElement("section");
        external.className = "worksheet-hints";
        external.setAttribute("aria-label", "問題のヒント");
        external.append(...panels);
        external.slot = "review-actions";
        examElement.prepend(external);
      }
      const hideNativeSteps = document.createElement("style");
      hideNativeSteps.textContent = ".stepsBtn, .steps.well { display: none !important; }";
      examElement.shadowRoot.append(hideNativeSteps);
    }
    examElement.shadowRoot.querySelector("exam-container")?.classList.add("sites-worksheet-ready");
  } catch (error) {
    submit?.remove();
    // A failed enhancement must not break the existing Numbas input mechanism.
    for (const button of examElement.shadowRoot.querySelectorAll("button.submitPart")) {
      button.hidden = false;
    }
    throw error;
  }
}

function formatExploreResult(output, correct) {
  if (!output.textContent.trim() || output.querySelector(".classroom-result-heading")) return;
  // Only replace the introductory status in the authored feedback. Keep the
  // explanation, inline maths and markup supplied by the exam.
  const reader = document.createTreeWalker(output, NodeFilter.SHOW_TEXT);
  let first;
  while ((first = reader.nextNode()) && !first.data.trim()) { /* skip whitespace */ }
  if (first) first.data = first.data.replace(/^\s*(?:正解です|誤答です|不正解です)。\s*/u, "");
  output.prepend(resultHeading(correct));
}

function resultHeading(correct) {
  const heading = document.createElement("strong");
  heading.className = "classroom-result-heading";
  const mark = document.createElement("span");
  mark.className = "classroom-result-mark";
  mark.setAttribute("aria-hidden", "true");
  mark.textContent = correct ? "◯" : "☓";
  heading.append(mark, correct ? "正解" : "不正解");
  return heading;
}

// Display the answer and explanation already supplied by the running exam.
function addMarkedResult(part, question, answer, retryMain) {
  const output = document.createElement("div");
  output.setAttribute("data-classroom-result", "");
  output.setAttribute("aria-live", "polite");
  function update() {
    if (!part.answered || part.isDirty) return;
    const correct = part.score >= part.marks;
    output.replaceChildren(resultHeading(correct));
    if (retryMain && !correct) {
      const choice = part.ticks.findIndex((row) => row[0]);
      const text = part.settings.distractors[choice]?.[0];
      if (text) { output.innerHTML = text; formatExploreResult(output, false); }
      return;
    }
    const advice = question.parts.length === 1 && question.display.hasAdvice() &&
      question.display.html.querySelector(".adviceDisplay");
    if (advice?.textContent.trim()) {
      for (const node of advice.childNodes) output.append(node.cloneNode(true));
    } else if (!correct) {
      const expected = part.display.correctAnswer();
      const choice = Array.from(answer.querySelectorAll("label")).find((label) =>
        label.querySelector('input[type="radio"]')?.value === String(expected));
      const solution = choice?.textContent.trim() || (part.type === "numberentry" ? expected : "");
      if (solution !== "" && solution != null) output.append("正解は「" + solution + "」です。");
    }
  }
  part.events.on("post-submit", update);
  if (part.type === "numberentry") {
    part.display.studentAnswer.subscribe(() => { if (part.isDirty) output.replaceChildren(); });
  }
  update();
  return output;
}

function arrangeRetryChoices(part, section, answer, feedback, retry) {
  const snapshot = retry.card(part);
  const menu = answer.querySelector(".radiogroup");
  const inputs = [...menu.querySelectorAll("input.choice")];
  const rows = new Map(inputs.map((input) => [Number(input.value), input.closest("li")]));
  // Numbas chooses the initial order. A reload of this particular attempt
  // preserves it and moves the original, bound list items (never their labels).
  if (snapshot.order.length === rows.size && snapshot.order.every((index) => rows.has(index))) {
    part.shuffleAnswers = snapshot.order.slice();
    for (const index of snapshot.order) menu.append(rows.get(index));
  }
  if (snapshot.answer && part.answered) {
    feedback.innerHTML = part.settings.distractors[snapshot.answer.choice][0];
    formatExploreResult(feedback, part.score >= part.marks);
  }
  if (part.previousPart) return;
  section.classList.add("classroom-choice-retry");
  const again = document.createElement("button");
  again.type = "button";
  again.className = "classroom-retry-button";
  again.textContent = "もう一度解きますか？";
  section.querySelector(".classroom-question-card").prepend(again);
  const mistaken = (index) => retry.mistakes.some((item) => item.choice === index);
  function paint() {
    const complete = part.answered && part.score >= part.marks;
    again.hidden = !retry.guarded;
    section.classList.toggle("classroom-awaiting-correct", !complete);
    const certified = complete && retry.recognized();
    for (const input of inputs) {
      const wrong = mistaken(Number(input.value));
      input.closest("li").classList.toggle("classroom-choice-mistake", wrong);
      input.disabled = retry.guarded || wrong || certified || part.locked;
    }
    if (!part.answered) feedback.replaceChildren();
  }
  again.addEventListener("click", () => { retry.start(); inputs.find((input) => !input.disabled)?.focus(); });
  menu.addEventListener("click", (event) => {
    const input = event.target.closest("label")?.querySelector("input.choice");
    if (!input) return;
    const index = Number(input.value);
    if (input.disabled || retry.guarded || mistaken(index)) {
      event.preventDefault();
      event.stopImmediatePropagation();
    } else if (part.answered && part.score >= part.marks) {
      // A completed, as-yet uncertified answer can be retried; opening the
      // card or clicking the already selected answer during a wait is passive.
      event.preventDefault();
      event.stopImmediatePropagation();
      if (retry.recognized() || (index === retry.card(part).answer?.choice && !retry.canCountAgain())) return;
      retry.start();
      queueMicrotask(() => part.display.studentAnswer(String(index)));
    }
  }, true);
  retry.observe(paint);
  paint();
}

function arrangeQuestionCard(part, question, section, prompt, attachArrow, retry) {
  const answer = section.querySelector(":scope > .student.answer");
  const authoredResult = prompt?.querySelector("[data-classroom-result]");
  if (!prompt || !answer || !["1_n_2", "numberentry"].includes(part.type)) {
    attachArrow?.(part, section, authoredResult);
    return;
  }
  if (question.partsMode === "explore" && !part.previousPart) {
    for (const legend of answer.querySelectorAll("fieldset:has(.radiogroup) > legend.sr-only")) {
      legend.parentElement.setAttribute("aria-label", "回答の選択肢");
      legend.setAttribute("aria-hidden", "true");
    }
  }
  const card = document.createElement("div");
  card.className = "classroom-question-card";
  section.classList.add("classroom-card-part");
  section.classList.toggle("classroom-choice-part", part.type === "1_n_2");
  if (question.parts.length === 1 || question.partsMode === "explore") section.classList.add("classroom-single-part");
  prompt.before(card);
  // Move the bound elements, including the worksheet's optional keypad and label.
  card.append(prompt);
  const label = section.querySelector(":scope > .answer-label");
  if (label) card.append(label);
  card.append(answer);
  const keypad = section.querySelector(":scope > :is(.number-pad-panel, .number-pad)");
  if (keypad) card.append(keypad);

  const feedback = authoredResult || addMarkedResult(part, question, answer, retry && !part.previousPart);
  const paragraph = feedback.parentElement;
  card.after(feedback);
  if (paragraph?.matches("p:empty")) paragraph.remove();
  if (authoredResult) {
    const format = () => formatExploreResult(feedback, part.score >= part.marks);
    new MutationObserver(format).observe(feedback, { childList: true });
    format();
  }
  if (part.type === "1_n_2") {
    const markExpected = () => {
      const show = part.answered && (!retry || part.previousPart || part.score >= part.marks);
      const expected = show ? String(part.display.correctAnswer()) : null;
      for (const input of answer.querySelectorAll(".radiogroup input[type=radio]")) {
        input.closest("li").classList.toggle("classroom-expected", show && input.value === expected);
      }
    };
    if (retry && !part.previousPart) retry.observe(markExpected);
    else part.events.on("post-submit", markExpected);
    markExpected();
    if (retry) arrangeRetryChoices(part, section, answer, feedback, retry);
  }
  attachArrow?.(part, section, feedback);
}

/* Reuse the native hint and its open state in both lesson layouts. */
async function installLessonHints(examElement, question = examElement.exam?.questionList?.[0], authored = false, attachArrow = null, retry = null) {
  if (!question) return;
  const classroomExplore = examElement.hasAttribute("data-main-question-set");
  const decorated = new WeakSet();
  async function decorate(part) {
    if (decorated.has(part)) return;
    decorated.add(part);
    const section = await part.display.html_promise;
    if (!examElement.isConnected) return;
    // Preserve the existing layout classification made by worksheet controls.
    const prompt = section.querySelector(":scope > .prompt");
    if (part.type === "1_n_2" || prompt?.querySelector(".worksheet-text") || prompt?.textContent.trim().length > 20) {
      section.classList.add("written-question");
    }
    arrangeQuestionCard(part, question, section, prompt, attachArrow, retry);
    const button = section.querySelector(":scope > .stepsBtn");
    const content = section.querySelector(":scope > .steps.well");
    if (!button || !content) return;
    const hint = document.createElement("div");
    hint.className = "lesson-hint";
    if (classroomExplore && prompt) {
      hint.append(content, button);
      prompt.after(hint);
    } else {
      hint.append(button, content);
      section.after(hint);
    }
    if (question.partsMode === "explore" && typeof part.display.visible === "function") {
      const updateHintVisibility = (visible) => { hint.hidden = !visible; };
      updateHintVisibility(part.display.visible());
      part.display.visible.subscribe(updateHintVisibility);
    }
    part.events.on("post-submit", () => {
      if (part.answered && Number(part.score) < Number(part.marks) && !part.stepsOpen) {
        part.openSteps();
      }
    });
    // A branch opened after a wrong main answer starts with its hint visible.
    if (!authored && question.partsMode === "explore" && part.previousPart?.answered &&
        Number(part.previousPart.score) < Number(part.previousPart.marks) && !part.stepsOpen) {
      part.openSteps();
    }
  }
  if (question.partsMode === "explore") {
    if (classroomExplore) {
      question.events.on("setCurrentPart", (part) => {
        part.display.html_promise.then((section) => requestAnimationFrame(() => {
          if (question.currentPart !== part || !section.getClientRects().length) return;
          const target = section.querySelector(".prompt");
          if (!target) return;
          target.tabIndex = -1;
          target.focus({ preventScroll: true });
          const top = target.getBoundingClientRect().top;
          if (top < 0 || top >= window.innerHeight) target.scrollIntoView({ block: "start", behavior: "instant" });
        }));
      });
    }
    question.events.on("addExtraPart", (part) => {
      void decorate(part).catch((error) => console.error("ヒントの準備に失敗しました。", error));
    });
  }
  await Promise.all(question.parts.map(decorate));
}

/* Submit a valid numeric answer after typing stops, using the same Numbas
   submission path as Enter. Existing blur and manual submissions remain active. */
async function installNumericAutoSubmit(examElement, question = examElement.exam?.questionList?.[0]) {
  if (!question) return;
  async function bind(part) {
    if (part.type !== "numberentry") return;
    const section = await part.display.html_promise;
    const input = section.querySelector(".student.answer input.numberentry");
    if (!input) return;

    let timer;
    let composing = false;
    const cancel = () => {
      clearTimeout(timer);
      timer = undefined;
    };
    const schedule = () => {
      cancel();
      if (composing || input.disabled || input.readOnly || !input.value.trim()) return;
      timer = setTimeout(() => {
        timer = undefined;
        if (composing || !input.isConnected || input.disabled || input.readOnly || examElement.inert ||
            examElement.closest("[hidden]") || question.exam.currentQuestion !== question || part.locked ||
            part.submitting || !part.isDirty || !part.display.cleanStudentAnswer()) return;
        part.display.controls.submit();
      }, 2000);
    };

    input.addEventListener("input", (event) => {
      if (event.isComposing) cancel();
      else schedule();
    });
    input.addEventListener("compositionstart", () => { composing = true; cancel(); });
    input.addEventListener("compositionend", () => { composing = false; schedule(); });
    input.addEventListener("blur", cancel);
    part.events.on("post-submit", cancel);
  }
  if (question.partsMode === "explore") {
    question.events.on("addExtraPart", (part) => {
      void bind(part).catch((error) => console.error("数値入力の準備に失敗しました。", error));
    });
  }
  await Promise.all(question.parts.map(bind));
}

let continuousStyles;
function prepareContinuousStyles() {
  // One set supplies every exam in the chapter, even if the preview disconnects.
  return continuousStyles ??= Promise.all(stylesheetURLs.map(async (href) => {
    const css = await readExerciseText(href, "Numbasのスタイルを読み込めませんでした。", { retry: true });
    // Inline styles resolve font URLs relative to the page instead of the stylesheet.
    return css.replaceAll("resources/iconfont/", resource("numbas-runtime/resources/iconfont/"));
  })).catch((error) => {
    continuousStyles = undefined;
    throw error;
  });
}

let runtimeReady;
export async function prepareRuntime({ retryResources = false } = {}) {
  return runtimeReady ??= loadRuntime(retryResources);
}

async function loadRuntime(retryResources) {
  const html = await readExerciseText(resource("template.html"), "Numbasの画面テンプレートを取得できませんでした。",
    { retry: retryResources });
  const templateHost = document.createElement("div");
  templateHost.innerHTML = html.replaceAll(
    "numbas-runtime/", resource("numbas-runtime/")
  );
  const template = templateHost.querySelector("#numbas-exam-template");
  if (!template) throw new Error("Numbasの画面テンプレートが見つかりません。");
  document.body.appendChild(template);

  await customElements.whenDefined("numbas-exam");
  await window.Numbas.init_promise;
  window.Numbas.display.control_focus = false;
  await setExerciseLanguage();
}

export async function bootExam(examHost, examStatus, level, lessonLayout, authored = null) {
  let examData = authored?.examData;
  let exploreNavigation, choiceRetryAttempt;
  if (authored) {
    ({ exploreNavigation, choiceRetryAttempt } = await import("./explore-navigation.js?v=shared-design-1"));
    await prepareRuntime();
  } else {
    const response = await fetch(new URL(examHost.dataset.examSource, location.href));
    if (!response.ok) throw new Error("問題の情報を取得できませんでした。");
    const raw = await response.text();
    examData = JSON.parse(raw.replace(/^\s*\/\/[^\n]*\r?\n/, ""));
  }
  applyExerciseSettings(examData);

  const continuous = !lessonLayout && examHost.dataset.exerciseMode === "continuous";
  const inlineStyles = continuous ? await prepareContinuousStyles() : null;
  const exam = document.createElement("numbas-exam");
  if (continuous) exam.dataset.exerciseMode = "continuous";
  exam.toggleAttribute("data-main-question-set", Boolean(authored));
  const questionCount = examData.question_groups.reduce((sum, group) => sum + group.questions.length, 0);
  exam.toggleAttribute("data-classroom-navigation", Boolean(authored) || questionCount === 1);
  exam.setAttribute("noload", "");
  // Numbas accepts an inline exam definition. The original source is retained
  // on the host for answer review and for question-specific history IDs.
  const source = document.createElement("script");
  source.type = "application/numbas-exam";
  source.textContent = JSON.stringify(examData);
  exam.append(source);
  exam.setAttribute("scorm", "false");
  exam.addEventListener("numbas:loaded", () => {
    examStatus.textContent = "";
    const footer = exam.shadowRoot.querySelector("#questionContainer footer");
    if (footer) {
      const reviewSlot = document.createElement("slot");
      reviewSlot.name = "classroom-review";
      footer.after(reviewSlot);
    }
    if (authored) {
      const retryIds = new Set(lessonLayout && examHost.dataset.exerciseMode !== "continuous" ?
        examData.question_groups.flatMap((group) => group.questions)
          .filter((q) => q.tags?.includes("classroom:retry-by-choice") && q.partsMode === "explore" &&
            q.parts.every((part) => part.type === "1_n_2" && part.displayType === "radiogroup"))
          .map((q) => q.parts[0].customName) : []);
      for (const question of exam.exam.questionList) {
        const main = authored.set.mains.find((item) => item.id === definitionId(question.parts[0]));
        if (!main) {
          examStatus.textContent = "動作中の主問題と教材の固定IDが一致しません。";
          continue;
        }
        const historyKey = practiceHistoryKey(level);
        const retry = retryIds.has(main.id) ? choiceRetryAttempt(question, main.parts,
          () => isRecognizedCorrect(readPracticeHistory(historyKey), main.id, recognitionStartedAt),
          () => canRecordRepeatedCorrect(readPracticeHistory(historyKey), main.id, recognitionStartedAt)) : null;
        void installPracticeReview(exam, examHost, historyKey, level, { set: authored.set, main, question, retry })
          .catch((error) => { console.error(error); examStatus.textContent = "学習履歴を準備できませんでした。"; });
        void installNumericAutoSubmit(exam, question).catch((error) => console.error("数値入力の準備に失敗しました。", error));
        void installLessonHints(exam, question, hasAuthoredExploreControls(question), main.parts[0].nextParts?.length ? exploreNavigation(exam, question, main.parts, retry) : null, retry)
          .catch((error) => console.error("ヒントの準備に失敗しました。", error));
        retry?.connect();
      }
      return;
    }
    // Keep Numbas marking unchanged. Only replace the irreversible reveal action.
    const review = installPracticeReview(exam, examHost, practiceHistoryKey(level), level);
    if (lessonLayout) {
      void installLessonHints(exam).catch((error) => console.error("ヒントの準備に失敗しました。", error));
      void installNumericAutoSubmit(exam).catch((error) => console.error("数値入力の準備に失敗しました。", error));
    }
    void review
      .then((examData) => lessonLayout ? undefined : installWorksheetControls(exam, examData))
      .catch((error) => {
        console.error("問題画面の準備に失敗しました。", error);
      });
  }, { once: true });
  examHost.replaceChildren(exam);

  if (inlineStyles) {
    for (const css of inlineStyles) {
      const style = document.createElement("style");
      style.textContent = css;
      exam.shadowRoot.appendChild(style);
    }
  } else {
    await Promise.all(stylesheetURLs.map((href) => new Promise((resolve, reject) => {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = href;
      link.onload = resolve;
      link.onerror = () => reject(new Error("Numbasのスタイルを読み込めませんでした。"));
      exam.shadowRoot.appendChild(link);
    })));
  }
  await exam.load_exam();
}

/* Add the previous lesson without changing the existing list and next links. */
function prepareLessonNavigation(lessonNumber) {
  const toolbar = document.querySelector('.problem-toolbar[aria-label="問題ページの移動"]');
  const listLink = toolbar?.querySelector('a[href="../../"]');
  if (!listLink || lessonNumber < 1 || lessonNumber > 129) return;

  const previous = document.createElement(lessonNumber > 1 ? "a" : "span");
  previous.className = "problem-previous";
  previous.textContent = "前の問題へ";
  if (lessonNumber > 1) {
    previous.href = "../m1-l" + String(lessonNumber - 1).padStart(3, "0") + "/questions.html";
  } else {
    previous.classList.add("problem-previous-pending");
    previous.setAttribute("aria-label", "前の問題はありません");
  }
  listLink.classList.add("problem-list");
  toolbar.classList.add("lesson-navigation");
  toolbar.prepend(previous);
}

async function boot() {
  if (!host || !host.dataset.examSource) throw new Error("問題の参照先が設定されていません。");
  preparePageFrame();
  const lessonMatch = location.pathname.match(/\/junior-high\/grade-1\/math\/lessons\/m1-l(\d{3})\/questions\.html$/);
  const lessonLayout = Boolean(lessonMatch) || host.hasAttribute("data-difficulty-tabs");
  if (lessonMatch) prepareLessonNavigation(Number(lessonMatch[1]));
  if (host.hasAttribute("data-main-question-set")) return; // The type tabs boot the intact exam once.
  const runtime = prepareRuntime();
  const initialLoad = host.dataset.sequenceSource === host.dataset.examSource ? runtime : runtime.then(() => bootExam(host, status, "basic", lessonLayout));

  if (lessonLayout) {
    createDifficultyTabs(host, status, async (examHost, examStatus, level) => {
      try {
        const response = await fetch(new URL(examHost.dataset.examSource, location.href));
        if (response.status === 404) {
          examStatus.textContent = "問題はまだありません。";
          return;
        }
        if (!response.ok) throw new Error("問題の情報を取得できませんでした。");
        await initialLoad;
        await bootExam(examHost, examStatus, level, true);
      } catch (error) {
        console.error(error);
        examStatus.textContent = "問題を表示できませんでした。";
      }
    }, (level) => isRecognizedCorrect(readPracticeHistory(practiceHistoryKey(level)), null, recognitionStartedAt));
  }
  await initialLoad;
}
boot().catch((error) => {
  console.error(error);
  status.textContent = "問題を表示できませんでした。";
});

