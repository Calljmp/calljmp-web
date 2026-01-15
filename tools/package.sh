#!/bin/sh

set -e

PACKAGE_JSON="package.json"
OUTPUT_JSON="package.out.json"
TEMP_JSON="package.temp.json"

cp "$PACKAGE_JSON" "$OUTPUT_JSON"

jq ".main = \"./index.cjs.js\"" "$OUTPUT_JSON" >"$TEMP_JSON" && mv "$TEMP_JSON" "$OUTPUT_JSON"
jq ".module = \"./index.esm.js\"" "$OUTPUT_JSON" >"$TEMP_JSON" && mv "$TEMP_JSON" "$OUTPUT_JSON"
jq ".types = \"./index.esm.d.ts\"" "$OUTPUT_JSON" >"$TEMP_JSON" && mv "$TEMP_JSON" "$OUTPUT_JSON"

jq '.exports = {
  ".": {
    "types": "./index.esm.d.ts",
    "import": "./index.esm.js",
    "require": "./index.cjs.js",
    "default": "./index.cjs.js"
  },
  "./react": {
    "types": "./react/index.esm.d.ts",
    "import": "./react/index.esm.js",
    "require": "./react/index.cjs.js",
    "default": "./react/index.cjs.js"
  },
  "./package.json": "./package.json"
}' "$OUTPUT_JSON" >"$TEMP_JSON" && mv "$TEMP_JSON" "$OUTPUT_JSON"

mv "$OUTPUT_JSON" "$PACKAGE_JSON"
