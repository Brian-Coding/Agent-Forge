// One-shot repair for UTF-8-read-as-CP1252 mojibake in index.html.
// Reverse transform: char -> its CP1252 byte, then strict-UTF-8-decode the bytes.
// Aborts loudly on any char that has no CP1252 byte or if the result is not valid UTF-8.
const path = 'src/client/index.html';
const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);

const dec1252 = new TextDecoder('windows-1252');
const inv = new Map<string, number>();
for (let b = 0; b < 256; b++) {
  const ch = dec1252.decode(new Uint8Array([b]));
  if (!inv.has(ch)) inv.set(ch, b);
}

const out: number[] = [];
const unmapped = new Map<string, number>();
for (const ch of text) {
  const cp = ch.codePointAt(0)!;
  if (cp < 0x80) { out.push(cp); continue; }
  const b = inv.get(ch);
  if (b === undefined) { unmapped.set(ch, (unmapped.get(ch) ?? 0) + 1); continue; }
  out.push(b);
}
if (unmapped.size) {
  for (const [ch, n] of unmapped) console.error(`UNMAPPED U+${ch.codePointAt(0)!.toString(16).toUpperCase()} x${n}`);
  process.exit(1);
}

let repaired: string;
try {
  repaired = new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(out));
} catch (e) {
  console.error('repaired bytes are not valid UTF-8 — file has mixed clean/corrupt text, aborting:', e);
  process.exit(1);
}

await Bun.write(path, repaired);
console.log(`repaired: ${text.length} chars -> ${repaired.length} chars`);
