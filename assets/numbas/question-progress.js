// Identify a question by its contents, so an edited or reordered question never
// inherits another question's results merely because it occupies the same slot.
export function examQuestions(examData) {
  return (examData.question_groups || []).flatMap((group) =>
    (group.questions || []).map((question) => ({ group, question }))
  );
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

// Numbas still marks every answer immediately. This function only decides
// whether a question has earned its progress mark from the recorded events.
export function isRecognizedCorrect(records, questionId = null, startedAt = initializeRecognitionRule()) {
  if (!Array.isArray(records)) return false;
  if (!Number.isFinite(startedAt)) return latestGradedKind(records, questionId) === "correct";

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
  return recognized;
}

// A reveal or an older, unidentified question is not a new marked answer.
export function questionProgress(records, ids, startedAt = initializeRecognitionRule()) {
  if (!Array.isArray(records) || !Array.isArray(ids) || ids.length !== 2 ||
      ids.some((id) => !id) || new Set(ids).size !== 2) return 0;
  return ids.filter((id) => isRecognizedCorrect(records, id, startedAt)).length;
}
