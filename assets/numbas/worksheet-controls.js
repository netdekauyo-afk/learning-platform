// Static Classroom worksheet controls adapted from the existing Sites implementation.
const translations = {
  "question.submit part": "答え合わせ",
  "question.show steps": "ヒントを表示",
  "question.hide steps": "ヒントを隠す",
  "question.show steps no penalty": "",
  "question.hide steps no penalty": "",
  "question.answer saved": "確認済み",
  "part.input title": "{{name}}の答え",
  "part.feedback title": "{{name}}の採点の詳細",
  "part.feedback": "採点の詳細",
  "part.there is new feedback": "採点結果が更新されました。",
  "part.correct answer": "正しい答え",
  "part.correct answer title": "{{name}}の正しい答え",
  "part.feedback out of date": "答えを変更したら、もう一度答え合わせをしてください。",
  "question.score feedback.score total actual": "{{score,niceNumber}} / {{marks,niceNumber}} 点",
  "question.nav.label": "問題の操作",
  "control.style options": "表示設定",
  "modal.style.main font": "書体",
  "modal.style.font.sans serif": "ゴシック体",
  "modal.style.font.serif": "明朝体",
  "modal.style.font.monospace": "等幅",
  "modal.style.text size": "文字の大きさ",
  "modal.style.font weight": "文字の太さ",
  "modal.style.spacing": "余白",
  "modal.style.colour scheme": "配色",
  "modal.style.automatic colour scheme": "標準",
  "modal.style.light colour scheme": "ライト",
  "modal.style.dark colour scheme": "ダーク",
  "modal.style.custom colour scheme": "色を個別に指定",
  "modal.style.background colour": "背景",
  "modal.style.text colour": "文字",
  "modal.style.main colour": "メインカラー",
  "modal.style.primary colour": "主要なボタン",
  "modal.style.link colour": "リンク",
  "modal.style.success colour": "正解",
  "modal.style.info colour": "案内",
  "modal.style.warning colour": "注意",
  "modal.style.danger colour": "エラー",
  "modal.style.muted colour": "補足",
  "modal.style.highlight colour": "強調",
  "modal.style.reset to defaults": "標準に戻す",
  "modal.forced colours warning": "端末の設定で表示色が指定されています。",
  "accessibility statement": "Numbasのアクセシビリティガイド",
  "page.skip to content": "問題へ移動",
  "lightbox.zoom in on image": "図を拡大",
  "modal.confirm": "確認",
  "modal.ok": "確認",
};
const outcomes = {
  correct: ["○", "正解"],
  partial: ["△", "一部正解"],
  wrong: ["✕", "不正解"],
};

export async function setExerciseLanguage() {
  window.Numbas.locale.set_preferred_locale("ja-JP");
  window.i18next.addResourceBundle("ja-jp", "translation", translations, true, true);
  await window.i18next.changeLanguage("ja-jp");
}

// The persisted answer is text for number entry, or the stable zero-based radio value.
export function partAnswers(part) {
  const draft = String(part.display.studentAnswer() ?? "");
  if (!part.answered) return { draft, submitted: null };
  if (part.type === "1_n_2") {
    const index = part.ticks.findIndex((row) => row[0]);
    return { draft, submitted: index < 0 ? null : String(index) };
  }
  return { draft, submitted: String(part.studentAnswer ?? "") };
}

export function restorePartAnswers(part, saved) {
  function stage(value) {
    if (part.type === "1_n_2") {
      const index = /^\d+$/.test(value) && Number(value) < part.numAnswers ? Number(value) : null;
      part.storeTick({ answer: index, choice: 0 });
      part.display.studentAnswer(index === null ? "" : String(index));
    } else {
      part.display.restoreAnswer(value);
      part.storeAnswer(value, true);
    }
  }
  if (saved.submitted?.trim()) {
    stage(saved.submitted);
    part.submit();
  }
  if (saved.draft !== partAnswers(part).draft) stage(saved.draft);
}

export function hasCheckedAnswer(part) {
  const { draft, submitted } = partAnswers(part);
  return submitted !== null && draft.trim() !== "" && !part.isDirty && draft.trim() === submitted.trim();
}

