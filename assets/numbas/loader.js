import { prepareAnswerControl, hasCheckedAnswer, setExerciseLanguage } from "./worksheet-controls.js?v=20261124-chapter-practice";
import { createDifficultyTabs } from "./difficulty-tabs.js";
import { applyExerciseSettings } from "./exercise-settings.js?v=20261123-shuffle";
import { initializeRecognitionRule, canRecordRepeatedCorrect, bindSelectedChoiceRetry, latestGradedKind, definitionId, allMainAnswersCorrect } from "./question-progress.js?v=fixed-parts-1";
/* One source of Numbas bootstrapping for all Classroom exercise pages. */
const host = document.querySelector("#numbas-host");
const status = document.querySelector("#numbas-status");
const engine = new URL("./engine/", import.meta.url);
const resource = (path) => new URL(path, engine).href;

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

function addSubjectSelectionLink() {
  const context = lessonContext();
  const toolbar = document.querySelector('.problem-toolbar[aria-label="問題ページの移動"]');
  if (!context || !toolbar || document.getElementById("other-subject-link")) return;
  const url = new URL(context.root + "study-home/", location.origin);
  url.searchParams.set("grade", context.grade);
  url.searchParams.set("screen", "subjects");
  const link = document.createElement("a");
  link.id = "other-subject-link";
  link.className = "text-link";
  link.href = url.href;
  link.textContent = "別の科目を見る";
  if (host?.hasAttribute("data-main-question-set")) {
    link.slot = "review-actions";
    // Keep the same link available below the lesson while Numbas loads.
    host.after(link);
    return;
  }
  const wrapper = document.createElement("p");
  wrapper.className = "problem-toolbar";
  wrapper.style.margin = "-10px 0 20px";
  wrapper.append(link);
  toolbar.after(wrapper);
}
addSubjectSelectionLink();

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

