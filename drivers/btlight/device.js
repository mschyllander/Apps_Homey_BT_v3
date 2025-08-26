'use strict';

const Homey = require('homey');

class BtLightDevice extends Homey.Device {
    async onInit() {
        const data = this.getData() || {};
        this._address = data.address || data.id || data.mac || null;

        // === Settings ===
        // Låt service_uuid/char_uuid vara tomma för autodetektering som option.
        this._svcSetting = (this.getSetting('service_uuid') || '').trim(); // ex 'ffb0' | 'ffe0' | '' (auto)
        this._chrSetting = (this.getSetting('char_uuid') || '').trim(); // ex 'ffb1' | 'ffe1' | '' (auto)
        this._rssiMin = Number(this.getSetting('rssi_min') ?? -85);     // för logg/info
        this._connectMinRssi = Number(this.getSetting('connect_min_rssi') ?? -85); // hoppa connect när svagare än så
        const pollS = Number(this.getSetting('metrics_interval_s') ?? 60);

        // === Cached light state ===
        this._h = clamp01(Number(this.getCapabilityValue('light_hue') || 0));
        this._s = clamp01(Number(this.getCapabilityValue('light_saturation') || 0));
        this._v = clamp01(Number(this.getCapabilityValue('dim') || 1));
        this._mode = this.getCapabilityValue('light_mode') || 'color'; // 'color' | 'temperature'
        this._ct = clamp01(Number(this.getCapabilityValue('light_temperature') || 0.5));

        // === BLE placeholders ===
        this._peripheral = null;
        this._writeChar = null;

        // === Capability listeners ===
        this.registerCapabilityListener('onoff', v => this._onOnOff(v));
        this.registerCapabilityListener('dim', v => this._onDim(v));
        this.registerCapabilityListener('light_hue', v => this._onHue(v));
        this.registerCapabilityListener('light_saturation', v => this._onSat(v));
        this.registerCapabilityListener('light_temperature', v => this._onTemp(v));
        this.registerCapabilityListener('light_mode', v => this._onMode(v));

        // Init link state
        this._setLinkState({ connected: false, rssi: null });

        // Connect loop
        this._connectLoopActive = true;
        this._connectLoop();

        // Metrics poll (anpassningsbar)
        this._metricsTimer = setInterval(() => {
            this._updateRssiSafe().catch(err => this.error('RSSI poll error:', err?.message));
        }, Math.max(15, pollS) * 1000);

        this.log('BtLight device init:', this.getName(), `[${last4(this._address)}]`);
    }

    async onSettings({ changedKeys, newSettings }) {
        // Om användaren ändrar intervall/tröskel i UI, uppdatera direkt
        if (changedKeys.includes('metrics_interval_s')) {
            const pollS = Number(newSettings.metrics_interval_s || 60);
            if (this._metricsTimer) clearInterval(this._metricsTimer);
            this._metricsTimer = setInterval(() => {
                this._updateRssiSafe().catch(() => { });
            }, Math.max(15, pollS) * 1000);
        }
        if (changedKeys.includes('connect_min_rssi')) {
            this._connectMinRssi = Number(newSettings.connect_min_rssi || -85);
        }
        if (changedKeys.includes('service_uuid')) {
            this._svcSetting = (newSettings.service_uuid || '').trim();
        }
        if (changedKeys.includes('char_uuid')) {
            this._chrSetting = (newSettings.char_uuid || '').trim();
        }
    }

    async onUninit() {
        this._connectLoopActive = false;
        if (this._metricsTimer) clearInterval(this._metricsTimer);
        await this._disconnectSafe();
    }

    // =========================================
    // Capability handlers
    // =========================================
    async _onOnOff(value) {
        if (value) {
            await this._ensureConnected();
            await this._sendOn().catch(() => { });
            await this._applyCurrentColor().catch(this.error);
        } else {
            await this._ensureConnected().catch(() => { });
            await this._sendOff().catch(() => { });
        }
    }
    async _onDim(value) { this._v = clamp01(Number(value)); await this._ensureConnected(); if (this.getCapabilityValue('onoff')) await this._applyCurrentColor(); }
    async _onHue(value) { this._h = clamp01(Number(value)); await this.setCapabilityValue('light_mode', 'color').catch(() => { }); await this._ensureConnected(); if (this.getCapabilityValue('onoff')) await this._applyCurrentColor(); }
    async _onSat(value) { this._s = clamp01(Number(value)); await this.setCapabilityValue('light_mode', 'color').catch(() => { }); await this._ensureConnected(); if (this.getCapabilityValue('onoff')) await this._applyCurrentColor(); }
    async _onTemp(value) { this._ct = clamp01(Number(value)); await this.setCapabilityValue('light_mode', 'temperature').catch(() => { }); await this._ensureConnected(); if (this.getCapabilityValue('onoff')) await this._applyCurrentColor(); }
    async _onMode(value) { this._mode = value === 'temperature' ? 'temperature' : 'color'; await this._ensureConnected(); if (this.getCapabilityValue('onoff')) await this._applyCurrentColor(); }