function prepareHint(section, prompt, inputId, headingId) {
  const content = prompt.querySelector(".hint-content");
  if (!content) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "hint-toggle";
  content.id = inputId + "-hint";
  button.setAttribute("aria-controls", content.id);
  button.setAttribute("aria-describedby", headingId);
  function setOpen(open) {
    content.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
    button.textContent = open ? "ヒントを隠す" : "ヒントを表示";
  }
  setOpen(false);
  button.addEventListener("click", () => setOpen(content.hidden));
  section.append(button, content);
  return () => setOpen(true);
}

function numericControl(part, section, answer, index) {
  const input = answer.querySelector("input.numberentry");
  input.inputMode = "decimal";
  input.maxLength = 128;
  input.placeholder = "入力";
  function normalizeInput() {
    const value = input.value.replace(/[０-９＋－．／−]/g, (character) =>
      character === "−" ? "-" : character.normalize("NFKC"),
    );
    if (value !== input.value) {
      const { selectionStart, selectionEnd } = input;
      input.value = value;
      input.setSelectionRange(selectionStart, selectionEnd);
    }
  }
  let composing = false;
  input.addEventListener("compositionstart", () => { composing = true; });
  input.addEventListener("input", (event) => {
    if (!composing && !event.isComposing) normalizeInput();
  }, true);
  input.addEventListener("compositionend", () => {
    composing = false;
    normalizeInput();
    part.display.studentAnswer(input.value);
  });
  // Numbas submits on keypress. Return must be available to confirm an IME candidate.
  input.addEventListener("keypress", (event) => {
    if (composing || event.isComposing || event.keyCode === 229) event.stopImmediatePropagation();
  }, true);
  const unit = section.querySelector(".prompt .answer-unit");
  if (unit) {
    unit.hidden = false;
    input.after(unit);
    answer.classList.add("with-unit");
  }
  const pad = document.createElement("fieldset");
  pad.className = "number-pad";
  pad.setAttribute("aria-label", part.name + "の数字ボタン");
  let panel;
  if (part.question.parts.length > 1) {
    // A learner can switch keypads without focusing a text field or opening the device keyboard.
    panel = document.createElement("details");
    panel.className = "number-pad-panel";
    panel.name = "worksheet-number-pads";
    panel.open = index === 0;
    const summary = document.createElement("summary");
    summary.textContent = "数字ボタン";
    summary.setAttribute("aria-label", part.name + "の数字ボタン");
    panel.append(summary, pad);
    section.append(panel);
    input.addEventListener("focus", () => {
      if (!input.readOnly) panel.open = true;
    });
  } else {
    section.append(pad);
  }
  for (const key of ["7", "8", "9", "消す", "4", "5", "6", "±", "1", "2", "3", "0", "."]) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = key;
    if (key === "消す") {
      button.className = "pad-delete";
      button.setAttribute("aria-label", "1字消す");
    } else if (key === "±") {
      button.className = "pad-sign";
      button.setAttribute("aria-label", "符号を変える");
    } else if (key === "0") button.className = "pad-zero";
    else if (key === ".") button.setAttribute("aria-label", "小数点");
    button.addEventListener("click", () => {
      if (pad.disabled) return;
      let value = partAnswers(part).draft;
      if (key === "消す") value = value.slice(0, -1);
      else if (key === "±") value = value.startsWith("-") ? value.slice(1) : "-" + value;
      else if (key === ".") {
        if (value.includes(".")) return;
        value = (value === "" || value === "-" ? value + "0" : value) + ".";
      } else {
        value = value.replace(/^(-?)0$/, "$1") + key;
      }
      if (value.length <= input.maxLength) part.display.studentAnswer(value);
    });
    pad.append(button);
  }
  return {
    input,
    guidance() {
      normalizeInput();
      part.display.studentAnswer(input.value);
      const draft = partAnswers(part).draft.trim();
      if (!draft) return "答えを入力してください。";
      if (part.display.cleanStudentAnswer() === "") return "答えを数字で入力してください。";
      return "";
    },
    focus() {
      if (matchMedia("(pointer: coarse)").matches && input.getRootNode().activeElement !== input) {
        if (panel) panel.open = true;
        pad.querySelector("button").focus();
      } else {
        input.focus();
      }
    },
    lock(locked) {
      input.readOnly = locked;
      pad.disabled = locked;
      if (panel) panel.hidden = locked;
    },
    solution() {
      const value = String(part.display.correctAnswer()).replace(/^-/, "−");
      return unit ? value + " " + unit.textContent : value;
    },
  };
}

