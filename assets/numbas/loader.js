import { prepareAnswerControl, hasCheckedAnswer, setExerciseLanguage } from "./worksheet-controls.js";
/* One source of Numbas bootstrapping for all Classroom exercise pages. */
const host = document.querySelector("#numbas-host");
const status = document.querySelector("#numbas-status");
const engine = new URL("./engine/", import.meta.url);
const resource = (path) => new URL(path, engine).href;



/* A non-locking answer view and a local practice history. The original .exam files
   and the Numbas score calculation are deliberately left unchanged. */
const practiceHistoryPrefix = "classroom:practice-history:v1:";

function practiceHistoryKey() {
  return practiceHistoryPrefix + location.pathname;
}

function readPracticeHistory() {
  try {
    const value = JSON.parse(localStorage.getItem(practiceHistoryKey()) || "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function appendPracticeHistory(entry) {
  try {
    const history = readPracticeHistory();
    history.push({ ...entry, at: new Date().toISOString() });
    localStorage.setItem(practiceHistoryKey(), JSON.stringify(history));
    return true;
  } catch {
    return false;
  }
}

function readPracticeAnswers(examData) {
  const groups = examData.question_groups || [];
  const questions = groups.flatMap((group) => group.questions || []);
  if (questions.length !== 1 || !questions[0].parts?.length) return null;
  const answers = questions[0].parts.map((part) => {
    if (part.type === "numberentry" && typeof part.displayAnswer === "string") {
      return part.displayAnswer;
    }
    if (part.type === "1_n_2" && Array.isArray(part.choices) && Array.isArray(part.matrix)) {
      const choices = part.choices.filter((_, index) => Number(part.matrix[index]) > 0);
      if (choices.length === 1) return choices[0];
    }
    return null;
  });
  return answers.every((answer) => typeof answer === "string" && answer.length) ? answers : null;
}

async function installPracticeReview(examElement) {
  const question = examElement.exam?.questionList?.[0];
  if (!question?.parts?.length) return;

  // Record each submitted answer after Numbas has marked it. Wrong answers remain
  // recorded even if the learner later submits a correct answer.
  const lastSubmission = new Map();
  const updateViews = [];
  const refresh = () => updateViews.forEach((fn) => fn());
  const save = (entry, messageElement) => {
    if (!appendPracticeHistory(entry)) {
      messageElement.textContent = "このブラウザでは学習履歴を保存できません。";
      messageElement.hidden = false;
    }
    refresh();
  };

  const notice = document.createElement("p");
  notice.className = "practice-save-warning";
  notice.hidden = true;

  for (const part of question.parts) {
    part.events.on("post-submit", () => {
      if (!part.answered || !Number.isFinite(Number(part.score))) return;
      const score = Number(part.score);
      const maximum = Number(part.marks);
      if (!Number.isFinite(maximum) || maximum <= 0) return;
      const answer = String(part.display?.studentAnswer?.() ?? "");
      if (!answer.trim()) return;
      const signature = JSON.stringify([part.path, answer, score, maximum]);
      if (lastSubmission.get(part.path) === signature) return;
      lastSubmission.set(part.path, signature);
      save({
        kind: score >= maximum ? "correct" : "wrong",
        part: String(part.path),
        answer,
        score,
        maximum,
      }, notice);
    });
  }

  // Unlike Numbas' own "Reveal answer", the separate view below never calls
  // revealAnswer(), so the existing input fields remain editable.
  const response = await fetch(new URL(host.dataset.examSource, location.href));
  if (!response.ok) return;
  const raw = await response.text();
  const examData = JSON.parse(raw.replace(/^\s*\/\/[^\n]*\r?\n/, ""));
  const answers = readPracticeAnswers(examData);
  if (!answers) return;

  const section = document.createElement("section");
  section.className = "practice-panel";
  section.setAttribute("aria-label", "解答の確認と学習履歴");

  const button = document.createElement("button");
  button.type = "button";
  button.className = "practice-reveal-button";
  button.textContent = "答えを見る";
  button.setAttribute("aria-controls", "practice-answer");
  button.setAttribute("aria-expanded", "false");

  const answerBox = document.createElement("div");
  answerBox.className = "practice-answer";
  answerBox.id = "practice-answer";
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

  updateViews.push(() => {
    const history = readPracticeHistory();
    const wrong = history.filter((item) => item.kind === "wrong").length;
    const reveals = history.filter((item) => item.kind === "reveal").length;
    summary.textContent = "学習履歴：誤答" + wrong + "回・解答確認" + reveals + "回";
    list.replaceChildren();
    const recent = history.slice(-10).reverse();
    if (!recent.length) {
      const item = document.createElement("li");
      item.textContent = "まだ記録はありません。";
      list.append(item);
    }
    for (const record of recent) {
      const item = document.createElement("li");
      const label = record.kind === "wrong" ? "✕ 誤答" :
        record.kind === "correct" ? "○ 正解" : "答えを確認";
      const time = new Date(record.at);
      const when = Number.isNaN(time.valueOf()) ? "" : time.toLocaleString("ja-JP");
      item.textContent = label + (record.answer ? "（" + record.answer + "）" : "") +
        (when ? "　" + when : "");
      list.append(item);
    }
  });
  refresh();

  button.addEventListener("click", () => {
    const show = answerBox.hidden;
    answerBox.hidden = !show;
    button.setAttribute("aria-expanded", String(show));
    button.textContent = show ? "答えを隠す" : "答えを見る";
    if (show) save({ kind: "reveal" }, notice);
  });
  section.append(button, answerBox, details, notice);
  host.append(section);

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

async function boot() {
  if (!host || !host.dataset.examSource) throw new Error("問題の参照先が設定されていません。");
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

  const exam = document.createElement("numbas-exam");
  exam.setAttribute("noload", "");
  exam.setAttribute("source_url", host.dataset.examSource);
  exam.setAttribute("scorm", "false");
  exam.addEventListener("numbas:loaded", () => {
    status.textContent = "";
    // Keep Numbas marking unchanged. Only replace the irreversible reveal action.
    void installPracticeReview(exam)
      .then((examData) => installWorksheetControls(exam, examData))
      .catch((error) => {
        console.error("問題画面の準備に失敗しました。", error);
      });
  }, { once: true });
  host.replaceChildren(exam);

  const styles = [
    resource("numbas-runtime/numbas.css"),
    new URL("./theme.css", import.meta.url).href,
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
boot().catch((error) => {
  console.error(error);
  status.textContent = "問題を表示できませんでした。";
});
