import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createPermissionBroker } from '../permission.js';

describe('createPermissionBroker', () => {
  let broker: ReturnType<typeof createPermissionBroker>;

  beforeEach(() => {
    broker = createPermissionBroker();
  });

  it('createPending 返回 Promise，resolve 后返回 true', async () => {
    const promise = broker.createPending('acc1', 'Bash', '{"command":"ls"}');
    broker.resolvePermission('acc1', true);
    const result = await promise;
    assert.equal(result, true);
  });

  it('resolvePermission false 返回 false', async () => {
    const promise = broker.createPending('acc1', 'Write', '{}');
    broker.resolvePermission('acc1', false);
    const result = await promise;
    assert.equal(result, false);
  });

  it('rejectPending 拒绝并返回 false', async () => {
    const promise = broker.createPending('acc1', 'Bash', '{}');
    broker.rejectPending('acc1');
    const result = await promise;
    assert.equal(result, false);
  });

  it('getPending 在 resolve 后返回 undefined', async () => {
    broker.createPending('acc1', 'Read', '{}');
    assert.ok(broker.getPending('acc1') !== undefined);
    broker.resolvePermission('acc1', true);
    assert.equal(broker.getPending('acc1'), undefined);
  });

  it('重复 createPending 替换旧的（旧的自动 resolve false）', async () => {
    const first = broker.createPending('acc1', 'Bash', '{}');
    const second = broker.createPending('acc1', 'Write', '{}');
    broker.resolvePermission('acc1', true);

    const [r1, r2] = await Promise.all([first, second]);
    assert.equal(r1, false); // 旧的被替换，自动拒绝
    assert.equal(r2, true);
  });

  it('连续 3 次 approve 后返回提示 hint', () => {
    for (let i = 0; i < 2; i++) {
      broker.createPending('acc1', 'Bash', '{}');
      const hint = broker.resolvePermission('acc1', true);
      assert.equal(hint, null);
    }
    broker.createPending('acc1', 'Bash', '{}');
    const hint = broker.resolvePermission('acc1', true);
    assert.ok(hint !== null && hint.includes('3'));
  });

  it('isTimedOut 在超时前返回 false', () => {
    assert.equal(broker.isTimedOut('acc1'), false);
  });
});
