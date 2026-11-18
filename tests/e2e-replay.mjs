// Replay the captured *real* upstream refusal stream through the patched
// adapter's translate() path and assert 0.2.0 semantics:
//   real wire (HTTP 200, message_delta stop_reason "refusal")
//     -> rejects with EMPTY_RESPONSE (retryable), never a synthesized answer.
//
// Run after `node tests/e2e.mjs` has staged tests/.work-e2e (it reuses the same
// staged dependencies).
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const work = join(here, '.work-e2e');
const capture = process.argv[2] ?? 'D:\\TAP\\_capture\\repro-sys-resp-2026-11-17T11-29-27-850Z.sse';

let staged;
try {
	staged = await import(pathToFileURL(join(work, 'lib', 'adapter.js')).href);
} catch {
	console.error('staged adapter not found — run `node tests/e2e.mjs` first.');
	process.exit(1);
}
const { translate } = staged;
const { createParser } = await import(pathToFileURL(join(work, 'node_modules', 'eventsource-parser', 'dist', 'index.js')).href);

let bytes = readFileSync(capture);
if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = gunzipSync(bytes);
const text = bytes.toString('utf8');

const events = [];
const parser = createParser({ onEvent: (event) => events.push(JSON.parse(event.data)) });
parser.feed(text);

console.log(`capture: ${capture}`);
console.log(`raw bytes: ${bytes.length}, SSE events: ${events.length}`);
const delta = events.find((event) => event.type === 'message_delta');
console.log(`upstream stop_reason: ${JSON.stringify(delta?.delta?.stop_reason)}`);

let chunks = [];
let error;
try {
	for await (const chunk of translate(events, 'deepseek-flash')) chunks.push(chunk);
} catch (caught) {
	error = caught;
}

const textDeltas = chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('');
const checks = [
	['real refusal is retryable EMPTY_RESPONSE', error?.code === 'EMPTY_RESPONSE'],
	['real refusal names the safety review', /refused to answer under its content safety review/i.test(String(error?.message))],
	['real refusal synthesizes no assistant text', textDeltas === ''],
	['no finish chunk is emitted for a refusal', chunks.every((chunk) => chunk.type !== 'finish')],
];

let failed = 0;
for (const [name, pass] of checks) {
	console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`);
	if (!pass) failed += 1;
}
if (failed > 0 && error !== undefined) console.log(`error: ${error.code} ${error.message}`);
console.log(`\n${checks.length - failed}/${checks.length} replay checks passed (node ${process.version})`);
process.exitCode = failed === 0 ? 0 : 1;

