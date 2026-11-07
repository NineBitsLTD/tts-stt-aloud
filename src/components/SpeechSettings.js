import * as vscode from 'vscode';

/** The section of the settings of VS Code (`ttsSttMdAloud.tts.*`, `ttsSttMdAloud.stt.*`). */
const CONFIG = 'ttsSttMdAloud';
/** The driver id of an external server: `external:<name>`. */
const EXTERNAL = 'external:';

/**
 * The drivers that come with the extension; System is always offered.
 * @type {Record<SpeechSection, { id: string, name: string }[]>}
 */
export const PRESET_DRIVERS = {
    tts: [{ id: 'system', name: 'System' }, { id: 'piper', name: 'Piper' }, { id: 'silero', name: 'Silero' }],
    stt: [{ id: 'system', name: 'System' }, { id: 'whisper', name: 'Whisper' }],
};

/** Keys a webview may set with `update`, with their ranges. */
const RANGES = {
    volume: { tts: [0, 100], stt: [0, 200] },
    rate: { tts: [0.5, 2] },
};

/**
 * @typedef {'tts' | 'stt'} SpeechSection
 * @typedef {{ name: string, url: string }} SpeechServer
 * @typedef {{ id: string, name: string, kind: 'system' | 'preset' | 'external', url?: string, enabled: boolean }} SpeechDriver
 * @typedef {object} SectionSettings
 * @property {boolean} enabled
 * @property {number} volume % of the volume of the computer (TTS), gain in % (STT)
 * @property {string} driver the driver in use (`system` when the chosen one is not offered)
 * @property {string[]} drivers drivers offered besides System
 * @property {SpeechServer[]} servers external servers
 * @typedef {SectionSettings & { rate: number, voice: string, voices: Record<string, string[]> }} TtsSettings
 * @typedef {{ tts: TtsSettings, stt: SectionSettings }} AllSpeechSettings
 */

/**
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 * @returns {number}
 */
