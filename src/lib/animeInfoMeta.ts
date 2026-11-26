import { formatEpisodeReleaseDate } from './episodeAvailability';
import type { AnimeDetails, AudioType, MediaKind } from './types';

const LANGUAGE_PT_BR_MAP: Record<string, string> = {
  ja: 'Japonês',
  jpn: 'Japonês',
  japanese: 'Japonês',
  'japonês': 'Japonês',
  japones: 'Japonês',
  zh: 'Chinês',
  zho: 'Chinês',
  chi: 'Chinês',
  chinese: 'Chinês',
  'chinês': 'Chinês',
  chines: 'Chinês',
  cmn: 'Mandarim',
  mandarin: 'Mandarim',
  'mandarin chinese': 'Mandarim',
  mandarim: 'Mandarim',
  yue: 'Cantonês',
  cantonese: 'Cantonês',
  'cantonês': 'Cantonês',
  taiwanese: 'Taiwanês',
  ko: 'Coreano',
  kor: 'Coreano',
  korean: 'Coreano',
  coreano: 'Coreano',
  en: 'Inglês',
  eng: 'Inglês',
  english: 'Inglês',
  'inglês': 'Inglês',
  ingles: 'Inglês',
  pt: 'Português',
  por: 'Português',
  'pt-br': 'Português',
  'pt-pt': 'Português',
  portuguese: 'Português',
  'brazilian portuguese': 'Português',
  'português': 'Português',
  portugues: 'Português',
  es: 'Espanhol',
  spa: 'Espanhol',
  spanish: 'Espanhol',
  castilian: 'Espanhol',
  espanhol: 'Espanhol',
  fr: 'Francês',
  fra: 'Francês',
  fre: 'Francês',
  french: 'Francês',
  'francês': 'Francês',
  frances: 'Francês',
  de: 'Alemão',
  deu: 'Alemão',
  ger: 'Alemão',
  german: 'Alemão',
  'alemão': 'Alemão',
  alemao: 'Alemão',
  it: 'Italiano',
  ita: 'Italiano',
  italian: 'Italiano',
  italiano: 'Italiano',
  ru: 'Russo',
  rus: 'Russo',
  russian: 'Russo',
  russo: 'Russo',
  th: 'Tailandês',
  tha: 'Tailandês',
  thai: 'Tailandês',
  'tailandês': 'Tailandês',
  tailandes: 'Tailandês',
  vi: 'Vietnamita',
  vie: 'Vietnamita',
  vietnamese: 'Vietnamita',
  vietnamita: 'Vietnamita',
  id: 'Indonésio',
  ind: 'Indonésio',
  indonesian: 'Indonésio',
  'indonésio': 'Indonésio',
  indonesio: 'Indonésio',
  ms: 'Malaio',
  msa: 'Malaio',
  may: 'Malaio',
  malay: 'Malaio',
  malaio: 'Malaio',
  hi: 'Hindi',
  hin: 'Hindi',
  hindi: 'Hindi',
  ar: 'Árabe',
  ara: 'Árabe',
  arabic: 'Árabe',
  'árabe': 'Árabe',
  arabe: 'Árabe',
  tr: 'Turco',
  tur: 'Turco',
  turkish: 'Turco',
  turco: 'Turco',
  pl: 'Polonês',
  pol: 'Polonês',
  polish: 'Polonês',
  'polonês': 'Polonês',
  polones: 'Polonês',
  nl: 'Holandês',
  nld: 'Holandês',
  dut: 'Holandês',
  dutch: 'Holandês',
  flemish: 'Holandês',
  'holandês': 'Holandês',
  holandes: 'Holandês',
  'neerlandês': 'Holandês',
  sv: 'Sueco',
  swe: 'Sueco',
  swedish: 'Sueco',
  sueco: 'Sueco',
  no: 'Norueguês',
  nor: 'Norueguês',
  nob: 'Norueguês',
  nno: 'Norueguês',
  norwegian: 'Norueguês',
  'norueguês': 'Norueguês',
  noruegues: 'Norueguês',
  da: 'Dinamarquês',
  dan: 'Dinamarquês',
  danish: 'Dinamarquês',
  'dinamarquês': 'Dinamarquês',
  dinamarques: 'Dinamarquês',
  fi: 'Finlandês',
  fin: 'Finlandês',
  finnish: 'Finlandês',
  'finlandês': 'Finlandês',
  finlandes: 'Finlandês',
  cs: 'Tcheco',
  ces: 'Tcheco',
  cze: 'Tcheco',
  czech: 'Tcheco',
  tcheco: 'Tcheco',
  uk: 'Ucraniano',
  ukr: 'Ucraniano',
  ukrainian: 'Ucraniano',
  ucraniano: 'Ucraniano',
  he: 'Hebraico',
  heb: 'Hebraico',
  hebrew: 'Hebraico',
  hebraico: 'Hebraico',
  tl: 'Filipino',
  tgl: 'Filipino',
  fil: 'Filipino',
  tagalog: 'Filipino',
  filipino: 'Filipino',
  el: 'Grego',
  ell: 'Grego',
  gre: 'Grego',
  greek: 'Grego',
  grego: 'Grego',
  hu: 'Húngaro',
  hun: 'Húngaro',
  hungarian: 'Húngaro',
  'húngaro': 'Húngaro',
  ro: 'Romeno',
  ron: 'Romeno',
  rum: 'Romeno',
  romanian: 'Romeno',
  romeno: 'Romeno',
  fa: 'Persa',
  fas: 'Persa',
  per: 'Persa',
  persian: 'Persa',
  farsi: 'Persa',
  persa: 'Persa',
  bn: 'Bengali',
  ben: 'Bengali',
  bengali: 'Bengali',
  ta: 'Tâmil',
  tam: 'Tâmil',
  tamil: 'Tâmil',
  'tâmil': 'Tâmil',
  te: 'Télugo',
  tel: 'Télugo',
  telugu: 'Télugo',
  'télugo': 'Télugo',
  la: 'Latim',
  lat: 'Latim',
  latin: 'Latim',
  latim: 'Latim',
  und: 'Desconhecido',
  unknown: 'Desconhecido',
};

