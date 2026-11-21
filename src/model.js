import { parseDelimited } from './parser.js';
import { createHash } from 'node:crypto';

export const TTL = 900;
export const CLOCK_SKEW_MS = 60000;
export const TOKEN = /^[^\s\x00-\x1f\x7f]{1,8192}(?![\s\S])/;
export const ROOM = /^[A-Z0-9]{12}$(?![\s\S])/;
export const isId = (value) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$(?![\s\S])/.test(value);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) => {
  if (!record(value)) return false;
  const actual = Object.keys(value).sort(), wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
};
const word = (value) => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,39}$(?![\s\S])/.test(value);
const line = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && value.isWellFormed()
  && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value) && value.trim() === value;
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : record(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
export const hash = (value) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

export function iso(raw) {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$(?![\s\S])/.test(raw)) throw new Error('Expected a UTC timestamp.');
  const time = Date.parse(raw);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 19) !== raw.slice(0, 19)) throw new Error('Invalid UTC timestamp.');
  return new Date(time).toISOString();
}



const safeId = value => word(value) && value.length <= 12 && !['constructor', 'prototype', '__proto__', 'unknown'].includes(value);
const order = (a, b) => a < b ? -1 : a > b ? 1 : 0;
export const POLICY = Object.freeze({ name: 'bounded-delimited-text-v1',
  bounds: '1..32768 UTF-16 units, 1..256 records including any header, 1..32 cells per record, at most 2048 UTF-16 units per decoded cell',
  delimiters: 'owner-selected comma, semicolon or tab; double quotes only; doubled quotes escape one literal quote',
  lineEndings: 'LF or CRLF outside and inside quoted fields; preserve embedded line endings; reject every bare CR',
  records: 'blank lines are one empty cell; final record separator adds no record; trailing delimiter adds an empty cell',
  header: 'preset declares first record header or no header; retain duplicate and empty header cells as an array',
  text: 'preserve strings and whitespace; no type coercion, formula evaluation, trimming, normalization or dialect inference; initial BOM refused',
  selection: 'one supplied dialect preset; Unknown withholds the import',
  excluded: 'byte encoding detection, schema mapping, spreadsheet execution, upload and source-system writes' });
export const POLICY_HASH = hash(POLICY);
const promptFor = input => `${input.title}\n${input.context}\nWhich documented dialect produced ${input.importId}?\n${input.presets.map(preset => `${preset.id}: ${preset.label} / ${preset.delimiter === '\t' ? 'TAB' : preset.delimiter}; header=${preset.header ? 'yes' : 'no'} / ${preset.reference}`).join('\n')}\nChoose from source documentation, or Unknown. Raw text stays local.`;
export function validateInput(input) {
  if (!keys(input, ['importId', 'title', 'context', 'text', 'presets']) || !word(input.importId)
    || !line(input.title, 40) || !line(input.context, 80) || typeof input.text !== 'string' || !input.text.length || input.text.length > 32768
    || !input.text.isWellFormed() || input.text.startsWith('\uFEFF') || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(input.text)
    || !Array.isArray(input.presets) || input.presets.length < 1 || input.presets.length > 3) throw new Error('Supply import metadata, nonempty well-formed text without an initial BOM or unsupported controls, and one to three dialect presets.');
  const ids = new Set(), semantics = new Set();
  const presets = Array.from(input.presets, preset => {
    if (!keys(preset, ['id', 'label', 'reference', 'delimiter', 'header']) || !safeId(preset.id) || ids.has(preset.id) || !line(preset.label, 26)
      || !line(preset.reference, 40) || ![',', ';', '\t'].includes(preset.delimiter) || typeof preset.header !== 'boolean') throw new Error('Presets need unique safe IDs, labels/references, comma/semicolon/tab delimiter and a boolean header declaration.');
    const semantic = `${preset.delimiter}:${preset.header}`;
    if (semantics.has(semantic)) throw new Error('Dialect presets must differ in delimiter or header interpretation.');
    ids.add(preset.id); semantics.add(semantic); return { ...preset };
  }).sort((a, b) => order(a.id, b.id));
  const result = { importId: input.importId, title: input.title, context: input.context, text: input.text, presets };
  if (promptFor(result).length > 500) throw new Error('Dialect selection prompt exceeds 500 UTF-16 units.');
  return result;
}
export function validateConfig(config) {
  if (!keys(config, ['participant']) || !keys(config.participant, ['id', 'label']) || !isId(config.participant.id) || !line(config.participant.label, 60)) throw new Error('Config requires an exact import owner UUID and label.');
  return structuredClone(config);
}
export const itemsFor = rawInput => { validateInput(rawInput); return [{ id: 'dialect' }]; };
export function requestFor(rawInput, config, itemId, attemptId) {
  const input = validateInput(rawInput); validateConfig(config);
  if (itemId !== 'dialect' || !isId(attemptId)) throw new Error('Invalid dialect selection item or attempt.');
  const key = `import-${attemptId}`;
  return { prompt: promptFor(input), context: `To ${config.participant.id}`,
    options: [...input.presets.map(preset => ({ value: preset.id, label: `${preset.id}: ${preset.label}`, style: 'default' })), { value: 'unknown', label: 'Unknown', style: 'default' }],
    responder_scope: 'direct', target_user_id: config.participant.id, ttl: TTL, correlation_id: key,
    data: { input_hash: hash(input), presets_hash: hash(input.presets), policy_hash: POLICY_HASH, item_id: itemId, attempt_id: attemptId }, idempotencyKey: key };
}
export function previewInput(rawInput, config) {
  const input = validateInput(rawInput), request = requestFor(input, config, 'dialect', '01990000-0000-7000-8000-000000000001');
  const { correlation_id, idempotencyKey, data, ...question } = request;
  return { source: input, sourceHash: hash(input), policy: POLICY, policyHash: POLICY_HASH, question,
    note: 'Attempt UUID, correlation ID and input/preset/policy hashes are bound when a session creates its Question.' };
}

