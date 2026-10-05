// Store rules. Sources:
// https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications/
// https://developer.apple.com/documentation/appstoreconnectapi/screenshotdisplaytype
// https://support.google.com/googleplay/android-developer/answer/9866151

// Portrait sizes; the landscape swap is accepted too. Order sets the default
// when one size fits several display types (2048x2732 -> 13" iPad).
export const ASC_DISPLAY_TYPES = {
  APP_IPHONE_67: { label: 'iPhone 6.9"', sizes: [[1320, 2868], [1290, 2796], [1260, 2736]] },
  APP_IPHONE_65: { label: 'iPhone 6.5"', sizes: [[1284, 2778], [1242, 2688]] },
  APP_IPHONE_61: { label: 'iPhone 6.3"', sizes: [[1206, 2622], [1179, 2556]] },
  APP_IPHONE_58: { label: 'iPhone 6.1"', sizes: [[1170, 2532], [1125, 2436], [1080, 2340]] },
  APP_IPHONE_55: { label: 'iPhone 5.5"', sizes: [[1242, 2208]] },
  APP_IPHONE_47: { label: 'iPhone 4.7"', sizes: [[750, 1334]] },
  APP_IPHONE_40: { label: 'iPhone 4"', sizes: [[640, 1136], [640, 1096]] },
  APP_IPHONE_35: { label: 'iPhone 3.5"', sizes: [[640, 960], [640, 920]] },
  APP_IPAD_PRO_3GEN_129: { label: 'iPad 13"', sizes: [[2064, 2752], [2048, 2732]] },
  APP_IPAD_PRO_129: { label: 'iPad Pro 12.9" (2nd gen)', sizes: [[2048, 2732]] },
  APP_IPAD_PRO_3GEN_11: { label: 'iPad 11"', sizes: [[1668, 2420], [1668, 2388], [1640, 2360], [1488, 2266]] },
  APP_IPAD_105: { label: 'iPad 10.5"', sizes: [[1668, 2224]] },
  APP_IPAD_97: { label: 'iPad 9.7"', sizes: [[1536, 2048], [1536, 2008], [768, 1024]] },
  APP_DESKTOP: { label: 'Mac', sizes: [[2880, 1800], [2560, 1600], [1440, 900], [1280, 800]] },
  APP_APPLE_TV: { label: 'Apple TV', sizes: [[3840, 2160], [1920, 1080]] },
  APP_APPLE_VISION_PRO: { label: 'Apple Vision Pro', sizes: [[3840, 2160]] },
  APP_WATCH_ULTRA: { label: 'Apple Watch Ultra', sizes: [[422, 514], [410, 502]] },
  APP_WATCH_SERIES_10: { label: 'Apple Watch Series 10', sizes: [[416, 496]] },
  APP_WATCH_SERIES_7: { label: 'Apple Watch Series 7', sizes: [[396, 484]] },
  APP_WATCH_SERIES_4: { label: 'Apple Watch Series 4', sizes: [[368, 448]] },
  APP_WATCH_SERIES_3: { label: 'Apple Watch Series 3', sizes: [[312, 390]] },
};

// Sizes shared by display types that can't be told apart by pixels alone.
const ASC_AMBIGUOUS = new Set(['3840x2160', '2160x3840']);

export const ASC_MAX_PER_SET = 10;

export const ASC_PLATFORMS = ['IOS', 'MAC_OS', 'TV_OS', 'VISION_OS'];

const fits = (sizes, w, h) => sizes.some(([a, b]) => (a === w && b === h) || (a === h && b === w));

export function ascDisplayTypesFor(w, h) {
  return Object.entries(ASC_DISPLAY_TYPES)
    .filter(([, t]) => fits(t.sizes, w, h))
    .map(([k]) => k);
}