const COUNTRY_PT_BR_MAP: Record<string, string> = {
  jp: 'Japão',
  jpn: 'Japão',
  japan: 'Japão',
  'japão': 'Japão',
  japao: 'Japão',
  cn: 'China',
  chn: 'China',
  china: 'China',
  "people's republic of china": 'China',
  prc: 'China',
  kr: 'Coreia do Sul',
  kor: 'Coreia do Sul',
  'south korea': 'Coreia do Sul',
  korea: 'Coreia do Sul',
  'republic of korea': 'Coreia do Sul',
  'korea, republic of': 'Coreia do Sul',
  'coreia do sul': 'Coreia do Sul',
  kp: 'Coreia do Norte',
  prk: 'Coreia do Norte',
  'north korea': 'Coreia do Norte',
  'coreia do norte': 'Coreia do Norte',
  tw: 'Taiwan',
  twn: 'Taiwan',
  taiwan: 'Taiwan',
  'republic of china': 'Taiwan',
  hk: 'Hong Kong',
  hkg: 'Hong Kong',
  'hong kong': 'Hong Kong',
  us: 'Estados Unidos',
  usa: 'Estados Unidos',
  'united states': 'Estados Unidos',
  'united states of america': 'Estados Unidos',
  'u.s.': 'Estados Unidos',
  'u.s.a.': 'Estados Unidos',
  'estados unidos': 'Estados Unidos',
  gb: 'Reino Unido',
  gbr: 'Reino Unido',
  uk: 'Reino Unido',
  'united kingdom': 'Reino Unido',
  'great britain': 'Reino Unido',
  england: 'Reino Unido',
  scotland: 'Reino Unido',
  wales: 'Reino Unido',
  'reino unido': 'Reino Unido',
  ca: 'Canadá',
  can: 'Canadá',
  canada: 'Canadá',
  'canadá': 'Canadá',
  au: 'Austrália',
  aus: 'Austrália',
  australia: 'Austrália',
  'austrália': 'Austrália',
  nz: 'Nova Zelândia',
  nzl: 'Nova Zelândia',
  'new zealand': 'Nova Zelândia',
  'nova zelândia': 'Nova Zelândia',
  br: 'Brasil',
  bra: 'Brasil',
  brazil: 'Brasil',
  brasil: 'Brasil',
  pt: 'Portugal',
  prt: 'Portugal',
  portugal: 'Portugal',
  es: 'Espanha',
  esp: 'Espanha',
  spain: 'Espanha',
  espanha: 'Espanha',
  fr: 'França',
  fra: 'França',
  france: 'França',
  'frança': 'França',
  franca: 'França',
  de: 'Alemanha',
  deu: 'Alemanha',
  ger: 'Alemanha',
  germany: 'Alemanha',
  alemanha: 'Alemanha',
  it: 'Itália',
  ita: 'Itália',
  italy: 'Itália',
  'itália': 'Itália',
  italia: 'Itália',
  ru: 'Rússia',
  rus: 'Rússia',
  russia: 'Rússia',
  'russian federation': 'Rússia',
  'rússia': 'Rússia',
  mx: 'México',
  mex: 'México',
  mexico: 'México',
  'méxico': 'México',
  ar: 'Argentina',
  arg: 'Argentina',
  argentina: 'Argentina',
  cl: 'Chile',
  chl: 'Chile',
  chile: 'Chile',
  co: 'Colômbia',
  col: 'Colômbia',
  colombia: 'Colômbia',
  'colômbia': 'Colômbia',
  in: 'Índia',
  ind: 'Índia',
  india: 'Índia',
  'índia': 'Índia',
  th: 'Tailândia',
  tha: 'Tailândia',
  thailand: 'Tailândia',
  'tailândia': 'Tailândia',
  tailandia: 'Tailândia',
  vn: 'Vietnã',
  vnm: 'Vietnã',
  vietnam: 'Vietnã',
  'viet nam': 'Vietnã',
  'vietnã': 'Vietnã',
  id: 'Indonésia',
  idn: 'Indonésia',
  indonesia: 'Indonésia',
  'indonésia': 'Indonésia',
  my: 'Malásia',
  mys: 'Malásia',
  malaysia: 'Malásia',
  'malásia': 'Malásia',
  ph: 'Filipinas',
  phl: 'Filipinas',
  philippines: 'Filipinas',
  filipinas: 'Filipinas',
  sg: 'Singapura',
  sgp: 'Singapura',
  singapore: 'Singapura',
  singapura: 'Singapura',
  cingapura: 'Singapura',
  tr: 'Turquia',
  tur: 'Turquia',
  turkey: 'Turquia',
  'türkiye': 'Turquia',
  turquia: 'Turquia',
  pl: 'Polônia',
  pol: 'Polônia',
  poland: 'Polônia',
  'polônia': 'Polônia',
  polonia: 'Polônia',
  nl: 'Países Baixos',
  nld: 'Países Baixos',
  netherlands: 'Países Baixos',
  'the netherlands': 'Países Baixos',
  holland: 'Países Baixos',
  'países baixos': 'Países Baixos',
  holanda: 'Países Baixos',
  be: 'Bélgica',
  bel: 'Bélgica',
  belgium: 'Bélgica',
  'bélgica': 'Bélgica',
  belgica: 'Bélgica',
  ch: 'Suíça',
  che: 'Suíça',
  switzerland: 'Suíça',
  'suíça': 'Suíça',
  suica: 'Suíça',
  at: 'Áustria',
  aut: 'Áustria',
  austria: 'Áustria',
  'áustria': 'Áustria',
  se: 'Suécia',
  swe: 'Suécia',
  sweden: 'Suécia',
  'suécia': 'Suécia',
  suecia: 'Suécia',
  no: 'Noruega',
  nor: 'Noruega',
  norway: 'Noruega',
  noruega: 'Noruega',
  dk: 'Dinamarca',
  dnk: 'Dinamarca',
  denmark: 'Dinamarca',
  dinamarca: 'Dinamarca',
  fi: 'Finlândia',
  fin: 'Finlândia',
  finland: 'Finlândia',
  'finlândia': 'Finlândia',
  finlandia: 'Finlândia',
  ie: 'Irlanda',
  irl: 'Irlanda',
  ireland: 'Irlanda',
  irlanda: 'Irlanda',
  za: 'África do Sul',
  zaf: 'África do Sul',
  'south africa': 'África do Sul',
  'áfrica do sul': 'África do Sul',
  eg: 'Egito',
  egy: 'Egito',
  egypt: 'Egito',
  egito: 'Egito',
  il: 'Israel',
  isr: 'Israel',
  israel: 'Israel',
  ua: 'Ucrânia',
  ukr: 'Ucrânia',
  ukraine: 'Ucrânia',
  'ucrânia': 'Ucrânia',
  ucrania: 'Ucrânia',
  cz: 'República Tcheca',
  cze: 'República Tcheca',
  'czech republic': 'República Tcheca',
  czechia: 'República Tcheca',
  'república tcheca': 'República Tcheca',
  'tchéquia': 'República Tcheca',
  hu: 'Hungria',
  hun: 'Hungria',
  hungary: 'Hungria',
  hungria: 'Hungria',
  ro: 'Romênia',
  rou: 'Romênia',
  romania: 'Romênia',
  'romênia': 'Romênia',
  romenia: 'Romênia',
  gr: 'Grécia',
  grc: 'Grécia',
  greece: 'Grécia',
  'grécia': 'Grécia',
  grecia: 'Grécia',
  su: 'União Soviética',
  ussr: 'União Soviética',
  'soviet union': 'União Soviética',
  'união soviética': 'União Soviética',
};

