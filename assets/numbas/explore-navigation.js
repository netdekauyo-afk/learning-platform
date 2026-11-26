import { exerciseSettings } from "./exercise-settings.js?v=shared-design-1";

const compareIds = new Intl.Collator("en", { numeric: true }).compare;

// A Numbas branch's index identifies its target in the authored parts array,
// even before that part has a runtime instance or a path.
export function nextOptionalBranch(available, parts, lastId) {
  const ordered = available.map((branch) => ({ branch, id: parts[branch.index].customName }));
  ordered.sort((a, b) => compareIds(a.id, b.id));
  const next = ordered.find(({ id }) => compareIds(id, lastId) > 0) ?? ordered[0];
  return next?.branch;
}

export function requiredBranches(branches, parts, mistakes) {
  const required = new Set(mistakes.map((mistake) => mistake.supportId));
  // Distinct authored edges can lead to the same support definition.
  return branches.filter((branch) => required.delete(parts[branch.index].customName))
    .sort((a, b) => compareIds(parts[a.index].customName, parts[b.index].customName));
}

// Only the current tab's unfinished work is restored here. Grading, permanent
// history, recognition and home progress continue to use the existing pipeline.
export function choiceRetryAttempt(question, parts, recognized, repeatCanCount) {
  const main = question.parts[0];
  const idOf = (part) => parts[part.index].customName;
  const mainId = idOf(main);
  const key = "classroom:choice-attempt:v1:" + location.pathname + ":" + mainId;
  const empty = (round) => ({ round, mistakes: [], cards: {}, visited: [], current: mainId });
  let state = empty(0);
  try {
    const saved = JSON.parse(sessionStorage.getItem(key));
    if (saved && Number.isInteger(saved.round) && Array.isArray(saved.mistakes) &&
        saved.mistakes.every((item) => Number.isInteger(item?.choice) && item.choice >= 0 && item.choice < main.numAnswers) &&
        Array.isArray(saved.visited) && saved.cards && typeof saved.cards === "object" &&
        parts.some((part) => part.customName === saved.current)) state = saved;
  } catch { /* A fresh attempt also works without session storage. */ }
  let guarded = state.current === mainId && recognized();
  let restoring = false;
  let batching = false;
  const observers = new Set();
  const notify = () => observers.forEach((fn) => fn());
  function save() {
    if (restoring) return;
    try { sessionStorage.setItem(key, JSON.stringify(state)); } catch { /* Keep this attempt in memory. */ }
  }
  function card(part) {
    const id = idOf(part);
    if (!Array.isArray(state.cards[id]?.order)) state.cards[id] = { order: part.shuffleAnswers.slice() };
    return state.cards[id];
  }
  function branchId(branch) { return parts[branch.index].customName; }
  function open(branch, remedial) {
    const existing = main.nextParts.find((edge) => edge.index === branch.index && edge.instance);
    if (existing) {
      question.setCurrentPart(existing.instance);
      return;
    }
    // The exam's variable replacement is evaluated by makeNextPart. Pass the
    // original reason for opening it, even though the main now has full credit.
    const scope = main.getScope();
    const origin = scope.getVariable("from_wrong");
    if (remedial && origin) scope.setVariable("from_wrong", Numbas.jme.wrapValue(true));
    try { main.makeNextPart(branch); }
    finally { if (remedial && origin) scope.setVariable("from_wrong", origin); }
  }
  function visit(part) {
    const id = idOf(part);
    state.current = id;
    if (part !== main) {
      state.visited = state.visited.filter((other) => other !== id);
      state.visited.push(id);
    }
    save();
  }
  function next() {
    if (!main.answered || main.isDirty || main.score < main.marks) return;
    const available = main.availableNextParts();
    const unseen = (branch) => !state.visited.includes(branchId(branch));
    return requiredBranches(available, parts, state.mistakes).find(unseen) ||
      nextOptionalBranch(available.filter(unseen), parts, "") ||
      nextOptionalBranch(available, parts, state.visited.at(-1) || "");
  }
  function record(part) {
    if (restoring || part.resuming || question.exam.loading || question.exam.mode === "review" || !part.answered) return;
    const choice = part.ticks.findIndex((row) => row[0]);
    if (choice < 0) return;
    const snapshot = card(part);
    snapshot.answer = { choice, score: part.score, credit: part.credit };
    if (part === main) {
      // Retain the marked radio answer used by the authored availability conditions.
      snapshot.answer.interpreted = Numbas.jme.unwrapValue(part.marking_values.interpreted_answer);
      if (part.score < part.marks) {
        const available = part.availableNextParts();
        if (!state.mistakes.some((item) => item.choice === choice)) {
          state.mistakes.push({ choice, supportId: available.length === 1 ? branchId(available[0]) : null });
        }
      } else {
        const required = requiredBranches(main.nextParts, parts, state.mistakes);
        if (required.length && !required.every((branch) => branch.instance)) {
          batching = true;
          try { for (const branch of required) if (!branch.instance) open(branch, true); }
          finally { batching = false; }
          // Numbas selects each part as it is created. Keep the marked main
          // on screen until its reading time ends or the learner uses the arrow.
          question.setCurrentPart(main);
          question.events.trigger("classroom:required-parts-ready");
        }
      }
    }
    save();
    notify();
  }
  function bind(part) {
    if (part.type !== "1_n_2") return;
    card(part);
    if (part.previousPart) save();
    part.events.on("post-submit", () => record(part));
    part.events.on("openSteps", () => { card(part).hint = true; save(); });
  }
  question.events.on("setCurrentPart", (part) => {
    if (!batching && !restoring) visit(part);
  });
  function restoreAnswer(part, answer) {
    // Replay only the saved input and native score display. Never submit it.
    part.resuming = true;
    try {
      part.display.studentAnswer("");
      if (answer) part.display.studentAnswer(String(answer.choice));
      part.setStudentAnswer();
      part.answered = Boolean(answer);
      part.score = answer?.score || 0;
      part.credit = answer?.credit || 0;
      if (part === main) part.marking_values = answer ?
        { interpreted_answer: Numbas.jme.wrapValue(answer.interpreted) } : {};
      part.setDirty(false);
      part.display.showScore(part.answered);
      part.display.updateNextParts();
    } finally { part.resuming = false; }
  }
  function connect() {
    // Listen after Classroom's history handler so the view sees the new mark.
    question.parts.forEach(bind);
    question.events.on("addExtraPart", bind);
    if (!state.cards[mainId]?.answer) return;
    restoring = true;
    try {
      restoreAnswer(main, card(main).answer);
      for (const [id, saved] of Object.entries(state.cards)) {
        const branch = main.nextParts.find((candidate) => branchId(candidate) === id);
        if (!branch) continue;
        open(branch, state.mistakes.some((item) => item.supportId === id));
        if (saved.answer) restoreAnswer(branch.instance, saved.answer);
        if (saved.hint) branch.instance.openSteps();
      }
      const target = main.nextParts.find((branch) => branchId(branch) === state.current);
      question.setCurrentPart(target?.instance || main);
      question.updateScore();
    } finally { restoring = false; }
    notify();
  }
  function start() {
    restoring = true;
    try {
      question.setCurrentPart(main);
      for (const branch of main.nextParts) if (branch.instance) main.removeNextPart(branch);
      state = empty(state.round + 1);
      guarded = false;
      restoreAnswer(main, null);
      card(main);
      question.updateScore();
    } finally { restoring = false; }
    save();
    notify();
  }
  function revisit() {
    if (question.currentPart !== main) return;
    guarded = recognized();
    if (!guarded && main.answered && main.score >= main.marks && repeatCanCount()) start();
    else notify();
  }
  question.exam.events.on("changeQuestion", () => { if (question.exam.currentQuestion === question) revisit(); });
  window.addEventListener("pageshow", (event) => { if (event.persisted && question.exam.currentQuestion === question) revisit(); });
  window.addEventListener("storage", (event) => {
    if (event.key === "classroom:practice-history:v1:" + location.pathname && question.exam.currentQuestion === question) revisit();
  });
  return {
    get round() { return state.round; }, get guarded() { return guarded; },
    get mistakes() { return state.mistakes; }, card, start, next, connect,
    observe(fn) { observers.add(fn); },
    open(branch) { open(branch, state.mistakes.some((item) => item.supportId === branchId(branch))); },
    canCountAgain: repeatCanCount, recognized,
  };
}