function practiceHistoryKey(level = "basic") {
  const base = practiceHistoryPrefix + location.pathname;
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

async function installPracticeReview(examElement, examHost, historyKey, level, set = null, question = examElement.exam?.questionList?.[0]) {
  if (!question?.parts?.length) return;
  // Some lesson pages replace the card in place. Capture its identity now,
  // before the shared host is pointed at the next question.
  const main = set?.mains.find((item) => item.id === definitionId(question.parts[0]));
  if (set && !main) throw new Error("動作中の主問題と教材の固定IDが一致しません。");
  const supportLabels = new Map();
  for (const edge of main?.parts[0].nextParts || []) {
    const id = main.parts[edge.otherPart]?.customName;
    if (id && edge.label && edge.label !== id) supportLabels.set(id, edge.label);
  }
  const questionId = main?.id || examHost.dataset.historyQuestionId || "";
  const questionNumber = set ? set.ids.indexOf(questionId) + 1 : examHost.dataset.historyQuestionNumber || "";
  const explore = question.partsMode === "explore";
  const authoredControls = set && hasAuthoredExploreControls(question);
  const primaryPart = question.parts[0];
  const showsAnswerOnCard = (part) => set && part.type === "1_n_2" && part.settings.displayType === "radiogroup";
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
      readPracticeHistory(historyKey), questionId || null, recognitionStartedAt
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
      const signature = JSON.stringify([part.path, answer, score, maximum]);
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
      // In explore mode, follow a uniquely available wrong-answer branch.
      // Correct answers stay on the main question with Numbas' optional paths.
      if (!authoredControls && !question.classroomHandlesBranchNavigation && explore && !support &&
          score < maximum && typeof part.availableNextParts === "function") {
        setTimeout(() => {
          if (!examHost.contains(examElement) || question.currentPart !== part ||
              !part.answered || Number(part.score) >= Number(part.marks)) return;
          const candidates = part.availableNextParts();
          if (candidates.length !== 1) return;
          const branch = candidates[0];
          if (branch.instance) question.setCurrentPart(branch.instance);
          else part.makeNextPart(branch);
        }, 0);
      }
    });

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
  const answerId = set ? "practice-answer-" + questionId : level === "basic" ? "practice-answer" : "practice-answer-" + level;
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
    const history = questionId ? allHistory.filter((item) => item.questionId === questionId) : allHistory;
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
  if (set) {
    const sync = () => { section.hidden = examElement.exam.currentQuestion !== question; };
    sync();
    examElement.exam.events.on("changeQuestion", sync);
  }
  if (set && examElement.shadowRoot.querySelector('slot[name="classroom-review"]')) {
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

  // Sites waits until Numbas has attached the part HTML before decorating it.
  await new Promise((resolve) => setTimeout(resolve, 0));
  const controls = [];
  let submit;
  try {
    for (const [index, part] of question.parts.entries()) {
      const steps = definedParts[index].steps || [];
      const hintMarkup = steps.filter((step) => step.type === "information")
        .map((step) => step.prompt || "").filter(Boolean).join("");
      controls.push(await prepareAnswerControl(part, index, hintMarkup));
    }

    const form = controls[0]?.form;
    if (!form) throw new Error("Numbasの入力フォームが見つかりません。");
    submit = document.createElement("button");
    submit.type = "submit";
    submit.className = "check-answers";
    submit.textContent = controls.length > 1 ? "まとめて答え合わせ" : "答え合わせ";
    form.append(submit);
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

    // Keep the hint outside <numbas-exam>, whose shadow DOM contains the card.
    const panels = controls.map((control) => control.hintPanel).filter(Boolean);
    if (panels.length) {
      const external = document.createElement("section");
      external.className = "worksheet-hints";
      external.setAttribute("aria-label", "問題のヒント");
      external.append(...panels);
      examElement.after(external);
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
  const heading = document.createElement("strong");
  heading.className = "classroom-result-heading";
  const mark = document.createElement("span");
  mark.className = "classroom-result-mark";
  mark.setAttribute("aria-hidden", "true");
  mark.textContent = correct ? "◯" : "☓";
  heading.append(mark, correct ? "正解" : "不正解");
  output.prepend(heading);
}

// Keep the bound Numbas controls and the feedback element updated by the exam.
function arrangeExplorePart(part, section, prompt, attachArrow) {
  const feedback = prompt?.querySelector("[data-classroom-result]");
  const answer = section.querySelector(":scope > .student.answer");
  if (!part.previousPart) {
    // The native root-part legend includes the management ID in its accessible name.
    for (const legend of answer?.querySelectorAll("fieldset:has(.radiogroup) > legend.sr-only") || []) {
      legend.parentElement.setAttribute("aria-label", "回答の選択肢");
      legend.setAttribute("aria-hidden", "true");
    }
  }
  if (feedback && answer) {
    const paragraph = feedback.parentElement;
    answer.after(feedback);
    if (paragraph.matches("p:empty")) paragraph.remove();
    const format = () => formatExploreResult(feedback, part.score >= part.marks);
    new MutationObserver(format).observe(feedback, { childList: true });
    format();
  }
  if (part.type === "1_n_2" && answer) {
    const markExpected = () => {
      const expected = String(part.display.correctAnswer());
      for (const input of answer.querySelectorAll(".radiogroup input[type=radio]")) {
        input.closest("li").classList.toggle("classroom-expected", part.answered && input.value === expected);
      }
    };
    part.events.on("post-submit", markExpected);
    markExpected();
  }
  attachArrow(part, section, prompt, answer, feedback);
}

/* Reuse the native hint and its open state in both lesson layouts. */
async function installLessonHints(examElement, question = examElement.exam?.questionList?.[0], authored = false, attachArrow = null) {
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
    if (attachArrow) arrangeExplorePart(part, section, prompt, attachArrow);
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
async function installNumericAutoSubmit(examElement) {
  const question = examElement.exam?.questionList?.[0];
  if (!question) return;
  async function bind(part) {
    if (part.type !== "numberentry") return;
    const section = await part.display.html_promise;
    const input = section.querySelector(":scope > .student.answer input.numberentry");
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
        if (composing || !input.isConnected || input.disabled || input.readOnly ||
            examElement.closest('[role="tabpanel"][hidden]') || part.locked ||
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

export async function prepareRuntime() {
  const response = await fetch(resource("template.html"));
  if (!response.ok) throw new Error("Numbasの画面テンプレートを取得できませんでした。");
  const templateHost = document.createElement("div");
  templateHost.innerHTML = (await response.text()).replaceAll(
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
  let exploreNavigation;
  if (authored) {
    ({ exploreNavigation } = await import("./explore-navigation.js?v=classroom-arrows-1"));
    await prepareRuntime();
  } else {
    const response = await fetch(new URL(examHost.dataset.examSource, location.href));
    if (!response.ok) throw new Error("問題の情報を取得できませんでした。");
    const raw = await response.text();
    examData = JSON.parse(raw.replace(/^\s*\/\/[^\n]*\r?\n/, ""));
  }
  applyExerciseSettings(examData);

  const exam = document.createElement("numbas-exam");
  const subjectLink = authored && document.querySelector('#other-subject-link[slot="review-actions"]');
  exam.toggleAttribute("data-main-question-set", Boolean(authored));
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
    if (authored) {
      const footer = exam.shadowRoot.querySelector("#questionContainer footer");
      if (footer) {
        if (subjectLink && exam.shadowRoot.querySelector('#questionContainer slot[name="review-actions"]')) {
          exam.append(subjectLink);
        }
        const reviewSlot = document.createElement("slot");
        reviewSlot.name = "classroom-review";
        footer.after(reviewSlot);
      }
      for (const question of exam.exam.questionList) {
        void installPracticeReview(exam, examHost, practiceHistoryKey(level), level, authored.set, question)
          .catch((error) => { console.error(error); examStatus.textContent = "学習履歴を準備できませんでした。"; });
        void installLessonHints(exam, question, hasAuthoredExploreControls(question), exploreNavigation(exam, question))
          .catch((error) => console.error("ヒントの準備に失敗しました。", error));
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

  const styles = [
    resource("numbas-runtime/numbas.css"),
    new URL("./theme.css?v=lesson-footer-1", import.meta.url).href,
  ];
  await Promise.all(styles.map((href) => new Promise((resolve, reject) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    link.onload = resolve;
    link.onerror = () => reject(new Error("Numbasのスタイルを読み込めませんでした。"));
    exam.shadowRoot.appendChild(link);
  })));
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
  const lessonMatch = location.pathname.match(/\/junior-high\/grade-1\/math\/lessons\/m1-l(\d{3})\/questions\.html$/);
  const lessonLayout = Boolean(lessonMatch) || host.hasAttribute("data-difficulty-tabs");
  if (lessonMatch) prepareLessonNavigation(Number(lessonMatch[1]));
  if (host.hasAttribute("data-main-question-set")) return; // The type tabs boot the intact exam once.
  const runtime = prepareRuntime();
  const initialLoad = runtime.then(() => bootExam(host, status, "basic", lessonLayout));

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
    });
  }
  await initialLoad;
}
boot().catch((error) => {
  console.error(error);
  status.textContent = "問題を表示できませんでした。";
});

