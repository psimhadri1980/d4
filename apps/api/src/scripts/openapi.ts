/**
 * Writes the OpenAPI document (the SDK is generated from it).
 * Usage: node dist/scripts/openapi.js [output-file]   (stdout without a file)
 */
import { writeFileSync } from 'node:fs';
import { buildOpenApiDocument } from '../http/openapi';

const text = `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`;
const out = process.argv[2];
if (out) writeFileSync(out, text);
else process.stdout.write(text);
