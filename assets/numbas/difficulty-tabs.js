/* The lesson keeps each loaded exam in its own panel, so switching tabs does
   not discard an in-progress answer. Difficulty files sit beside the basic one. */
export function createDifficultyTabs(basicHost, basicStatus, loadExam, recognized) {
  const levels = [
    { id: "basic", label: "基礎", suffix: "" },
    { id: "standard", label: "標準", suffix: "-s" },
    { id: "advanced", label: "発展", suffix: "-a" },
  ];
  const parent = basicHost.parentNode;
  const tablist = document.createElement("div");
  tablist.className = "difficulty-tabs";
  tablist.setAttribute("role", "tablist");
  tablist.setAttribute("aria-label", "問題の難易度");
  let disclosure;
  if (basicHost.dataset.sequenceSource) {
    disclosure = document.createElement("details");
    disclosure.className = "difficulty-picker";
    const summary = document.createElement("summary");
    summary.textContent = "難易度";
    disclosure.append(summary, tablist);
  } else {
    tablist.classList.add("classroom-tabs");
    parent.insertBefore(tablist, basicStatus);
  }

  const tabs = [];
  const panels = [];
  levels.forEach((level, index) => {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.id = "difficulty-" + level.id + "-tab";
    const title = document.createElement("span");
    title.textContent = level.label;
    tab.append(title);
    if (!disclosure) {
      level.mark = document.createElement("span");
      level.mark.className = "question-type-mark";
      level.mark.setAttribute("aria-hidden", "true");
      tab.append(level.mark);
    }
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-controls", "difficulty-" + level.id + "-panel");
    tab.setAttribute("aria-selected", String(index === 0));
    tab.tabIndex = index === 0 ? 0 : -1;
    tablist.append(tab);

    const panel = document.createElement("section");
    panel.id = "difficulty-" + level.id + "-panel";
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("aria-labelledby", tab.id);
    panel.hidden = index !== 0;
    parent.insertBefore(panel, index === 0 ? basicStatus : null);

    if (index === 0) {
      panel.append(basicStatus, basicHost);
    } else {
      const status = document.createElement("p");
      status.className = "numbas-difficulty-status";
      status.setAttribute("role", "status");
      status.textContent = "問題を読み込んでいます。";
      const host = document.createElement("div");
      host.className = "numbas-difficulty-host";
      host.dataset.examSource = (basicHost.dataset.sequenceSource || basicHost.dataset.examSource).replace(/\.exam(?=[?#]|$)/, level.suffix + ".exam");
      panel.append(status, host);
      level.host = host;
      level.status = status;
    }
    tabs.push(tab);
    panels.push(panel);
  });

  if (disclosure) parent.append(disclosure);
  else {
    const refresh = () => levels.forEach((level, i) => {
      const earned = recognized(level.id);
      level.mark.classList.toggle("is-recognized", earned);
      tabs[i].setAttribute("aria-label", level.label + (earned ? "、正解認定済み" : "、未認定"));
    });
    refresh();
    parent.addEventListener("classroom:history-changed", refresh);
    window.addEventListener("pageshow", refresh);
    window.addEventListener("storage", refresh);
  }

  function select(index) {
    tabs.forEach((tab, i) => {
      tab.setAttribute("aria-selected", String(i === index));
      tab.tabIndex = i === index ? 0 : -1;
      panels[i].hidden = i !== index;
    });
    basicHost.dispatchEvent(new Event("classroom:panel-change", { bubbles: true }));
    const level = levels[index];
    if (index && !level.loaded) {
      level.loaded = true;
      void loadExam(level.host, level.status, level.id);
    }
  }

  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => select(index));
    tab.addEventListener("keydown", (event) => {
      let next;
      if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
      else if (event.key === "ArrowLeft") next = (index + tabs.length - 1) % tabs.length;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = tabs.length - 1;
      else return;
      event.preventDefault();
      select(next);
      tabs[next].focus();
    });
  });
}