function choiceControl(part, answer) {
  const group = answer.querySelector("fieldset");
  const buttons = Array.from(group.querySelectorAll('input[type="radio"]'));
  const input = buttons[0];
  return {
    input,
    guidance() { return buttons.some((radio) => radio.checked) ? "" : "答えを1つ選んでください。"; },
    focus() { input.focus(); },
    lock(locked) { group.disabled = locked; },
    solution() {
      const correct = String(part.display.correctAnswer());
      return buttons.find((button) => button.value === correct).closest("label").textContent.trim();
    },
  };
}

export async function prepareAnswerControl(part, index, stepHintHTML = '') {
  const display = part.display;
  const section = await display.html_promise;
  const answer = section.querySelector(".student.answer");
  const heading = section.querySelector(".partheader");
  const prompt = section.querySelector(".prompt");
  const choice = part.type === "1_n_2";
  if (choice || prompt.querySelector(".worksheet-text") || prompt.textContent.trim().length > 20) section.classList.add("written-question");
  const control = choice ? choiceControl(part, answer) : numericControl(part, section, answer, index);
  const { input } = control;
  if (!input.id) input.id = part.full_path + "-first-option";
  const base = input.id + "-worksheet";
  heading.id = base + "-question";
  prompt.id = base + "-prompt";
  // Numbas .exam uses information steps; Sites embeds hints in prompt markup.
  // Adapt only the hint source, retaining the existing Sites component behavior.
  if (stepHintHTML && !prompt.querySelector(".hint-content")) {
    const content = document.createElement("div");
    content.className = "hint-content";
    content.hidden = true;
    content.innerHTML = stepHintHTML;
    prompt.appendChild(content);
  }
  const openHint = prepareHint(section, prompt, base, heading.id);
  const label = document.createElement(choice ? "span" : "label");
  label.className = "answer-label";
  label.textContent = choice ? "答えを1つ選ぶ" : "答え";
  label.id = base + "-label";
  if (!choice) {
    label.htmlFor = input.id;
    input.setAttribute("aria-labelledby", heading.id + " " + label.id);
  }
  const note = document.createElement("output");
  note.className = "answer-note";
  note.id = base + "-note";
  note.setAttribute("aria-live", "polite");
  const field = choice ? answer.querySelector("fieldset") : input;
  if (choice) field.setAttribute("aria-labelledby", label.id);
  field.setAttribute("aria-describedby", prompt.id + " " + note.id);
  answer.classList.add("answer-row");
  answer.before(label);
  answer.after(note);
  const partButton = section.querySelector("button.submitPart");
  partButton.type = "button";
  partButton.hidden = true;
  let guidance = "";
  let showResult = false;
  function refresh() {
    const checked = showResult && hasCheckedAnswer(part);
    section.classList.toggle("checked-answer", checked);
    if (guidance) field.setAttribute("aria-invalid", "true");
    else field.removeAttribute("aria-invalid");
    if (!checked) {
      note.textContent = guidance;
      return;
    }
    const outcome = outcomes[display.scoreFeedback.state()];
    if (!outcome) {
      note.textContent = "確認済み";
      return;
    }
    const mark = document.createElement("span");
    mark.className = "mark";
    mark.setAttribute("aria-hidden", "true");
    mark.textContent = outcome[0];
    note.replaceChildren(mark, " " + outcome[1]);
  }
  display.controls.submit = () => input.form.requestSubmit();
  display.studentAnswer.subscribe(() => {
    guidance = "";
    refresh();
  });
  return {
    form: input.form,
    lock: control.lock,
    solution: control.solution,
    validate() {
      guidance = control.guidance();
      refresh();
      if (guidance) control.focus();
      return !guidance;
    },
    showResult() {
      showResult = true;
      display.feedbackShown(false);
      refresh();
      if (["wrong", "partial"].includes(display.scoreFeedback.state())) openHint?.();
    },
  };
}
