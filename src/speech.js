import { HostRequests } from './markdown/HostRequests';
import { ModelDialog } from './speech/ModelDialog';
import { ServerDialog } from './speech/ServerDialog';
import { SpeechSection } from './speech/SpeechSection';

/**
 * The webview of the speech side bar (`SpeechPanel` on the host): the TTS and STT sections. The host
 * sends the state of the settings (`state`), the voices of the TTS driver (`voices`), the levels of
 * the sound (`level`), what the microphone does (`micState`) and what went wrong (`status`); the
 * view sends the changes.
 */
const vscode = acquireVsCodeApi();
const host = new HostRequests(message => vscode.postMessage(message));
const dialog = new ServerDialog();
const modelDialog = new ModelDialog();
const sections = {
    tts: new SpeechSection({
        name: 'tts',
        title: 'TTS',
        hint: 'Text to speech',
        volume: { label: 'Volume', icon: 'unmute', max: 100, title: 'Volume of the speech, in % of the volume of the computer' },
        host,
        dialog,
        modelDialog,
    }),
    stt: new SpeechSection({
        name: 'stt',
        title: 'STT',
        hint: 'Speech to text',
        volume: { label: 'Mic', icon: 'mic', max: 200, title: 'Gain of the microphone, in % (100: as recorded)' },
        host,
        dialog,
        modelDialog,
    }),
};
document.querySelector('.speech').append(sections.tts.element, sections.stt.element);

window.addEventListener('message', (event) => {
    const message = event.data;
    if (host.handleMessage(message)) return;
    const section = sections[message?.section];
    switch (message?.type) {
        case 'state':
            for (const [name, item] of Object.entries(sections)) item.setState(message.settings[name], message.drivers[name], message.notes?.[name] ?? '', message.models?.[name] ?? {}, message.uiLanguage);
            break;
        case 'voices':
            sections.tts.setVoices(message);
            break;
        case 'level':
            section?.showLevel(message);
            break;
        case 'micState':
            sections.stt.setMicState(message);
            break;
        case 'status':
            section?.setStatus(message.message ?? '');
            break;
    }
});
vscode.postMessage({ type: 'ready' });
