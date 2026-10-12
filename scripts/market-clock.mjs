// NYSE calendar + ET clock shared by the feed loop and its tests.
// ---------- market clock (ET) ----------
export const NYSE_HOLIDAYS = new Set(["2026-01-01","2026-01-19","2026-02-16","2026-04-03","2026-05-25","2026-06-19","2026-07-03","2026-09-07","2026-11-26","2026-12-25",
  "2027-01-01","2027-01-18","2027-02-15","2027-03-26","2027-05-31","2027-06-18","2027-07-05","2027-09-06","2027-11-25","2027-12-24"]);
export const NYSE_HALF_DAYS = new Set(["2026-11-27","2026-12-24","2027-11-26"]); // 13:00 ET close
export function etNow(now = new Date()) {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short" }).formatToParts(now);
  const g = t => p.find(x => x.type === t)?.value;
  return { date: `${g("year")}-${g("month")}-${g("day")}`, min: (Number(g("hour")) % 24) * 60 + Number(g("minute")), dow: ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].indexOf(g("weekday")) };
}
export function marketPhase(now = new Date()) {
  const t = etNow(now);
  if (t.dow === 0 || t.dow === 6 || NYSE_HOLIDAYS.has(t.date)) return "closed";
  const close = NYSE_HALF_DAYS.has(t.date) ? 13 * 60 : 16 * 60;
  if (t.min < 4 * 60) return "closed";
  if (t.min < 9 * 60 + 30) return "pre";
  if (t.min < close) return "regular";
  if (t.min < 20 * 60) return "post";
  return "closed";
}