/** Pure parser result. CLI export additionally requires attributed owner evidence. */
export function analyzeImport(rawInput, presetId) {
  const input = validateInput(rawInput), preset = input.presets.find(item => item.id === presetId);
  if (!preset) throw new Error('Select a declared dialect preset before importing.');
  const parsed = parseDelimited(input.text, preset.delimiter);
  if (parsed.status === 'invalid') return { presetId, status: 'invalid', table: null, diagnostic: parsed.diagnostic };
  const width = parsed.records[0].length;
  const mismatch = parsed.records.findIndex(row => row.length !== width);
  if (mismatch !== -1) return { presetId, status: 'invalid', table: null,
    diagnostic: { code: 'unequal-width', record: mismatch + 1, expectedCells: width, actualCells: parsed.records[mismatch].length } };
  return { presetId, status: 'valid', table: { header: preset.header ? parsed.records[0] : null, rows: preset.header ? parsed.records.slice(1) : parsed.records },
    recordCount: parsed.records.length, rowCount: parsed.records.length - Number(preset.header), columnCount: width,
    delimiter: preset.delimiter, headerPresent: preset.header, diagnostic: null, sourceHash: hash(input), policyHash: POLICY_HASH,
    stringsPreserved: true, formulasExecuted: false, sourceWritten: false };
}
export function importPlan(rawInput, choice) {
  const input = validateInput(rawInput);
  if (![null, 'unknown', ...input.presets.map(preset => preset.id)].includes(choice)) throw new Error('Supply a listed dialect preset, Unknown or a missing choice.');
  if (choice === null || choice === 'unknown') return { status: choice === null ? 'incomplete' : 'unknown', analysis: null };
  const analysis = analyzeImport(input, choice);
  return { status: analysis.status === 'valid' ? 'complete' : 'invalid', analysis };
}

