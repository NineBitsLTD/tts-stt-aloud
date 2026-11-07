// Packs the VSIX for the platform of this machine (`npm run pack`): the native addon of sherpa-onnx
// in dist/native is built for it, so the package is platform-specific
// (tts-stt-md-aloud-<platform>-<arch>-<version>.vsix); vsce runs the build first (vscode:prepublish).
import { spawnSync } from 'node:child_process';

/** The targets of vsce by the platform and architecture of Node. */
const TARGETS = {
    'darwin-arm64': 'darwin-arm64',
    'darwin-x64': 'darwin-x64',
    'linux-arm64': 'linux-arm64',
    'linux-x64': 'linux-x64',
    'win32-arm64': 'win32-arm64',
    'win32-x64': 'win32-x64',
};
const machine = `${process.platform}-${process.arch}`;
const target = TARGETS[machine];
if (!target) {
    console.error(`No VSIX target for ${machine}: sherpa-onnx and vsce support ${Object.keys(TARGETS).join(', ')}`);
    process.exit(1);
}
console.log(`Packing for ${target}`);
const result = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['vsce', 'package', '--no-dependencies', '--target', target], { stdio: 'inherit', shell: process.platform === 'win32' });
process.exit(result.status ?? 1);
