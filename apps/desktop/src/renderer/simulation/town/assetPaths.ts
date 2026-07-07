/** Public simulation assets (CC0 Kenney City Kit Commercial + Mixamo Xbot via three.js examples). */

const BASE = "/simulation/assets";

export const SIM_CHARACTER_GLB = `${BASE}/Xbot.glb`;

const BUILDINGS = `${BASE}/buildings`;
const KENNEY = `${BASE}/kenney_city-kit-commercial/Models/GLB format`;

export const KENNEY_BUILDINGS = {
  // Plaza & civic
  plazaWide: `${KENNEY}/building-a.glb`,
  plazaWideB: `${KENNEY}/building-b.glb`,
  townHall: `${BUILDINGS}/building-skyscraper-e.glb`,
  townHallB: `${KENNEY}/building-skyscraper-c.glb`,
  skyscraperA: `${KENNEY}/building-skyscraper-a.glb`,
  skyscraperD: `${KENNEY}/building-skyscraper-d.glb`,

  // Market & commercial
  marketAwning: `${BUILDINGS}/detail-awning-wide.glb`,
  awning: `${KENNEY}/detail-awning.glb`,
  overhang: `${KENNEY}/detail-overhang.glb`,
  overhangWide: `${KENNEY}/detail-overhang-wide.glb`,
  shopA: `${KENNEY}/building-c.glb`,
  shopB: `${KENNEY}/building-d.glb`,
  shopC: `${KENNEY}/building-e.glb`,
  shopD: `${KENNEY}/building-g.glb`,
  shopE: `${KENNEY}/building-h.glb`,
  shopF: `${KENNEY}/building-i.glb`,

  // Restaurant & food
  restaurant: `${BUILDINGS}/building-f.glb`,
  restaurantB: `${KENNEY}/building-e.glb`,
  restaurantC: `${KENNEY}/building-g.glb`,

  // Workplaces
  workshopA: `${BUILDINGS}/building-m.glb`,
  workshopB: `${BUILDINGS}/building-n.glb`,
  workshopC: `${KENNEY}/building-k.glb`,
  workshopD: `${KENNEY}/building-l.glb`,

  // Residential — normal-sized buildings (not low-detail)
  houseA: `${KENNEY}/building-h.glb`,
  houseB: `${KENNEY}/building-i.glb`,
  houseC: `${KENNEY}/building-j.glb`,
  houseD: `${KENNEY}/building-k.glb`,
  houseE: `${KENNEY}/building-l.glb`,
  houseF: `${KENNEY}/building-m.glb`,
  houseG: `${KENNEY}/building-n.glb`,

  // Mid-rise accents
  accentA: `${KENNEY}/building-a.glb`,
  accentB: `${KENNEY}/building-b.glb`,
  accentC: `${KENNEY}/building-c.glb`,
  accentD: `${KENNEY}/building-d.glb`,
  accentE: `${KENNEY}/building-e.glb`,

  // Park props
  parasolA: `${BUILDINGS}/detail-parasol-a.glb`,
  parasolB: `${KENNEY}/detail-parasol-b.glb`,

  // Road-side small accents
  roadAccentA: `${KENNEY}/building-j.glb`,
  roadAccentB: `${KENNEY}/building-k.glb`,
} as const;

/** All unique GLB URLs used by the town scene — preload once at boot. */
export const TOWN_GLB_URLS = [...new Set(Object.values(KENNEY_BUILDINGS))];
