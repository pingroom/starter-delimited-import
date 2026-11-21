# Delimited text imports with PingRoom

Convert a retained CSV-style export into a table of strings after its owner selects the documented dialect through PingRoom. Code handles quoted delimiters, escaped quotes and embedded line endings, checks rectangular row widths, and exports a local JSON table. It never guesses a dialect, coerces values or evaluates formulas.

Use this between an existing export process and a data-import adapter. The source file stays unchanged; no database or external system is written.

## Try it offline

Choose **Use this template**, clone your copy, and use Node.js 22 or newer:

```sh
npm ci
npm test
npm run demo
```

The fictional workshop-supply export contains a quoted comma, escaped quotes and an embedded newline. The demo shows header and no-header interpretations, Unknown, and a malformed import. Tests and demos use published `@pingroom/sdk` **0.8.0** through local mock transports. After installation, they need no credentials or network and send no live pings. The lockfile pins dependencies; `.npmrc` requests a 14-day minimum release age where supported by npm.

## Define the import

```sh
cp examples/import.json import.json
cp config.example.json config.json
```

Decode your export with its documented character encoding in your existing adapter, then put its exact text into the JSON `text` string. Do not trim fields or change embedded line endings. This starter does not read a CSV path or detect byte encoding.

| Field | Contract |
| --- | --- |
| `importId` | Stable 1–40 character ID: lowercase letter first, then lowercase letters, digits, `_` or `-`. |
| `title`, `context` | Nonempty single-line text, at most 40 and 80 UTF-16 code units. Identify the source documentation to consult. |
| `text` | 1–32,768 UTF-16 code units. Well-formed Unicode; no initial byte-order-mark character, NUL, DEL or C0 controls other than tab, CR and LF. The complete JSON input must also fit the 64 KiB file limit. |
| `presets` | 1–3 objects containing exactly `id`, `label`, `reference`, `delimiter` and `header`. Each must differ in delimiter or header interpretation. |
| Preset `id` | Unique, 1–12 characters using the `importId` alphabet. `unknown`, `constructor`, `prototype` and `__proto__` are reserved. |
| Preset `label`, `reference` | Nonempty single-line text, at most 26 and 40 UTF-16 code units. |
| `delimiter` | Exactly comma `","`, semicolon `";"` or tab `"\t"`. |
| `header` | Boolean: `true` means the first decoded record is a header; `false` means every record is data. |

Extra fields, sparse arrays, malformed Unicode and invalid preset metadata fail before any Question. Metadata must already be trimmed and contain no controls or formatting characters; the program does not trim it. Presets canonicalize by ID; the raw text is preserved. The complete Question must fit 500 UTF-16 code units.

## Connect and select

Install [PingRoom](https://pingroom.io/i), then:

```sh
npm run connect
npm run inspect
```

Approve the printed pairing link and grant a **standard private room** containing the import owner, with room-list and Question create/read permissions. Verify the intended person in the app, then put their exact member UUID and label in `config.json`. A display name alone does not establish identity.

For an existing connection, copy `.env.example` to `.env` and set **both** `PINGROOM_TOKEN` and `PINGROOM_ROOM`. Blank or partial pairs are rejected; credential sources cannot be combined.

```sh
npm run preview
npm start
# After the owner answers:
npm start
npm run export
```

`preview` and `validate` show the exact local source, policy, recipient and Question without network access. PingRoom receives title/context, import ID, preset IDs/labels/references, delimiter and header settings, owner UUID and input/preset/policy hashes. Raw cells stay local.

Each invocation creates at most one direct, 15-minute Question or reads the original Question once. Unknown, missing, expired, cancelled, invalid or misattributed answers withhold the import. No background polling or replacement Question is created. A selected dialect can parse successfully and still be the wrong interpretation; the owner must consult the source documentation.

## Parsing and output

The policy uses the double-quote and doubled-quote conventions described in [RFC 4180](https://www.rfc-editor.org/rfc/rfc4180#section-2). It also permits semicolon/tab delimiters, LF record separators and Unicode text, within the following limits:

- A quote may begin only at the start of a cell. Inside a quoted cell, `""` decodes to one literal quote. Delimiters and LF/CRLF are preserved inside quotes.
- After a closing quote, only a delimiter, record separator or end of input is accepted. Surrounding whitespace is not silently discarded. Every bare CR is rejected, including inside quotes.
- A blank line is one empty cell. A final record separator adds no extra record; a trailing delimiter adds an empty cell. Empty text is refused.
- At most 256 records, including a header, and 32 cells per record are accepted. A decoded cell may contain at most 2,048 UTF-16 code units. Every record must have the same width.
- Header cells remain an array, so duplicate and empty names are preserved without creating object keys. A header-only input is valid and produces zero data rows. Without a header, `header` is `null`.
- Every value remains a string, including `001`, whitespace and formula-looking text. The JSON output is not a spreadsheet sanitizer; downstream software must decide how to handle such values.

```sh
npm run status
npm run report
npm run export
```

These commands are local and need no credentials. `report` writes `.import/report.json`, including partial answers or parse diagnostics. A known choice with malformed syntax, exceeded parser bounds or unequal row widths has `status: invalid`, with `analysis.table: null`; export is refused. Syntax diagnostics use zero-based UTF-16 offsets, while unequal-width diagnostics identify a one-based record number. No partial table is exported.

A complete export writes `.import/table.json`, retaining the normalized source, selected preset, policy, owner and attributed Question evidence. `analysis.table` contains `header` (an array or `null`) and a `rows` array. Counts and input/policy hashes are sibling fields on `analysis`. These hashes bind local content to the saved session; they do not authenticate the source system. Treat source cells and exports as private. Repeated exports create no Questions and leave the source unchanged.

## Adapt and resume

Map your retained export to `import.json`, supply documented presets, and consume the table in a separate import adapter. `parseDelimited(text, delimiter)` in `src/parser.js` is the pure decoder; `analyzeImport(input, presetId)` adds header and rectangular-width interpretation. CLI export additionally requires attributed owner evidence. No database, spreadsheet, deployment or external-action adapter is included.

Keep `.import/` and `.pingroom/` private and intact. Credentials, real inputs, configuration, state and outputs are ignored by Git. Input/configuration reads are bounded to 64/16 KiB; state and outputs are private and written atomically under a local lock. Changed input, participant, room or credentials cannot reuse a session.

A lost creation response leaves `create_unknown`; the program never automatically resends:

```sh
npm run status
npm run find-id
npm run recover -- EXACT-QUESTION-UUID
```

Recover only the original Question. An empty bounded search does not prove creation failed. Resolve or revoke uncertain/expired pairing in Connected Agents before archiving its pending record. Remove a stale `.lock` only after confirming its process stopped. Resolve the original session before archiving it for a new source.

Run commands serially. Exit codes: `0` complete/local result; `1` invalid setup/evidence or refused export; `2` incomplete, Unknown, malformed import or failed answer; `3` ready/pending/interrupted; `4` uncertain creation. Local status/report commands exit 0 even when reporting a failure; inspect the JSON status.

Tests cover quote and newline cases, parser limits, 1,200 generated-table round trips, invalid input, durable recovery, pairing and real CLI subprocesses. GitHub Actions checks Node.js 22 and 24. Live phone delivery is not tested. MIT licensed.