function clamp(value, min, max, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

/**
 * The speech settings of VS Code for every extension: kept in the user settings
 * (`ttsSttMdAloud.*`, read by any extension), the keys of external servers in the secret storage
 * of VS Code. Values are checked as they are read: a hand-edited setting out of range or a
 * driver no longer offered does not break the speech.
 */
export class SpeechSettings {

    /**
     * @param {vscode.ExtensionContext} context
     */
    constructor(context) {
        this._secrets = context.secrets;
        /** @type {vscode.EventEmitter<AllSpeechSettings>} */
        this._changed = new vscode.EventEmitter();
        /** Fires with the settings after they changed (in the panel, the settings editor or settings.json). */
        this.onDidChange = this._changed.event;
        this._subscription = vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration(CONFIG)) this._changed.fire(this.get());
        });
    }

    dispose() {
        this._subscription.dispose();
        this._changed.dispose();
    }

    /**
     * @returns {AllSpeechSettings}
     */
    get() {
        const config = vscode.workspace.getConfiguration(CONFIG);
        const voices = config.get('tts.voices');
        return {
            tts: {
                ...this._section('tts', config),
                rate: clamp(config.get('tts.rate'), 0.5, 2, 1),
                voice: String(config.get('tts.voice') ?? ''),
                voices: voices && typeof voices === 'object' && !Array.isArray(voices)
                    ? Object.fromEntries(Object.entries(voices).filter(([, names]) => Array.isArray(names)).map(([id, names]) => [id, names.map(String)]))
                    : {},
            },
            stt: this._section('stt', config),
        };
    }

    /**
     * @param {SpeechSection} section
     * @returns {SpeechDriver[]} System, the preset drivers and the external servers; enabled: offered
     */
    drivers(section) {
        const { drivers, servers } = this.get()[section];
        return [
            ...PRESET_DRIVERS[section].map(({ id, name }) => ({ id, name, kind: /** @type {const} */ (id === 'system' ? 'system' : 'preset'), enabled: id === 'system' || drivers.includes(id) })),
            ...servers.map(({ name, url }) => ({ id: EXTERNAL + name, name, kind: /** @type {const} */ ('external'), url, enabled: drivers.includes(EXTERNAL + name) })),
        ];
    }

    /**
     * @param {SpeechSection} section
     * @param {string} id
     * @returns {string} the name of a driver to show
     */
    driverName(section, id) {
        return this.drivers(section).find(driver => driver.id === id)?.name ?? id;
    }

    /**
     * Sets a value a webview may set: enabled, volume, rate (TTS), driver, voice (TTS).
     * @param {SpeechSection} section
     * @param {string} key
     * @param {unknown} value
     */
    async update(section, key, value) {
        const range = RANGES[key]?.[section];
        if (key === 'enabled') value = !!value;
        else if (range && Number.isFinite(Number(value))) value = clamp(value, range[0], range[1], range[0]);
        else if (key === 'driver') value = this.drivers(section).some(driver => driver.enabled && driver.id === value) ? value : 'system';
        else if (key === 'voice' && section === 'tts') value = String(value ?? '');
        else return;
        await this._set(`${section}.${key}`, value);
    }

    /**
     * Offers a driver besides System, or no longer (the one in use falls back to System).
     * @param {SpeechSection} section
     * @param {string} id
     * @param {boolean} enabled
     */
    async setDriverEnabled(section, id, enabled) {
        const known = this.drivers(section).some(driver => driver.kind !== 'system' && driver.id === id);
        const { drivers, driver } = this.get()[section];
        if (!known) return;
        await this._set(`${section}.drivers`, enabled ? [...new Set([...drivers, id])] : drivers.filter(item => item !== id));
        if (!enabled && driver === id) await this._set(`${section}.driver`, 'system');
    }

    /**
     * Adds an external server under its name, offered at once; its key goes to the secret storage.
     * @param {SpeechSection} section
     * @param {{ name?: string, url?: string, key?: string }} server
     * @returns {Promise<string>} why it is not added ('' : added)
     */
    async addServer(section, { name = '', url = '', key = '' }) {
        const title = String(name).trim();
        const address = String(url).trim();
        if (!title) return 'Enter the name of the server.';
        if (this.drivers(section).some(driver => driver.name.toLowerCase() === title.toLowerCase())) return `There is a driver named ${title} already.`;
        let parsed;
        try {
            parsed = new URL(address);
        } catch {
            parsed = null;
        }
        if (!parsed || !/^https?:$/.test(parsed.protocol)) return 'Enter the address of the server as http(s)://host[:port][/path].';
        const { servers, drivers } = this.get()[section];
        if (String(key).trim()) await this._secrets.store(SpeechSettings._secretKey(section, title), String(key).trim());
        await this._set(`${section}.servers`, [...servers, { name: title, url: address }]);
        await this._set(`${section}.drivers`, [...new Set([...drivers, EXTERNAL + title])]);
        return '';
    }

    /**
     * Removes an external server with its key and its checked voices.
     * @param {SpeechSection} section
     * @param {string} id `external:<name>`
     */
    async removeServer(section, id) {
        const settings = this.get()[section];
        const name = id.slice(EXTERNAL.length);
        if (!id.startsWith(EXTERNAL) || !settings.servers.some(server => server.name === name)) return;
        await this._set(`${section}.servers`, settings.servers.filter(server => server.name !== name));
        await this._set(`${section}.drivers`, settings.drivers.filter(item => item !== id));
        if (settings.driver === id) await this._set(`${section}.driver`, 'system');
        const voices = this.get().tts.voices;
        if (section === 'tts' && id in voices) await this._set('tts.voices', SpeechSettings._without(voices, id));
        await this._secrets.delete(SpeechSettings._secretKey(section, name));
    }

    /**
     * @param {SpeechSection} section
     * @param {string} name of the server
     * @returns {Promise<string>} its key ('' : none)
     */
    async serverKey(section, name) {
        return (await this._secrets.get(SpeechSettings._secretKey(section, name))) ?? '';
    }

    /**
     * Checks a voice of a driver (picked automatically, offered to other extensions) or unchecks it.
     * @param {string} driver
     * @param {string} name
     * @param {boolean} checked
     */
    async setVoiceChecked(driver, name, checked) {
        const voices = this.get().tts.voices;
        const names = voices[driver] ?? [];
        const next = checked ? [...new Set([...names, name])] : names.filter(item => item !== name);
        const others = SpeechSettings._without(voices, driver);
        await this._set('tts.voices', next.length ? { ...others, [driver]: next } : others);
    }

    /**
     * @param {string} key under `ttsSttMdAloud.`
     * @returns {boolean} whether the user settings have no value of their own for it
     */
    isDefault(key) {
        return vscode.workspace.getConfiguration(CONFIG).inspect(key)?.globalValue === undefined;
    }

    /**
     * @param {SpeechSection} section
     * @param {vscode.WorkspaceConfiguration} config
     * @returns {SectionSettings}
     */
    _section(section, config) {
        const range = RANGES.volume[section];
        const servers = (config.get(`${section}.servers`) ?? [])
            .filter(server => server && typeof server.name === 'string' && server.name.trim() && typeof server.url === 'string')
            .map(server => ({ name: server.name.trim(), url: server.url }));
        const known = new Set([...PRESET_DRIVERS[section].map(driver => driver.id), ...servers.map(server => EXTERNAL + server.name)]);
        const drivers = (config.get(`${section}.drivers`) ?? []).filter(id => id !== 'system' && known.has(id));
        const driver = String(config.get(`${section}.driver`) ?? 'system');
        return {
            enabled: config.get(`${section}.enabled`) === true,
            volume: clamp(config.get(`${section}.volume`), range[0], range[1], 100),
            driver: drivers.includes(driver) ? driver : 'system',
            drivers,
            servers,
        };
    }

    /**
     * @param {string} key under `ttsSttMdAloud.`
     * @param {unknown} value
     */
    async _set(key, value) {
        await vscode.workspace.getConfiguration(CONFIG).update(key, value, vscode.ConfigurationTarget.Global);
    }

    /**
     * @param {Record<string, string[]>} voices
     * @param {string} driver
     * @returns {Record<string, string[]>} the checked voices without those of a driver
     */
    static _without(voices, driver) {
        return Object.fromEntries(Object.entries(voices).filter(([id]) => id !== driver));
    }

    /**
     * @param {SpeechSection} section
     * @param {string} name
     * @returns {string}
     */
    static _secretKey(section, name) {
        return `${CONFIG}.server.${section}.${name}`;
    }
}
