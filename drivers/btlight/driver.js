'use strict';

const Homey = require('homey');

function normUuid(u) {
    return (u || '').toLowerCase();
}

module.exports = class BtLightDriver extends Homey.Driver {

    onInit() {
        this.log('[BtLight] driver init');
    }

    /**
     * Pairing list: discover BLE advertisements and show those that look like our lamp
     * (service FFB0 or name containing uac088).
     */
    async onPairListDevices() {
        // Correct SDK v3 API:
        const advertisements = await this.homey.ble.discover();

        const items = advertisements
            .filter(adv => {
                const name = (adv.localName || '').toLowerCase();
                const svcs = (adv.serviceUuids || []).map(normUuid);
                return (
                    name.includes('uac088') ||
                    svcs.includes('ffb0') ||
                    svcs.includes('0000ffb0-0000-1000-8000-00805f9b34fb')
                );
            })
            .map(adv => {
                const uuid = adv.uuid; // SDK v3 property
                const rssi = adv.rssi;
                const name = adv.localName || 'BT Light';
                const shortId = (uuid || '').replace(/[:-]/g, '').slice(-6).toUpperCase();
                return {
                    name: `${name} [${shortId}] RSSI ${typeof rssi === 'number' ? rssi : '?'} dBm`,
                    data: { id: uuid },
                    store: { peripheralUuid: uuid, lastRssi: rssi ?? null }
                };
            });

        this.log('[BtLight] presenting', items.length, 'device(s)');
        return items;
    }
};