let cachedPtBrLanguageNames: Intl.DisplayNames | null | undefined;
let cachedPtBrRegionNames: Intl.DisplayNames | null | undefined;

function getPtBrDisplayNames(type: 'language' | 'region'): Intl.DisplayNames | null {
  if (type === 'language') {
    if (cachedPtBrLanguageNames !== undefined) return cachedPtBrLanguageNames;
    try {
      cachedPtBrLanguageNames = new Intl.DisplayNames(['pt-BR'], { type: 'language', fallback: 'none' });
    } catch {
      cachedPtBrLanguageNames = null;
    }
    return cachedPtBrLanguageNames;
  }
  if (cachedPtBrRegionNames !== undefined) return cachedPtBrRegionNames;
  try {
    cachedPtBrRegionNames = new Intl.DisplayNames(['pt-BR'], { type: 'region', fallback: 'none' });
  } catch {
    cachedPtBrRegionNames = null;
  }
  return cachedPtBrRegionNames;
}

function capitalizePtBrLabel(label: string): string {
  const clean = label.trim();
  if (!clean) return '';
  return clean.charAt(0).toLocaleUpperCase('pt-BR') + clean.slice(1);
}

export function translateLanguageToPtBr(raw: string): string {
  const clean = raw.replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  const direct = LANGUAGE_PT_BR_MAP[clean.toLowerCase()];
  if (direct) return direct;
  if (/^[a-z]{2,3}(?:-[a-z]{2,4})?$/i.test(clean)) {
    try {
      const resolved = getPtBrDisplayNames('language')?.of(clean.toLowerCase());
      if (resolved && resolved.toLowerCase() !== clean.toLowerCase()) {
        return capitalizePtBrLabel(resolved);
      }
    } catch {
      // ignore invalid language tags
    }
  }
  return clean;
}

