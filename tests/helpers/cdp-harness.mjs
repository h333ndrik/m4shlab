import {existsSync, mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';

const chromeCandidates = [
  process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

export class CdpClient {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 0;
    this.pending = new Map();
    this.exceptions = [];
    this.consoleErrors = [];
    this.socket.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
      } else if (message.method === 'Runtime.exceptionThrown') {
        this.exceptions.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
      } else if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
        this.consoleErrors.push(message.params.args.map(arg => arg.value ?? arg.description ?? '').join(' '));
      }
    };
  }

  open() {
    if (this.socket.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolveOpen, rejectOpen) => {
      this.socket.onopen = resolveOpen;
      this.socket.onerror = rejectOpen;
    });
  }

  send(method, params = {}) {
    const id = ++this.nextId;
    this.socket.send(JSON.stringify({id, method, params}));
    return new Promise((resolveSend, rejectSend) => this.pending.set(id, {resolve: resolveSend, reject: rejectSend}));
  }

  async evaluate(expression) {
    const response = await this.send('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true});
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
    return response.result.value;
  }

  async setFile(selector, path) {
    await this.setFiles(selector, [path]);
  }

  async setFiles(selector, paths) {
    const response = await this.send('Runtime.evaluate', {expression: `document.querySelector(${JSON.stringify(selector)})`});
    await this.send('DOM.setFileInputFiles', {objectId: response.result.objectId, files: paths});
  }

  async waitFor(expression, timeout = 30000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await this.evaluate(expression).catch(() => false)) return;
      await new Promise(resolveWait => setTimeout(resolveWait, 100));
    }
    const state = await this.evaluate(`({
      status: document.querySelector('#status')?.textContent,
      error: document.querySelector('#error')?.hidden === false ? document.querySelector('#error')?.textContent : null,
      ready: document.documentElement.dataset.appReady
    })`).catch(() => null);
    throw new Error(`Timeout waiting for ${expression}\n${JSON.stringify(state)}`);
  }

  close() {
    this.socket.close();
  }
}

export async function launchChrome(profilePrefix = 'm4shlab-cdp-') {
  const binary = chromeCandidates.find(candidate => existsSync(candidate));
  if (!binary) return null;
  const profile = mkdtempSync(join(tmpdir(), profilePrefix));
  const process = spawn(binary, [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    'about:blank',
  ], {stdio: ['ignore', 'ignore', 'pipe']});
  const endpoint = await new Promise((resolveEndpoint, rejectEndpoint) => {
    let stderr = '';
    const timer = setTimeout(() => {
      process.kill('SIGTERM');
      rejectEndpoint(new Error(`Chrome did not expose CDP within 15 seconds: ${stderr}`));
    }, 15000);
    process.stderr.on('data', chunk => {
      stderr += chunk.toString();
      const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(stderr);
      if (!match) return;
      clearTimeout(timer);
      resolveEndpoint(match[1]);
    });
    process.once('exit', code => {
      clearTimeout(timer);
      rejectEndpoint(new Error(`Chrome exited before CDP was ready (${code}): ${stderr}`));
    });
  });
  return {process, profile, endpoint};
}

export async function pageTarget(endpoint) {
  const debugUrl = new URL(endpoint);
  const targets = await (await fetch(`http://${debugUrl.host}/json/list`)).json();
  const target = targets.find(item => item.type === 'page');
  if (!target) throw new Error('Chrome has no page target');
  const connection = new CdpClient(target.webSocketDebuggerUrl);
  await connection.open();
  return connection;
}
