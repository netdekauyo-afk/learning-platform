(function () {
  "use strict";

  // The same grade/subject lesson is used by the home, course list and quiz.
  // Keep the existing settings object and its unrelated properties intact.
  const SETTINGS_KEY = "classroom-study-home-settings";
  const LIST_CHOICE_KEY = "classroom:study-home-list-choice:v1";
  const KINDS = new Set(["lesson", "questions", "summary"]);
  const isObject = (value) => value && typeof value === "object" && !Array.isArray(value);
  const subjectKey = (grade, subject) => String(grade) + ":" + subject;
  const validGrade = (grade) => /^(?:e[1-6]|[1-3])$/.test(String(grade));
  const validSubject = (subject) => /^(?:math|science|english|social|japanese|information)$/.test(subject);

  function readSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      const settings = raw ? JSON.parse(raw) : {};
      if (!isObject(settings)) return null;
      for (const name of ["lessons", "startModes", "studyProgressV1"]) {
        if (settings[name] !== undefined && !isObject(settings[name])) return null;
      }
      return settings;
    } catch (_) { return null; }
  }

  function writeSettings(settings) {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); return true; }
    catch (_) { return false; }
  }

  function revision(meta) {
    return Number.isSafeInteger(meta?.revision) && meta.revision >= 0 ? meta.revision : 0;
  }

  function chooseLesson(grade, subject, lessonId, kind) {
    if (!validGrade(grade) || !validSubject(subject) || typeof lessonId !== "string" || !lessonId) return false;
    const settings = readSettings();
    if (!settings) return false;
    const key = subjectKey(grade, subject);
    const previous = settings.studyProgressV1?.[key];
    if (previous !== undefined && !isObject(previous)) return false;
    settings.lessons = { ...settings.lessons, [key]: lessonId };
    settings.startModes = { ...settings.startModes, [key]: "lesson" };
    settings.studyProgressV1 = { ...settings.studyProgressV1, [key]: {
      ...previous, revision: revision(previous) + 1, pending: null, completed: false, needsChoice: false,
    } };
    if (!settings.destination && KINDS.has(kind)) settings.destination = kind;
    return writeSettings(settings);
  }

  function setDestination(kind) {
    const settings = readSettings();
    if (!settings || !KINDS.has(kind)) return false;
    settings.destination = kind;
    return writeSettings(settings);
  }

  function clearLesson(grade, subject) {
    if (!validGrade(grade) || !validSubject(subject)) return false;
    const settings = readSettings();
    if (!settings) return false;
    const key = subjectKey(grade, subject);
    const previous = settings.studyProgressV1?.[key];
    if (previous !== undefined && !isObject(previous)) return false;
    settings.lessons = { ...settings.lessons };
    settings.startModes = { ...settings.startModes };
    delete settings.lessons[key];
    delete settings.startModes[key];
    settings.studyProgressV1 = { ...settings.studyProgressV1, [key]: {
      ...previous, revision: revision(previous) + 1, pending: null, completed: false, needsChoice: false,
    } };
    return writeSettings(settings);
  }

  function setListMode(grade, subject) {
    if (!validGrade(grade) || !validSubject(subject)) return false;
    const settings = readSettings();
    if (!settings) return false;
    const key = subjectKey(grade, subject);
    // Merely visiting a list never replaces an existing lesson or its mode.
    if (!settings.lessons?.[key]) settings.startModes = { ...settings.startModes, [key]: "list" };
    return writeSettings(settings);
  }

  function beginListChoice(grade, subject) {
    if (!validGrade(grade) || !validSubject(subject)) return false;
    try { sessionStorage.setItem(LIST_CHOICE_KEY, JSON.stringify({ grade: String(grade), subject })); return true; }
    catch (_) { return false; }
  }

  function cancelListChoice() {
    try { sessionStorage.removeItem(LIST_CHOICE_KEY); } catch (_) { /* Leave navigation usable. */ }
  }

  function consumeListChoice(grade, subject, lessonId, kind) {
    try {
      const choice = JSON.parse(sessionStorage.getItem(LIST_CHOICE_KEY) || "null");
      if (!choice || choice.grade !== String(grade) || choice.subject !== subject) return false;
      if (!chooseLesson(grade, subject, lessonId, kind)) return false;
      sessionStorage.removeItem(LIST_CHOICE_KEY);
      return true;
    } catch (_) { return false; }
  }

  function siteRoot() {
    const match = location.pathname.match(/^(.*\/)(?:study-home|(?:elementary|junior-high|high-school)\/grade-\d+)(?:\/|$)/);
    return match ? new URL(match[1], location.origin) : null;
  }

  async function validateSequence(pending, root, grade, subject, lessonId) {
    if (!pending.ids) return true;
    if (!Array.isArray(pending.ids) || pending.ids.length !== 2 || new Set(pending.ids).size !== 2) return false;
    const source = new URL(pending.source, root);
    const course = new URL(`junior-high/grade-${grade}/${subject}/lessons/${lessonId}/`, root);
    if (source.origin !== root.origin || !source.pathname.startsWith(course.pathname) || !source.pathname.endsWith(".exam")) return false;
    const response = await fetch(source.href);
    if (!response.ok) throw new Error("問題データを読み込めませんでした。");
    const raw = await response.text();
    const exam = JSON.parse(raw.replace(/^\s*\/\/[^\n]*\r?\n/, ""));
    const { examQuestions, questionIds } = await import(new URL("assets/numbas/question-progress.js?v=20261123-shared", root).href);
    const questions = examQuestions(exam);
    if (questions.length !== 2 || questions.some(({ question }) =>
      !Array.isArray(question.parts) || question.parts.length !== 1 || Number(question.parts[0].marks) <= 0)) return false;
    const ids = await questionIds(questions);
    return ids.every((id, index) => id === pending.ids[index]);
  }

  async function mainSetEligibility(pending, row, course, root) {
    if (pending.mode !== "main-set" || !Array.isArray(pending.ids) || !row.dataset.mainQuestionSet) return null;
    const source = new URL(row.dataset.mainQuestionSet, course);
    const requested = new URL(pending.source, course);
    const folder = new URL("lessons/" + row.dataset.lessonId + "/", course);
    if (source.origin !== root.origin || !source.pathname.startsWith(folder.pathname) ||
        requested.origin !== source.origin || requested.pathname !== source.pathname) return null;
    const { mainQuestionSet, readExamSource, allMainAnswersCorrect } =
      await import(new URL("assets/numbas/question-progress.js?v=fixed-parts-1", root).href);
    const set = mainQuestionSet(await readExamSource(source.href));
    if (set.lessonId !== row.dataset.lessonId || set.ids.length !== pending.ids.length ||
        !set.ids.every((id) => pending.ids.includes(id))) return null;
    const key = "classroom:practice-history:v1:" + new URL("questions.html", folder).pathname;
    // Called after the final asynchronous fetch, immediately before updating the resume position.
    return () => {
      try { return allMainAnswersCorrect(JSON.parse(localStorage.getItem(key) || "[]"), set.ids); }
      catch (_) { return false; }
    };
  }

  async function nextLesson(grade, subject, lessonId, root, pending) {
    const elementary = String(grade).startsWith("e");
    const number = elementary ? String(grade).slice(1) : String(grade);
    const school = elementary ? "elementary" : "junior-high";
    const course = new URL(`${school}/grade-${number}/${subject}/`, root);
    const response = await fetch(course.href);
    if (!response.ok) throw new Error("授業一覧を読み込めませんでした。");
    const doc = new DOMParser().parseFromString(await response.text(), "text/html");
    const rows = Array.from(doc.querySelectorAll(".lesson-item[data-lesson-id]"));
    const list = rows.map((row) => row.dataset.lessonId);
    if (!list.length || list.some((id) => !id) || new Set(list).size !== list.length || !list.includes(lessonId)) return { ambiguous: true };
    const row = rows[list.indexOf(lessonId)];
    let stillReady;
    if (row.dataset.mainQuestionSet || pending.mode === "main-set") {
      stillReady = await mainSetEligibility(pending, row, course, root);
      if (!stillReady) return { stale: true };
    } else if (!await validateSequence(pending, root, grade, subject, lessonId)) {
      return { ambiguous: true };
    }
    let ordered = list;
    if (!elementary) {
      const timingResponse = await fetch(new URL(`assets/junior-high-grade-${number}-timing.json`, root).href);
      if (!timingResponse.ok) throw new Error("授業時期の対応表を読み込めませんでした。");
      const table = await timingResponse.json();
      if (!table || table.version !== 1 || table.school !== "junior-high" || String(table.grade) !== number || !Array.isArray(table.days)) return { ambiguous: true };
      ordered = [];
      let last = 0;
      for (const day of table.days) {
        if (!Number.isInteger(day.dateNumber) || day.dateNumber <= last) return { ambiguous: true };
        last = day.dateNumber;
        const ids = day[subject] || [];
        if (!Array.isArray(ids) || ids.length > 1 || ids.some((id) => typeof id !== "string")) return { ambiguous: true };
        ordered.push(...ids);
      }
      if (ordered.length !== list.length || new Set(ordered).size !== list.length || ordered.some((id) => !list.includes(id))) return { ambiguous: true };
    } else {
      const numbers = rows.map((row) => row.dataset.seq).filter(Boolean);
      if (new Set(numbers).size !== numbers.length || rows.some((row) => row.dataset.choice || row.dataset.choiceVariant)) return { ambiguous: true };
    }
    const index = ordered.indexOf(lessonId);
    if (index < 0) return { ambiguous: true };
    return index === ordered.length - 1 ? { completed: true, stillReady } : { next: ordered[index + 1], stillReady };
  }

  async function resolvePending(grade, subject) {
    if (!validGrade(grade) || !validSubject(subject)) return false;
    const key = subjectKey(grade, subject);
    const before = readSettings();
    const meta = before?.studyProgressV1?.[key];
    const lessonId = before?.lessons?.[key];
    const pending = meta?.pending;
    const root = siteRoot();
    if (!isObject(meta) || !isObject(pending) || !lessonId || !root || pending.revision !== revision(meta)) return false;
    let result;
    try {
      result = await nextLesson(String(grade), subject, lessonId, root, pending);
    } catch (_) { return false; } // Keep the pending item for a later retry.
    const latest = readSettings();
    const now = latest?.studyProgressV1?.[key];
    if (!latest || !isObject(now) || latest.lessons?.[key] !== lessonId || revision(now) !== pending.revision || now.pending?.revision !== pending.revision) return false;
    if (result.stale || (result.stillReady && !result.stillReady())) {
      latest.studyProgressV1 = { ...latest.studyProgressV1, [key]: {
        ...now, revision: revision(now) + 1, pending: null,
      } };
      writeSettings(latest);
      return false;
    }
    if (result.next) latest.lessons = { ...latest.lessons, [key]: result.next };
    latest.startModes = { ...latest.startModes, [key]: "lesson" };
    latest.studyProgressV1 = { ...latest.studyProgressV1, [key]: {
      ...now, revision: revision(now) + 1, pending: null,
      completed: Boolean(result.completed), needsChoice: Boolean(result.ambiguous),
    } };
    return writeSettings(latest);
  }

  globalThis.ClassroomStudyProgress = Object.freeze({
    read: readSettings, chooseLesson, clearLesson, setDestination, setListMode, beginListChoice, cancelListChoice,
    consumeListChoice, resolvePending,
  });

  // This file also supplies the storage helpers to the home and problem pages.
  // Run the existing list and grade-navigation setup only on course lists.
  if (!/(?:^|\/)(?:elementary|junior-high|high-school)\/grade-\d+\/[a-z-]+(?:\/(?:index\.html)?)?$/.test(location.pathname)) return;

  // A list choice applies only while the learner is on that list. If they
  // leave without selecting a lesson, a later review must not reuse it.
  window.addEventListener("pagehide", cancelListChoice);

  // Page-specific data remains in the page; common behavior lives here.
  const options = document.currentScript?.dataset || {};
  let publishedPaths = [];
  try {
    const parsed = JSON.parse(options.publishedPaths || "[]");
    if (Array.isArray(parsed)) publishedPaths = parsed;
  } catch (error) { /* The per-link published flags remain available. */ }
  const PUBLISHED_PATHS = new Set(publishedPaths);
  const allDetails = Array.from(document.querySelectorAll("details.chapter, details.section"));
  const summaryReturnKey = options.summaryReturnKey || "";

  // Preserve the existing saved keys and restore behavior on pages that used it.
  function rememberSummaryReturn() {
    if (!summaryReturnKey) return;
    try {
      sessionStorage.setItem(summaryReturnKey, JSON.stringify({
        open: allDetails.map(function (detail) { return detail.open; }),
        scrollY: window.scrollY,
      }));
    } catch (error) { /* Use the browser's usual history behavior. */ }
  }
  if (summaryReturnKey) {
    window.addEventListener("pageshow", function () {
      try {
        const saved = sessionStorage.getItem(summaryReturnKey);
        if (!saved) return;
        const state = JSON.parse(saved);
        sessionStorage.removeItem(summaryReturnKey);
        if (!Array.isArray(state.open) || state.open.length !== allDetails.length) return;
        allDetails.forEach(function (detail, i) { detail.open = Boolean(state.open[i]); });
        if (Number.isFinite(state.scrollY)) {
          requestAnimationFrame(function () {
            requestAnimationFrame(function () { window.scrollTo(0, state.scrollY); });
          });
        }
      } catch (error) { /* Use the browser's usual history behavior. */ }
    });
  }

  const openAllBtn = document.getElementById("open-all");
  const closeAllBtn = document.getElementById("close-all");
  const toast = document.getElementById("status-toast");
  let toastTimer = null;

  function showToast(message) {
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add("is-visible");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toast.classList.remove("is-visible");
    }, 2800);
  }

  function syncLinkState(link) {
    const target = link.dataset.target || "";
    const isPublished = link.dataset.published === "true" || PUBLISHED_PATHS.has(target);
    if (isPublished && target) {
      link.setAttribute("href", target);
      link.dataset.published = "true";
      link.classList.remove("is-unpublished");
      link.removeAttribute("aria-disabled");
    } else {
      link.removeAttribute("href");
      link.dataset.published = "false";
      link.classList.add("is-unpublished");
      link.setAttribute("aria-disabled", "true");
    }
  }

  const allLinks = Array.from(document.querySelectorAll("a[data-target]"));
  allLinks.forEach(function (link) {
    syncLinkState(link);

    function handleActivate(event) {
      if (link.closest("summary")) event.stopPropagation();
      if (link.dataset.published !== "true") {
        event.preventDefault();
        const target = link.dataset.target || "";
        showToast("準備中のページです（予定パス: " + target + "）");
      }
    }

    link.addEventListener("click", handleActivate);
    link.addEventListener("click", function (event) {
      if (event.defaultPrevented || event.button !== 0 || link.dataset.published !== "true" || !KINDS.has(link.dataset.kind)) return;
      const row = link.closest(".lesson-item[data-lesson-id]");
      const page = location.pathname.match(/(?:^|\/)(elementary|junior-high)\/grade-(\d+)\/(math|science|english|social|japanese|information)(?:\/(?:index\.html)?)?$/);
      if (!row || !page || !row.dataset.lessonId) return;
      const grade = page[1] === "elementary" ? "e" + page[2] : page[2];
      consumeListChoice(grade, page[3], row.dataset.lessonId, link.dataset.kind);
    });
    if (summaryReturnKey) {
      link.addEventListener("click", function (event) {
        if (link.dataset.kind === "summary" && link.dataset.published === "true" &&
            !event.defaultPrevented && event.button === 0 &&
            !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
          rememberSummaryReturn();
        }
      });
    }
    link.addEventListener("keydown", function (event) {
      if (event.key === "Enter" || event.key === " ") {
        if (link.dataset.published !== "true") {
          handleActivate(event);
        } else if (event.key === "Enter" && link.closest("summary")) {
          event.stopPropagation();
        }
      }
    });
  });

  if (openAllBtn) {
    openAllBtn.addEventListener("click", function () {
      allDetails.forEach(function (el) { el.open = true; });
    });
  }
  if (closeAllBtn) {
    closeAllBtn.addEventListener("click", function () {
      allDetails.forEach(function (el) { el.open = false; });
    });
  }

  // One route map drives previous/next grade links across subject listings.
  const gradeRoutes = {
    math:        ["e1", "e2", "e3", "e4", "e5", "e6", "m1", "m2", "m3", "h1", "h2", "h3"],
    japanese:    ["e1", "e2", "e3", "e4", "e5", "e6", "m1", "m2", "m3"],
    science:     ["e3", "e4", "e5", "e6", "m1", "m2", "m3", "h1", "h2", "h3"],
    english:     ["e3", "e4", "e5", "e6", "m1", "m2", "m3", "h1", "h2", "h3"],
    social:      ["e3", "e4", "e5", "e6", "m1", "m2", "m3"],
    information: ["m1", "m3"],
  };
  const schoolCodes = { elementary: "e", "junior-high": "m", "high-school": "h" };
  const schoolPaths = { e: "elementary", m: "junior-high", h: "high-school" };
  const schoolNames = { e: "小学", m: "中学", h: "高校" };
  const subjectNames = { japanese: "国語", science: "理科", english: "英語", social: "社会", information: "情報" };
  const pathParts = window.location.pathname.match(/(?:^|\/)(elementary|junior-high|high-school)\/grade-(\d+)\/(math|japanese|science|english|social|information)(?:\/(?:index\.html)?)?$/);
  if (pathParts) {
    const school = schoolCodes[pathParts[1]];
    const grade = Number(pathParts[2]);
    const subject = pathParts[3];
    const pageCode = school + grade;
    // Keep navigation on the existing grade 1–2 placeholder pages. Teaching
    // in science and foreign languages starts with grade 3 in the main route.
    const isEarlyPlaceholder = school === "e" && grade <= 2 &&
      (subject === "science" || subject === "english");
    const route = isEarlyPlaceholder ? ["e1", "e2", "e3"] : gradeRoutes[subject];
    const current = route.indexOf(pageCode);
    if (current !== -1) {
      const previous = route[current - 1];
      const next = route[current + 1];
      const main = document.querySelector("main");
      let gradeNav = document.querySelector("nav.grade-navigation");
      if (!gradeNav && main && (previous || next)) {
        gradeNav = document.createElement("nav");
        gradeNav.className = "problem-toolbar grade-navigation";
        gradeNav.setAttribute("aria-label", "同じ科目の学年移動");
        gradeNav.style.marginTop = "24px";
        main.appendChild(gradeNav);
      }
      if (gradeNav) {
        function setGradeLink(target, direction) {
          if (!target) return;
          const targetSchool = target.charAt(0);
          const targetGrade = Number(target.slice(1));
          let name = subject === "math"
            ? (targetSchool === "e" ? "算数" : "数学")
            : subjectNames[subject];
          if (subject === "english" && targetSchool === "e" &&
              targetGrade >= 3 && targetGrade <= 4 && !isEarlyPlaceholder) {
            name = "外国語活動";
          }
          const label = schoolNames[targetSchool] + targetGrade + "年の" + name;
          const href = (targetSchool === school
            ? "../../grade-" + targetGrade + "/"
            : "../../../" + schoolPaths[targetSchool] + "/grade-" + targetGrade + "/") +
            subject + "/";
          const className = direction === "previous" ? "problem-previous" : "problem-next";
          let link = gradeNav.querySelector("a." + className);
          if (!link) {
            link = document.createElement("a");
            link.className = className;
            if (direction === "previous") gradeNav.insertBefore(link, gradeNav.firstChild);
            else gradeNav.appendChild(link);
          }
          link.setAttribute("href", href);
          link.textContent = direction === "previous" ? "← " + label : label + " →";
        }
        setGradeLink(previous, "previous");
        setGradeLink(next, "next");
      }
    }
  }
})();
