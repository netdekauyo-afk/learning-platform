(function () {
  "use strict";

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
