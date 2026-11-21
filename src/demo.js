import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { step, exportTable } from './engine.js';
import { readJson } from './storage.js';
import { mockApi, CONFIG, ROOM_CODE, id } from './mock.js';
const input = await readJson(new URL('../examples/import.json', import.meta.url), 65536);
for (const scenario of [{choice:'a'}, {choice:'b'}, {choice:'unknown'}, {choice:'a',text:'h1,h2\n\"unfinished'}]) {
  const choice = scenario.choice, source = scenario.text ? { ...input, text: scenario.text } : input;
  const directory = await mkdtemp(join(tmpdir(), 'import-demo-'));
  try {
    const now = () => '2026-01-01T09:00:00.000Z', api = mockApi(now);
    const options = { client: api.client, directory, input: source, config: CONFIG, token: 'offline-fixture-token', room: ROOM_CODE, now };
    const pending = await step(options); assert.equal(pending.status, 'pending');
    api.answer(id(1), choice); const result = await step(options);
    if (choice === 'unknown' || scenario.text) { assert.equal(result.status, scenario.text ? 'invalid' : 'unknown'); await assert.rejects(exportTable(directory, source)); }
    else { const exported = await exportTable(directory, source); assert.equal(exported.analysis.presetId, choice); }
    assert.equal(api.calls.filter(call => call.method === 'POST').length, 1);
    console.log(JSON.stringify({ choice, status: result.status, analysis: result.analysis }, null, 2));
  } finally { await rm(directory, { recursive: true, force: true }); }
}
