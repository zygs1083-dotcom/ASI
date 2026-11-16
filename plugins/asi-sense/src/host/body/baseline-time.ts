const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export const formatter = (timeZone: string | undefined): Intl.DateTimeFormat =>
  new Intl.DateTimeFormat('en-US-u-nu-latn', {
    ...(timeZone ? { timeZone } : {}),
    weekday: 'short',
    hour: 'numeric',
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  });

/** Local weekday*24+hour slot and local calendar date for `at` in `fmt`'s zone. */
export const slotOf = (fmt: Intl.DateTimeFormat, at: number): { index: number; date: string } => {
  let wd = -1;
  let hour = -1;
  let y = '';
  let m = '';
  let d = '';
  for (const p of fmt.formatToParts(at)) {
    if (p.type === 'weekday') wd = WEEKDAY[p.value] ?? -1;
    else if (p.type === 'hour') hour = Number(p.value);
    else if (p.type === 'year') y = p.value;
    else if (p.type === 'month') m = p.value;
    else if (p.type === 'day') d = p.value;
  }
  return { index: wd * 24 + hour, date: `${y}-${m}-${d}` };
};
