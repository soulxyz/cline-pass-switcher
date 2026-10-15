import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { StreamObserver, normalizeUsage, addAggregate } from '../lib/telemetry.js';
import { priceEntry } from '../lib/costs.js';
import { parseModelsDev, createModelsDevStore } from '../lib/models-dev.js';

// A single compact smoke run: real proxy through a local mock; no paid requests.
assert.equal(normalizeUsage(null).totalTokens, null);
assert.equal(normalizeUsage({ input_tokens: 12, output_tokens: 8 }).totalTokens, 20);
const observer = new StreamObserver(1000);
const unicode = Buffer.from('data: {"choices":[{"delta":{"content":"你好"}}]}\r\n\r\n');
const split = unicode.indexOf(Buffer.from('你')) + 1;
observer.push(unicode.subarray(0, split), 1500);
observer.push(unicode.subarray(split), 2000);
observer.push(Buffer.from('data: {"choices":[{"delta":{"content":"!"}}]}\n\n'), 3000);
observer.push(Buffer.from('data: {"usage":{"prompt_tokens":12,"completion_tokens":8,"total_tokens":20}}\n\ndata: [DONE]'), 3100);
observer.end(3100);
assert.equal(observer.metrics(3100).tps, 8);
assert.equal(observer.metrics(3100).ttftMs, 1000);
assert.equal(observer.done, true);
const aggregate = { days: {}, hours: {} };
addAggregate(aggregate, { ts: Date.now(), ms: 100, ...observer.metrics(3100) });
assert.equal(Object.values(aggregate.days)[0].totalTokens, 20);
const rule = { 'cline-pass/test': { input: 1, output: 2, cacheRead: .1, cacheWrite: 1.25 } };
assert.equal(priceEntry({model:'cline-pass/test',inputTokens:100,outputTokens:20,cachedTokens:80,cacheWriteTokens:10},rule).costUsd,70.5 / 1e6);
assert.equal(priceEntry({model:'cline-pass/test',inputTokens:100,outputTokens:20},rule).costUsd,null);
assert.equal(priceEntry({model:'cline-pass/test',inputTokens:100,outputTokens:20,costUsd:0,costSource:'reported'},rule).costUsd,0);

