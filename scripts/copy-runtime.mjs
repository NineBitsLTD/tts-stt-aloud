// Copies the runtime of Piper into dist/ (the extension loads it from there; node_modules is not
// packed): the native addon of sherpa-onnx built for this machine with its libraries (dist/native)
// and piper-phonemize — espeak-ng in WASM with its data (dist/piper-phonemize).
// Run by `npm run build` (copy:runtime) from the root of the project.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const platform = process.platform === 'win32' ? 'win' : process.platform;
const sherpa = join('node_modules', `sherpa-onnx-${platform}-${process.arch}`);
const native = join('dist', 'native');
rmSync(native, { recursive: true, force: true });
if (existsSync(sherpa)) {
    mkdirSync(native, { recursive: true });
    const files = readdirSync(sherpa).filter(name => !/^(package\.json|README\.md|index\.js)$/.test(name));
    for (const name of files) cpSync(join(sherpa, name), join(native, name), { recursive: true, dereference: true });
    console.log(`sherpa-onnx for ${process.platform}-${process.arch}: ${files.join(', ')} -> ${native}`);
} else {
    console.warn(`sherpa-onnx has no addon for ${process.platform}-${process.arch} (${sherpa} is not installed): Piper does not speak in this build`);
}

const phonemize = join('node_modules', 'piper-phonemize');
const target = join('dist', 'piper-phonemize');
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
for (const name of ['index.js', 'piper-phonemize.node.js', 'piper-phonemize-wasm-nodejs.js', 'piper-phonemize-wasm-nodejs.wasm', 'espeak-ng-data']) {
    cpSync(join(phonemize, name), join(target, name), { recursive: true, dereference: true });
}
// Its files are CommonJS; the package.json of the project says "module"
writeFileSync(join(target, 'package.json'), `${JSON.stringify({ type: 'commonjs' })}\n`);
console.log(`piper-phonemize -> ${target}`);
