/** Decode a bounded delimited string without trimming, coercion or evaluation. */
export function parseDelimited(text, delimiter) {
  const fail = (code, offset) => ({ status: 'invalid', diagnostic: { code, offset } });
  if (typeof text !== 'string' || !text.length || text.length > 32768 || !text.isWellFormed()
    || text.startsWith('\uFEFF') || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text) || ![',', ';', '\t'].includes(delimiter)) return fail('unsupported-input', 0);
  const bareCR = /\r(?!\n)/.exec(text);
  if (bareCR) return fail('bare-cr', bareCR.index);
  const records = [];
  let row = [], field = '', state = 'start', endedRecord = false;
  const append = value => { field += value; return field.length <= 2048; };
  const finishCell = () => { row.push(field); field = ''; state = 'start'; return row.length <= 32; };
  const finishRecord = () => { records.push(row); row = []; return records.length <= 256; };
  for (let offset = 0; offset < text.length; offset++) {
    const ch = text[offset];
    if (state === 'quoted') {
      if (ch === '"') {
        if (text[offset + 1] === '"') { if (!append('"')) return fail('cell-limit', offset); offset++; }
        else state = 'closed';
      } else if (!append(ch)) return fail('cell-limit', offset);
      continue;
    }
    if (ch === delimiter) {
      if (!finishCell()) return fail('column-limit', offset);
      endedRecord = false;
    } else if (ch === '\r' || ch === '\n') {
      if (!finishCell()) return fail('column-limit', offset);
      if (!finishRecord()) return fail('record-limit', offset);
      if (ch === '\r') offset++;
      endedRecord = true;
    } else if (state === 'closed') {
      return fail('after-closing-quote', offset);
    } else if (ch === '"') {
      if (state !== 'start') return fail('quote-in-unquoted-cell', offset);
      state = 'quoted'; endedRecord = false;
    } else {
      state = 'plain'; endedRecord = false;
      if (!append(ch)) return fail('cell-limit', offset);
    }
  }
  if (state === 'quoted') return fail('unterminated-quote', text.length);
  if (!endedRecord) {
    if (!finishCell()) return fail('column-limit', text.length);
    if (!finishRecord()) return fail('record-limit', text.length);
  }
  return { status: 'valid', records };
}
