(function (global) {
  'use strict';

  // Civil dates are date-only values; calculate their weekdays in UTC so the
  // result does not change with the viewer's time zone. "Today" uses Japan time.
  const WEEKDAYS_JA = Object.freeze(['日', '月', '火', '水', '木', '金', '土']);
  const japaneseDateFormatter = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: 'numeric', day: 'numeric'
  });

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
    return Object.freeze({
      isoDate: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(date).padStart(2, '0')}`,
      year, month, day: date,
      weekday,
      weekdayJa: WEEKDAYS_JA[weekday],
      isWeekend: weekday === 0 || weekday === 6,
      schoolYear: month >= 4 ? year : year - 1
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

  global.ClassroomCalendar = Object.freeze({ day, fromISO, today, month, academicYear });
})(globalThis);