// Picks the display type for a folder of images. An exact enum name as the
// folder wins; otherwise the pixel size decides.
export function ascResolveDisplayType(folder, w, h) {
  const named = folder.toUpperCase();
  if (ASC_DISPLAY_TYPES[named]) {
    return fits(ASC_DISPLAY_TYPES[named].sizes, w, h)
      ? { type: named }
      : { error: `${w}x${h} is not a valid size for ${named} (${sizeList(ASC_DISPLAY_TYPES[named].sizes)})` };
  }
  const types = ascDisplayTypesFor(w, h);
  if (!types.length) return { error: `${w}x${h} is not an App Store screenshot size` };
  if (ASC_AMBIGUOUS.has(`${w}x${h}`)) {
    return { error: `${w}x${h} fits ${types.join(' and ')}; name the folder after the display type` };
  }
  return { type: types[0], also: types.slice(1) };
}

export const sizeList = (sizes) => sizes.map(([w, h]) => `${w}x${h}`).join(', ');

// Google Play image types and the folder names that map to them.
export const PLAY_IMAGE_TYPES = {
  phoneScreenshots: { label: 'Phone', max: 8, aliases: ['phone'] },
  sevenInchScreenshots: { label: '7" tablet', max: 8, tablet: true, aliases: ['tablet-7', 'tablet7', 'seven-inch'] },
  tenInchScreenshots: { label: '10" tablet', max: 8, tablet: true, aliases: ['tablet', 'tablet-10', 'tablet10', 'ten-inch'] },
  tvScreenshots: { label: 'TV', max: 8, aliases: ['tv'] },
  wearScreenshots: { label: 'Wear OS', max: 8, aliases: ['wear'] },
  featureGraphic: { label: 'Feature graphic', max: 1, exact: [1024, 500], aliases: ['feature-graphic', 'feature'] },
};

export function playResolveImageType(folder) {
  const f = folder.toLowerCase();
  for (const [type, t] of Object.entries(PLAY_IMAGE_TYPES)) {
    if (type.toLowerCase() === f || t.aliases.includes(f)) return type;
  }
  return null;
}

const is916 = (w, h) => Math.abs(Math.max(w, h) / Math.min(w, h) - 16 / 9) < 0.01;

// Hard rules become errors; Play's recommendations become warnings.
export function playImageCheck(type, info) {
  const errors = [];
  const warnings = [];
  const { width: w, height: h } = info;
  if (!['png', 'jpeg'].includes(info.format)) errors.push('must be PNG or JPEG');
  if (info.alpha) errors.push('has an alpha channel (Play needs 24-bit PNG or JPEG)');
  const spec = PLAY_IMAGE_TYPES[type];
  if (spec.exact) {
    if (w !== spec.exact[0] || h !== spec.exact[1]) errors.push(`must be exactly ${spec.exact[0]}x${spec.exact[1]}`);
    return { errors, warnings };
  }
  const short = Math.min(w, h);
  const long = Math.max(w, h);
  if (short < 320 || long > (spec.tablet ? 7680 : 3840)) {
    errors.push(`sides must be between 320 and ${spec.tablet ? 7680 : 3840} px`);
  }
  if (long > 2 * short) errors.push('long side is more than twice the short side');
  if (info.bytes > 8 * 1024 * 1024) warnings.push('is larger than 8 MB');
  if (type === 'wearScreenshots') {
    if (w !== h || w < 384) warnings.push('Wear OS screenshots should be square, at least 384x384');
  } else if (type !== 'tvScreenshots' && (short < 1080 || !is916(w, h))) {
    warnings.push('Play recommends 9:16 or 16:9 with at least 1080 px on the short side');
  }
  return { errors, warnings };
}

// Character limits, counted in Unicode code points.
export const ASC_LIMITS = {
  name: 30,
  subtitle: 30,
  keywords: 100,
  promotional_text: 170,
  description: 4000,
  whats_new: 4000,
};

export const PLAY_LIMITS = { title: 30, short_description: 80, full_description: 4000 };

// App Store version states that are on the store now.
export const ASC_LIVE = new Set(['READY_FOR_DISTRIBUTION', 'READY_FOR_SALE']);

// Editable App Store version states.
export const ASC_EDITABLE = new Set([
  'PREPARE_FOR_SUBMISSION',
  'DEVELOPER_REJECTED',
  'REJECTED',
  'METADATA_REJECTED',
  'INVALID_BINARY',
]);