    // =========================================
    // Connect loop
    // =========================================
    async _connectLoop() {
        while (this._connectLoopActive) {
            try {
                if (!this._peripheral || !this._peripheral.isConnected) {
                    await this._connectOnce();
                }
            } catch (err) {
                this.error('Connect loop error:', err?.message);
            }
            await delay(12000); // snällare backoff
        }
    }

    async _ensureConnected() {
        if (this._writeChar && this._peripheral?.isConnected) return;
        await this._connectOnce();
    }

    async _connectOnce() {
        // 0) Kolla annonserad RSSI – hoppa anslutning om för svag länk
        try {
            const advs = await this.homey.ble.getAdvertisements();
            const a = findAdvForAddress(advs, this._address);
            if (a) {
                if (Array.isArray(a.serviceUuids)) {
                    this.log('Adv.serviceUuids:', a.serviceUuids.join(', ') || '(none)');
                }
                if (typeof a.rssi === 'number') {
                    const advRssi = a.rssi;
                    const minForConnect = this._connectMinRssi ?? -85;
                    if (advRssi < minForConnect) {
                        this.log(`Skip connect: adv RSSI ${advRssi} < minForConnect ${minForConnect}`);
                        this._setLinkState({ connected: false, rssi: advRssi });
                        throw new Error('Link too weak to connect right now :-(');
                    }
                }
            }
        } catch (_) { }

        // 1) Hitta peripheral
        let p = null;
        if (this._address) p = await this.homey.ble.find(normAddr(this._address)).catch(() => null);
        if (!p) {
            const advs = await this.homey.ble.getAdvertisements();
            if (this._svcSetting) {
                const svcNeedle = normUuid(this._svcSetting);
                const match = advs.find(a => (a.serviceUuids || []).map(u => normUuid(u)).some(u => equalsOrEndsWith(u, svcNeedle)));
                if (match) p = await match.getPeripheral();
            } else {
                const match = advs.find(a => normAddr(a?.address) === normAddr(this._address));
                if (match) p = await match.getPeripheral();
            }
        }
        if (!p) throw new Error('Peripheral not found');

        await p.connect();
        await delay(1000); // ge stacken tid att exponera GATT
        this._peripheral = p;

        p.once('disconnect', () => {
            this._writeChar = null;
            this._setLinkState({ connected: false, rssi: null });
            this.log('Peripheral disconnected');
        });

        // 2) Service discovery (robust + retrys + explicit discover)
        const idVariants = [];
        if (this._svcSetting) {
            const short = normUuid(this._svcSetting);
            const full = toFullUuid(short);
            idVariants.push(full, short);
        }
        const service = await this._resolveServiceWithRetries(p, idVariants, 8, 400);
        if (!service) throw new Error('Service not found (tried: ' + (this._svcSetting || 'autodetect') + ', plus fallbacks)');

        // 3) Characteristic discovery (robust + retrys)
        const chrVariants = [];
        if (this._chrSetting) {
            const cshort = normUuid(this._chrSetting);
            const cfull = toFullUuid(cshort);
            chrVariants.push(cfull, cshort);
        }
        const charObj = await this._resolveCharacteristicWithRetries(service, chrVariants, 8, 400);
        if (!charObj) throw new Error('Characteristic not found (tried: ' + (this._chrSetting || 'autodetect') + ', plus writable fallback)');

        this._writeChar = charObj;

        // 4) Link + RSSI
        await this._updateRssiSafe();
        this._setLinkState({ connected: true, rssi: await this._readRssiSafe() });

        this.log('Connected to', last4(this._address) || '(by service autodetect)');
    }

