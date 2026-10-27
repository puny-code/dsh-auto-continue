/**
 * 启动门禁: 宿主重启后不要在主窗口就绪前抢跑续跑。
 *
 * 回归目标 —— 用户反馈宿主重启后马上发"继续", 此时工具还没加载完, 工具调用会丢:
 * 门禁关闭期间攒下的续跑必须被挂起(而不是丢弃), 主窗口连上状态桥之后再等
 * 一段落定时间, 才按原来的原因重新调度。
 */
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { makeHost, turnEnd } from './host-fixture.mjs';

mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
const flush = async (ms = 0) => {
  mock.timers.tick(ms);
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};
const userMessage = () => ({
  type: 'user/message', seq: 99, time: Date.now(),
  data: { source: { kind: 'user' }, content: [{ type: 'text', text: '我自己来' }] },
});
const hosts = [];
const host = (options) => { const h = makeHost(options); hosts.push(h); return h; };

try {
  // 主窗口连接之前的续跑被挂起; 连接后再等落定时间才发。
  const gated = host({ graceMs: 10, bootWaitForClient: true, bootReadyDelayMs: 5000 });
  const held = gated.agent('held', [turnEnd(1, 'interrupted')]);
  gated.start();
  await flush();
  await flush(4000);
  assert.equal(held.followups.length, 0, '主窗口未就绪时不发续跑');
  assert.equal(held.reads, 1, '挂起期间不再重复读取历史');
  gated.stats(); // 状态桥首个订阅者 = 主窗口已就绪
  await flush(4000);
  assert.equal(held.followups.length, 0, '主窗口就绪后仍要等落定时间');
  await flush(1000);
  await flush(10);
  assert.equal(held.followups.length, 1, '落定时间到点后按原原因放行, 且只发一次');
  await flush(60000);
  assert.equal(held.followups.length, 1, '放行后的续跑不会被启动扫描重复安排');

  // 用户抢在门禁开放前自己发消息: 挂起的续跑要撤销, 门禁开放后不得补发。
  const intercepted = host({ graceMs: 10, bootWaitForClient: true, bootReadyDelayMs: 3000 });
  const takenOver = intercepted.agent('taken-over', [turnEnd(1, 'interrupted')]);
  intercepted.start();
  await flush();
  assert.equal(takenOver.followups.length, 0);
  intercepted.emit(takenOver, userMessage());
  intercepted.stats();
  await flush(3000);
  await flush(100);
  assert.equal(takenOver.followups.length, 0, '用户介入取消挂起的续跑');

  // 不等主窗口时退化为纯启动延迟(仍然不是立即发送)。
  const delayed = host({ graceMs: 10, bootWaitForClient: false, bootReadyDelayMs: 8000 });
  const later = delayed.agent('later', [turnEnd(1, 'interrupted')]);
  delayed.start();
  await flush();
  await flush(7000);
  assert.equal(later.followups.length, 0, '纯启动延迟同样会压住续跑');
  await flush(1000);
  await flush(50);
  assert.equal(later.followups.length, 1, '启动延迟结束后放行');

  // 门禁关掉(0ms)保持既有行为: 启动扫描立刻安排续跑。
  const open = host();
  const immediate = open.agent('immediate', [turnEnd(1, 'interrupted')]);
  open.start();
  await flush();
  await flush(10);
  assert.equal(immediate.followups.length, 1, '门禁关闭时行为与之前一致');

  // 重启后补物化(从未被客户端打开)的会话也走同一道门禁。
  const swept = host({ graceMs: 10, bootWaitForClient: true, bootReadyDelayMs: 1000 });
  const coldEvents = [turnEnd(1, 'interrupted')];
  swept.provide('sessionQuery', {
    listSessions: async () => [{ header: { id: 'cold' }, live: false, persisted: true }],
    observeSession: async () => ({
      events: [...coldEvents], header: { id: 'cold' }, projections: { values: {} },
      [Symbol.dispose]: () => {},
    }),
  });
  swept.onResume('cold', coldEvents);
  swept.start();
  // 存储扫描是异步的: tick 期间既推进定时器也要排空读链。
  for (let i = 0; i < 400; i += 1) { await flush(0); }
  assert.equal(swept.resumes().length, 1, '冷会话在本轮扫描中被补物化');
  const cold = swept.agents.get('cold');
  assert.equal(cold.followups.length, 0, '补物化出来的会话同样被门禁压住');
  swept.stats();
  await flush(1000);
  await flush(50);
  assert.equal(cold.followups.length, 1, '门禁开放后冷会话才续跑');

  console.log('Boot gate holds startup continuations until the main window is ready ✅');
} finally {
  for (const h of hosts) h.dispose();
  mock.timers.reset();
}
