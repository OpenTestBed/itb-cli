#!/usr/bin/env node
// otb-gherkin — the language's own command line.
//
//   otb-gherkin dialects --installed --out assets
//   otb-gherkin compile my.feature --out build --zip suite.zip
//
// Two subcommands, both about the language and neither about a test bed:
// assemble the dialects you installed into the directory the compiler reads,
// and compile feature files into a GITB TDL suite. Everything here works with
// no network, no containers and no Interoperability Test Bed. Connecting one
// is a separate, optional step.
//
// The subcommands live beside this file rather than in dist/ because they are
// plain scripts, not part of the library surface. Importing the library from
// here would also be wrong: `otb-gherkin compile` must compile with the
// version of the parser it shipped with, which is the one next door.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const COMMANDS = {
  compile: 'cmd-compile.mjs',
  dialects: 'cmd-dialects.mjs',
};

const [cmd, ...rest] = process.argv.slice(2);

if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
  usage();
  process.exit(cmd ? 0 : 2);
}

if (cmd === '--version' || cmd === '-v') {
  const { readFileSync } = await import('node:fs');
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  console.log(pkg.version);
  process.exit(0);
}

const file = COMMANDS[cmd];
if (!file) {
  console.error(`Unknown command: ${cmd}`);
  usage();
  process.exit(2);
}

// argv is rewritten so each subcommand parses its own flags unchanged.
process.argv = [process.argv[0], fileURLToPath(new URL(file, import.meta.url)), ...rest];
await import(new URL(file, import.meta.url).href);

function usage() {
  console.log(`otb-gherkin — compile Gherkin feature files to a GITB TDL test suite

usage:
  otb-gherkin dialects [--installed] [--from <path|url>] [--out <dir>] [--list <a,b>]
      Assemble a components/ directory from the dialects you have. --installed
      reads node_modules for packages carrying an "otbDialect" field, so the
      set is pinned by your lockfile and needs no network.

  otb-gherkin compile <file-or-dir>... [--out <dir>] [--zip <name>] [--json]
      Compile feature files. Exits non-zero on any error and prints every
      diagnostic. --out writes the suite, --zip also packages it for upload.
      Needs ITB_ASSET_ROOT pointing at the directory holding components/.

  otb-gherkin --version

example:
  npm install @opentestbed/otb-gherkin @opentestbed/dialect-fhir-validator
  otb-gherkin dialects --installed --out assets
  ITB_ASSET_ROOT=./assets otb-gherkin compile my.feature --out build --zip suite.zip

A Test Bed is optional: authoring, compiling and packaging need only Node.`);
}