export function validateState(state, rawInput) {
  const input = validateInput(rawInput);
  if (!keys(state, ['version', 'inputHash', 'config', 'room', 'credentialHash', 'startedAt', 'attempts']) || state.version !== 1
    || state.inputHash !== hash(input) || typeof state.room !== 'string' || !ROOM.test(state.room)
    || typeof state.credentialHash !== 'string' || !/^[0-9a-f]{64}$(?![\s\S])/.test(state.credentialHash)
    || !Array.isArray(state.attempts) || state.attempts.length > itemsFor(input).length || iso(state.startedAt) !== state.startedAt) throw new Error('Invalid state or changed import metadata. Restore the original input and configuration.');
  validateConfig(state.config);
  const items = itemsFor(input), ids = new Set(), questionIds = new Set(); let previous = state.startedAt, askerId;
  for (const [index, attempt] of state.attempts.entries()) {
    if (!keys(attempt, ['id', 'itemId', 'createdAt', 'request', 'questionId', 'status', 'observation']) || !isId(attempt.id) || ids.has(attempt.id)
      || attempt.itemId !== items[index].id || iso(attempt.createdAt) !== attempt.createdAt || attempt.createdAt < previous
      || hash(attempt.request) !== hash(requestFor(input, state.config, attempt.itemId, attempt.id))
      || !['creating', 'pending', 'answered', 'expired', 'cancelled', 'invalid_answer'].includes(attempt.status)) throw new Error('Invalid saved dialect selection or order.');
    ids.add(attempt.id); previous = attempt.createdAt;
    if (attempt.status === 'creating') {
      if (attempt.questionId !== null || attempt.observation !== null) throw new Error('Invalid uncertain creation state.');
    } else {
      if (!isId(attempt.questionId) || questionIds.has(attempt.questionId)) throw new Error('Invalid or repeated Question ID.');
      questionIds.add(attempt.questionId); validateObservation(attempt.observation, attempt.status, attempt.request);
      if (attempt.observation.checkedAt < attempt.createdAt) throw new Error('Observation predates its saved creation intent.');
      previous = attempt.observation.checkedAt;
      if (Date.parse(attempt.observation.createdAt) < Date.parse(attempt.createdAt) - CLOCK_SKEW_MS) throw new Error('Question predates its saved creation intent.');
      if (askerId !== undefined && attempt.observation.askerId !== askerId) throw new Error('Questions belong to different asking registrations.');
      askerId = attempt.observation.askerId;
    }
    if (['creating', 'pending'].includes(attempt.status) && index !== state.attempts.length - 1) throw new Error('Only the last confirmation may have an active Question.');
  }
  return state;
}




export function report(state, rawInput) {
  const input = validateInput(rawInput); validateState(state, input);
  const attempt = state.attempts[0], answer = attempt?.observation?.answer;
  const answers = [{ itemId: 'dialect', status: attempt?.status === 'creating' ? 'create_unknown' : attempt?.status ?? 'unasked',
    choice: answer?.value ?? null, label: answer?.label ?? null, questionId: attempt?.questionId ?? null, attemptId: attempt?.id ?? null,
    responderId: answer?.responderId ?? null, answeredAt: answer?.answeredAt ?? null, askerId: attempt?.observation?.askerId ?? null, observedAt: attempt?.observation?.checkedAt ?? null }];
  const calculation = importPlan(input, answers[0].choice);
  const status = ['create_unknown', 'pending'].includes(answers[0].status) ? answers[0].status : answers[0].status === 'unasked' ? 'ready' : calculation.status;
  return { version: 1, importId: input.importId, sourceHash: hash(input), source: input, policy: POLICY, policyHash: POLICY_HASH,
    participant: state.config.participant, room: state.room, configHash: hash(state.config), answers, ...calculation, status };
}

