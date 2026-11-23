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

// A reveal or an older, unidentified question is not a new marked answer.
export function questionProgress(records, ids) {
  if (!Array.isArray(records) || !Array.isArray(ids) || ids.length !== 2 ||
      ids.some((id) => !id) || new Set(ids).size !== 2) return 0;
  return ids.filter((id) => latestGradedKind(records, id) === "correct").length;
}
