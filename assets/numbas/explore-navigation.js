const compareIds = new Intl.Collator("en", { numeric: true }).compare;

// A Numbas branch's index identifies its target in the authored parts array,
// even before that part has a runtime instance or a path.
export function nextOptionalBranch(available, parts, lastId) {
  const ordered = available.map((branch) => ({ branch, id: parts[branch.index].customName }));
  ordered.sort((a, b) => compareIds(a.id, b.id));
  const next = ordered.find(({ id }) => compareIds(id, lastId) > 0) ?? ordered[0];
  return next?.branch;
}

export function exploreNavigation(examElement, question, parts) {
  const main = question.parts[0];
  const branchDelayMs = 10000;
  const transitionMs = 220;
  let forward, countdown, movingArrow, navigationTimer, countdownInterval;
  let deadline = 0;
  let lastOptionalId = "";

  function active(part) {
    return examElement.isConnected && question.exam.currentQuestion === question && question.currentPart === part;
  }
  function next() {
    if (!main.answered || main.isDirty) return;
    const available = main.availableNextParts();
    if (main.score < main.marks) return available.length === 1 ? available[0] : undefined;
    return nextOptionalBranch(available, parts, lastOptionalId);
  }
  function refresh() {
    if (!forward) return;
    const option = next();
    forward.disabled = !option;
    forward.setAttribute("aria-label", option?.label ? "補助問題へ　" + option.label : "補助問題へ");
  }
  function cancel() {
    clearTimeout(navigationTimer);
    clearInterval(countdownInterval);
    movingArrow?.classList.remove("is-moving");
    movingArrow = null;
    deadline = 0;
    if (countdown) countdown.hidden = true;
  }
  function move(part, arrow) {
    if (!active(part) || movingArrow || arrow.disabled) return;
    clearTimeout(navigationTimer);
    movingArrow = arrow;
    arrow.classList.add("is-moving");
    const delay = deadline ? Math.max(0, Math.min(transitionMs, deadline - performance.now())) : transitionMs;
    navigationTimer = setTimeout(() => {
      cancel();
      if (!active(part)) return;
      if (part !== main) {
        question.display.goToPreviousPart();
      } else {
        const branch = next();
        if (!branch) return;
        if (branch.instance) question.setCurrentPart(branch.instance);
        else main.makeNextPart(branch);
        if (main.score >= main.marks) lastOptionalId = parts[branch.index].customName;
      }
      refresh();
    }, delay);
  }
  function afterMark() {
    if (main.score < main.marks) lastOptionalId = "";
    refresh();
    if (!forward || !active(main) || main.resuming || question.exam.loading ||
        question.exam.mode === "review" || main.score >= main.marks || !next()) return;
    deadline = performance.now() + branchDelayMs;
    const tick = () => {
      const seconds = Math.max(1, Math.ceil((deadline - performance.now()) / 1000));
      const message = "あと" + seconds + "秒で補助問題へ";
      if (countdown.textContent !== message) countdown.textContent = message;
    };
    tick();
    countdown.hidden = false;
    countdownInterval = setInterval(tick, 200);
    navigationTimer = setTimeout(() => move(main, forward), branchDelayMs - transitionMs);
  }
  main.events.on("pre-submit", cancel);
  main.events.on("post-submit", afterMark);
  question.events.on("setCurrentPart", () => { cancel(); refresh(); });
  question.exam.events.on("changeQuestion", () => { if (!active(main)) cancel(); });
  window.addEventListener("pagehide", cancel);

  return function attach(part, section, prompt, answer, feedback) {
    const back = part !== main;
    const arrow = document.createElement("button");
    arrow.type = "button";
    arrow.className = "classroom-arrow " + (back ? "back" : "forward");
    arrow.setAttribute("aria-label", back ? "主問題に戻る" : "補助問題へ");
    const triangle = document.createElement("span");
    triangle.setAttribute("aria-hidden", "true");
    arrow.append(triangle);
    arrow.addEventListener("click", () => move(part, arrow));

    if (part.type === "1_n_2" && prompt && answer) {
      section.classList.add("classroom-choice-part");
      const card = document.createElement("div");
      card.className = "classroom-question-card";
      prompt.before(card);
      card.append(prompt, answer);
      section.append(arrow);
    } else {
      // Other input types keep their native part layout and input controls.
      section.parentElement.classList.add("classroom-part-with-arrow");
      section.after(arrow);
    }
    if (back) return;
    forward = arrow;
    countdown = document.createElement("span");
    countdown.className = "classroom-countdown";
    countdown.setAttribute("role", "timer");
    countdown.setAttribute("aria-live", "off");
    countdown.hidden = true;
    (feedback || section).after(countdown);
    question.classroomHandlesBranchNavigation = true;
    refresh();
  };
}
