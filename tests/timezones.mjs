import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { addAggregate } from '../lib/telemetry.js';
import '../public/analytics.js';

if (!process.argv.includes('--child')) {
  for (const timeZone of ['UTC', 'Asia/Singapore', 'Asia/Kathmandu', 'America/New_York']) {
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--child'], { env: {...process.env, TZ:timeZone}, encoding:'utf8', windowsHide:true });
    assert.equal(result.status, 0, `${timeZone}: ${result.stderr}`);
  }
  console.log('PASS: local midnight, fractional offsets, local CSV timestamps and daylight-saving days across four time zones');
} else {
  const A = globalThis.CPSAnalytics;
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const analytics = {days:{},hours:{}};
  const before = new Date(2026,9,14,23,59,59).getTime();
  const after = new Date(2026,9,15,0,1).getTime();
  const now = new Date(2026,9,15,12,30).getTime();
  for (const ts of [before,after]) addAggregate(analytics,{ts,model:'test',status:200},timeZone);
  assert.equal(A.dateKey(before),'2026-10-14');
  assert.equal(A.dateKey(after),'2026-10-15');
  assert.equal(analytics.days['2026-10-14'].requests,1);
  assert.equal(analytics.days['2026-10-15'].requests,1);
  assert.equal(A.sum(A.range(analytics,'today',now)).requests,1);
  assert.equal(A.sum(A.range(analytics,'1',now)).requests,2);
  assert.deepEqual(A.range(analytics,'7',now).map(bucket=>bucket.key),['2026-10-09','2026-10-10','2026-10-11','2026-10-12','2026-10-13','2026-10-14','2026-10-15']);
  assert.match(A.isoTimestamp(after),/^2026-10-15T00:01:00\.000[+-]\d{2}:\d{2}$/);
  assert.equal(Date.parse(A.isoTimestamp(after)),after);
  assert.equal(A.dateKey(A.addDays(A.startOfDay(after),-1)),'2026-10-14');
  if (timeZone === 'Asia/Katmandu' || timeZone === 'Asia/Kathmandu') assert.ok(A.isoTimestamp(after).endsWith('+05:45'));
  if (timeZone === 'America/New_York') {
    const fall = {days:{},hours:{}};
    for (const iso of ['2026-11-01T01:30:00-04:00','2026-11-01T01:30:00-05:00']) addAggregate(fall,{ts:Date.parse(iso),status:200},timeZone);
    const repeatedHours = A.range(fall,'today',new Date(2026,10,1,23,30).getTime());
    assert.equal(repeatedHours.length,25);
    assert.equal(new Set(repeatedHours.map(bucket=>bucket.key)).size,25);
    assert.equal(A.sum(repeatedHours).requests,2);
    const spring = A.range({days:{},hours:{}},'today',new Date(2026,2,8,23,30).getTime());
    assert.equal(spring.length,23);
    const week = A.range(fall,'7',new Date(2026,10,3,12).getTime());
    assert.equal(new Set(week.map(bucket=>bucket.key)).size,7);
    assert.equal(A.sum(week).requests,2);
  }
}
