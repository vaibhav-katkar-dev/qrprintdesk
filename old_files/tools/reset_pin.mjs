import { hashPin, setSetting, createAdminSession, verifyPin, getSetting } from '../src/db.js';
import crypto from 'crypto';

let targetPin = (process.argv[2] || '1234').toString().replace(/["'\r\n]/g, '').trim();
if (!targetPin || targetPin.length < 4) {
  targetPin = '1234';
}

const hashed = hashPin(targetPin);
setSetting('admin_pin_hash', hashed);

const sessionToken = crypto.randomBytes(32).toString('hex');
createAdminSession(sessionToken);

const stored = getSetting('admin_pin_hash');
const ok = verifyPin(targetPin, stored);

console.log('========================================================');
console.log(` [+] SUCCESS! Master Admin PIN is now set to: [ ${targetPin} ]`);
console.log(` [+] Verified in database: ${ok ? 'YES (Valid)' : 'NO (Failed)'}`);
console.log(' [+] You can now unlock the console with PIN: ' + targetPin);
console.log('========================================================');
