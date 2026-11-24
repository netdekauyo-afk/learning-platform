// Identify a question by its contents, so an edited or reordered question never
// inherits another question's results merely because it occupies the same slot.
export function examQuestions(examData) {
  return (examData.question_groups || []).flatMap((group) =>
    (group.questions || []).map((question) => ({ group, question }))
  );
}

export async function readExamSource(source) {
  const response = await fetch(source);
  if (!response.ok) throw new Error("問題データを読み込めませんでした。");
  return JSON.parse((await response.text()).replace(/^\s*\/\/[^\n]*\r?\n/, ""));
}

export function questionTypeLabel(question, index, useFullName = false) {
  const name = String(question.name || "").trim();
  const suffix = name.match(/[（(]([^（）()]+)[）)]\s*$/);
  const numbered = name.match(/^[A-Za-z]+\d+[\s　]+(.+)$/);
  const label = (suffix?.[1] || numbered?.[1] || name).trim();
  return label && (useFullName || Array.from(label).length <= 12) ? label : "問題" + (index + 1);
}

// Only explicitly opted-in lessons use authored IDs. Existing sequences keep their content hashes.
export function mainQuestionSet(exam) {
  const lessonId = String(exam.name || "").trim().split(/\s+/)[0];
  const seen = new Set();
  const mains = examQuestions(exam).map(({ question }, index) => {
    const parts = question.parts || [];
    const id = parts[0]?.customName;
    if (!lessonId || question.partsMode !== "explore" || !(Number(parts[0]?.marks) > 0) ||
        typeof id !== "string" || !id.startsWith(lessonId + "-") || !/^M[1-9]\d*$/.test(id.slice(lessonId.length + 1))) {
      throw new Error("教材の主問題IDを確認できませんでした。");
    }
    for (const [i, part] of parts.entries()) {
      const partId = part.customName;
      const validChild = typeof partId === "string" && partId.startsWith(id + "-") &&
        /^S[1-9]\d*$/.test(partId.slice(id.length + 1));
      if (!part.useCustomName || seen.has(partId) || (i > 0 && !validChild)) {
        throw new Error("補助問題の親IDまたは教材内の固定IDを確認できませんでした。");
      }
      seen.add(partId);
    }
    return { id, label: questionTypeLabel(question, index, true), parts };
  });
  if (!mains.length) throw new Error("教材に主問題がありません。");
  return { lessonId, mains, ids: mains.map((main) => main.id) };
}

export function definitionId(part) {
  // Explore may replace part.customName with the branch label. The original definition is stable.
  return part?.json?.customName || part?.xml?.getAttribute("customname");
}

export function allMainAnswersCorrect(records, ids) {
  return ids.length > 0 && ids.every((id) => latestGradedKind(records, id) === "correct");
}

export async function questionIds(questions) {
  return Promise.all(questions.map(async ({ question }) => {
    const bytes = new TextEncoder().encode(JSON.stringify(question));
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return "sha256:" + Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0")
    ).join("");
  }));
}

// Revealing an answer is not a marked response. With no question ID, preserve
// the lesson-level history used by one-question pages and difficulty markers.
export function latestGradedKind(records, questionId = null) {
  if (!Array.isArray(records)) return null;
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i];
    if (record && (questionId === null || record.questionId === questionId) &&
        (record.kind === "correct" || record.kind === "wrong")) return record.kind;
  }
  return null;
}

// A single setting controls the waiting period for every subject and level.
export const RECOGNITION_WAIT_MS = 24 * 60 * 60 * 1000;
const RECOGNITION_START_KEY = "classroom:recognition-rule-start:v1";

// Take the existing marks as the starting point for the new rule. The marker
// is separate from the history arrays, whose contents and keys are unchanged.
export function initializeRecognitionRule(storage, now = Date.now()) {
  try {
    const target = storage || globalThis.localStorage;
    const saved = target.getItem(RECOGNITION_START_KEY);
    if (saved !== null) {
      const startedAt = Number(saved);
      return saved.trim() && Number.isFinite(startedAt) && startedAt >= 0 ? startedAt : null;
    }
    target.setItem(RECOGNITION_START_KEY, String(now));
    return now;
  } catch {
    // Keep the old display if this browser cannot persist the transition.
    return null;
  }
}

// Numbas still marks every answer immediately. This state only decides whether
// a question has earned its progress mark and when another attempt may do so.
export function recognitionState(records, questionId = null, startedAt = initializeRecognitionRule()) {
  if (!Array.isArray(records)) return { recognized: false, waitUntil: 0 };
  if (!Number.isFinite(startedAt)) {
    return { recognized: latestGradedKind(records, questionId) === "correct", waitUntil: 0 };
  }

  const relevant = records.filter((record) =>
    record && (questionId === null || record.questionId === questionId)
  );
  let recognized = false;
  let waitUntil = 0;

  for (const record of relevant) {
    const at = Date.parse(record.at);
    const beforeRule = !Number.isFinite(at) || at < startedAt;
    if (beforeRule && record.kind === "correct") {
      // An existing mark remains valid even if older history contains mistakes.
      recognized = true;
      waitUntil = 0;
      continue;
    }
    if (record.kind === "wrong") {
      recognized = false;
      // A new mistake starts a wait only when there is no active wait.
      if (Number.isFinite(at) && at >= waitUntil) waitUntil = at + RECOGNITION_WAIT_MS;
    } else if (record.kind === "reveal" && !recognized) {
      // Looking at an answer during a wait does not extend that wait.
      if (Number.isFinite(at) && at >= waitUntil) waitUntil = at + RECOGNITION_WAIT_MS;
    } else if (record.kind === "correct" && Number.isFinite(at) && at >= waitUntil) {
      recognized = true;
      waitUntil = 0;
    }
  }
  return { recognized, waitUntil };
}

export function isRecognizedCorrect(records, questionId = null, startedAt = initializeRecognitionRule()) {
  return recognitionState(records, questionId, startedAt).recognized;
}

export function canRecordRepeatedCorrect(records, questionId, startedAt, now = Date.now()) {
  const state = recognitionState(records, questionId, startedAt);
  return !state.recognized && state.waitUntil > 0 && now >= state.waitUntil;
}

// A selected radio does not emit another change event when selected again.
// Allow an explicit repeat only when the waiting period has already ended.
export function bindSelectedChoiceRetry(section, canRetry, submit) {
  let selectedBeforeAction = null;
  const inputFrom = (target) => {
    if (!target || typeof target.matches !== "function") return null;
    if (target.matches('input[type="radio"]')) return target;
    return target.closest("label")?.querySelector('input[type="radio"]') || null;
  };
  const remember = (event) => {
    const input = inputFrom(event.target);
    selectedBeforeAction = input?.checked ? input : null;
  };
  section.addEventListener("pointerdown", remember, true);
  section.addEventListener("keydown", (event) => {
    if (event.key === " " || event.key === "Enter") remember(event);
  }, true);
  section.addEventListener("click", (event) => {
    const input = inputFrom(event.target);
    const repeat = input && input === selectedBeforeAction && input.checked;
    selectedBeforeAction = null;
    if (repeat && canRetry()) submit();
  }, true);
}

// A reveal or an older, unidentified question is not a new marked answer.
export function questionProgress(records, ids, startedAt = initializeRecognitionRule()) {
  if (!Array.isArray(records) || !Array.isArray(ids) || ids.length !== 2 ||
      ids.some((id) => !id) || new Set(ids).size !== 2) return 0;
  return ids.filter((id) => isRecognizedCorrect(records, id, startedAt)).length;
}
