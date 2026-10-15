import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const blocked = http.createServer();
const reservation = http.createServer();
await listen(blocked);
await listen(reservation);
const primaryPort = blocked.address().port;
const extraPort = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-listeners-'));
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({port: primaryPort, extraPorts: []}));
// Seed a fresh local cache to keep this check offline.
fs.writeFileSync(path.join(dataDir, 'models-dev-pricing.json'), JSON.stringify({version:1,fetchedAt:Date.now(),entries:[{key:'test',model:'test',provider:'test',price:{input:1,output:1}}]}));
const start = extraPorts => spawn(process.execPath, ['server.js'], {
  env: {...process.env, DATA_DIR:dataDir, PORT:String(primaryPort), EXTRA_PORTS:extraPorts, BIND_HOST:'127.0.0.1', CLINE_PASS_KEY:'', PROXY_KEY:'', PUBLIC_BASE_URL:''},
  stdio:'pipe', windowsHide:true,
});
let service;
try {
  service = start(`${extraPort},${extraPort}`);
  await Promise.race([once(service.stdout,'data'), new Promise((_,reject) => setTimeout(() => reject(Error('startup timeout')),5000).unref())]);
  const meta = await (await fetch(`http://127.0.0.1:${extraPort}/api/meta`)).json();
  assert.equal(meta.proxyBase, `http://127.0.0.1:${extraPort}/v1`);
  assert.equal(meta.configured,false);
  const stopped = once(service,'exit');
  service.kill();
  await stopped;
  service = start('');
  const [code] = await Promise.race([once(service,'exit'), new Promise((_,reject) => setTimeout(() => reject(Error('exit timeout')),5000).unref())]);
  assert.equal(code,1);
  console.log('PASS: occupied primary port, duplicate fallback ports, usable endpoint and failure exit status');
} finally {
  if (service?.exitCode === null) service.kill();
  blocked.closeAllConnections();
  await new Promise(resolve => blocked.close(resolve));
  fs.rmSync(dataDir,{recursive:true,force:true});
}
