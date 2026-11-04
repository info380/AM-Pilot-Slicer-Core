// Group lines by the input stream's bounded chunks. Keep readline's CR, LF and
// CRLF semantics, including a CRLF split between chunks and an unterminated EOF.
// The caller provides a UTF-8 decoded stream, preserving multibyte boundaries.
export async function* readGcodeLineBatches(stream) {
  let carry = '', skipLf = false;
  for await (let chunk of stream) {
    if (typeof chunk !== 'string') throw new TypeError('G-code chunks must be decoded strings.');
    if (!chunk.length) continue;
    if (skipLf && chunk.startsWith('\n')) chunk = chunk.slice(1);
    skipLf = chunk.endsWith('\r');
    const lines = (carry + chunk).split(/\r\n|[\r\n]/);
    carry = lines.pop();
    if (lines.length) yield lines;
  }
  if (carry) yield [carry];
}
