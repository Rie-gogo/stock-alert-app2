export const JPX_EQUITY_CALENDAR_VERSION = "jpx-market-holidays-2026-2027-v1";

const JPX_EQUITY_MARKET_HOLIDAYS = new Set([
  "2026-01-01", "2026-01-02", "2026-01-03", "2026-01-12", "2026-02-11", "2026-02-23", "2026-03-20", "2026-04-29", "2026-05-03", "2026-05-04", "2026-05-05", "2026-05-06", "2026-07-20", "2026-08-11", "2026-09-21", "2026-09-22", "2026-09-23", "2026-10-12", "2026-11-03", "2026-11-23", "2026-12-31",
  "2027-01-01", "2027-01-02", "2027-01-03", "2027-01-11", "2027-02-11", "2027-02-23", "2027-03-21", "2027-03-22", "2027-04-29", "2027-05-03", "2027-05-04", "2027-05-05", "2027-07-19", "2027-08-11", "2027-09-20", "2027-09-23", "2027-10-11", "2027-11-03", "2027-11-23", "2027-12-31",
]);

export function nextTokyoEquityTradeDate(date: string) {
  const next = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(next.getTime())) throw new Error(`jpx_equity_calendar_invalid_date:${date}`);
  do {
    next.setUTCDate(next.getUTCDate() + 1);
    const year = next.getUTCFullYear();
    if (year < 2026 || year > 2027) throw new Error(`jpx_equity_calendar_not_configured:${year}`);
  } while (next.getUTCDay() === 0 || next.getUTCDay() === 6 || JPX_EQUITY_MARKET_HOLIDAYS.has(next.toISOString().slice(0, 10)));
  return next.toISOString().slice(0, 10);
}
