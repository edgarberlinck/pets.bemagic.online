export const THEMES = {
  meadow: { name: "Jardim encantado", sky: "#ecfdf5", ground: "#bbd9a5", accent: "#34735a", pet: "#a78bfa", night: false },
  sunset: { name: "Pôr do sol", sky: "#fff0dc", ground: "#e8b598", accent: "#a44e39", pet: "#f59e8b", night: false },
  cosmos: { name: "Noite cósmica", sky: "#242546", ground: "#5b548b", accent: "#6357ab", pet: "#c4b5fd", night: true },
  ocean: { name: "Fundo do mar", sky: "#e0f2fe", ground: "#9bc9d0", accent: "#227f95", pet: "#6dd4c5", night: false },
  candy: { name: "Doce aventura", sky: "#fce7f3", ground: "#e8bcda", accent: "#a0477d", pet: "#f9a8d4", night: false },
} as const;

export type ThemeName = keyof typeof THEMES;
export const ACTIONS = ["feed", "play", "sleep", "clean"] as const;
export type PetAction = typeof ACTIONS[number];
export type PetStats = { hunger: number; happiness: number; energy: number; cleanliness: number };
export type GamePet = PetStats & {
  id: string;
  name: string;
  theme: string;
  petColor: string;
  backgroundColor: string;
  updatedAt: string;
  createdAt: string;
  version: number;
};
export const ACTION_COOLDOWN_MS = 10_000;
const clamp = (value: number) => Math.max(0, Math.min(100, value));

// Pet starts tiny and reaches full size after GROW_DAYS days.
const GROW_DAYS = 7;
export function growthScale(createdAt: Date | string | number, now: Date | number = Date.now()): number {
  const days = (new Date(now).getTime() - new Date(createdAt).getTime()) / 86_400_000;
  return 0.35 + 0.65 * Math.min(1, Math.max(0, days / GROW_DAYS));
}

// ---- Personality & daily routine (pets behave like small children) ----
// The routine follows the player's device clock: `tz` is minutes east of UTC
// (default -180 = Brasilia). Bedtime is early (~19h) and shifts with energy.
export const PERSONALITIES = {
  brincalhao: { name: "Brincalhão", bed: 20 * 60, wake: 6 * 60 + 30, quiet: 0.15, nap: false },
  tranquilo: { name: "Tranquilo", bed: 19 * 60, wake: 7 * 60, quiet: 0.6, nap: false },
  guloso: { name: "Guloso", bed: 19 * 60 + 30, wake: 6 * 60 + 30, quiet: 0.35, nap: false },
  dorminhoco: { name: "Dorminhoco", bed: 19 * 60, wake: 7 * 60 + 30, quiet: 0.45, nap: true },
} as const;
export type PersonalityKey = keyof typeof PERSONALITIES;
export type Want = "sleep" | "feed" | "play" | "quiet" | "clean";
export const DEFAULT_TZ = -180;
export function validTz(value: unknown): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= -840 && n <= 840 ? n : DEFAULT_TZ;
}

