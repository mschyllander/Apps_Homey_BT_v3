'use strict';
const Homey = require('homey');

module.exports = class BLELightDevice extends Homey.Device {
  async onInit() {
    this.log('Init device', this.getName());
    await this._ensureConnected();

    this.registerCapabilityListener('onoff', async value => {
      const onHex  = (this.getSetting('onValue')  || '01').replace(/\s+/g, '');
      const offHex = (this.getSetting('offValue') || '00').replace(/\s+/g, '');
      const buf = Buffer.from(value ? onHex : offHex, 'hex');
      await this._writeToChar(this.getSetting('onOffChar'), buf);
    });

    this.registerMultipleCapabilityListener(['light_mode','light_hue','light_saturation','dim'], async values => {
      const mode = values.light_mode ?? this.getCapabilityValue('light_mode') ?? 'color';
      if (mode !== 'color') return;
      const hue = values.light_hue ?? this.getCapabilityValue('light_hue') ?? 0;
      const sat = values.light_saturation ?? this.getCapabilityValue('light_saturation') ?? 0;
      const bri = values.dim ?? this.getCapabilityValue('dim') ?? 1;
      const { r, g, b } = hsvToRgb(hue, sat, bri);
      let arr = [r, g, b];
      const order = (this.getSetting('rgbOrder') || 'RGB').toUpperCase();
      if (order === 'GRB') arr = [arr[1], arr[0], arr[2]];
      if (order === 'BGR') arr = [arr[2], arr[1], arr[0]];
      await this._writeToChar(this.getSetting('rgbChar'), Buffer.from(arr));
    }, 100);
  }

  async onDeleted() {
    try { if (this._peripheral && this._peripheral.isConnected) await this._peripheral.disconnect(); } catch(e) { this.error(e); }
  }

  async _ensureConnected() {
    const advUuid = this.getStoreValue('advUuid');
    const serviceUuid = this.getSetting('serviceUuid') || '0000ffb0-0000-1000-8000-00805f9b34fb';
    if (!advUuid) throw new Error('Missing advUuid from pairing.');
    const adv = await this.homey.ble.find(advUuid);
    this._peripheral = await adv.connect();
    this._service = await this._peripheral.getService(serviceUuid);
  }

  async _getCharacteristic(uuid) {
    if (!uuid) throw new Error('Characteristic UUID not set in settings.');
    if (!this._peripheral || !this._peripheral.isConnected) await this._ensureConnected();
    return await this._service.getCharacteristic(uuid);
  }

  async _writeToChar(charUuid, buffer) {
    const ch = await this._getCharacteristic(charUuid);
    try { await ch.write(buffer); }
    catch { await ch.writeWithoutResponse(buffer); }
  }
};

function hsvToRgb(h, s, v) {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  let r, g, b;
  switch (i % 6) {
    case 0: r=v; g=t; b=p; break;
    case 1: r=q; g=v; b=p; break;
    case 2: r=p; g=v; b=t; break;
    case 3: r=p; g=q; b=v; break;
    case 4: r=t; g=p; b=v; break;
    case 5: r=v; g=p; b=q; break;
  }
  return { r: Math.round(r*255), g: Math.round(g*255), b: Math.round(b*255) };
}
