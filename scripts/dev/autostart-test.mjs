#!/usr/bin/env node
/**
 * Starting at logon without a prompt and without a window.
 *
 * Two defects made "start with Windows" require a person: the app manifest
 * demanded elevation on every launch (a UAC prompt at every boot), and autostart
 * was configured twice, so the second copy nudged the first into showing itself.
 *
 *   node scripts/dev/autostart-test.mjs
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const A = require(path.join(ROOT, 'desktop', 'lib', 'autostart.js'));

let passed = 0, failed = 0; const fails = [];
const check = (name, cond, extra = '') => {
  if (cond) { passed++; console.log(`  ✔ ${name}`); }
  else { failed++; fails.push(name); console.log(`  ✘ ${name} ${extra}`); }
};

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'nimbus-boot-'));
const EXE = 'C:\\Users\\conta\\AppData\\Local\\Programs\\Nimbus Drive\\Nimbus Drive.exe';

console.log('\n— the app never asks for administrator rights');
{
  const pkg = JSON.parse(await fsp.readFile(path.join(ROOT, 'desktop', 'package.json'), 'utf8'));
  const win = pkg.build?.win || {};
  const nsis = pkg.build?.nsis || {};
  check('the manifest runs as the invoking user', win.requestedExecutionLevel === 'asInvoker', String(win.requestedExecutionLevel));
  check('...so no UAC prompt can appear at logon', win.requestedExecutionLevel !== 'highestAvailable' && win.requestedExecutionLevel !== 'requireAdministrator');
  check('the installer does not elevate either', nsis.allowElevation === false, String(nsis.allowElevation));
  check('...and installs per-user, which keeps updates prompt-free', nsis.perMachine === false, String(nsis.perMachine));
}

console.log('\n— the startup script Windows will actually run');
{
  const vbs = A.buildStartupScript(EXE);
  check('it is a VBScript that runs the app', /WshShell\.Run/.test(vbs));
  check('window style 0 — no console flash', /, 0, False/.test(vbs), vbs);
  check('it passes the hidden/autostart flags', /--hidden --autostart/.test(vbs));
  check('the path is quoted, so spaces survive', vbs.includes('"""' + EXE + '""'), JSON.stringify(vbs));
  // VBScript has no backslash escapes: doubling them (as the old builder did)
  // wrote C:\\Users\\… into the script, which only worked by accident
  check('backslashes are NOT doubled', !vbs.includes('C:\\\\Users'), JSON.stringify(vbs));
  check('lines are CRLF, as Windows Script Host expects', vbs.includes('\r\n') && !/[^\r]\n/.test(vbs));
  check('it explains itself to anyone who opens it', /Nimbus Drive/.test(vbs) && /^'/m.test(vbs));

  // decode the literal the way VBScript would, and confirm the command line
  const line = vbs.split('\r\n').find((l) => l.startsWith('WshShell.Run'));
  const literal = line.slice(line.indexOf('"'), line.lastIndexOf('", 0, False') + 1);
  const decoded = literal.slice(1, -1).replace(/""/g, '"');
  check('the resulting command line is exactly right', decoded === `"${EXE}" --hidden --autostart`, decoded);
}

console.log('\n— creating and removing the entry');
{
  const appData = path.join(tmp, 'AppData');
  const target = A.startupScriptPath(appData);
  const on = A.applyWindowsStartup({ appData, exePath: EXE, enable: true, fs });
  check('enabling writes the script', on.ok && on.action === 'created' && fs.existsSync(target), JSON.stringify(on));
  check('...into the real Windows Startup folder', target.includes(path.join('Start Menu', 'Programs', 'Startup')), target);
  check('...creating the folder if Windows has not yet', fs.existsSync(path.dirname(target)));

  const again = A.applyWindowsStartup({ appData, exePath: EXE, enable: true, fs });
  check('enabling twice is harmless', again.ok && fs.readFileSync(target, 'utf8') === A.buildStartupScript(EXE));

  const off = A.applyWindowsStartup({ appData, exePath: EXE, enable: false, fs });
  check('disabling removes it', off.ok && off.action === 'removed' && !fs.existsSync(target));
  const offAgain = A.applyWindowsStartup({ appData, exePath: EXE, enable: false, fs });
  check('disabling when already off is not an error', offAgain.ok && offAgain.action === 'absent');

  const bad = A.applyWindowsStartup({
    appData, exePath: EXE, enable: true,
    fs: { mkdirSync: () => {}, writeFileSync: () => { const e = new Error('EACCES: permission denied'); throw e; }, existsSync: () => false, unlinkSync: () => {} },
  });
  check('a locked-down Startup folder reports why, not silence', !bad.ok && /permission denied/.test(bad.error || ''), JSON.stringify(bad));
}

console.log('\n— a logon launch must not put a window on screen');
{
  check('an autostart launch is recognised by --autostart', A.isAutostartLaunch(['C:\\app.exe', '--autostart']));
  check('...and by --hidden', A.isAutostartLaunch(['C:\\app.exe', '--hidden']));
  check('a person double-clicking is not', A.isAutostartLaunch(['C:\\app.exe']) === false);
  check('an empty argv is not', A.isAutostartLaunch([]) === false);

  const mainSrc = await fsp.readFile(path.join(ROOT, 'desktop', 'main.js'), 'utf8');
  const handler = /app\.on\('second-instance',[\s\S]{0,400}?\n  \}\);/.exec(mainSrc)?.[0] || '';
  check('second-instance receives argv', /second-instance',\s*\(_?event,\s*argv\)/.test(handler), handler.slice(0, 80));
  check('...and returns early for an autostart launch', /isAutostartLaunch\([\s\S]{0,20}\)\)\s*return;/.test(handler), handler);
  check('...before it would show the window', handler.indexOf('isAutostartLaunch') < handler.indexOf('win.show()'), '');

  check('Windows uses the startup script, not the login item too',
    /app\.setLoginItemSettings\(\{ openAtLogin: false \}\)/.test(mainSrc), 'both would launch two copies at logon');
  check('the Settings checkbox reads the script, not the login item',
    /win32'\s*\n?\s*\?\s*fs\.existsSync\(startupScriptPath/.test(mainSrc), 'else the box always shows unchecked on Windows');
}

await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
console.log(`\n══ autostart: ${passed} passed, ${failed} failed ══`);
if (fails.length) { console.log('Failed:'); fails.forEach((f) => console.log('  - ' + f)); process.exit(1); }
