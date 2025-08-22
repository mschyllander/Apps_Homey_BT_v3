
# Mats BT Custom

Schema-kompatibel Homey-app (SDK3) för BLE-lampor (på/av + RGB).

## Kör
```
npm i -g homey
homey login
homey app run
```

## Efter parning
Öppna enhetens **Inställningar** och ange:
- Service UUID (default: 0000ffb0-0000-1000-8000-00805f9b34fb)
- On/Off Characteristic UUID
- RGB Characteristic UUID
- Byteordning (RGB/GRB/BGR)
- On/Off-värden (hex)
