(function () {
  "use strict";

  // The curriculum pages run this before their existing link setup, so the
  // summary link receives exactly the same published-state and return logic
  // as the lesson title.
  const isLowerElementary = /(?:^|\/)elementary\/grade-[12](?:\/|$)/.test(window.location.pathname);
  const labels = isLowerElementary
    ? { summary: "ようやく", video: "どうが", questions: "もんだい" }
    : { summary: "要約", video: "動画", questions: "問題" };

  document.querySelectorAll('a[data-kind="section-questions"]').forEach(function (link) {
    link.remove();
  });

  document.querySelectorAll(".lesson-item[data-lesson-id]").forEach(function (row) {
    const title = row.querySelector('a.lesson-title-link[data-kind="summary"]');
    const actions = row.querySelector(".lesson-links");
    if (!title || !actions) return;

    let summary = actions.querySelector('a[data-kind="summary"]');
    if (!summary) {
      summary = title.cloneNode(false);
      summary.removeAttribute("id");
      summary.classList.remove("lesson-title-link");
      summary.classList.add("action-link");
      actions.insertBefore(summary, actions.firstChild);
    }
    summary.textContent = labels.summary;
    summary.setAttribute("aria-label", title.textContent.trim() + "の" + labels.summary);

    const video = actions.querySelector('a[data-kind="lesson"]');
    const questions = actions.querySelector('a[data-kind="questions"]');
    if (video) video.textContent = labels.video;
    if (questions) questions.textContent = labels.questions;
  });

  if (isLowerElementary) {
    document.querySelectorAll('.chapter-question-link[data-kind$="questions"]').forEach(function (link) {
      if (link.textContent.trim() === "問題") link.textContent = labels.questions;
    });
  }
})();
