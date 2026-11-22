(function (global) {
  'use strict';

  // Civil dates are date-only values; calculate their weekdays in UTC so the
  // result does not change with the viewer's time zone. "Today" uses Japan time.
  const WEEKDAYS_JA = Object.freeze(['日', '月', '火', '水', '木', '金', '土']);
  const japaneseDateFormatter = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: 'numeric', day: 'numeric'
  });

  // Cabinet Office confirmed holidays, including substitute and citizens' holidays.
  // Keep this snapshot available if the remotely maintained dataset is unavailable.
  // Source: https://www8.cao.go.jp/chosei/shukujitsu/gaiyou.html
  const confirmedSnapshot = Object.freeze({
    '2026-01-01': '元日', '2026-01-12': '成人の日', '2026-02-11': '建国記念の日',
    '2026-02-23': '天皇誕生日', '2026-03-20': '春分の日', '2026-04-29': '昭和の日',
    '2026-05-03': '憲法記念日', '2026-05-04': 'みどりの日', '2026-05-05': 'こどもの日',
    '2026-05-06': '休日', '2026-07-20': '海の日', '2026-08-11': '山の日',
    '2026-09-21': '敬老の日', '2026-09-22': '休日', '2026-09-23': '秋分の日',
    '2026-10-12': 'スポーツの日', '2026-11-03': '文化の日', '2026-11-23': '勤労感謝の日',
    '2027-01-01': '元日', '2027-01-11': '成人の日', '2027-02-11': '建国記念の日',
    '2027-02-23': '天皇誕生日', '2027-03-21': '春分の日', '2027-03-22': '休日',
    '2027-04-29': '昭和の日', '2027-05-03': '憲法記念日', '2027-05-04': 'みどりの日',
    '2027-05-05': 'こどもの日', '2027-07-19': '海の日', '2027-08-11': '山の日',
    '2027-09-20': '敬老の日', '2027-09-23': '秋分の日', '2027-10-11': 'スポーツの日',
    '2027-11-03': '文化の日', '2027-11-23': '勤労感謝の日'
  });
  const HOLIDAY_URL = 'https://hrkn.github.io/jp-holidays/api/v1/list.json';
  let holidayDates = new Map(Object.entries(confirmedSnapshot));
  let knownHolidayYears = new Set([2026, 2027]);
  let holidayStatus = 'snapshot';
  let refreshVersion = 0;

  function publishHolidayStatus() {
    const root = global.document && global.document.documentElement;
    if (!root) return;
    root.dataset.calendarHolidayStatus = holidayStatus;
    root.dataset.calendarHolidayYears = [...knownHolidayYears].sort((a, b) => a - b).join(',');
  }

  async function refreshHolidays() {
    const version = ++refreshVersion;
    try {
      if (typeof global.fetch !== 'function') throw new Error('Holiday data unavailable');
      const response = await global.fetch(HOLIDAY_URL, { mode: 'cors', credentials: 'omit', cache: 'no-cache' });
      if (!response.ok) throw new Error('Holiday data unavailable');
      const payload = await response.json();
      if (!payload || !Array.isArray(payload.data) || payload.data.length < 100) throw new Error('Invalid holiday dataset');

      const nextDates = new Map();
      const counts = new Map();
      for (const item of payload.data) {
        if (!item || typeof item.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(item.date) || typeof item.title !== 'string' || !item.title.trim()) {
          throw new Error('Invalid holiday record');
        }
        const dateInfo = fromISO(item.date);
        if (nextDates.has(item.date)) throw new Error('Duplicate holiday record');
        nextDates.set(item.date, item.title.trim());
        counts.set(dateInfo.year, (counts.get(dateInfo.year) || 0) + 1);
      }
      // Never replace known current data with a truncated or stale dataset.
      if ((counts.get(2026) || 0) < 16 || (counts.get(2027) || 0) < 16) throw new Error('Incomplete holiday dataset');
      if (version === refreshVersion) {
        holidayDates = nextDates;
        knownHolidayYears = new Set([...counts].filter(([year, count]) => year >= 1955 && count >= (year < 2026 ? 8 : 16)).map(([year]) => year));
        holidayStatus = 'updated';
      }
    } catch (_) {
      // Retain the last verified data. Years outside it remain unknown, not weekdays.
      if (version === refreshVersion && holidayStatus !== 'updated') holidayStatus = 'snapshot';
    }
    publishHolidayStatus();
    return Object.freeze({ status: holidayStatus, years: Object.freeze([...knownHolidayYears].sort((a, b) => a - b)) });
  }

  function day(year, month, date) {
    if (![year, month, date].every(Number.isInteger) || year < 1 || year > 9999 || month < 1 || month > 12 || date < 1 || date > 31) {
      throw new RangeError('Invalid calendar date');
    }
    const civilDate = new Date(0);
    civilDate.setUTCHours(0, 0, 0, 0);
    civilDate.setUTCFullYear(year, month - 1, date);
    if (civilDate.getUTCFullYear() !== year || civilDate.getUTCMonth() !== month - 1 || civilDate.getUTCDate() !== date) {
      throw new RangeError('Invalid calendar date');
    }
    const weekday = civilDate.getUTCDay();
    const isoDate = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(date).padStart(2, '0')}`;
    const holidayKnown = knownHolidayYears.has(year);
    const holidayName = holidayKnown ? (holidayDates.get(isoDate) || null) : null;
    return Object.freeze({
      isoDate,
      year, month, day: date,
      weekday,
      weekdayJa: WEEKDAYS_JA[weekday],
      isWeekend: weekday === 0 || weekday === 6,
      schoolYear: month >= 4 ? year : year - 1,
      holidayKnown,
      isHoliday: holidayKnown ? holidayName !== null : null,
      holidayName
    });
  }

  function fromISO(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new RangeError('Expected a date in YYYY-MM-DD format');
    }
    const [year, month, date] = value.split('-').map(Number);
    return day(year, month, date);
  }

  function today(instant = new Date()) {
    const value = instant instanceof Date ? instant : new Date(instant);
    if (Number.isNaN(value.getTime())) throw new RangeError('Invalid time');
    const parts = Object.fromEntries(japaneseDateFormatter.formatToParts(value).map((part) => [part.type, part.value]));
    return day(Number(parts.year), Number(parts.month), Number(parts.day));
  }

  function month(year, monthNumber) {
    day(year, monthNumber, 1);
    const nextMonthFirst = new Date(0);
    nextMonthFirst.setUTCHours(0, 0, 0, 0);
    nextMonthFirst.setUTCFullYear(year, monthNumber, 0);
    const lastDay = nextMonthFirst.getUTCDate();
    return Array.from({ length: lastDay }, (_, index) => day(year, monthNumber, index + 1));
  }

  function academicYear(year) {
    if (!Number.isInteger(year) || year < 1 || year > 9998) throw new RangeError('Invalid academic year');
    return [4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2, 3].flatMap((monthNumber) => month(monthNumber >= 4 ? year : year + 1, monthNumber));
  }

  const SCHOOL_BREAKS_KEY = 'classroom-calendar-school-breaks-v1';
  // Shared calendar data lives in GitHub beside this script. It is not drawn
  // on the calendar. Add exact schoolBreaks with ISO dates, or yearly
  // recurringSchoolBreaks as approximate periods with MM-DD dates.
  const currentScript = global.document && global.document.currentScript;
  const SHARED_CALENDAR_URL = currentScript && currentScript.src
    ? new URL('calendar-data.json', currentScript.src).href : null;

  function normalizeSchoolBreak(period) {
    if (!period || typeof period !== 'object' || typeof period.name !== 'string') throw new TypeError('Invalid school break');
    const name = period.name.trim();
    if (!name || name.length > 80) throw new RangeError('Invalid school break name');
    const start = fromISO(period.start).isoDate;
    const end = fromISO(period.end).isoDate;
    if (start > end) throw new RangeError('School break ends before it starts');
    return Object.freeze({ name, start, end });
  }

  function getSchoolBreaks() {
    let value;
    try { value = global.localStorage.getItem(SCHOOL_BREAKS_KEY); }
    catch (_) { throw new Error('School break storage is unavailable'); }
    if (value === null) return [];
    let stored;
    try { stored = JSON.parse(value); } catch (_) { throw new Error('School break data is invalid'); }
    if (!stored || stored.version !== 1 || !Array.isArray(stored.periods)) throw new Error('School break data is invalid');
    try { return stored.periods.map(normalizeSchoolBreak); }
    catch (_) { throw new Error('School break data is invalid'); }
  }

  function saveSchoolBreaks(periods) {
    if (!Array.isArray(periods)) throw new TypeError('Expected school break periods');
    const normalized = periods.map(normalizeSchoolBreak);
    const seen = new Set();
    for (const period of normalized) {
      const key = JSON.stringify([period.name, period.start, period.end]);
      if (seen.has(key)) throw new RangeError('Duplicate school break');
      seen.add(key);
    }
    // Do not replace an existing value that cannot be read and validated.
    getSchoolBreaks();
    try { global.localStorage.setItem(SCHOOL_BREAKS_KEY, JSON.stringify({ version: 1, periods: normalized })); }
    catch (_) { throw new Error('School break storage is unavailable'); }
    return normalized;
  }

  function schoolBreaksOn(isoDate) {
    const date = fromISO(isoDate).isoDate;
    return getSchoolBreaks().filter((period) => period.start <= date && date <= period.end);
  }

  function normalizeRecurringSchoolBreak(period) {
    if (!period || typeof period !== 'object' || typeof period.name !== 'string' || period.approximate !== true) {
      throw new TypeError('Invalid approximate school break');
    }
    const name = period.name.trim();
    if (!name || name.length > 80) throw new RangeError('Invalid school break name');
    for (const date of [period.start, period.end]) {
      if (typeof date !== 'string' || !/^\d{2}-\d{2}$/.test(date)) throw new RangeError('Expected a month and day');
      // 2001 is not a leap year, so each endpoint is valid every year.
      fromISO(`2001-${date}`);
    }
    return Object.freeze({ name, start: period.start, end: period.end, approximate: true });
  }

  async function loadSharedCalendarData() {
    if (!SHARED_CALENDAR_URL || typeof global.fetch !== 'function') throw new Error('Shared calendar data is unavailable');
    const response = await global.fetch(SHARED_CALENDAR_URL, { credentials: 'same-origin', cache: 'no-cache' });
    if (!response.ok) throw new Error('Shared calendar data is unavailable');
    const data = await response.json();
    if (!data || data.version !== 1 || !Array.isArray(data.schoolBreaks)) throw new Error('Shared calendar data is invalid');
    const schoolBreaks = data.schoolBreaks.map(normalizeSchoolBreak);
    if (data.recurringSchoolBreaks !== undefined && !Array.isArray(data.recurringSchoolBreaks)) throw new Error('Shared calendar data is invalid');
    const recurringSchoolBreaks = (data.recurringSchoolBreaks || []).map(normalizeRecurringSchoolBreak);
    const seen = new Set();
    for (const period of schoolBreaks) {
      const key = JSON.stringify([period.name, period.start, period.end]);
      if (seen.has(key)) throw new Error('Duplicate shared school break');
      seen.add(key);
    }
    const recurringSeen = new Set();
    for (const period of recurringSchoolBreaks) {
      const key = JSON.stringify([period.name, period.start, period.end]);
      if (recurringSeen.has(key)) throw new Error('Duplicate recurring school break');
      recurringSeen.add(key);
    }
    return Object.freeze({ version: 1, schoolBreaks: Object.freeze(schoolBreaks), recurringSchoolBreaks: Object.freeze(recurringSchoolBreaks) });
  }

  function recurringSchoolBreakOn(period, date) {
    const monthDay = date.slice(5);
    const crossesYear = period.start > period.end;
    const matches = crossesYear
      ? monthDay >= period.start || monthDay <= period.end
      : monthDay >= period.start && monthDay <= period.end;
    if (!matches) return null;
    const year = Number(date.slice(0, 4));
    let startYear = year;
    let endYear = year;
    if (crossesYear) {
      if (monthDay >= period.start) endYear++;
      else startYear--;
    }
    // Clip to the calendar's supported years at the extreme boundaries.
    const start = startYear < 1 ? '0001-01-01' : `${String(startYear).padStart(4, '0')}-${period.start}`;
    const end = endYear > 9999 ? '9999-12-31' : `${String(endYear).padStart(4, '0')}-${period.end}`;
    return Object.freeze({ name: period.name, start, end, approximate: true, recurrence: 'annual' });
  }

  async function sharedSchoolBreaksOn(isoDate) {
    const date = fromISO(isoDate).isoDate;
    const data = await loadSharedCalendarData();
    const exact = data.schoolBreaks.filter((period) => period.start <= date && date <= period.end);
    const approximate = data.recurringSchoolBreaks.map((period) => recurringSchoolBreakOn(period, date)).filter(Boolean);
    return [...exact, ...approximate];
  }

  // Numbers are estimates for an academic year, not a school's official schedule.
  // The shared break data is read once per calculation; browser-local settings
  // intentionally do not change the common numbering.
  async function numberedSchoolDays(year) {
    const data = await loadSharedCalendarData();
    await refreshHolidays();
    const days = academicYear(year);
    if (days.some((date) => !date.holidayKnown)) throw new Error('Holiday data is unavailable for this academic year');
    const numbered = [];
    for (const date of days) {
      if (date.isWeekend || date.isHoliday) continue;
      const isExactBreak = data.schoolBreaks.some((period) => period.start <= date.isoDate && date.isoDate <= period.end);
      const isApproximateBreak = data.recurringSchoolBreaks.some((period) => recurringSchoolBreakOn(period, date.isoDate));
      if (isExactBreak || isApproximateBreak) continue;
      numbered.push(Object.freeze({ ...date, dateNumber: numbered.length + 1, approximate: true }));
    }
    return Object.freeze(numbered);
  }

  async function dateNumberForDate(isoDate) {
    const date = fromISO(isoDate);
    const days = await numberedSchoolDays(date.schoolYear);
    return days.find((item) => item.isoDate === date.isoDate)?.dateNumber ?? null;
  }

  async function dateForNumber(year, dateNumber) {
    if (!Number.isInteger(dateNumber) || dateNumber < 1) throw new RangeError('Invalid date number');
    const days = await numberedSchoolDays(year);
    return days[dateNumber - 1] || null;
  }

  async function lessonDateNumberRanges(year, lessons) {
    if (!Array.isArray(lessons)) throw new TypeError('Expected lesson list');
    const days = await numberedSchoolDays(year);
    const bounds = new Map();
    for (const date of days) {
      const previous = bounds.get(date.month);
      bounds.set(date.month, { start: previous ? previous.start : date.dateNumber, end: date.dateNumber });
    }
    const mappings = lessons.map((lesson) => {
      if (!lesson || typeof lesson.id !== 'string' || !lesson.id) throw new TypeError('Invalid lesson ID');
      const match = typeof lesson.month === 'string' ? /^(\d{1,2})月$/.exec(lesson.month.trim()) : null;
      const monthNumber = match ? Number(match[1]) : null;
      const range = bounds.get(monthNumber);
      return Object.freeze({
        id: lesson.id,
        month: monthNumber,
        startDateNumber: range ? range.start : null,
        endDateNumber: range ? range.end : null,
        approximate: true,
        basis: range ? 'existing-lesson-month' : 'unknown'
      });
    });
    return Object.freeze({ academicYear: year, days, lessons: Object.freeze(mappings) });
  }

  global.ClassroomCalendar = Object.freeze({ day, fromISO, today, month, academicYear, refreshHolidays, getSchoolBreaks, saveSchoolBreaks, schoolBreaksOn, loadSharedCalendarData, sharedSchoolBreaksOn, numberedSchoolDays, dateNumberForDate, dateForNumber, lessonDateNumberRanges });
  if (global.document) {
    publishHolidayStatus();
    void refreshHolidays();
  }
})(globalThis);
