export function createModelPreset(input) {
  const preset = {
    modelmaster: String(input.modelmaster || '').toUpperCase(),
    designation: String(input.designation || '').trim(),
    press: String(input.press || '').toUpperCase(),
    material: String(input.material || ''),
    grossPerDay: Number(input.grossPerDay),
    leadTimeDays: Number(input.leadTimeDays),
    yieldPercent: Number(input.yieldPercent)
  };
  const errors = [];
  if (!/^[A-Z0-9]{7}$/.test(preset.modelmaster)) errors.push('Modelmaster muss genau 7 Buchstaben oder Ziffern enthalten.');
  if (!preset.designation || !/^[\p{L}\p{N} .&/_-]{1,60}$/u.test(preset.designation)) errors.push('Bezeichnung ist ungültig.');
  if (!/^[A-Z0-9]{4}$/.test(preset.press)) errors.push('Presse muss genau 4 Buchstaben oder Ziffern enthalten.');
  if (!['TitanCerm', 'Vilboplus'].includes(preset.material)) errors.push('Werkstoff ist ungültig.');
  if (!(preset.grossPerDay > 0)) errors.push('Brutto pro Tag muss größer als 0 sein.');
  if (!Number.isInteger(preset.leadTimeDays) || preset.leadTimeDays < 0) errors.push('Durchlaufzeit muss eine ganze Zahl ab 0 sein.');
  if (!(preset.yieldPercent > 0 && preset.yieldPercent <= 100)) errors.push('Yield muss größer als 0 und höchstens 100 % sein.');
  if (errors.length) throw new Error(errors.join(' '));
  return preset;
}

export function upsertModelPreset(presets, preset) {
  return [...presets.filter((item) => item.modelmaster !== preset.modelmaster), preset]
    .sort((a, b) => a.modelmaster.localeCompare(b.modelmaster));
}

export function removeModelPreset(presets, modelmaster) {
  return presets.filter((item) => item.modelmaster !== modelmaster);
}
