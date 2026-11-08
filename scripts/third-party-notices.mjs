// Writes THIRD-PARTY-NOTICES.md: what the VSIX holds of others, with the texts of their licenses.
// Run by hand when the dependencies change: npm run notices
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const modules = name => `node_modules/${name}`;

/** Bundled into `dist/` by esbuild, or copied there by the build. */
const COMPONENTS = [
    {
        name: 'piper-phonemize', package: 'piper-phonemize', license: 'GPL-3.0-or-later', url: 'https://github.com/csukuangfj/piper-phonemize', texts: [],
        note: 'WebAssembly build of the phonemizer of Piper, with espeak-ng. Its license text is `COPYING`. Source code: the repository above (also https://github.com/rhasspy/piper-phonemize).',
    },
    {
        name: 'espeak-ng and espeak-ng-data', license: 'GPL-3.0-or-later', url: 'https://github.com/espeak-ng/espeak-ng', texts: [],
        note: 'Compiled into piper-phonemize; its data files are in `dist/piper-phonemize/espeak-ng-data`. Its license text is `COPYING`. Source code: the repository above.',
    },
    { name: 'sherpa-onnx', package: 'sherpa-onnx-node', license: 'Apache-2.0', url: 'https://github.com/k2-fsa/sherpa-onnx', texts: ['resources/licenses/sherpa-onnx-LICENSE.txt'] },
    { name: 'ONNX Runtime', license: 'MIT', url: 'https://github.com/microsoft/onnxruntime', texts: ['resources/licenses/onnxruntime-LICENSE.txt'], note: 'Shipped with sherpa-onnx.' },
    { name: 'marked', package: 'marked', license: 'MIT', url: 'https://github.com/markedjs/marked', texts: [`${modules('marked')}/LICENSE.md`] },
    { name: 'parse5', package: 'parse5', license: 'MIT', url: 'https://github.com/inikulin/parse5', texts: [`${modules('parse5')}/LICENSE`] },
    { name: 'entities', package: 'entities', license: 'BSD-2-Clause', url: 'https://github.com/fb55/entities', texts: [`${modules('entities')}/LICENSE`] },
    { name: 'Codicons', package: '@vscode/codicons', license: 'CC-BY-4.0 (icons), MIT (code)', url: 'https://github.com/microsoft/vscode-codicons', texts: [`${modules('@vscode/codicons')}/LICENSE`, `${modules('@vscode/codicons')}/LICENSE-CODE`] },
    { name: 'CMUdict', license: 'BSD-style', url: 'https://github.com/cmusphinx/cmudict', texts: ['resources/cmudict/LICENSE'], note: 'English pronunciations, `resources/cmudict/`.' },
];

/**
 * @param {string} name of a package in node_modules
 * @returns {string} its version
 */
function versionOf(name) {
    return JSON.parse(readFileSync(join(root, modules(name), 'package.json'), 'utf8')).version;
}

/**
 * @param {typeof COMPONENTS[number]} component
 * @returns {string} its section of the notices
 */
function sectionOf(component) {
    const version = component.package ? ` ${versionOf(component.package)}` : '';
    const lines = [`## ${component.name}${version}`, '', `License: ${component.license}. ${component.url}`];
    if (component.note) lines.push('', component.note);
    for (const text of component.texts) lines.push('', '```text', readFileSync(join(root, text), 'utf8').trim(), '```');
    return lines.join('\n');
}

const notices = `# Third-party notices

The package of TTS / STT Aloud (the VSIX) holds the components below. Because it holds piper-phonemize and espeak-ng, the package as a whole is distributed under the GNU General Public License, version 3 or later (\`COPYING\`). The source code of the extension itself is under the MIT license (\`LICENSE\`): https://github.com/NineBitsLTD/tts-stt-aloud

The voice models of Piper and the models of Whisper are not part of the package: they are downloaded or chosen by the user, each under its own license.

${COMPONENTS.map(sectionOf).join('\n\n')}
`;
writeFileSync(join(root, 'THIRD-PARTY-NOTICES.md'), notices);
console.log(`THIRD-PARTY-NOTICES.md: ${COMPONENTS.length} components`);
