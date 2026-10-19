// Date utility helper for consistent SQL Server Date conversion across all routes
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const MONTH_MAP = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12'
};

function getTodayIstIso() {
  const ist = new Date(Date.now() + 5.5 * 3600000);
  const y = ist.getUTCFullYear();
  const m = String(ist.getUTCMonth() + 1).padStart(2, '0');
  const d = String(ist.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function toSqlDate(dateStr) {
  if (!dateStr) return getTodayIstIso();
  if (dateStr instanceof Date) {
    if (isNaN(dateStr.getTime())) return getTodayIstIso();
    return dateStr.toISOString().split('T')[0];
  }
  const s = String(dateStr).trim();
  if (!s) return getTodayIstIso();

  // 1. ISO YYYY-MM-DD
  const iso = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (iso) {
    return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;
  }

  // 2. DD/MMM/YYYY or DD-MMM-YYYY (e.g. 15/Jun/2026)
  const ddmmyyyyAlpha = s.match(/^(\d{1,2})[-/]([A-Za-z]{3})[-/](\d{4})/);
  if (ddmmyyyyAlpha) {
    const mo = MONTH_MAP[ddmmyyyyAlpha[2].toLowerCase()] || '01';
    return `${ddmmyyyyAlpha[3]}-${mo}-${ddmmyyyyAlpha[1].padStart(2, '0')}`;
  }

  // 3. DD/MM/YYYY or DD-MM-YYYY (e.g. 15/06/2026)
  const ddmmyyyy = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
  if (ddmmyyyy) {
    return `${ddmmyyyy[3]}-${ddmmyyyy[2].padStart(2, '0')}-${ddmmyyyy[1].padStart(2, '0')}`;
  }

  // Fallback try Date parse
  const parsed = new Date(s);
  if (!isNaN(parsed.getTime())) {
    return parsed.toISOString().split('T')[0];
  }

  return getTodayIstIso();
}

function toDmyString(dateStr) {
  const iso = toSqlDate(dateStr);
  const parts = iso.split('-');
  const moIdx = parseInt(parts[1], 10) - 1;
  const moStr = (moIdx >= 0 && moIdx < 12) ? MONTHS[moIdx] : MONTHS[0];
  return `${parts[2]}/${moStr}/${parts[0]}`;
}

module.exports = { toSqlDate, toDmyString, getTodayIstIso };
