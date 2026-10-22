import { cn } from "@/lib/utils";

const sprite = [
  "     oooooo     ",
  "   ooaaaaaaoo   ",
  "  oaaaaaaaaaao  ",
  " oaaaaaaaaaaaao ",
  " oaaaaaaaaaaaao ",
  "oaaawwaaaawwaaao",
  "oaaakkaaaakkaaao",
  "oaapaaaaaaaapaao",
  "oaaaaakaakaaaaao",
  "oaaaaaakkaaaaaao",
  " oaaaaaaaaaaaao ",
  " oaaaaaaaaaaaao ",
  "  oaaaaaaaaaao  ",
  "   ooaaaaaaoo   ",
  "   okkoookko    ",
  "    oo  oo      ",
];

export function PixelPet({ color = "#a78bfa", className, sleepy = false }: { color?: string; className?: string; sleepy?: boolean }) {
  const palette: Record<string, string> = { o: "#303331", a: color, w: "#fffdf5", k: "#303331", p: "#f5a9b8" };
  return (
    <svg viewBox="0 0 16 16" role="img" aria-label={sleepy ? "Mascote pixel descansando" : "Mascote pixel sorridente"} className={cn("pixel-pet", className)} shapeRendering="crispEdges">
      {sprite.flatMap((line, y) => [...line].map((pixel, x) => pixel === " " ? null : <rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" fill={palette[pixel]} />))}
    </svg>
  );
}
