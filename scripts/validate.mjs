// Validate an array of benchmark records against the result schema.
// usage: NODE_MODULES_DIR=.cache/node_modules node scripts/validate.mjs schema.json records.json
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const modDir = process.env.NODE_MODULES_DIR;
const require = createRequire(modDir ? `${process.cwd()}/${modDir}/` : import.meta.url);
const Ajv2020 = require("ajv/dist/2020");
const addFormats = require("ajv-formats");

const [schemaPath, dataPath] = process.argv.slice(2);
const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
let records = JSON.parse(readFileSync(dataPath, "utf8"));
if (!Array.isArray(records)) records = [records];

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(schema);

let bad = 0;
for (const rec of records) {
  if (!validate(rec)) {
    for (const e of validate.errors) {
      bad++;
      console.error(`${rec.id ?? "?"}: ${e.instancePath || "<root>"}: ${e.message}`);
    }
  }
}
console.log(`validated ${records.length} records, ${bad} errors`);
process.exit(bad ? 1 : 0);