export function translateCountryToPtBr(raw: string): string {
  const clean = raw.replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  const direct = COUNTRY_PT_BR_MAP[clean.toLowerCase()];
  if (direct) return direct;
  if (/^[a-z]{2}$/i.test(clean)) {
    try {
      const resolved = getPtBrDisplayNames('region')?.of(clean.toUpperCase());
      if (resolved && resolved.toLowerCase() !== clean.toLowerCase()) {
        return capitalizePtBrLabel(resolved);
      }
    } catch {
      // ignore invalid region codes
    }
  }
  return clean;
}

function translateMetaList(
  raw: string | undefined,
  translator: (item: string) => string
): string[] {
  const parsed = parseMetaValueList(raw);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of parsed) {
    const translated = translator(item);
    if (!translated) continue;
    const key = translated.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(translated);
  }
  return out;
}

export function translateLanguageValueToPtBr(raw?: string): string | undefined {
  const items = translateMetaList(raw, translateLanguageToPtBr);
  return items.length > 0 ? items.join(', ') : undefined;
}

export function translateCountryValueToPtBr(raw?: string): string | undefined {
  const items = translateMetaList(raw, translateCountryToPtBr);
  return items.length > 0 ? items.join(', ') : undefined;
}

export type AnimeMetaKind =
  | 'status'
  | 'rating'
  | 'shield'
  | 'date'
  | 'clock'
  | 'layers'
  | 'studio'
  | 'network'
  | 'globe'
  | 'server';

export interface AnimeInfoMetaItem {
  id: string;
  label: string;
  value: string;
  items?: string[];
  kind: AnimeMetaKind;
  highlight?: boolean;
  fullWidth?: boolean;
}

