import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WORLD_LAND_PATH } from '../src/components/worldLand';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

type Pt = [number, number];

/** Parses the compact `M x,y l dx,dy ... z` land path into rings (absolute coordinates). */
function parseLand(d: string): Pt[][] {
  const rings: Pt[][] = [];
  let cur: Pt[] = [];
  let x = 0;
  let y = 0;
  for (const m of d.matchAll(/([Mlz])([^Mlz]*)/g)) {
    const cmd = m[1];
    if (cmd === 'z') {
      if (cur.length) rings.push(cur);
      cur = [];
      continue;
    }
    const nums = (m[2].match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
    if (cmd === 'M') {
      [x, y] = [nums[0], nums[1]];
    } else {
      x += nums[0];
      y += nums[1];
    }
    cur.push([x, y]);
  }
  return rings;
}

function inRing(p: Pt, ring: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Same equirectangular projection the map uses for its pins. */
const project = (lon: number, lat: number): Pt => [((lon + 180) / 360) * 1000, ((90 - lat) / 180) * 500];

function isLand(rings: Pt[][], lon: number, lat: number): boolean {
  const p = project(lon, lat);
  let hits = 0; // even-odd across all rings, like fill-rule="evenodd"
  for (const r of rings) if (inRing(p, r)) hits++;
  return hits % 2 === 1;
}

function testMapRequirements() {
  console.log('--- TEST 1: Verify removal of "Pausar Animação" and pause buttons from the map ---');
  const map2dContent = fs.readFileSync(path.resolve(__dirname, '../src/components/NetworkMap2D.tsx'), 'utf8');
  assert(!map2dContent.toLowerCase().includes('pausar animação'), 'NetworkMap2D must not contain "Pausar Animação" button/text');
  console.log('Confirmed: Zero pause animation buttons found in the map.');

  console.log('\n--- TEST 2: Verify point labels appear strictly on hover or click ---');
  assert(map2dContent.includes('hoveredNodeId'), 'NetworkMap2D must track hoveredNodeId');
  assert(map2dContent.includes('selectedNode'), 'NetworkMap2D must track selectedNode');
  assert(map2dContent.includes('opacity-0 scale-95 z-0 pointer-events-none'), 'NetworkMap2D must hide point labels by default with opacity-0 and pointer-events-none');
  assert(map2dContent.includes('opacity-100 scale-100 z-30 pointer-events-auto'), 'NetworkMap2D must show point labels on hover/click with opacity-100 and pointer-events-auto');
  console.log('Confirmed: Point labels are hidden by default and only display on hover or click.');

  console.log('\n--- TEST 3: The 3D globe is gone ---');
  assert(!fs.existsSync(path.resolve(__dirname, '../src/components/NetworkGlobe3D.tsx')), 'NetworkGlobe3D.tsx must be removed');
  const app = fs.readFileSync(path.resolve(__dirname, '../src/App.tsx'), 'utf8');
  assert(!app.includes('Globe3D') && !app.includes('mapProjectionMode'), 'App must not reference the 3D globe');
  console.log('Confirmed: only the 2D map remains.');

  console.log('\n--- TEST 4: Map uses real coastlines, not hand-drawn polygons ---');
  assert(map2dContent.includes('WORLD_LAND_PATH'), 'NetworkMap2D must draw WORLD_LAND_PATH');
  assert(!map2dContent.includes('NORTH AMERICA (Alaska'), 'Hand-drawn continent polygons must be gone');
  assert(!/NaN|undefined/.test(WORLD_LAND_PATH), 'land path must be numeric');
  const rings = parseLand(WORLD_LAND_PATH);
  assert(rings.length > 100, `expected many land rings (continents + islands), got ${rings.length}`);

  // inland points: the outline is simplified to ~0.13°, so coastal pixels are not asserted
  const land: Array<[string, number, number]> = [
    ['São Paulo', -46.63, -23.55],
    ['Belo Horizonte', -43.94, -19.92],
    ['Brasília', -47.88, -15.78],
    ['Orlando (Florida)', -81.38, 28.54],
    ['Atlanta', -84.38, 33.74],
    ['Ashburn', -77.48, 39.04],
    ['Canberra', 149.13, -35.28],
    ['Alice Springs (Australian interior)', 133.88, -23.7],
    ['Kalgoorlie', 121.47, -30.75],
    ['Cairo', 31.24, 30.04],
    ['London', -0.12, 51.5],
    ['Nagano (Honshu)', 138.19, 36.65],
    ['Johannesburg', 28.05, -26.2],
    ['Moscow', 37.62, 55.75],
  ];
  for (const [name, lon, lat] of land) assert(isLand(rings, lon, lat), `${name} must be on land`);

  const sea: Array<[string, number, number]> = [
    ['mid South Atlantic', -25, -20],
    ['mid North Atlantic', -40, 35],
    ['central Pacific', -150, 0],
    ['Gulf of Mexico', -90, 25],
    ['Indian Ocean', 80, -20],
    ['Tasman Sea', 160, -38],
    ['Mediterranean', 18, 34],
  ];
  for (const [name, lon, lat] of sea) assert(!isLand(rings, lon, lat), `${name} must be water`);
  console.log('Confirmed: major cities are on land, open ocean and seas are water.');

  console.log('\n--- TEST 5: Australia is a continent shape, not a blob ---');
  // Walk a west-east line through Australia's latitude band and count land/water transitions at 0.5° steps:
  // a real coast has Gulf of Carpentaria / Great Australian Bight indentations; check key outline points.
  assert(isLand(rings, 143.85, -37.56), 'Ballarat');
  assert(!isLand(rings, 137, -15.5), 'Gulf of Carpentaria is water');
  assert(!isLand(rings, 130, -35.5), 'Great Australian Bight is water');
  assert(isLand(rings, 147, -42.0), 'Tasmania');
  assert(isLand(rings, 175, -39), 'New Zealand');
  console.log('Confirmed: gulfs, Bight, Tasmania and New Zealand are in the right places.');

  console.log('\n✅ ALL MAP COMPONENT TESTS PASSED SUCCESSFULLY!');
}

testMapRequirements();