function validateObservation(observation, status, request) {
  if (!keys(observation, ['createdAt', 'expiresAt', 'checkedAt', 'askerId', 'resolvedAt', 'answer']) || !isId(observation.askerId)) throw new Error('Invalid saved observation.');
  for (const key of ['createdAt', 'expiresAt', 'checkedAt']) if (iso(observation[key]) !== observation[key]) throw new Error('Invalid saved timestamp.');
  const duration = Date.parse(observation.expiresAt) - Date.parse(observation.createdAt);
  if (duration < TTL * 1000 - 1000 || duration > TTL * 1000 + 1000) throw new Error('Question lifetime differs from the saved request.');
  const latest = Date.parse(observation.checkedAt) + CLOCK_SKEW_MS;
  if (Date.parse(observation.createdAt) > latest) throw new Error('Question creation is implausibly in the future. Check the local clock.');
  if (status === 'pending') {
    if (observation.resolvedAt !== null) throw new Error('Pending Question has a resolution timestamp.');
  } else if (iso(observation.resolvedAt) !== observation.resolvedAt || observation.resolvedAt < observation.createdAt
    || Date.parse(observation.resolvedAt) > latest
    || (status === 'expired' ? observation.resolvedAt < observation.expiresAt : observation.resolvedAt > observation.expiresAt)) throw new Error('Invalid Question resolution time.');
  if (status === 'answered') {
    const answer = observation.answer;
    if (!keys(answer, ['value', 'label', 'responderId', 'answeredAt']) || answer.responderId !== request.target_user_id
      || !request.options.some((option) => option.value === answer.value && option.label === answer.label)
      || iso(answer.answeredAt) !== answer.answeredAt || answer.answeredAt !== observation.resolvedAt
      || answer.answeredAt < observation.createdAt || answer.answeredAt > observation.expiresAt) throw new Error('Invalid saved dialect selection evidence.');
  } else if (observation.answer !== null) throw new Error('Unanswered dialect selections must not contain dialect selection evidence.');
}

export function observeQuestion(q, request, questionId, room, checkedAt) {
  if (!isId(questionId) || q?.id !== questionId || q.kind !== 'question' || (q.is_handoff !== undefined && q.is_handoff !== false)
    || q.asker?.type !== 'agent' || !isId(q.asker?.id) || q.prompt !== request.prompt || q.context !== request.context
    || q.responder_scope !== 'direct' || q.target_user_id !== request.target_user_id || q.resolution_policy !== 'first'
    || (q.results !== undefined && q.results !== null) || q.text_input !== null || q.correlation_id !== request.correlation_id || q.reply_to !== null || hash(q.data) !== hash(request.data)
    || (q.room_code ?? q.room?.code) !== room || q.room_code !== undefined && q.room_code !== room
    || q.room !== undefined && q.room?.code !== room || !['pending', 'answered', 'expired', 'cancelled'].includes(q.state)
    || !Array.isArray(q.options) || q.options.length !== request.options.length
    || Array.from(q.options).some((option, index) => option?.value !== request.options[index].value || option?.label !== request.options[index].label
      || (option?.primary !== undefined && option.primary !== false) || (option?.destructive !== undefined && option.destructive !== false))) throw new Error('Question does not match the saved configuration, room, or reviewer.');
  const observation = { createdAt: iso(q.created_at), expiresAt: iso(q.expires_at), checkedAt: iso(checkedAt), askerId: q.asker.id,
    resolvedAt: q.resolved_at === null ? null : iso(q.resolved_at), answer: null };
  let status = q.state === 'answered' ? 'invalid_answer' : q.state;
  if (q.state !== 'answered' && q.answer !== null) throw new Error('Unresolved Question includes an unexpected answer.');
  if (q.state === 'answered') {
    const answer = q.answer;
    try {
      if (!answer || answer.text !== null || answer.responder?.id !== request.target_user_id
        || !request.options.some((option) => option.value === answer.value && option.label === answer.label)) throw new Error('Invalid answer.');
      observation.answer = { value: answer.value, label: answer.label, responderId: answer.responder.id, answeredAt: iso(answer.answered_at) };
      validateObservation(observation, 'answered', request); status = 'answered';
    } catch { observation.answer = null; }
  }
  validateObservation(observation, status, request);
  return { status, observation };
}

export function assertParticipantRoom(rooms, room, participantId) {
  if (!Array.isArray(rooms) || rooms.length > 1000) throw new Error('Invalid room inventory.');
  const matches = rooms.filter((item) => item?.invite_code === room), selected = matches[0];
  if (matches.length !== 1 || selected.type !== 'standard' || selected.is_public !== false || !Array.isArray(selected.members)
    || selected.members.length > 1000 || !selected.members.some((member) => member?.user_id === participantId)) throw new Error('Use a granted standard private room containing the named participant.');
}
