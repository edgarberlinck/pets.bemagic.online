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

export function evolvePet<T extends PetStats>(pet: T, updatedAt: Date | string, now = new Date()): T {
  const hours = Math.min(48, Math.max(0, (now.getTime() - new Date(updatedAt).getTime()) / 3_600_000));
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