export function exploreNavigation(examElement, question, parts, retry = null) {
  const main = question.parts[0];
  const branchDelayMs = exerciseSettings.supportDelayMs;
  const transitionMs = 220;
  let forward, countdown, movingArrow, navigationTimer, countdownInterval;
  let deadline = 0;
  let lastOptionalId = "";

  function active(part) {
    return examElement.isConnected && question.exam.currentQuestion === question && question.currentPart === part;
  }
  function next() {
    if (retry) return retry.next();
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
        if (retry) retry.open(branch);
        else if (branch.instance) question.setCurrentPart(branch.instance);
        else main.makeNextPart(branch);
        if (main.score >= main.marks) lastOptionalId = parts[branch.index].customName;
      }
      refresh();
    }, delay);
  }
  function startCountdown() {
    if (!forward || !active(main) || main.resuming || question.exam.loading ||
        question.exam.mode === "review" || (retry && document.hidden) || !next()) return;
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
  if (retry) {
    question.events.on("classroom:required-parts-ready", startCountdown);
    document.addEventListener("visibilitychange", () => { if (document.hidden) cancel(); });
  }
  retry?.observe(refresh);
  main.events.on("pre-submit", cancel);
  main.events.on("post-submit", () => {
    if (main.score < main.marks) lastOptionalId = "";
    refresh();
    if (!retry && main.score < main.marks) startCountdown();
  });
  question.events.on("setCurrentPart", () => { cancel(); refresh(); });
  question.exam.events.on("changeQuestion", () => { if (!active(main)) cancel(); });
  window.addEventListener("pagehide", cancel);

  return function attach(part, section, feedback) {
    const back = part !== main;
    const arrow = document.createElement("button");
    arrow.type = "button";
    arrow.className = "classroom-arrow " + (back ? "back" : "forward");
    arrow.setAttribute("aria-label", back ? "主問題に戻る" : "補助問題へ");
    const triangle = document.createElement("span");
    triangle.setAttribute("aria-hidden", "true");
    arrow.append(triangle);
    arrow.addEventListener("click", () => move(part, arrow));

    if (section.classList.contains("classroom-card-part")) {
      section.append(arrow);
    } else {
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
