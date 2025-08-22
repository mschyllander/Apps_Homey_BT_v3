'use strict';

const { Driver } = require('homey');

const SERVICE_UUID = '0000ffb0-0000-1000-8000-00805f9b34fb';

// Dina två enheter (både med och utan kolon, blandade case tillåtna)
const WHITELIST = new Set([
  '3410183003f7', '34:10:18:30:03:f7',
  '341018300187', '34:10:18:30:01:87',
]);

const normAddr = s => (s || '').toLowerCase().replace(/[^0-9a-f]/g, '');

class BtLightDriver extends Driver {
  onInit() {
    this.log('BtLight driver init');
  }

  async onPair(session) {
    session.setHandler('list_devices', async () => {
      // Skanna BLE (prova med servicefilter, annars utan)
      let peripherals = [];
      try {
        peripherals = await this.homey.ble.discover([SERVICE_UUID]);
      } catch {
        peripherals = await this.homey.ble.discover();
      }

      // Deduplicera per address/uuid
      const map = new Map();
      for (const p of peripherals || []) {
        const addr = normAddr(p.address || p.uuid || p.id);
        if (!addr) continue;
        if (!map.has(addr)) map.set(addr, p);
      }

      // Filtrera: whitelist OCH/ELLER tjänst + namn
      const devices = [];
      for (const [addr, p] of map) {
        const name = p.localName || p.name || 'BLE Device';
        const whitelisted = WHITELIST.has(addr) || WHITELIST.has((p.address || '').toLowerCase());
        if (!whitelisted) continue;

        // Snyggare visningsnamn: sista två bytes
        const tail = addr.slice(-4).toUpperCase();
        const niceName = name.toLowerCase().includes('uac') ? `uac088 (${tail})` : `${name} (${tail})`;

        devices.push({
          name: niceName,
          data: { id: addr },          // stabil unik ID
          store: { address: addr },    // kan användas i device.js
          settings: {
            serviceUuid: SERVICE_UUID,
            onOffChar: '',
            rgbChar: '',
            rgbOrder: 'RGB',
            onValue: '01',
            offValue: '00'
          }
        });
      }

      return devices;
    });
  }
}

module.exports = BtLightDriver;
