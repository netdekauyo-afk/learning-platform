import { isRecognizedCorrect } from "./question-progress.js?v=continuous-3";

const LEVELS = ["basic", "standard", "advanced"];
const HISTORY_PREFIX = "classroom:practice-history:v1:";
const PASS_PREFIX = "classroom:lesson-pass:v1:";
const RULE_KEY = "classroom:recognition-rule-start:v1";
const KINDS = new Set(["correct", "wrong", "reveal"]);
const UNREADABLE = Symbol("unreadable");

export function lessonHistoryKey(pathname, level) {
  return HISTORY_PREFIX + pathname + (level === "basic" ? "" : ":" + level);
}

function describeLesson(descriptor) {
  const { lessonId, pathname, slots } = descriptor || {};
  const lessonPath = /^\/(?:[^/?#\\]+\/)*(?:elementary\/grade-[1-6]|junior-high\/grade-[1-3])\/(?:math|science|english|social|japanese|information)\/lessons\/([^/?#\\]+)\/questions\.html$/;
  if (typeof pathname !== "string" || !lessonId || pathname.match(lessonPath)?.[1] !== lessonId) {
    return null;
  }
  const hasThree = Array.isArray(slots) && slots.length === 3;
  const fixed = hasThree && slots.every((slot) => slot?.level === "basic" &&
    typeof slot.questionId === "string" && slot.questionId.startsWith(lessonId + "-") &&
    /^M[1-9]\d*$/.test(slot.questionId.slice(lessonId.length + 1))) &&
    new Set(slots.map((slot) => slot.questionId)).size === 3;
  const difficulty = hasThree && LEVELS.every((level) =>
    slots.some((slot) => slot?.level === level && slot.questionId === null));
  return {
    lessonId, pathname, fixed,
    slots: fixed || difficulty ? slots : null,
    levels: fixed ? ["basic"] : LEVELS,
    key: PASS_PREFIX + pathname.slice(0, -"/questions.html".length),
  };
}

function read(storage, key) {
  try {
    return (storage ?? globalThis.localStorage).getItem(key);
  } catch {
    return UNREADABLE;
  }
}

function parse(raw, absent) {
  if (raw === null) return absent;
  if (raw === UNREADABLE) return UNREADABLE;
  try {
    return JSON.parse(raw);
  } catch {
    return UNREADABLE;
  }
}

function capture(context, storage) {
  const readLevel = (level) => read(storage, lessonHistoryKey(context.pathname, level));
  const snapshot = Object.fromEntries(LEVELS.map((level) => [level, readLevel(level)]));
  if (context.slots && !context.fixed) {
    // The three difficulty keys are separate. Reject a mixed read if another tab changed one mid-read.
    for (const level of context.levels) {
      if (snapshot[level] !== readLevel(level)) snapshot[level] = UNREADABLE;
    }
  }
  return snapshot;
}

function histories(snapshot) {
  return Object.fromEntries(LEVELS.map((level) => {
    const rows = parse(snapshot[level], []);
    return [level, Array.isArray(rows) ? rows : UNREADABLE];
  }));
}

function readStartedAt({ storage, recognitionStartedAt, now = Date.now() }) {
  if (recognitionStartedAt !== undefined) return recognitionStartedAt;
  const raw = read(storage, RULE_KEY);
  if (raw === UNREADABLE) return UNREADABLE;
  if (raw === null) return now;
  const time = Number(raw);
  return raw.trim() && Number.isFinite(time) && time >= 0 ? time : null;
}

function mainRecord(row, lessonId) {
  return KINDS.has(row?.kind) && row.role !== "supplement" &&
    (row.lessonId == null || row.lessonId === lessonId);
}

function countRecognized(context, allHistories, startedAt) {
  if (!context.slots || startedAt === UNREADABLE ||
      context.levels.some((level) => allHistories[level] === UNREADABLE)) return null;
  const rowsByLevel = Object.fromEntries(context.levels.map((level) =>
    [level, allHistories[level].filter((row) => mainRecord(row, context.lessonId))]));
  try {
    return context.slots.filter(({ level, questionId }) =>
      isRecognizedCorrect(rowsByLevel[level], questionId, startedAt)).length;
  } catch {
    return null;
  }
}

function headOf(rows) {
  const row = rows.find((entry) => KINDS.has(entry?.kind));
  return row ? [typeof row.at === "string" ? row.at : null, row.kind,
    typeof row.questionId === "string" ? row.questionId : null] : null;
}

function isIsoUtc(value) {
  if (typeof value !== "string") return false;
  const at = Date.parse(value);
  return Number.isFinite(at) && new Date(at).toISOString() === value.replace(/(:\d{2})Z$/, "$1.000Z");
}

function sameData(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function readReceipt(context, storage, allHistories) {
  const receipt = parse(read(storage, context.key), undefined);
  if (receipt === undefined) return null;
  if (!receipt?.historyHeads || (receipt.firstPassedAt !== null && !isIsoUtc(receipt.firstPassedAt))) {
    return UNREADABLE;
  }
  const levels = Object.keys(receipt.historyHeads);
  if (!levels.includes("basic") || (levels.length !== 1 &&
      (levels.length !== 3 || !LEVELS.every((level) => levels.includes(level))))) return UNREADABLE;
  for (const level of levels) {
    const head = receipt.historyHeads[level];
    if (!Array.isArray(head) || head.length !== 3 || !KINDS.has(head[1]) ||
        [head[0], head[2]].some((value) => value !== null && typeof value !== "string") ||
        allHistories[level] === UNREADABLE) return UNREADABLE;
  }
  // A missing or replaced history invalidates the receipt; an unreadable one does not.
  return levels.every((level) => sameData(receipt.historyHeads[level], headOf(allHistories[level]))) ?
    receipt : null;
}

export function readLessonPass(descriptor, options = {}) {
  const context = describeLesson(descriptor);
  const allHistories = context ? histories(capture(context, options.storage)) : null;
  const count = context?.slots ? countRecognized(context, allHistories, readStartedAt(options)) : null;
  const receipt = context ? readReceipt(context, options.storage, allHistories) : null;
  const persisted = Boolean(receipt && receipt !== UNREADABLE);
  const unknown = receipt === UNREADABLE || (context?.slots && count === null);
  return {
    lessonId: descriptor?.lessonId ?? null,
    status: !context?.slots ? "out-of-scope" : count === null ? "unavailable" : "ok",
    recognizedCount: count,
    currentlyPassed: count === null ? null : count === 3,
    hasPassed: persisted || count === 3 ? true : unknown ? null : false,
    firstPassedAt: persisted ? receipt.firstPassedAt : null,
    persisted,
  };
}

function hasEarlierMode(context, before) {
  if (context.fixed && LEVELS.slice(1).some((level) => before[level] === UNREADABLE ||
      before[level].some((row) => mainRecord(row, context.lessonId)))) return true;
  return context.levels.some((level) => before[level].some((row) => mainRecord(row, context.lessonId) &&
    !context.slots.some((slot) => slot.level === level && slot.questionId === (row.questionId ?? null))));
}

function firstPassTime(context, before, after, attempt, startedAt) {
  const { level, records } = attempt;
  const record = records.at(-1);
  const slot = context.slots.find((slot) => slot.level === level &&
    (slot.questionId === null || slot.questionId === record?.questionId));
  if (!before || !slot || record?.kind !== "correct" || !mainRecord(record, context.lessonId) ||
      !isIsoUtc(record.at) || countRecognized(context, before, startedAt) !== 2 ||
      !sameData(before[level], records.slice(0, -1)) || !sameData(after[level], records) ||
      hasEarlierMode(context, before)) return null;

  const at = Date.parse(record.at);
  for (const sourceLevel of context.levels) {
    const sameHistory = sourceLevel === level || sameData(before[sourceLevel], after[sourceLevel]);
    const ordered = before[sourceLevel].every((row) => isIsoUtc(row?.at) &&
      (sourceLevel === level ? Date.parse(row.at) <= at : Date.parse(row.at) < at));
    if (!sameHistory || !ordered) return null;
  }
  const prior = before[level].filter((row) => mainRecord(row, context.lessonId) &&
    (slot.questionId === null || row.questionId === slot.questionId));
  // The other two slots were recognized already. An earlier recognition of this slot
  // leaves a prior pass possible, so do not substitute the timestamp of a later attempt.
  for (const [index, row] of prior.entries()) {
    if (row.kind === "correct" && isRecognizedCorrect(prior.slice(0, index + 1), slot.questionId, startedAt)) {
      return null;
    }
  }
  return record.at;
}

function hasPrefix(current, captured) {
  return current !== UNREADABLE && current.length >= captured.length &&
    captured.every((row, index) => sameData(row, current[index]));
}

export function createLessonPassTracker(descriptor, options = {}) {
  const context = describeLesson(descriptor);
  if (!context?.slots) return null;
  const { storage } = options;
  const snapshot = () => capture(context, storage);

  async function remember(beforeSnapshot, afterSnapshot, attempt) {
    // Snapshot synchronously at the call site, then yield to the existing grading and view handlers.
    await Promise.resolve();
    const startedAt = readStartedAt(options);
    const before = beforeSnapshot ? histories(beforeSnapshot) : null;
    const after = histories(afterSnapshot);
    const wasPassed = before && countRecognized(context, before, startedAt) === 3;
    if (!wasPassed && countRecognized(context, after, startedAt) !== 3) return false;
    const evidence = wasPassed ? before : after;
    const canSave = () => {
      const current = histories(snapshot());
      return readReceipt(context, storage, current) === null &&
        context.levels.every((level) => hasPrefix(current[level], evidence[level]));
    };
    if (!canSave()) return false;

    const save = (locked) => {
      try {
        if (!canSave()) return false;
        const firstPassedAt = locked && attempt && !wasPassed ?
          firstPassTime(context, before, after, attempt, startedAt) : null;
        const historyHeads = Object.fromEntries(context.levels.map((level) => [level, headOf(evidence[level])]));
        (storage ?? globalThis.localStorage).setItem(context.key, JSON.stringify({ firstPassedAt, historyHeads }));
        return true;
      } catch {
        return false;
      }
    };
    try {
      const locks = options.locks === undefined ? globalThis.navigator?.locks : options.locks;
      if (typeof locks?.request === "function") return await locks.request(context.key, () => save(true));
    } catch {
      // Without an available lock, keep the proof of passing without certifying its time.
    }
    return save(false);
  }

  return {
    capture: snapshot,
    restore: () => remember(null, snapshot(), null),
    afterSave(before, attempt) {
      if (!context.levels.includes(attempt.level) ||
          attempt.key !== lessonHistoryKey(context.pathname, attempt.level) ||
          !attempt.records?.length) return Promise.resolve(false);
      return remember(before, snapshot(), attempt);
    },
  };
}