/**
 * Splits a multi-value metadata string (such as studios, networks, languages, or countries)
 * into deduplicated items without breaking legal company suffixes like `Warner Bros., Inc.`.
 */
export function parseMetaValueList(raw?: string): string[] {
  if (!raw || !raw.trim()) return [];
  const parts = raw
    .split(/\s*(?:,(?!\s*(?:inc|ltd|co|llc|corp|s\.?a)\.?(?:\b|$))|;|·|•|\|)\s*/i)
    .map((p) => p.trim())
    .filter(Boolean);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of parts) {
    const key = part.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(part);
  }
  return out;
}

export function parseProviderNames(raw?: string): string[] {
  if (!raw || !raw.trim()) return [];
  const parts = raw
    .split(/\s*(?:,|·|•|\+|\||\/)\s*/)
    .map((p) => p.trim())
    .filter(Boolean);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of parts) {
    const key = part.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(part);
  }
  return out;
}

function inferProviderFromUrl(rawUrl?: string): string | null {
  if (!rawUrl) return null;
  if (/hinatasoul/i.test(rawUrl)) return 'Hinata Soul';
  if (/topanimes/i.test(rawUrl)) return 'TopAnimes';
  return null;
}

export function extractAnimeProviders(anime: Pick<
  AnimeDetails,
  'sourceServerName' | 'url' | 'episodes' | 'audioTracks'
>): string[] {
  const providers: string[] = [];
  const seen = new Set<string>();

  const pushProvider = (name: string | null | undefined) => {
    const clean = (name || '').trim();
    if (!clean) return;
    const key = clean.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    providers.push(clean);
  };

  for (const name of parseProviderNames(anime.sourceServerName)) {
    pushProvider(name);
  }

  const allEpisodes = [
    ...(anime.episodes || []),
    ...(anime.audioTracks?.DUB?.episodes || []),
    ...(anime.audioTracks?.LEG?.episodes || []),
  ];

  for (const ep of allEpisodes) {
    if (ep.availableOnServer === false) continue;
    pushProvider(inferProviderFromUrl(ep.url));
  }

  if (providers.length === 0) {
    pushProvider(inferProviderFromUrl(anime.url));
  }

  return providers;
}

const LONG_SINGLE_META_THRESHOLD = 22;

