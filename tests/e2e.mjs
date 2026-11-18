// End-to-end check against a mock Messages endpoint.
//
// Purpose: exercise the *real* patched adapter class over real HTTP (undici),
// not just translate() fixtures:
//   1st request  -> upstream SSE ends with stop_reason "refusal"
//   2nd request  -> normal SSE with text
// The adapter must reject the first call with the retryable EMPTY_RESPONSE
// code (so the agent loop retries) and finish the retried call normally, with
// no synthesized answer text anywhere.
//
// Usage: node tests/e2e.mjs   (after the dependency staging done by npm test,
// or standalone: it stages its own copy under tests/.work-e2e)
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);
const work = join(here, '.work-e2e');
const DEPS = {
	'@deepseek-ai/cosmokit': '^1.9.0',
	'@deepseek-ai/dsh-anonymous-user-id': '0.2.2-rc.3',
	'@deepseek-ai/dsh-atomic-write': '0.2.2-rc.3',
	'@deepseek-ai/dsh-attachment': '0.2.2-rc.3',
	'@deepseek-ai/dsh-home-paths': '0.2.2-rc.3',
	'@deepseek-ai/dsh-launch-environment': '0.2.2-rc.3',
	'@deepseek-ai/dsh-llm': '0.2.2-rc.3',
	'@deepseek-ai/dsh-timeout': '0.2.2-rc.3',
	'@deepseek-ai/dsh-util-values': '0.2.2-rc.3',
	'@deepseek-ai/schemastery': '^3.19.0',
	'eventsource-parser': '^3.1.1',
	semver: '^7.8.0',
};

await rm(work, { recursive: true, force: true });
await mkdir(join(work, 'lib'), { recursive: true });
await copyFile(join(root, 'lib', 'adapter.js'), join(work, 'lib', 'adapter.js'));
await writeFile(join(work, 'package.json'), JSON.stringify({ name: 'refusal-fix-e2e', private: true, type: 'module', dependencies: DEPS }, null, 2));
const install = spawnSync('npm install --no-audit --no-fund --loglevel=error', { cwd: work, stdio: 'inherit', shell: true });
if (install.status !== 0) {
	console.error(`npm install failed (exit ${install.status})`);
	process.exit(install.status ?? 1);
}

const { DeepSeekAdapter, resolveAdapterOptions } = await import(pathToFileURL(join(work, 'lib', 'adapter.js')).href);

function sse(events) {
	return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

const START = { type: 'message_start', message: { usage: { input_tokens: 12, output_tokens: 0 } } };
const REFUSAL = sse([
	START,
	{ type: 'message_delta', delta: { stop_reason: 'refusal', stop_sequence: null }, usage: { output_tokens: 22, output_tokens_details: { thinking_tokens: 22 } } },
	{ type: 'message_stop' },
]);
const NORMAL = sse([
	START,
	{ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
	{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
	{ type: 'content_block_stop', index: 0 },
	{ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
	{ type: 'message_stop' },
]);

let calls = 0;
const server = createServer((req, res) => {
	if (req.method !== 'POST' || !req.url.endsWith('/v1/messages')) {
		res.writeHead(404).end();
		return;
	}
	req.resume();
	req.on('end', () => {
		calls += 1;
		const body = calls === 1 ? REFUSAL : NORMAL;
		res.writeHead(200, { 'content-type': 'text/event-stream' });
		res.end(body);
	});
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

const connection = resolveAdapterOptions({ baseURL: `http://127.0.0.1:${port}/anthropic`, apiKey: 'e2e-test-key' });
const adapter = new DeepSeekAdapter({
	options: () => connection,
	providerName: 'DeepSeek (e2e)',
	resolveAuth: async () => ({ headers: { 'x-dsh-auth-token': 'e2e-test-token' } }),
	resolveUserId: () => 'e2e-user',
	prepareExtensions: async () => ({ fields: {}, accept: async () => {} }),
});

async function call() {
	const chunks = [];
	try {
		for await (const chunk of adapter.stream({
			provider: 'deepseek-account',
			model: 'deepseek-flash',
			messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
			maxOutputTokens: 64,
			signal: AbortSignal.timeout(20000),
		})) chunks.push(chunk);
		return { chunks };
	} catch (error) {
		return { chunks, error };
	}
}

const first = await call();
const second = await call();
server.close();
if (process.env.E2E_DEBUG) {
	console.log('first error:', first.error?.code, first.error?.message);
	console.log('second error:', second.error?.code, second.error?.message);
	console.log('second chunks:', JSON.stringify(second.chunks).slice(0, 300));
}

const finishOf = (chunks) => chunks.find((chunk) => chunk.type === 'finish');
const textOf = (chunks) => chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('');

const checks = [
	['first call rejects with EMPTY_RESPONSE', first.error?.code === 'EMPTY_RESPONSE'],
	['first call carries a refusal explanation', /refused to answer under its content safety review/i.test(String(first.error?.message))],
	['first call synthesizes no text', textOf(first.chunks) === ''],
	['retried call succeeds', second.error === undefined],
	['retried call finishes as stop', finishOf(second.chunks)?.reason?.kind === 'stop'],
	['retried call returns upstream text', textOf(second.chunks) === 'ok'],
];

let failed = 0;
for (const [name, pass] of checks) {
	console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`);
	if (!pass) failed += 1;
}
console.log(`\n${checks.length - failed}/${checks.length} e2e checks passed (mock Messages endpoint, node ${process.version})`);
process.exitCode = failed === 0 ? 0 : 1;
