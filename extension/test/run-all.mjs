// Entry point for `node --test extension/test/` (Node 22 does not expand a directory
// argument; package.json "main" points here). Each file can also run on its own.
import './stream-core.test.mjs';
import './manifest.test.mjs';
