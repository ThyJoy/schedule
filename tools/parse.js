// Разбор файла расписания из командной строки: node tools/parse.js <файл.doc|docx> [out.json]
// Нужны пакеты cfb, jszip, @xmldom/xmldom (NODE_PATH или локальный node_modules).
const fs = require('fs');
const path = require('path');
const P = require('../docs/parser.js');

(async () => {
  const [file, out] = process.argv.slice(2);
  const data = fs.readFileSync(file);
  const sched = await P.parseFile(data, path.basename(file), {
    CFB: require('cfb'),
    JSZip: require('jszip'),
    DOMParser: require('@xmldom/xmldom').DOMParser,
  });
  const json = JSON.stringify(sched, null, 1);
  if (out) fs.writeFileSync(out, json);
  else console.log(json);
})().catch((e) => { console.error(e); process.exit(1); });
