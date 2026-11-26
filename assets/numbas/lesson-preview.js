import { examQuestions, mainQuestionSet, readExamSource } from "./question-progress.js?v=shared-design-1";

// A preview is deliberately less capable than Numbas: when its content needs
// evaluation or a missing diagram, the lesson title is safer than a guess.
const unsupportedMarkup = /<(?:img|svg|canvas|math|audio|video|iframe|object|embed|script|style|form|input|button|select|textarea|var)\b|\bdata-jme-|\bdata-parent-result\s*=|\bhidden(?:\s|=|\/?>)|\baria-hidden\s*=\s*["']?true|(?:display\s*:\s*none|visibility\s*:\s*hidden)|\\(?:var|simplify|href|url|require|style|class|cssId)\s*\{|\{\{/i;
const missingContext = /(?:この|上の|下の|右の|左の|次の)(?:図|表|グラフ|資料|絵)|度数分布表|累積度数/;

export function representativeProblem(exam, authoredMainSet = false) {
  try {
    const first = examQuestions(exam)[0]?.question;
    if (!first) return null;
    // The same validation used by the real question page distinguishes M1
    // from its S1, S2, ... support parts in fixed-ID Explore lessons.
    const part = authoredMainSet || first.partsMode === "explore"
      ? mainQuestionSet(exam, []).mains[0]?.parts[0]
      : first.parts?.[0];
    if (!part || !["numberentry", "1_n_2"].includes(part.type) || typeof part.prompt !== "string" || !part.prompt.trim()) return null;
    const choices = part.type === "1_n_2" ? part.choices : [];
    if (!Array.isArray(choices) || (part.type === "1_n_2" && !choices.length) || choices.some((choice) => typeof choice !== "string")) return null;
    const fragments = [part.prompt, ...choices];
    const plainPrompt = part.prompt.replace(/<[^>]*>/g, "").trim();
    if (fragments.some((value) => unsupportedMarkup.test(value)) || missingContext.test(plainPrompt) || /^(?:この|その|それ|以上の)/.test(plainPrompt)) return null;
    const variableNames = new Set([...Object.keys(exam.variables || {}), ...Object.keys(first.variables || {})]);
    for (const value of fragments) {
      for (const match of value.matchAll(/\{([^{}]+)\}/g)) {
        if ([...variableNames].some((name) => new RegExp(`(^|[^A-Za-z0-9_])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z0-9_]|$)`).test(match[1]))) return null;
      }
    }
    return { prompt: part.prompt, choices };
  } catch (_) {
    return null;
  }
}

export async function readRepresentativeProblem(source, authoredMainSet = false) {
  return representativeProblem(await readExamSource(source), authoredMainSet);
}

// Use the existing school-day numbers, not invented dates. A month-only
// mapping identifies a month-sized range rather than a specific school day.
export function planCandidateWindow(lessons, schedule, today) {
  const byId = new Map((schedule?.lessons || []).map((item) => [item.id, item]));
  const items = lessons.map((lesson, index) => ({ lesson, index, timing: byId.get(lesson.id) || null }));
  const dated = items.filter(({ timing }) => Number.isInteger(timing?.startDateNumber) && Number.isInteger(timing?.endDateNumber));
  const exactTable = dated.length > 0 && dated.every(({ timing }) => timing.basis === "grade-date-number-table");
  if (exactTable && dated.length === items.length) {
    items.sort((a, b) => a.timing.startDateNumber - b.timing.startDateNumber || a.index - b.index);
  }
  if (!today || !dated.length || !schedule?.days?.length) {
    return { items, start: 0, end: items.length - 1, target: 0, label: "", status: "時期の情報がないため、授業一覧の最初から表示しています。" };
  }
  const previous = schedule.days.filter((day) => day.isoDate <= today.isoDate);
  const todayNumber = previous.at(-1)?.dateNumber || 0;
  const distance = ({ timing }) => todayNumber < timing.startDateNumber
    ? timing.startDateNumber - todayNumber : Math.max(0, todayNumber - timing.endDateNumber);
  const nearestDistance = Math.min(...dated.map(distance));
  const nearest = dated.filter((item) => distance(item) === nearestDistance)
    .sort((a, b) => Number(a.timing.startDateNumber > todayNumber) - Number(b.timing.startDateNumber > todayNumber) || a.index - b.index);
  // With only a month, centre that month's group without claiming a date for
  // any one lesson. The curriculum has no more precise information there.
  const selected = exactTable ? nearest[0] : nearest[Math.floor((nearest.length - 1) / 2)];
  const target = items.indexOf(selected);
  const now = Date.parse(today.isoDate + "T00:00:00Z");
  const lowerIso = new Date(now - 31 * 86400000).toISOString().slice(0, 10);
  const upperIso = new Date(now + 31 * 86400000).toISOString().slice(0, 10);
  const withinDays = schedule.days.filter((day) => day.isoDate >= lowerIso && day.isoDate <= upperIso);
  const low = withinDays[0]?.dateNumber ?? todayNumber;
  const high = withinDays.at(-1)?.dateNumber ?? todayNumber;
  const included = items.flatMap((item, index) => item.timing && Number.isInteger(item.timing.startDateNumber) &&
    item.timing.startDateNumber <= high && item.timing.endDateNumber >= low ? [index] : []);
  return {
    items, target, start: Math.min(target, ...(included.length ? included : [target])),
    end: Math.max(target, ...(included.length ? included : [target])),
    label: exactTable ? "今日の目安" : "今月ごろの目安",
    status: exactTable ? "授業時期の目安から選んでいます。" : "授業の月の目安から選んでいます。"
  };
}

const allowedTags = new Set(["P", "DIV", "SPAN", "BR", "STRONG", "B", "EM", "I", "SUP", "SUB", "UL", "OL", "LI", "TABLE", "THEAD", "TBODY", "TR", "TH", "TD"]);

// Do not copy attributes, links, scripts or interactive controls from exam HTML.
export function safeProblemFragment(markup, documentObject = document) {
  const parsed = new DOMParser().parseFromString(markup, "text/html");
  const result = documentObject.createDocumentFragment();
  function copy(node, parent) {
    if (node.nodeType === 3) { parent.append(documentObject.createTextNode(node.nodeValue)); return true; }
    if (node.nodeType !== 1 || !allowedTags.has(node.tagName)) return false;
    const element = documentObject.createElement(node.tagName.toLowerCase());
    for (const child of node.childNodes) if (!copy(child, element)) return false;
    parent.append(element);
    return true;
  }
  for (const child of parsed.body.childNodes) if (!copy(child, result)) return null;
  return result;
}

let mathJaxReady;
async function loadMathJax() {
  if (!mathJaxReady) {
    mathJaxReady = new Promise((resolve, reject) => {
      globalThis.MathJax = {
        startup: { typeset: false },
        tex: { inlineMath: [["\\(", "\\)"], ["$", "$"]] },
        // This site's bundled renderer does not include the speech worker.
        // Keep the normal question-page configuration untouched.
        options: { enableSpeech: false, enableBraille: false, menuOptions: { settings: { enrich: false, speech: false, braille: false } } },
      };
      const script = document.createElement("script");
      script.src = new URL("./engine/mathjax/tex-svg.js", import.meta.url).href;
      script.onload = () => Promise.resolve(globalThis.MathJax?.startup?.promise).then(resolve, reject);
      script.onerror = reject;
      document.head.append(script);
    });
  }
  return mathJaxReady;
}

export async function renderRepresentativeProblem(target, problem) {
  const container = document.createElement("div");
  const prompt = safeProblemFragment(problem.prompt);
  if (!prompt) return false;
  container.append(prompt);
  if (problem.choices.length) {
    const list = document.createElement("ul");
    list.className = "candidate-options";
    for (const choice of problem.choices) {
      const fragment = safeProblemFragment(choice);
      if (!fragment) return false;
      const item = document.createElement("li");
      item.append(fragment);
      list.append(item);
    }
    container.append(list);
  }
  if (!container.textContent.trim()) return false;
  const containsMath = /\\\(|\\\[|\$/.test(container.textContent);
  if (containsMath) container.style.visibility = "hidden";
  target.replaceChildren(container);
  if (containsMath) {
    let timer;
    try {
      await loadMathJax();
      await Promise.race([
        globalThis.MathJax.typesetPromise([container]),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Math rendering timed out")), 8000); }),
      ]);
      if (!container.querySelector("mjx-container svg") || container.querySelector("mjx-merror, [data-mml-node='merror']")) throw new Error("Invalid math");
      container.style.removeProperty("visibility");
    } catch (_) { target.replaceChildren(); return false; }
    finally { clearTimeout(timer); }
  }
  return true;
}
