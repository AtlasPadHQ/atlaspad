/**
 * MAINNET-CHECKLIST.md parser (INTEGRATION §10.5): every `- [ ]` / `- [x]` line is an item. go-mainnet refuses to
 * execute while any item is unticked.
 */
import { existsSync, readFileSync } from 'node:fs';
import { CHECKLIST } from './paths.mjs';

/** @returns {{ items: {checked:boolean, text:string, line:number, section:string}[], unchecked: object[] }} */
export function parseChecklist(text) {
  const items = [];
  let section = '';
  text.split(/\r?\n/).forEach((raw, i) => {
    const h = /^#{1,6}\s+(.*)$/.exec(raw);
    if (h) section = h[1].trim();
    const m = /^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/.exec(raw);
    if (m) items.push({ checked: m[1] !== ' ', text: m[2].trim(), line: i + 1, section });
  });
  return { items, unchecked: items.filter((x) => !x.checked) };
}

export function readChecklist(path = CHECKLIST) {
  if (!existsSync(path)) return null;
  return parseChecklist(readFileSync(path, 'utf8'));
}
