// Classroom全体の問題設定。選択肢の並び替えはNumbasの機能を使う。
export const exerciseSettings = Object.freeze({
  // 学校段階・科目ごとの種類名。教材側で付けた種類名を優先する。
  questionTypesBySubject: {
    "junior-high/math": ["確認", "文章題", "使い分け"],
    "junior-high/social": ["知識", "理解", "資料読解"],
  },
  supportDelayMs: 10000,
  shuffleChoices: true,
  // 例外は教材ID、設問名、パート番号（1から）の順に指定する。
  // 例: "j2-l001": { "設問名": { "1": false } }
  shuffleChoicesOverrides: {},
});

// 教材ごとに固定する場合はNumbasの shuffleChoices: false を維持する。
// 共通設定と異なる値は上の例外に指定し、教材や履歴のIDを変更しない。
export function applyExerciseSettings(examData, settings = exerciseSettings) {
  const examId = (examData.name || "").trim().split(/\s+/, 1)[0];
  function applyToPart(part, overrides, partPath) {
    if (["1_n_2", "m_n_2", "m_n_x"].includes(part.type)) {
      const override = overrides?.[partPath];
      if (typeof override === "boolean") {
        part.shuffleChoices = override;
      } else if (part.shuffleChoices !== false) {
        part.shuffleChoices = settings.shuffleChoices;
      }
    }
    for (const name of ["steps", "gaps"]) {
      for (const [index, child] of (part[name] || []).entries()) {
        applyToPart(child, overrides, `${partPath}.${name}.${index + 1}`);
      }
    }
  }
  for (const group of examData.question_groups || []) {
    for (const question of group.questions || []) {
      const overrides = settings.shuffleChoicesOverrides?.[examId]?.[question.name];
      for (const [index, part] of (question.parts || []).entries()) {
        applyToPart(part, overrides, String(index + 1));
      }
    }
  }
  return examData;
}
