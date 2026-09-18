// Original editable vector artwork. Coordinates are tuned for a 96-pixel XL key.
const paths = {
  ring: '<circle cx="43" cy="35" r="19"/><path d="m31 18 5-8h14l5 8-12 9z"/>',
  chest: '<path d="M17 30q0-17 17-17h24q17 0 17 17v27H17zM17 33h58M32 14v42M59 14v42"/><path d="M41 30h11v13H41z"/>',
  scroll: '<path d="M28 13h41v37q0 9-10 9H23q-9-3-5-13h38q-4 10 4 13M28 13q-12 0-10 12h39q-2-12 12-12M30 32h24M30 39h17"/>',
  hammer: '<path d="m19 23 15-15 28 22-17 18zM42 43 23 63l-7-7 20-20M57 11l12 12"/>',
  shop: '<path d="M15 30 23 13h50l8 17M20 30v30h57V30M15 30q8 14 16 0 8 14 17 0 8 14 17 0 8 14 16 0M29 42h18v18M56 43h12"/>',
  sword: '<path d="m22 57 40-40 14-3-3 14-40 40M28 44l18 18M19 65l8-8"/>',
  flask: '<path d="M35 11h24v9h-4v13q21 23 9 31H29q-12-8 10-31V20h-4zM30 48h34"/>',
  sigil: '<circle cx="47" cy="36" r="25"/><path d="m47 8 9 20 23 8-23 9-9 19-9-19-20-9 20-8zM47 25v21M37 36h20"/>',
  crystal: '<path d="m45 9 19 17-5 35H35L26 29zM45 9v52M26 29l19 8 19-11"/>',
  mic: '<rect x="36" y="10" width="22" height="35" rx="11"/><path d="M27 31v7q0 17 20 17t20-17v-7M47 55v10M34 65h26"/>',
  coins: '<ellipse cx="36" cy="23" rx="19" ry="9"/><path d="M17 23v24q19 15 38 0V23M17 35q19 14 38 0M55 32q25-7 24 7v19q-16 12-31 0"/>',
  eye: '<path d="M12 36q35-40 70 0-35 40-70 0z"/><circle cx="47" cy="36" r="13"/><path d="m44 29 8 7-8 8"/>',
  scan: '<path d="M16 27V13h16M61 13h16v14M77 47v14H61M32 61H16V47M26 24h39v26H26zM12 37h70"/>',
  bars: '<path d="M23 20h12v38H23zM57 20h12v38H57z"/>',
  play: '<path d="m31 16 39 23-39 23z"/>',
  stop: '<path d="M32 10h30l20 20v24L62 71H32L13 54V30z"/><path d="m33 29 28 25M61 29 33 54"/>',
  shield: '<path d="M47 9 76 20v19q-3 20-29 29Q22 59 18 39V20zM32 37l10 10 22-25"/>',
  book: '<path d="M13 16q17-9 34 3 17-12 34-3v43q-17-9-34 1-17-10-34-1zM47 19v41M23 28l14 2M23 39l14 2M57 30l14-2M57 41l14-2"/>',
  gear: '<path d="m39 9 17 0 2 10 10 4 9-2 7 15-8 7-1 9-10 9-9-3-8 6-15-4-2-10-9-5-1-17 11-3z"/><circle cx="48" cy="37" r="12"/>',
  home: '<path d="m12 34 35-26 35 26M22 28v35h19V45h14v18h18V28"/>',
  arrow: '<path d="M18 36h51M55 21l16 15-16 15"/>',
};
function motif(id) {
  if (id.includes('rings')) return 'ring';
  if (id.includes('transfer') || id.includes('stash') || id.startsWith('sort.')) return 'chest';
  if (/health|mana/.test(id)) return 'flask';
  if (/sigil|unleash/.test(id)) return 'sigil';
  if (/verisium/.test(id)) return 'crystal';
  if (/craft|gear/.test(id)) return 'hammer';
  if (/shop|vendor/.test(id)) return 'shop';
  if (/voice/.test(id)) return 'mic';
  if (/scan|capture|calibrat/.test(id)) return 'scan';
  if (/pause/.test(id)) return 'bars';
  if (/stop/.test(id)) return 'stop';
  if (/resume|start/.test(id)) return 'play';
  if (/combat/.test(id)) return 'sword';
  if (/bag|identify/.test(id)) return 'scroll';
  if (/helper|feed|value/.test(id)) return 'coins';
  if (/rearm|dry/.test(id)) return 'shield';
  if (/dashboard/.test(id)) return 'home';
  if (/settings|hotkeys/.test(id)) return 'gear';
  if (/evaluate/.test(id)) return 'eye';
  return 'book';
}
const xml = text => text.replaceAll('&','&amp;').replaceAll('<','&lt;');
export function icon(id, label, state, index) {
  const emergency = id === 'safety.estop';
  const color = emergency ? '#ff5b62' : state === 'error' ? '#ff806f' : state === 'active' ? '#66f0bc' : state === 'paused' ? '#ffcf6a' : state === 'unavailable' || state === 'disconnected' ? '#a8adb7' : '#ead6a1';
  const marks = { idle: '', active: '▶', paused: 'Ⅱ', unavailable: '⊘', disconnected: '×', error: '!' };
  // Every command has its own heraldic badge as well as a family silhouette and label.
  const badge = id.includes('cleanup') || id.includes('drop') ? '×' : id.includes('gamble') ? '⚄' : id.includes('empty') ? '↓' : id.includes('fill') ? '↑' : id.includes('two-cycle') ? '↕' : id.includes('open.') ? '↗' : String(index + 1).padStart(2,'0');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 96 96"><defs><radialGradient id="b"><stop stop-color="#28303d"/><stop offset="1" stop-color="#090b11"/></radialGradient></defs><rect width="96" height="96" rx="8" fill="url(#b)"/><path d="M5 23V6h18M73 6h17v17M5 73v17h18M73 90h17V73" fill="none" stroke="${color}" stroke-width="2"/><g fill="none" stroke="${color}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" transform="translate(0 1) scale(.94)">${paths[motif(id)]}</g><rect x="61" y="44" width="29" height="24" rx="4" fill="#141922" stroke="${color}"/><text x="75" y="61" text-anchor="middle" font-family="Segoe UI Symbol,Arial" font-weight="bold" font-size="17" fill="${color}">${badge}</text><text x="48" y="83" text-anchor="middle" font-family="Arial" font-weight="bold" font-size="${label.length > 9 ? 9 : 11}" fill="#fff">${xml(label)}</text>${state === 'idle' ? '' : `<circle cx="13" cy="13" r="11" fill="#10131a" stroke="${color}"/><text x="13" y="18" text-anchor="middle" font-family="Segoe UI Symbol,Arial" font-weight="bold" font-size="16" fill="${color}">${marks[state]}</text>`}${state === 'disconnected' ? '<path d="m30 20 37 39" stroke="#acb4c5" stroke-width="3"/>' : ''}</svg>`;
}
