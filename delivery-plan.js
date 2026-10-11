const DAY_MS = 24 * 60 * 60 * 1000;

function parseIsoDate(value) {
  const [year, month, day] = String(value).split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function formatIsoDate(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(isoDate, days) {
  return formatIsoDate(new Date(parseIsoDate(isoDate).getTime() + Number(days) * DAY_MS));
}

function isValidIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return false;
  return formatIsoDate(parseIsoDate(value)) === value;
}

export function validateDeliveryInput(input) {
  const errors = [];
  if (!/^[A-Za-z0-9]{7}$/.test(String(input.modelmaster || ''))) {
    errors.push('Modelmaster muss genau 7 Buchstaben oder Ziffern enthalten.');
  }
  if (!isValidIsoDate(input.startDate) || !isValidIsoDate(input.endDate)) {
    errors.push('Bitte Start- und Enddatum vollständig eingeben.');
  } else if (input.endDate < input.startDate) {
    errors.push('Das Enddatum darf nicht vor dem Startdatum liegen.');
  }
  if (!(Number(input.grossPerDay) > 0)) errors.push('Brutto-Menge pro Tag muss größer als 0 sein.');
  if (!Number.isInteger(Number(input.leadTimeDays)) || Number(input.leadTimeDays) < 0) {
    errors.push('Durchlaufzeit muss eine ganze Zahl ab 0 sein.');
  }
  if (!(Number(input.yieldPercent) > 0 && Number(input.yieldPercent) <= 100)) {
    errors.push('Yield muss größer als 0 und höchstens 100 % sein.');
  }
  return errors;
}

export function calculateDailyDeliveries(input) {
  const rows = [];
  const start = parseIsoDate(input.startDate);
  const end = parseIsoDate(input.endDate);
  for (let time = start.getTime(), index = 0; time <= end.getTime(); time += DAY_MS, index += 1) {
    const castingDate = formatIsoDate(new Date(time));
    const gross = index === 0 ? Number((Number(input.grossPerDay) * 0.6).toFixed(6)) : Number(input.grossPerDay);
    rows.push({
      modelmaster: input.modelmaster,
      castingDate,
      gross,
      net: Math.round(gross * Number(input.yieldPercent) / 100),
      warehouseDate: addDays(castingDate, Number(input.leadTimeDays))
    });
  }
  return rows;
}

function isoWeek(isoDate) {
  const date = parseIsoDate(isoDate);
  const weekday = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - weekday);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil((((date - yearStart) / DAY_MS) + 1) / 7);
}

export function groupWeeklyDeliveries(rows) {
  const groups = new Map();
  for (const row of rows) {
    const warehouse = parseIsoDate(row.warehouseDate);
    const fridayDate = addDays(row.warehouseDate, (5 - warehouse.getUTCDay() + 7) % 7);
    const existing = groups.get(fridayDate) || {
      modelmaster: row.modelmaster,
      calendarWeek: isoWeek(fridayDate),
      fridayDate,
      netTotal: 0
    };
    existing.netTotal += row.net;
    groups.set(fridayDate, existing);
  }
  return [...groups.values()].sort((a, b) => a.fridayDate.localeCompare(b.fridayDate));
}
