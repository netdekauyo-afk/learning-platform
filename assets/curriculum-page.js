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
})();