let releaseLive, readyLive;
const liveReady = new Promise(resolve => { readyLive = resolve; });
const mock = http.createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw || '{}');
  if (body.model === 'cline-pass/error') {
    res.writeHead(429, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'mock rate limit' } })); return;
  }
  if (body.stream) {
    assert.equal(body.stream_options.include_usage, true);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (body.cut_stream) {
      res.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
      setTimeout(() => res.destroy(), 30);
      return;
    }
    if (body.live_probe) {
      res.write('data: {"provider":"Test Provider","model":"test/model","choices":[{"delta":{"content":"a"}}]}\n\n');
      await new Promise(resolve => setTimeout(resolve, 70));
      res.write('data: {"choices":[{"delta":{"content":"b"}}],"usage":{"prompt_tokens":12,"completion_tokens":4}}\n\n');
      await new Promise(resolve => { releaseLive = resolve; readyLive(); });
      res.end('data: {"usage":{"prompt_tokens":12,"completion_tokens":8,"total_tokens":20}}\n\ndata: [DONE]\n\n');
      return;
    }
    res.write('da');
    await new Promise(r => setTimeout(r, 10));
    res.write('ta: {"provider":"Test Provider","model":"test/model","choices":[{"delta":{"content":"你好"}}]}\n\n');
    await new Promise(r => setTimeout(r, 100));
    res.write('data: {"choices":[{"delta":{"content":"世界"}}]}\n\n');
    await new Promise(r => setTimeout(r, 20));
    res.end('data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":8,"total_tokens":20,"cost":0.04,"prompt_tokens_details":{"cached_tokens":6,"cache_write_tokens":2},"completion_tokens_details":{"reasoning_tokens":2}}}\n\ndata: [DONE]\n\n');
  } else {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ model: 'test/model', provider: 'Test Provider', choices: [{ message: { content: 'OK' } }], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } }));
  }
});
await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-ui-'));
const priceFixture = {
  'test-provider': {name:'测试渠道',models:{test:{canonical_model_id:'test/model',cost:{input:2,output:4,cache_read:.2,cache_write:2.5,tiers:[{input:3,output:5,cache_read:.3,cache_write:3.5,tier:{type:'context',size:100}}]}}}},
  'other-provider': {name:'其他渠道',models:{test:{canonical_model_id:'test/model',cost:{input:.1,output:.2}}}},
};
const priceStore=createModelsDevStore(path.join(temp,'models-dev-pricing.json'),{fetcher:async()=>priceFixture});
await priceStore.refresh(true);
const channelPrice=priceStore.lookup({model:'cline-pass/test',canonical:'test/model',provider:'test-provider'});
assert.equal(channelPrice.input,2);assert.equal(channelPrice.match,'upstream');
assert.equal(priceStore.lookup({model:'cline-pass/test',canonical:'test/model'}),null);
assert.equal(priceEntry({model:'cline-pass/test',inputTokens:101,outputTokens:20,cachedTokens:0,cacheWriteTokens:0},{},channelPrice).costPricing.input,3);
const cachedFile=path.join(temp,'models-dev-pricing.json');
const failedStore=createModelsDevStore(cachedFile,{fetcher:async()=>{throw new Error('mock offline')}});
await failedStore.refresh(true);assert.equal(failedStore.status().count,2);assert.ok(failedStore.status().error);
const reservation = http.createServer();
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
fs.writeFileSync(path.join(temp, 'config.json'), JSON.stringify({ port, extraPorts: [], accounts: [{ name: '本地测试账号', key: 'mock', enabled: true }], knownModels: ['cline-pass/test'], upstreamBase: `http://127.0.0.1:${mock.address().port}`, perModel: {}, pricing: {'cline-pass/test':{input:1,output:2}} }));
fs.writeFileSync(path.join(temp, 'metadata.json'), JSON.stringify({ models: {}, history: [], catalog: ['test/model'], catalogFetchedAt: Date.now() }));
const service = spawn(process.execPath, ['server.js'], { cwd: process.cwd(), env: { ...process.env, DATA_DIR: temp, PORT: String(port), CLINE_PASS_KEY: '', PROXY_KEY: '', PUBLIC_BASE_URL: '', EXTRA_PORTS: '', BIND_HOST: '127.0.0.1' }, stdio: 'pipe', windowsHide: true });
try {
  await Promise.race([once(service.stdout, 'data'), new Promise((_, reject) => setTimeout(() => reject(Error('startup timeout')), 5000).unref())]);
  const base = `http://127.0.0.1:${port}`;
  const call = (body) => fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'cline-pass/test', messages: [{ role: 'user', content: 'Hi' }], ...body }) });
  const streamed = await call({ stream: true });
  assert.ok((await streamed.text()).includes('[DONE]'));
  assert.equal((await call({ stream: false })).status, 200);
  assert.equal((await call({ model: 'cline-pass/error', stream: false })).status, 429);
  const telemetry = await (await fetch(`${base}/api/telemetry`)).json();
  assert.equal(telemetry.active.length, 0);
  assert.equal(telemetry.recent.length, 3);
  const streamedRecord = telemetry.recent.find(r => r.stream);
  assert.equal(streamedRecord.inputTokens, 12);
  assert.equal(streamedRecord.outputTokens, 8);
  assert.equal(streamedRecord.reasoningTokens, 2);
  assert.equal(streamedRecord.provider, 'test-provider');
  assert.ok(streamedRecord.tps > 0);
  assert.equal(streamedRecord.trace.length, 1);
  const day = Object.values(telemetry.analytics.days)[0];
  assert.equal(day.requests, 3); assert.equal(day.errors, 1); assert.equal(day.totalTokens, 40);
  assert.equal(day.costRequests,2); assert.ok(Math.abs(day.costUsd - .040028) < 1e-10);
  const localized = await (await fetch(base + '/api/telemetry?timeZone=Asia%2FKathmandu')).json();
  assert.equal(Object.values(localized.analytics.days).reduce((sum,day)=>sum+day.requests,0),3);
  assert.equal(localized.analytics.legacyRequests,0);
  const localCached = await (await fetch(base + '/api/telemetry?timeZone=Asia%2FKathmandu&version=' + encodeURIComponent(localized.version))).json();
  assert.equal('analytics' in localCached,false);
  assert.equal((await fetch(base + '/api/telemetry?timeZone=invalid-zone')).status,400);

  const liveResponse = await call({ stream: true, live_probe: true });
  const liveText = liveResponse.text();
  await liveReady;
  const live = await (await fetch(base + '/api/live')).json();
  assert.equal(live.active.length, 1);
  assert.ok(live.active[0].liveTps > 0);
  assert.ok(live.latestMeasured.tps > 0);
  assert.equal('analytics' in live, false);
  releaseLive();
  assert.ok((await liveText).includes('[DONE]'));
  const interrupted = await call({stream:true,cut_stream:true});
  await assert.rejects(interrupted.text());
  const afterInterrupt = await (await fetch(base + '/api/telemetry')).json();
  assert.equal(afterInterrupt.active.length,0);
  assert.equal(afterInterrupt.recent[0].status,502);
  assert.equal((await call({stream:false})).status,200);
  const updatedLocal = await (await fetch(base + '/api/telemetry?timeZone=Asia%2FKathmandu')).json();
  assert.equal(Object.values(updatedLocal.analytics.days).reduce((sum,day)=>sum+day.requests,0),6);
  const persisted = JSON.parse(fs.readFileSync(path.join(temp,'metadata.json'),'utf8'));
  assert.ok(persisted.analyticsByTimeZone[updatedLocal.analytics.timeZone]);
  assert.equal(normalizeUsage({input_tokens:10,cache_read_input_tokens:80,cache_creation_input_tokens:10,output_tokens:20}).inputTokens,100);
  assert.equal(normalizeUsage({prompt_tokens:100,prompt_tokens_details:{cached_tokens:80},completion_tokens:20}).inputTokens,100);
  assert.equal(normalizeUsage({cost:0,cost_currency:'EUR'}).costUsd,null);
  const unchanged = await (await fetch(base + '/api/telemetry?version=' + encodeURIComponent((await (await fetch(base + '/api/telemetry')).json()).version))).json();
  assert.equal('analytics' in unchanged,false);
  const saved = await fetch(base + '/api/pricing', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pricing:{'cline-pass/test':{input:2,output:3}}})});
  assert.equal(saved.status,200);
  assert.equal((await (await fetch(base + '/api/pricing')).json()).pricing['cline-pass/test'].input,2);
  const badPrice = await fetch(base + '/api/pricing', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pricing:{'cline-pass/test':{input:-1,output:3}}})});
  assert.equal(badPrice.status,400);
  console.log('PASS: usage normalization, split SSE/UTF-8, stream recording, HTTP errors, live rates, aggregates, pricing save/validation and catalog cache');
} finally {
  releaseLive?.();
  const stopped = once(service,'exit');
  service.kill();
  await stopped;
  mock.closeAllConnections();
  await new Promise(resolve => mock.close(resolve));
  fs.rmSync(temp,{recursive:true,force:true});
}
