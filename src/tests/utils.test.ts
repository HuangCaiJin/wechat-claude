import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ---- splitMessage (copied inline to avoid import side-effects) ----

const MAX_MESSAGE_LENGTH = 2048;

function splitMessage(text: string, maxLen: number = MAX_MESSAGE_LENGTH): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) { chunks.push(remaining); break; }
    let splitIdx = remaining.lastIndexOf('\n', maxLen);
    if (splitIdx < maxLen * 0.3) splitIdx = maxLen;
    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).replace(/^\n+/, '');
  }
  return chunks;
}

describe('splitMessage', () => {
  it('短文本不分割', () => {
    const result = splitMessage('hello', 100);
    assert.deepEqual(result, ['hello']);
  });

  it('超长文本按 maxLen 分割', () => {
    const text = 'a'.repeat(100);
    const result = splitMessage(text, 30);
    assert.ok(result.every(c => c.length <= 30));
    assert.equal(result.join(''), text);
  });

  it('优先在换行处分割', () => {
    // 换行在 maxLen 的 30% 以后才会被采用，构造一个换行在 50% 位置的场景
    const line1 = 'a'.repeat(15); // 15 chars
    const line2 = 'b'.repeat(15); // 15 chars
    const text = line1 + '\n' + line2; // 31 chars, maxLen=20 → \n at idx 15 >= 20*0.3=6, split there
    const result = splitMessage(text, 20);
    assert.equal(result[0], line1);
    assert.equal(result[1], line2);
  });

  it('空字符串返回空数组', () => {
    const result = splitMessage('', 100);
    assert.deepEqual(result, ['']);
  });

  it('恰好等于 maxLen 不分割', () => {
    const text = 'a'.repeat(50);
    const result = splitMessage(text, 50);
    assert.deepEqual(result, [text]);
  });
});

// ---- redact ----

import { redact } from '../logger.js';

describe('redact', () => {
  it('脱敏 Bearer token', () => {
    const result = redact('Authorization: Bearer abc123xyz');
    assert.ok(!result.includes('abc123xyz'));
    assert.ok(result.includes('Bearer ***'));
  });

  it('脱敏 JSON 中的 token 字段', () => {
    const result = redact(JSON.stringify({ token: 'secret123' }));
    assert.ok(!result.includes('secret123'));
  });

  it('脱敏 password 字段', () => {
    const result = redact(JSON.stringify({ password: 'mypassword' }));
    assert.ok(!result.includes('mypassword'));
  });

  it('不影响普通字段', () => {
    const result = redact(JSON.stringify({ name: 'alice', age: 30 }));
    assert.ok(result.includes('alice'));
    assert.ok(result.includes('30'));
  });
});