function hash(text: string) {
  let h = 7;
  for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
}
export function personalityOf(seed: string): PersonalityKey {
  const keys = Object.keys(PERSONALITIES) as PersonalityKey[];
  return keys[hash(seed) % keys.length];
}
const localMs = (ms: number, tz: number) => ms + tz * 60_000;
const minuteOfDay = (ms: number, tz: number) => Math.floor((((localMs(ms, tz) % 86_400_000) + 86_400_000) % 86_400_000) / 60_000);
// Tired pets (low energy) go to bed an hour earlier; energetic ones stay up 30 min more.
export function isAsleepAt(seed: string, ms: number, tz = DEFAULT_TZ, energy = 50): boolean {
  const p = PERSONALITIES[personalityOf(seed)];
  const m = minuteOfDay(ms, tz);
  const bed = p.bed + (energy < 30 ? -60 : energy > 70 ? 30 : 0);
  if (p.nap && m >= 13 * 60 && m < 15 * 60) return true;
  return m >= bed || m < p.wake;
}
export function sleepsUntil(seed: string, ms: number, tz = DEFAULT_TZ): number {
  let t = ms;
  while (isAsleepAt(seed, t, tz, 100) && t < ms + 86_400_000) t += 60_000;
  return t;
}
export function petWant(pet: PetStats, seed: string, now: Date | number = Date.now(), tz = DEFAULT_TZ): Want {
  const ms = new Date(now).getTime();
  if (isAsleepAt(seed, ms, tz, pet.energy)) return "sleep";
  const p = PERSONALITIES[personalityOf(seed)];
  const justWoke = isAsleepAt(seed, ms - 90 * 60_000, tz, 100);
  if ((justWoke && pet.hunger < 90) || pet.hunger < 35) return "feed";
  if (pet.cleanliness < 25) return "clean";
  const slot = Math.floor(localMs(ms, tz) / (2 * 3_600_000));
  return (hash(`${seed}:${slot}`) % 100) / 100 < p.quiet ? "quiet" : "play";
}
// Returns a reason string when the pet refuses the action right now.
export function actionBlocked(pet: PetStats, seed: string, action: PetAction, now: Date | number = Date.now(), tz = DEFAULT_TZ): string | null {
  const want = petWant(pet, seed, now, tz);
  if (want === "sleep") return "Shhh… ele está dormindo. Volte quando acordar.";
  if (action === "play" && want === "quiet") return "Ele quer ficar quietinho agora. Tente mais tarde.";
  return null;
}
// 0 (full day) .. 0.6 (deep night), from the device clock, for the scenery.
export function skyDim(date: Date | number): number {
  const d = new Date(date);
  const h = d.getHours() + d.getMinutes() / 60;
  if (h >= 20 || h < 5) return 0.6;
  if (h >= 18) return 0.6 * (h - 18) / 2;
  if (h < 7) return 0.6 * (7 - h) / 2;
  return 0;
}

export function evolvePet<T extends PetStats>(pet: T, updatedAt: Date | string, now = new Date(), seed?: string, tz = DEFAULT_TZ): T {
  const start = new Date(updatedAt).getTime();
  const end = now.getTime();
  if (seed) {
    // Simulate in 30-minute steps so sleeping hours restore energy.
    const stop = Math.min(end, start + 48 * 3_600_000);
    let { hunger, happiness, energy, cleanliness } = pet;
    let t = start;
    let sleeping = isAsleepAt(seed, t, tz, energy);
    while (t < stop) {
      const h = Math.min(30 * 60_000, stop - t) / 3_600_000;
      if (sleeping) { hunger -= 1.5 * h; energy += 8 * h; cleanliness -= 0.5 * h; }
      else { hunger -= 4 * h; happiness -= 3 * h; energy -= 2 * h; cleanliness -= 3 * h; }
      energy = clamp(energy);
      const next = isAsleepAt(seed, t + 30 * 60_000, tz, energy);
      if (sleeping && !next) hunger -= 15; // wakes up hungry
      sleeping = next;
      t += 30 * 60_000;
      hunger = clamp(hunger); happiness = clamp(happiness); cleanliness = clamp(cleanliness);
    }
    return { ...pet, hunger, happiness, energy, cleanliness };
  }
  const hours = Math.min(48, Math.max(0, (end - start) / 3_600_000));
  return {
    ...pet,
    hunger: clamp(pet.hunger - hours * 4),
    happiness: clamp(pet.happiness - hours * 3),
    energy: clamp(pet.energy - hours * 2),
    cleanliness: clamp(pet.cleanliness - hours * 3),
  };
}

export function applyAction<T extends PetStats>(pet: T, action: PetAction): T {
  const next = { ...pet };
  if (action === "feed") {
    next.hunger += 25;
    next.cleanliness -= 5;
  } else if (action === "play") {
    next.happiness += 25;
    next.energy -= 12;
    next.hunger -= 8;
  } else if (action === "sleep") {
    next.energy += 30;
    next.hunger -= 5;
  } else if (action === "clean") {
    next.cleanliness += 35;
    next.happiness += 5;
  }
  return { ...next, hunger: clamp(next.hunger), happiness: clamp(next.happiness), energy: clamp(next.energy), cleanliness: clamp(next.cleanliness) };
}

export function isTheme(value: unknown): value is ThemeName {
  return typeof value === "string" && Object.hasOwn(THEMES, value);
}

export function isColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}

export function petMood(pet: PetStats) {
  const lowest = Math.min(pet.hunger, pet.happiness, pet.energy, pet.cleanliness);
  return lowest < 25 ? "Precisando de carinho" : lowest < 50 ? "Que tal um cuidado?" : "Feliz da vida";
}
