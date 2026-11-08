import { loadRuntime } from '../utils/loadRuntime';
import { WavAudio } from '../utils/WavAudio';

/** @typedef {import('./WhisperModels').WhisperModels} WhisperModels */
/** @typedef {import('./WhisperModels').WhisperModel} WhisperModel */
/** @typedef {{ text: string, lang: string, model: string }} Recognized the text, the language Whisper heard or was given, the model */

/**
 * Speech recognized by Whisper through sherpa-onnx (the native addon of this machine in
 * `dist/native`): a model of `WhisperModels` — the one chosen, else the first ready —, the language
 * given (a code it knows) or detected by Whisper. The recognizer of the last model and language is
 * kept loaded; loading and decoding are asynchronous — the extension host is not blocked.
 */
export class WhisperRecognizer {

    /**
     * @param {import('vscode').ExtensionContext} context
     * @param {WhisperModels} models
     */
    constructor(context, models) {
        this._extension = context.extensionUri.fsPath;
        this._models = models;
        /** @type {{ key: string, recognizer: Promise<any> } | null} */
        this._loaded = null;
    }

    /**
     * @returns {string} why Whisper cannot recognize in this build ('' : it can)
     */
    unavailable() {
        try {
            loadRuntime(this._extension, 'native/sherpa-onnx.node');
            return '';
        } catch (error) {
            return `Whisper cannot recognize in this build for ${process.platform}-${process.arch}: sherpa-onnx is missing (${error?.message || error}).`;
        }
    }

    /**
     * @returns {Promise<WhisperModel[]>} the models ready to recognize
     */
    async models() {
        return (await this._models.list()).filter(model => model.exists && model.ready);
    }

    /**
     * @param {string} [path] of the model chosen
     * @returns {Promise<WhisperModel | null>} that model when it is ready, else the first ready one
     */
    async model(path) {
        const models = await this.models();
        return models.find(model => model.path === path) ?? models[0] ?? null;
    }

    /**
     * @param {Buffer} wav the speech
     * @param {{ model?: string, language?: string }} [options] language: a code ('' or one the model
     *   does not know: Whisper detects it)
     * @returns {Promise<Recognized>}
     */
    async recognize(wav, { model: path, language = '' } = {}) {
        const addon = loadRuntime(this._extension, 'native/sherpa-onnx.node');
        const model = await this.model(path);
        if (!model) throw new Error('Whisper has no model ready: add one under Add driver → Whisper.');
        const audio = WavAudio.parse(wav);
        if (!audio) throw new Error('The recording is not audio Whisper can read.');
        const lang = model.multilingual && model.languages.includes(language) ? language : '';
        const recognizer = await this._recognizer(addon, model, lang);
        const stream = addon.createOfflineStream(recognizer);
        addon.acceptWaveformOffline(stream, { samples: audio.samples(), sampleRate: audio.sampleRate });
        const result = JSON.parse(await addon.decodeOfflineStreamAsync(recognizer, stream));
        return { text: String(result?.text ?? '').trim(), lang: String(result?.lang || lang || (model.multilingual ? '' : 'en')), model: model.name };
    }

    /**
     * @param {any} addon
     * @param {WhisperModel} model
     * @param {string} language
     * @returns {Promise<any>} the recognizer of a model and language (loaded once)
     */
    _recognizer(addon, model, language) {
        const key = `${model.path}\n${language}`;
        if (this._loaded?.key !== key) {
            const recognizer = addon.createOfflineRecognizerAsync({
                featConfig: { sampleRate: 16000, featureDim: model.mels },
                modelConfig: {
                    whisper: { encoder: model.files.encoder, decoder: model.files.decoder, language, task: 'transcribe', tailPaddings: -1 },
                    tokens: model.files.tokens,
                    numThreads: 2,
                    provider: 'cpu',
                    debug: 0,
                },
            });
            recognizer.catch(() => {
                if (this._loaded?.key === key) this._loaded = null;
            });
            this._loaded = { key, recognizer };
        }
        return this._loaded.recognizer;
    }
}
