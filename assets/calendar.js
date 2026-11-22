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

  global.ClassroomCalendar = Object.freeze({ day, fromISO, today, month, academicYear, refreshHolidays });
  if (global.document) {
    publishHolidayStatus();
    void refreshHolidays();
  }
})(globalThis);