export function buildAnimeInfoMetaItems(anime: AnimeDetails): AnimeInfoMetaItem[] {
  const compactItems: AnimeInfoMetaItem[] = [];
  const fullWidthItems: AnimeInfoMetaItem[] = [];

  const pushMeta = (item: AnimeInfoMetaItem) => {
    if (item.fullWidth) {
      fullWidthItems.push(item);
    } else {
      compactItems.push(item);
    }
  };

  if (anime.status) {
    pushMeta({
      id: 'status',
      label: 'Status',
      value: anime.status,
      kind: 'status',
      highlight: /em exibição|lançamento|airing|ongoing|continuing/i.test(anime.status),
    });
  }

  const parsedRating = anime.rating ? Number.parseFloat(anime.rating) : Number.NaN;
  if (anime.rating && Number.isFinite(parsedRating) && parsedRating > 0) {
    pushMeta({
      id: 'rating',
      label: 'Nota',
      value: anime.rating.trim(),
      kind: 'rating',
    });
  }

  if (anime.contentRating && anime.contentRating.trim()) {
    const ratingText = anime.contentRating.trim();
    pushMeta({
      id: 'contentRating',
      label: 'Classificação',
      value: ratingText,
      kind: 'shield',
      ...(ratingText.length > LONG_SINGLE_META_THRESHOLD ? { fullWidth: true } : {}),
    });
  }

  if (anime.firstAirDate) {
    pushMeta({
      id: 'firstAirDate',
      label: 'Estreia',
      value: formatEpisodeReleaseDate(anime.firstAirDate) || anime.firstAirDate,
      kind: 'date',
    });
  } else if (anime.year) {
    pushMeta({ id: 'year', label: 'Ano', value: anime.year, kind: 'date' });
  }

  if (anime.lastAirDate) {
    pushMeta({
      id: 'lastAirDate',
      label: 'Recente',
      value: formatEpisodeReleaseDate(anime.lastAirDate) || anime.lastAirDate,
      kind: 'date',
    });
  }

  if (anime.averageDuration) {
    pushMeta({
      id: 'duration',
      label: 'Duração',
      value: anime.averageDuration,
      kind: 'clock',
    });
  }

  if (anime.seasonsCount) {
    pushMeta({
      id: 'seasons',
      label: 'Temporadas',
      value: anime.seasonsCount,
      kind: 'layers',
    });
  }

  const languages = translateMetaList(anime.originalLanguage, translateLanguageToPtBr);
  if (languages.length > 0) {
    const isMulti = languages.length > 1;
    const joined = languages.join(', ');
    pushMeta({
      id: 'language',
      label: isMulti ? 'Idiomas originais' : 'Idioma original',
      value: joined,
      items: languages,
      kind: 'globe',
      fullWidth: isMulti || joined.length > LONG_SINGLE_META_THRESHOLD,
    });
  }

  const countries = translateMetaList(anime.originalCountry, translateCountryToPtBr);
  if (countries.length > 0) {
    const isMulti = countries.length > 1;
    const joined = countries.join(', ');
    pushMeta({
      id: 'country',
      label: isMulti ? 'Países' : 'País',
      value: joined,
      items: countries,
      kind: 'globe',
      fullWidth: isMulti || joined.length > LONG_SINGLE_META_THRESHOLD,
    });
  }

  const studios = parseMetaValueList(anime.studio);
  if (studios.length > 0) {
    const isMulti = studios.length > 1;
    const joined = studios.join(', ');
    pushMeta({
      id: 'studio',
      label: isMulti ? 'Estúdios' : 'Estúdio',
      value: joined,
      items: studios,
      kind: 'studio',
      fullWidth: isMulti || joined.length > LONG_SINGLE_META_THRESHOLD,
    });
  }

  const networks = parseMetaValueList(anime.network);
  if (networks.length > 0) {
    const isMulti = networks.length > 1;
    const joined = networks.join(', ');
    pushMeta({
      id: 'network',
      label: isMulti ? 'Redes' : 'Rede',
      value: joined,
      items: networks,
      kind: 'network',
      fullWidth: isMulti || joined.length > LONG_SINGLE_META_THRESHOLD,
    });
  }

  const providers = extractAnimeProviders(anime);
  if (providers.length > 0) {
    pushMeta({
      id: 'providers',
      label: providers.length > 1 ? 'Provedores' : 'Provedor',
      value: providers.join(' · '),
      items: providers,
      kind: 'server',
      fullWidth: providers.length > 1,
    });
  }

  return [...compactItems, ...fullWidthItems];
}

export type HeroAudioBadge = 'DUB' | 'LEG';

export function resolveAnimeHeroAudioBadges(
  anime: Pick<AnimeDetails, 'audioType' | 'audioTracks' | 'kind'>
): HeroAudioBadge[] {
  const isMovie = anime.kind === 'movie';
  const dubTrack = anime.audioTracks?.DUB;
  const legTrack = anime.audioTracks?.LEG;

  const hasBothTracks = Boolean(
    !isMovie &&
      dubTrack &&
      legTrack &&
      dubTrack.episodes.length > 0 &&
      legTrack.episodes.length > 0 &&
      (dubTrack.playableCount > 0 || legTrack.playableCount > 0)
  );
  if (hasBothTracks) {
    return ['DUB', 'LEG'];
  }

  const hasDubTrack = Boolean(
    !isMovie && dubTrack && dubTrack.episodes.length > 0 && dubTrack.playableCount > 0
  );
  const hasLegTrack = Boolean(
    !isMovie && legTrack && legTrack.episodes.length > 0 && legTrack.playableCount > 0
  );
  if (hasDubTrack && hasLegTrack) return ['DUB', 'LEG'];
  if (hasDubTrack) return ['DUB'];
  if (hasLegTrack) return ['LEG'];

  if (anime.audioType === 'DUB' || anime.audioType === 'LEG') {
    return [anime.audioType];
  }
  return [];
}

function cleanGenreList(
  genres: readonly string[] | undefined,
  redundantLabel: string
): string[] {
  if (!genres || genres.length === 0) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of genres) {
    const clean = raw.trim();
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (key === redundantLabel) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }
  return out;
}

export function resolveVisibleGenres(
  primaryGenres?: readonly string[],
  fallbackGenres?: readonly string[],
  kind?: MediaKind | null
): string[] {
  const redundantLabel = kind === 'movie' ? 'filme' : kind === 'series' ? 'série' : 'anime';
  const primary = cleanGenreList(primaryGenres, redundantLabel);
  if (primary.length > 0) return primary;
  return cleanGenreList(fallbackGenres, redundantLabel);
}

