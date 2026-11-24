import { prepareAnswerControl, hasCheckedAnswer, setExerciseLanguage } from "./worksheet-controls.js?v=20261124-explore";
import { createDifficultyTabs } from "./difficulty-tabs.js";
import { applyExerciseSettings } from "./exercise-settings.js?v=20261123-shuffle";
import { initializeRecognitionRule, canRecordRepeatedCorrect, bindSelectedChoiceRetry } from "./question-progress.js?v=20261123-recognition";
/* One source of Numbas bootstrapping for all Classroom exercise pages. */
const host = document.querySelector("#numbas-host");
const status = document.querySelector("#numbas-status");
const engine = new URL("./engine/", import.meta.url);
const resource = (path) => new URL(path, engine).href;

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

async function installPracticeReview(examElement, examHost, historyKey, level) {
  const question = examElement.exam?.questionList?.[0];
  if (!question?.parts?.length) return;
  // Some lesson pages replace the card in place. Capture its identity now,
  // before the shared host is pointed at the next question.
  const questionId = examHost.dataset.historyQuestionId || "";
  const questionNumber = examHost.dataset.historyQuestionNumber || "";
  const explore = question.partsMode === "explore";
  const primaryPart = question.parts[0];
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
  const lastSubmission = new Map();
  const updateViews = [];
  const refresh = () => updateViews.forEach((fn) => fn());
  const save = (entry, messageElement, support = false) => {
    const key = support ? supportHistoryKey : historyKey;
    if (!appendPracticeHistory(key, questionId ? { ...entry, questionId } : entry)) {
      messageElement.textContent = "このブラウザでは学習履歴を保存できません。";
      messageElement.hidden = false;
    }
    refresh();
    examHost.dispatchEvent(new CustomEvent("classroom:history-changed", { bubbles: true }));
  };

  const notice = document.createElement("p");
  notice.className = "practice-save-warning";
  notice.hidden = true;

  const boundParts = new WeakSet();
  function bindPart(part) {
    if (boundParts.has(part)) return;
    boundParts.add(part);
    const support = explore && part !== primaryPart;
    const repeatCanCount = () => !support && canRecordRepeatedCorrect(
      readPracticeHistory(historyKey), questionId || null, recognitionStartedAt
    );
    part.events.on("post-submit", () => {
      if (!part.answered || !Number.isFinite(Number(part.score))) return;
      const score = Number(part.score);
      const maximum = Number(part.marks);
      if (!Number.isFinite(maximum) || maximum <= 0) return;
      const answer = String(part.display?.studentAnswer?.() ?? "");
      if (!answer.trim()) return;
      const signature = JSON.stringify([part.path, answer, score, maximum]);
      if (lastSubmission.get(part) === signature &&
          !(score >= maximum && repeatCanCount())) return;
      lastSubmission.set(part, signature);
      save({
        kind: score >= maximum ? "correct" : "wrong",
        part: String(part.path),
        answer,
        score,
        maximum,
      }, notice, support);
      // In explore mode, follow a uniquely available wrong-answer branch.
      // Correct answers stay on the main question with Numbas' optional paths.
      if (explore && !support && score < maximum && typeof part.availableNextParts === "function") {
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

    // Mark a single-choice answer as soon as Numbas has stored the selection.
    if (part.type === "1_n_2") {
      part.events.on("storeAnswer", () => {
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
  const response = await fetch(new URL(examHost.dataset.examSource, location.href));
  if (!response.ok) return;
  const raw = await response.text();
  const examData = JSON.parse(raw.replace(/^\s*\/\/[^\n]*\r?\n/, ""));
  // A replaced card must not append its review controls to the new card.
  if (!examHost.contains(examElement)) return examData;
  const answers = readPracticeAnswers(examData);
  if (!answers) return;

  const section = document.createElement("section");
  section.className = "practice-panel";
  section.setAttribute("aria-label", "解答の確認と学習履歴");

  const button = document.createElement("button");
  button.type = "button";
  button.className = "practice-reveal-button";
  button.textContent = "答えを見る";
  const answerId = level === "basic" ? "practice-answer" : "practice-answer-" + level;
  button.setAttribute("aria-controls", answerId);
  button.setAttribute("aria-expanded", "false");

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
      item.textContent = label + (record.answer ? "（" + record.answer + "）" : "") +
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
    summary.textContent = prefix + "誤答" + wrong + "回・解答確認" + reveals + "回";
    renderHistory(list, history);
    if (questionId) {
      const older = allHistory.filter((item) => !item.questionId || !activeQuestionIds.includes(item.questionId));
      olderDetails.hidden = older.length === 0;
      olderSummary.textContent = "以前の履歴（旧問題・設問未区別）：" + older.length + "件";
      renderHistory(olderList, older);
    }
    if (explore) {
      const supportHistory = readPracticeHistory(supportHistoryKey)
        .filter((item) => !questionId || item.questionId === questionId);
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
      const defined = examData.question_groups?.[0]?.questions?.[0]?.parts?.[question.currentPart?.index];
      const value = defined && readPartAnswer(defined);
      const p = document.createElement("p");
      p.textContent = value || "この補助問題の答えは表示できません。";
      answerBox.replaceChildren(heading, p);
    } else if (show && typeof question.display?.hasAdvice === "function" &&
        question.display.hasAdvice()) {
      // Reuse Numbas' rendered advice, including its formatting and variables.
      const advice = examElement.shadowRoot?.querySelector(".adviceDisplay");
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
    if (show) save({ kind: "reveal" }, notice, inSupport);
  });
  if (explore) question.events.on("setCurrentPart", () => {
    answerBox.hidden = true;
    button.setAttribute("aria-expanded", "false");
    button.textContent = "答えを見る";
  });
  section.append(button, answerBox, details);
  if (questionId) section.append(olderDetails);
  if (explore) section.append(supportDetails);
  section.append(notice);
  examHost.append(section);

  // Hide Numbas' irreversible reveal button only when our safe replacement
  // is ready. If this setup fails, Numbas retains its original functionality.
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

/* Keep the existing Numbas controls and card, but put its own hint after the
   card. Opening a hint after an incorrect answer does not re-submit the part. */
async function installLessonHints(examElement) {
  const question = examElement.exam?.questionList?.[0];
  if (!question) return;
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
    const button = section.querySelector(":scope > .stepsBtn");
    const content = section.querySelector(":scope > .steps.well");
    if (!button || !content) return;
    const hint = document.createElement("div");
    hint.className = "lesson-hint";
    hint.append(button, content);
    section.after(hint);
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
    if (question.partsMode === "explore" && part.previousPart?.answered &&
        Number(part.previousPart.score) < Number(part.previousPart.marks) && !part.stepsOpen) {
      part.openSteps();
    }
  }
  if (question.partsMode === "explore") {
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

async function prepareRuntime() {
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

export async function bootExam(examHost, examStatus, level, lessonLayout) {
  const response = await fetch(new URL(examHost.dataset.examSource, location.href));
  if (!response.ok) throw new Error("問題の情報を取得できませんでした。");
  const raw = await response.text();
  const examData = JSON.parse(raw.replace(/^\s*\/\/[^\n]*\r?\n/, ""));
  applyExerciseSettings(examData);

  const exam = document.createElement("numbas-exam");
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
    new URL("./theme.css?v=20261124-choice-feedback", import.meta.url).href,
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

