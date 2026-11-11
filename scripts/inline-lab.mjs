// Inline scripts/lab.mjs into app.html as window.KNLab, so the single-file app (GitHub Pages, the preview) runs the same engine the
// tests and the feed import. `node scripts/inline-lab.mjs` rewrites the block between the markers; the test suite checks it is current.
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const START = "<!-- lab-engine:start -->", END = "<!-- lab-engine:end -->";

export function inlineBlock() {
  const src = fs.readFileSync(path.join(root, "scripts/lab.mjs"), "utf8");
  const names = [...src.matchAll(/^export (?:async )?(?:function|const|let|class) ([A-Za-z_$][\w$]*)/gm)].map(m => m[1]);
  const body = src.replace(/^export (?=(?:async )?(?:function|const|let|class) )/gm, "");
  if (/^export /m.test(body) || /^import /m.test(body)) throw new Error("lab.mjs must only use `export function/const` and no imports to be inlinable");
  return `${START}\n<script id="labEngine">/* GENERATED from scripts/lab.mjs by scripts/inline-lab.mjs — edit the module, then run \`node scripts/inline-lab.mjs\` */\n(() => { "use strict";\n${body}\nwindow.KNLab = { ${names.join(", ")} };\n})();\n</script>\n${END}`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const file = path.join(root, "app.html"); let html = fs.readFileSync(file, "utf8"); const block = inlineBlock();
  const a = html.indexOf(START), b = html.indexOf(END);
  if (a >= 0 && b > a) html = html.slice(0, a) + block + html.slice(b + END.length);
  else { const at = html.indexOf("<script>\n(() => {\n\"use strict\";\nconst KN_VERSION"); if (at < 0) throw new Error("could not find the main script to insert before"); html = html.slice(0, at) + block + "\n" + html.slice(at); }
  fs.writeFileSync(file, html); console.log(`inlined ${block.length.toLocaleString()} chars (${(block.match(/\n/g) || []).length} lines) into app.html`);
}
