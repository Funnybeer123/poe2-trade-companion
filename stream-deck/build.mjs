import { build } from 'esbuild';
import { mkdirSync, writeFileSync, readFileSync, cpSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Resvg } from '@resvg/resvg-js';
import { zipSync, strToU8 } from 'fflate';
import { icon } from './icons.mjs';
const catalog = await build({ entryPoints: ['../src/shared/deckActions.ts'], bundle: true, write: false, format: 'esm' });
const { DECK_ACTIONS } = await import('data:text/javascript;base64,' + Buffer.from(catalog.outputFiles[0].text).toString('base64'));
const plugin = 'com.poe2companion.deck.sdPlugin', output = '../artifacts/stream-deck';
const uuid = id => `com.poe2companion.deck.${id.replaceAll('.', '-').toLowerCase()}`;
const json = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
for (const dir of [plugin + '/bin', plugin + '/ui', plugin + '/profiles', output, 'assets/svg']) mkdirSync(dir, { recursive: true });
const states = ['idle', 'active', 'paused', 'unavailable', 'disconnected', 'error'];
const font = { loadSystemFonts: false, fontFiles: ['C:/Windows/Fonts/arial.ttf', 'C:/Windows/Fonts/arialbd.ttf', 'C:/Windows/Fonts/seguisym.ttf'] };
const contact = [];
for (const [index, [id, name, label]] of DECK_ACTIONS.entries()) {
  mkdirSync(`${plugin}/icons/${id}`, { recursive: true });
  for (const state of states) {
    const svg = icon(id, label, state, index);
    const unchanged = existsSync(`assets/svg/${id}-${state}.svg`) && readFileSync(`assets/svg/${id}-${state}.svg`, 'utf8') === svg;
    writeFileSync(`assets/svg/${id}-${state}.svg`, svg);
    for (const [size, suffix] of [[72, ''], [96, '-96'], [144, '@2x']]) {
      const file = `${plugin}/icons/${id}/${state}${suffix}.png`;
      if (unchanged && suffix === '-96' && existsSync(file)) continue;
      writeFileSync(file, new Resvg(svg, { font, fitTo: { mode: 'width', value: size } }).render().asPng());
    }
    if (state === 'idle') contact.push(`<g transform="translate(${index % 8 * 136} ${Math.floor(index / 8) * 132})"><image x="20" width="96" height="96" href="data:image/png;base64,${readFileSync(`${plugin}/icons/${id}/idle@2x.png`).toString('base64')}"/><text x="68" y="113" fill="#ddd" text-anchor="middle" font-size="10" font-family="Arial">${name.replaceAll('&','&amp;')}</text></g>`);
  }
}
const sheet = `<svg xmlns="http://www.w3.org/2000/svg" width="1088" height="${Math.ceil(DECK_ACTIONS.length / 8) * 132}" viewBox="0 0 1088 ${Math.ceil(DECK_ACTIONS.length / 8) * 132}"><rect width="100%" height="100%" fill="#090b11"/>${contact.join('')}</svg>`;
writeFileSync(output + '/contact-sheet.svg', sheet); writeFileSync(output + '/contact-sheet.png', new Resvg(sheet, {font}).render().asPng());
const stateSheet = `<svg xmlns="http://www.w3.org/2000/svg" width="576" height="120"><rect width="100%" height="100%" fill="#090b11"/>${states.map((state,i) => `<image x="${i*96}" width="96" height="96" href="data:image/png;base64,${readFileSync(`${plugin}/icons/rings.gamble/${state}@2x.png`).toString('base64')}"/><text x="${i*96+48}" y="112" text-anchor="middle" fill="white" font-size="10">${state}</text>`).join('')}</svg>`;
writeFileSync(output + '/states.png', new Resvg(stateSheet, {font}).render().asPng());
cpSync(`${plugin}/icons/open.dashboard/idle.png`, `${plugin}/plugin.png`);
cpSync(`${plugin}/icons/open.dashboard/idle@2x.png`, `${plugin}/plugin@2x.png`);
writeFileSync(`${plugin}/category.svg`, '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28"><path d="M14 2 25 8v10l-11 8L3 18V8zM9 10h10v8H9z" fill="none" stroke="white" stroke-width="2"/></svg>');
await build({ entryPoints: ['src/plugin.ts'], outfile: `${plugin}/bin/plugin.js`, bundle: true, platform: 'node', target: 'node24', format: 'esm', sourcemap: true, banner: {js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);'} });
writeFileSync(`${plugin}/package.json`, '{"type":"module"}\n');
cpSync('ui/inspector.html', `${plugin}/ui/inspector.html`);
json(`${plugin}/manifest.json`, {
  $schema: 'https://schemas.elgato.com/streamdeck/plugins/manifest.json', UUID: 'com.poe2companion.deck', Name: 'PoE2 Companion', Author: 'PoE2 Companion', Version: '1.0.0.0',
  Description: 'Native local PoE2 Companion controls with acknowledged commands and real status.', Category: 'PoE2 Companion', CategoryIcon: 'category', Icon: 'plugin',
  CodePath: 'bin/plugin.js', SDKVersion: 2, Software: { MinimumVersion: '7.1' }, Nodejs: { Version: '24' }, OS: [{ Platform: 'windows', MinimumVersion: '10' }],
  PropertyInspectorPath: 'ui/inspector.html',
  Actions: DECK_ACTIONS.map(([id, name, , detail]) => ({ UUID: uuid(id), Name: name, Icon: `icons/${id}/idle`, Tooltip: detail, Controllers: ['Keypad'], SupportedInMultiActions: false,
    States: [{ Image: `icons/${id}/idle`, TitleAlignment: 'top', FontSize: 11 }], UserTitleEnabled: false })),
  Profiles: [{ Name: 'profiles/PoE2 Companion XL', DeviceType: 2, AutoInstall: true, DontAutoSwitchWhenInstalled: true, Readonly: false }],
});
// Add a new profile with independent IDs. Never copy or edit the user's profile.
const profileId = '27B63E4C-42A0-430A-90D3-882F88126D91';
const pages = ['d17b2aa0-7ce4-4497-a5bb-aa090b82c011', 'd17b2aa0-7ce4-4497-a5bb-aa090b82c012', 'd17b2aa0-7ce4-4497-a5bb-aa090b82c013'];
const groups = [
  DECK_ACTIONS.filter(([id]) => /^(rings|bag|transfer|sort|script|tabs)\./.test(id)),
  DECK_ACTIONS.filter(([id]) => /^(combat|voice|helper|item|scan|feed|valuation|overlay)\./.test(id)),
  DECK_ACTIONS.filter(([id]) => id.startsWith('open.')),
];
groups[2].push(...groups[0].splice(24), ...groups[1].splice(24));
const profile = {}, mapping = [];
const root = `${profileId}.sdProfile`;
profile[`${root}/manifest.json`] = strToU8(JSON.stringify({ Device: { Model: '20GAT9902', UUID: '' }, Name: 'PoE2 Companion XL', Pages: { Current: pages[0], Default: pages[0], Pages: pages }, Version: '3.0' }));
function key(entry) {
  return { ActionID: randomUUID(), LinkedTitle: true, Name: entry[1], Plugin: { Name: 'PoE2 Companion', UUID: 'com.poe2companion.deck', Version: '1.0.0.0' }, Resources: null, Settings: {}, State: 0,
    States: [{ Image: '', ShowTitle: true, Title: '', TitleAlignment: 'top', FontSize: 11, TitleColor: '#ffffff', OutlineThickness: 2 }], UUID: uuid(entry[0]) };
}
for (const [page, entries] of groups.entries()) {
  const actions = {};
  const controls = ['safety.dry-on', 'safety.dry-off', 'safety.rearm', 'workflow.stop', 'safety.estop'].map(id => DECK_ACTIONS.find(a => a[0] === id));
  if (entries.length > 24) throw new Error('Too many page actions');
  for (const [i, entry] of entries.entries()) { actions[`${i%8},${Math.floor(i/8)}`] = key(entry); mapping.push([page+1, Math.floor(i/8)+1, i%8+1, ...entry]); }
  for (const [i, entry] of controls.entries()) { actions[`${i+3},3`] = key(entry); mapping.push([page+1,4,i+4,...entry]); }
  // Pages are siblings, not child folders: cyclic folder references are discarded by Stream Deck.
  for (const [i, direction] of ['previous', 'next'].entries()) {
    const navigation = `com.elgato.streamdeck.page.${direction}`;
    actions[`${i},3`] = { ActionID: randomUUID(), Name: direction === 'previous' ? 'Previous Page' : 'Next Page', Plugin: { Name: 'Navigation', UUID: navigation, Version: '1.0' }, Settings: {}, State: 0,
      States: [{ ShowTitle: true, Title: direction === 'previous' ? 'PREVIOUS' : 'NEXT', TitleAlignment: 'bottom', FontSize: 11, TitleColor: '#ffffff' }], UUID: navigation };
  }
  profile[`${root}/Profiles/${pages[page].toUpperCase()}/manifest.json`] = strToU8(JSON.stringify({ Controllers: [{ Actions: actions, Type: 'Keypad' }], Icon: '', Name: ['Workflows','Combat & tools','Settings'][page] }));
}
const assigned = new Set();
for (const [file, bytes] of Object.entries(profile)) {
  if (!file.includes('/Profiles/')) continue;
  const actions = JSON.parse(new TextDecoder().decode(bytes)).Controllers[0].Actions;
  for (const [coordinate, entry] of Object.entries(actions)) {
    if (entry.UUID.startsWith('com.poe2companion.deck.')) assigned.add(entry.UUID);
    if (entry.UUID === 'com.elgato.streamdeck.profile.openchild') throw new Error('Top-level pages cannot be linked as child folders');
    if (Number(coordinate.split(',')[1]) > 3) throw new Error('Action outside XL grid');
  }
  if (actions['7,3']?.UUID !== uuid('safety.estop')) throw new Error('Emergency stop missing');
}
for (const [id] of DECK_ACTIONS) if (!assigned.has(uuid(id))) throw new Error(`Profile lost action: ${id}`);
const archive = zipSync(profile);
writeFileSync(`${plugin}/profiles/PoE2 Companion XL.streamDeckProfile`, archive);
writeFileSync(`${output}/PoE2 Companion XL.streamDeckProfile`, archive);
json(`${output}/profile-files.json`, Object.fromEntries(Object.entries(profile).map(([key,value]) => [key, JSON.parse(new TextDecoder().decode(value))])));
const rows = mapping.map(([page,row,col,id,name,label,detail]) => `| ${page} | ${row},${col} | ${label} | ${id} | [SVG](../stream-deck/assets/svg/${id}-idle.svg) | ${detail} |`);
writeFileSync('../docs/STREAM_DECK_MAPPING.md', `# Stream Deck XL mapping\n\nCoordinates are row,column (1-based). Pages: 1 Workflows; 2 Combat & tools; 3 Settings. Bottom-right is always Emergency stop. Bottom-left keys select the previous or next page. Every action can be dragged from PoE2 Companion in Stream Deck to reassign keys.\n\nAll buttons show idle, active (triangle), paused (bars), unavailable (barred circle), disconnected (cross) or error (!). Counts appear at the top when the service publishes them. The Property Inspector shows the exact reason. Configuration toggles show active when enabled; they stop combat just like desktop configuration.\n\n| Page | Key | Label | Command | Icon | Function |\n|---|---|---|---|---|---|\n${rows.join('\n')}\n`);
console.log(`Built ${DECK_ACTIONS.length} native actions, ${DECK_ACTIONS.length*states.length} SVG sources, three XL pages, and contact sheets.`);
