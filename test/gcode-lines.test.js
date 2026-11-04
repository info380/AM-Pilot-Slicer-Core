import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createInterface } from 'node:readline';
import { readGcodeLineBatches } from '../src/gcode-lines.js';
const chunks = async function* (values) { yield* values; };
const collect = async stream => { const lines = []; for await (const batch of readGcodeLineBatches(stream)) lines.push(...batch); return lines; };

test('batches preserve readline line and EOF semantics across every stream boundary', async () => {
  for (const source of ['', '\n', '\r', '\r\n', 'G90', 'G90\n', 'G90\r\n\rG1 X1\n; café\r\nlast', '\r\n\n\r\r\n']) {
    const expected = [];
    for await (const line of createInterface({ input: Readable.from([source]), crlfDelay: Infinity })) expected.push(line);
    for (let cut = 0; cut <= source.length; cut++) {
      assert.deepEqual(await collect(chunks([source.slice(0, cut), '', source.slice(cut)])), expected, `split ${cut} in ${JSON.stringify(source)}`);
    }
    assert.deepEqual(await collect(chunks([...source])), expected);
  }
});

test('batches retain backpressure and close the stream when parsing stops', async () => {
  let reads = 0, closed = false;
  const input = async function* () { try { reads++; yield 'G90\n'; reads++; yield 'G1 X1\n'; } finally { closed = true; } };
  const iterator = readGcodeLineBatches(input());
  assert.deepEqual((await iterator.next()).value, ['G90']); assert.equal(reads, 1);
  await iterator.return(); assert.equal(reads, 1); assert.equal(closed, true);
});

test('stream errors propagate and undecoded chunks fail closed', async () => {
  const error = new Error('input interrupted');
  const input = async function* () { yield 'G90\n'; throw error; };
  await assert.rejects(collect(input()), error);
  await assert.rejects(collect(chunks([Buffer.from('G90\n')])), /decoded strings/);
});