export function resolveEpisodeMediaKind(params: {
  isMovie?: boolean;
  mediaType?: 'anime' | 'series' | 'movie';
  seriesKind?: MediaKind | null;
  seriesUrl?: string;
  url?: string;
}): 'anime' | 'series' | 'movie' {
  if (
    params.isMovie ||
    params.mediaType === 'movie' ||
    params.seriesKind === 'movie' ||
    /\/filmes?\//i.test(params.url || '') ||
    /\/filmes?\//i.test(params.seriesUrl || '')
  ) {
    return 'movie';
  }
  if (
    params.mediaType === 'series' ||
    params.seriesKind === 'series' ||
    /\/series\//i.test(params.seriesUrl || '') ||
    /\/series\//i.test(params.url || '')
  ) {
    return 'series';
  }
  return 'anime';
}

function inferAudioFromText(text?: string): HeroAudioBadge | null {
  if (!text) return null;
  if (/\bdublado\b|\bdub\b|-dublado\b|-dub(?=\/|-|$|\d)/i.test(text)) return 'DUB';
  if (/\blegendado\b|\bleg\b|-legendado\b|-leg(?=\/|-|$|\d)/i.test(text)) return 'LEG';
  return null;
}

export function resolveEpisodeAudioBadges(params: {
  matchedEpisodeAudio?: AudioType;
  selectedOptionAudio?: AudioType;
  seriesAudioType?: AudioType;
  title?: string;
  seriesTitle?: string;
  url?: string;
  seriesUrl?: string;
  options?: readonly { audioType?: AudioType; label?: string }[];
}): HeroAudioBadge[] {
  if (params.matchedEpisodeAudio === 'DUB' || params.matchedEpisodeAudio === 'LEG') {
    return [params.matchedEpisodeAudio];
  }

  const fromTitleOrUrl =
    inferAudioFromText(params.title) ||
    inferAudioFromText(params.url) ||
    inferAudioFromText(params.seriesTitle) ||
    inferAudioFromText(params.seriesUrl);
  if (fromTitleOrUrl) {
    return [fromTitleOrUrl];
  }

  if (params.selectedOptionAudio === 'DUB' || params.selectedOptionAudio === 'LEG') {
    return [params.selectedOptionAudio];
  }

  if (params.seriesAudioType === 'DUB' || params.seriesAudioType === 'LEG') {
    return [params.seriesAudioType];
  }

  if (params.options && params.options.length > 0) {
    const found = new Set<HeroAudioBadge>();
    for (const opt of params.options) {
      if (opt.audioType === 'DUB' || opt.audioType === 'LEG') {
        found.add(opt.audioType);
      } else {
        const inferred = inferAudioFromText(opt.label);
        if (inferred) found.add(inferred);
      }
    }
    const ordered: HeroAudioBadge[] = [];
    if (found.has('DUB')) ordered.push('DUB');
    if (found.has('LEG')) ordered.push('LEG');
    return ordered;
  }

  return [];
}

export function isSynopsisTextOverflowing(params: {
  scrollHeight: number;
  clientHeight: number;
  lineHeight: number;
  isExpanded: boolean;
  maxLines?: number;
}): boolean {
  const maxLines = params.maxLines ?? 4;
  if (params.scrollHeight <= 0) return false;
  if (!params.isExpanded) {
    if (params.clientHeight <= 0) return false;
    return params.scrollHeight > params.clientHeight + 1;
  }
  if (Number.isFinite(params.lineHeight) && params.lineHeight > 0) {
    return params.scrollHeight > params.lineHeight * maxLines + 2;
  }
  return true;
}

/**
 * Formats a season header label, appending an optional custom TheTVDB arc/season name
 * (e.g. `Temporada 2 · Distrito do Entretenimento`) while skipping redundant generic names.
 */
export function formatSeasonDisplayHeading(
  seasonNumber: number,
  fallbackLabel: string,
  seasonNames?: Readonly<Record<number, string>>
): string {
  const custom = seasonNames?.[seasonNumber]?.trim();
  if (!custom) return fallbackLabel;
  if (custom.toLowerCase() === fallbackLabel.trim().toLowerCase()) {
    return fallbackLabel;
  }
  return `${fallbackLabel} · ${custom}`;
}