    // ---- service resolver with retries + explicit discovery + fallbacks
    async _resolveServiceWithRetries(p, idVariants, retries = 8, delayMs = 400) {
        for (let attempt = 0; attempt < retries; attempt++) {
            // (a) explicit discovery först
            try {
                if (typeof p.discoverServices === 'function') {
                    const only = (idVariants || []).map(id => toFullUuid(id)).filter(Boolean);
                    await p.discoverServices(only.length ? only : []);
                } else if (typeof p.discoverAllServicesAndCharacteristics === 'function') {
                    await p.discoverAllServicesAndCharacteristics();
                }
            } catch (_) { }

            // (b) direkta getService-försök
            if (typeof p.getService === 'function' && idVariants?.length) {
                for (const id of idVariants) {
                    try {
                        const svc = await p.getService(id);
                        if (svc) return svc;
                    } catch (_) { }
                }
            }

            // (c) lista services
            let services = [];
            if (typeof p.getServices === 'function') {
                try { services = await p.getServices(); } catch (_) { }
            }

            // debug
            try {
                this.log('Services (full UUIDs):', services.map(s => (s?.uuid || s?.id || '')).join(', '));
            } catch (_) { }

            // (d) matcha mot varianter
            if (idVariants?.length) {
                const svc = findServiceByVariants(services, idVariants);
                if (svc) return svc;
            }

            // (e) fallback: kända ljus-services
            const fallbackIds = ['ffe0', 'ffb0'];
            let svc = findServiceByVariants(services, fallbackIds);
            if (svc) { this.log('Falling back to service', svc.uuid || svc.id); return svc; }

            // (f) sista utväg: första service med skrivbar char
            svc = await firstServiceWithWritableChar(services);
            if (svc) { this.log('Picked first service with writable characteristic:', svc.uuid || svc.id); return svc; }

            // (g) paus + reconnect halvvägs
            await delay(delayMs * (1 + attempt));
            if (attempt === Math.floor(retries / 2)) {
                try { await this._peripheral.disconnect(); } catch (_) { }
                await delay(300);
                await this._peripheral.connect();
                await delay(700);
            }
        }
        return null;
    }

    // ---- char resolver with retries + writable fallback
    async _resolveCharacteristicWithRetries(service, idVariants, retries = 8, delayMs = 400) {
        for (let attempt = 0; attempt < retries; attempt++) {
            let chars = [];
            if (typeof service.getCharacteristics === 'function') {
                try { chars = await service.getCharacteristics(); } catch (_) { }
            }

            // debug
            try {
                this.log('Characteristics (full UUIDs):', chars.map(c => (c?.uuid || c?.id || '')).join(', '));
                this.log('Characteristics props:',
                    chars.map(c => {
                        const u = c?.uuid || c?.id || '';
                        const p = c.properties || c.props || {};
                        return `${u} [${['read', 'write', 'writeWithoutResponse', 'notify', 'indicate'].filter(k => p[k]).join(',')}]`;
                    }).join(' | ')
                );
            } catch (_) { }

            if (idVariants?.length) {
                const cobj = findCharByVariants(chars, idVariants);
                if (cobj) return cobj;
            }

            const writable = firstWritableChar(chars);
            if (writable) { this.log('Falling back to writable characteristic', writable.uuid || writable.id); return writable; }

            await delay(delayMs * (1 + attempt));
        }
        return null;
    }

    async _disconnectSafe() {
        try { if (this._peripheral?.isConnected) await this._peripheral.disconnect(); }
        catch (_) { }
        finally { this._peripheral = null; this._writeChar = null; }
    }

    async _readRssiSafe() {
        try {
            if (this._peripheral && typeof this._peripheral.rssi === 'number') return this._peripheral.rssi;
        } catch (_) { }
        return null;
    }

    async _updateRssiSafe() {
        const rssi = await this._readRssiSafe();
        const connected = !!(this._peripheral && this._peripheral.isConnected);
        this._setLinkState({ connected, rssi });
    }

    _setLinkState({ connected, rssi }) {
        this.setCapabilityValue('alarm_connection', !connected).catch(() => { });

        if (typeof rssi === 'number') {
            const val = Math.max(-120, Math.min(0, Math.round(rssi)));
            this.setCapabilityValue('measure_rssi', val).catch(() => { });
            const quality = (val >= -70) ? 'good' : (val >= -85) ? 'ok' : 'bad';
            this.setCapabilityValue('signal_quality', quality).catch(() => { });
            if (this._rssiMin && val < this._rssiMin) {
                this.log(`RSSI ${val} dBm < threshold ${this._rssiMin} dBm`);
            }
        } else {
            const quality = connected ? 'ok' : 'bad';
            this.setCapabilityValue('signal_quality', quality).catch(() => { });
        }
    }

    // ===== write commands
    async _sendOn() { if (!this._writeChar) throw new Error('Not connected'); try { await this._writeChar.write(Buffer.from([0xCC, 0x23, 0x33])); } catch (_) { } }
    async _sendOff() { if (!this._writeChar) throw new Error('Not connected'); try { await this._writeChar.write(Buffer.from([0xCC, 0x24, 0x33])); } catch (_) { } }
    async _sendColorRGB(r, g, b) {
        if (!this._writeChar) throw new Error('Not connected');
        const buf = Buffer.from([0x56, r & 0xFF, g & 0xFF, b & 0xFF, 0x00, 0xF0, 0xAA]);
        await this._writeChar.write(buf);
    }
    async _applyCurrentColor() {
        if (this._mode === 'temperature') {
            const kelvin = 2000 + Math.round(4500 * this._ct);
            const { r, g, b } = cctToRgb(kelvin);
            const { r: rr, g: gg, b: bb } = scaleByV({ r, g, b }, this._v);
            await this._sendColorRGB(rr, gg, bb);
        } else {
            const { r, g, b } = hsvToRgb(this._h, this._s, 1.0);
            const { r: rr, g: gg, b: bb } = scaleByV({ r, g, b }, this._v);
            await this._sendColorRGB(rr, gg, bb);
        }
    }
}

// ===== helpers
const delay = ms => new Promise(r => setTimeout(r, ms));
const clamp01 = v => Math.max(0, Math.min(1, isFinite(v) ? v : 0));
const normUuid = u => (u || '').toString().trim().toLowerCase().replace(/-/g, '');
const toFullUuid = u => {
    const s = normUuid(u);
    if (!s) return '';
    return (s.length === 4) ? `0000${s}-0000-1000-8000-00805f9b34fb` : s;
};
const normAddr = a => (a || '').toString().toLowerCase().replace(/[^0-9a-f]/g, '');
const equalsOrEndsWith = (hay, needle) => {
    if (!hay || !needle) return false;
    const H = normUuid(hay), N = normUuid(needle);
    if (!H || !N) return false;
    return (N.length === 4) ? H.endsWith(N) : H === N;
};
const last4 = addr => { const n = normAddr(addr); return n ? n.slice(-4).toUpperCase() : ''; };

function findServiceByVariants(services, variants) {
    const normOf = x => normUuid(x || '');
    for (const s of services) {
        const u = normOf(s?.uuid || s?.id);
        if (variants.some(id => equalsOrEndsWith(u, normUuid(id)))) return s;
    }
    return null;
}
function findCharByVariants(chars, variants) {
    const normOf = x => normUuid(x || '');
    for (const c of chars) {
        const u = normOf(c?.uuid || c?.id);
        if (variants.some(id => equalsOrEndsWith(u, normUuid(id)))) return c;
    }
    return null;
}
function firstWritableChar(chars) {
    return chars.find(c => {
        const p = c.properties || c.props || {};
        return p.write || p.writeWithoutResponse;
    });
}
async function firstServiceWithWritableChar(services) {
    for (const s of services) {
        if (typeof s.getCharacteristics === 'function') {
            try {
                const list = await s.getCharacteristics();
                if (firstWritableChar(list)) return s;
            } catch (_) { }
        }
    }
    return null;
}
function findAdvForAddress(advs, addr) {
    if (!addr) return null;
    const want = normAddr(addr);
    return advs.find(a => normAddr(a?.address) === want) || null;
}
function scaleByV({ r, g, b }, v) {
    const rr = Math.max(0, Math.min(255, Math.round(r * v)));
    const gg = Math.max(0, Math.min(255, Math.round(g * v)));
    const bb = Math.max(0, Math.min(255, Math.round(b * v)));
    return { r: rr, g: gg, b: bb };
}
function hsvToRgb(h, s, v) {
    let r = 0, g = 0, b = 0; const i = Math.floor(h * 6), f = h * 6 - i;
    const p = Math.round(255 * v * (1 - s)), q = Math.round(255 * v * (1 - f * s)), t = Math.round(255 * v * (1 - (1 - f) * s)), vv = Math.round(255 * v);
    switch (i % 6) { case 0: r = vv; g = t; b = p; break; case 1: r = q; g = vv; b = p; break; case 2: r = p; g = vv; b = t; break; case 3: r = p; g = q; b = vv; break; case 4: r = t; g = p; b = vv; break; case 5: r = vv; g = p; b = q; break; }
    return { r, g, b };
}
function cctToRgb(k) {
    let t = k / 100, r, g, b;
    if (t <= 66) r = 255; else { r = t - 60; r = 329.698727446 * Math.pow(r, -0.1332047592); r = Math.max(0, Math.min(255, r)); }
    if (t <= 66) g = 99.4708025861 * Math.log(t) - 161.1195681661; else { g = t - 60; g = 288.1221695283 * Math.pow(g, -0.0755148492); }
    g = Math.max(0, Math.min(255, g));
    if (t >= 66) b = 255; else if (t <= 19) b = 0; else { b = 138.5177312231 * Math.log(t - 10) - 305.0447927307; b = Math.max(0, Math.min(255, b)); }
    return { r: Math.round(r), g: Math.round(g), b: Math.round(b) };
}

module.exports = BtLightDevice;
