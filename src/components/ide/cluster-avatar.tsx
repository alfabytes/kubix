import { useId } from "react";

import type {
  AvatarEyes,
  AvatarFinish,
  AvatarShape,
  ClusterAvatarConfig,
} from "@/stores/cluster-profile-store";

const PROFILE_PALETTE = [
  "#9a3412", // burnt terracotta
  "#1e3a8a", // royal navy
  "#14532d", // forest green
  "#3b0764", // deep violet
  "#475569", // slate gray
  "#155e75", // deep teal
  "#7c2d12", // warm amber-brown
  "#1e1b4b", // indigo night
];

/** 17 vibrant character colors matching the 2x9 swatch grid (after the Auto "A" slot). */
export const AVATAR_COLOR_SWATCHES = [
  // Row 1 (8 colors after Auto)
  "#ef4444", // red
  "#f97316", // orange
  "#facc15", // yellow
  "#84cc16", // lime
  "#22c55e", // green
  "#2dd4bf", // mint
  "#38bdf8", // cyan
  "#3b82f6", // sky blue
  // Row 2 (9 colors)
  "#2563eb", // cobalt
  "#6366f1", // indigo
  "#a855f7", // violet
  "#e040c8", // magenta plush pink
  "#f472b6", // soft pink
  "#be123c", // crimson
  "#854d27", // brown
  "#d6b88d", // sand
  "#9ca3af", // stone gray
];

export const AVATAR_SHAPES: Array<{ id: AvatarShape; label: string }> = [
  { id: "circle", label: "Circle" },
  { id: "blob", label: "Blob" },
  { id: "squircle", label: "Squircle" },
  { id: "pill", label: "Pill" },
  { id: "triangle", label: "Triangle" },
  { id: "hexagon", label: "Hexagon" },
  { id: "cloud", label: "Cloud" },
  { id: "square", label: "Square" },
  { id: "diamond", label: "Diamond" },
  { id: "pentagon", label: "Pentagon" },
];

export const AVATAR_EYES: Array<{ id: AvatarEyes; label: string }> = [
  { id: "glance-up", label: "Glance Up" },
  { id: "tall-bars", label: "Tall Bars" },
  { id: "round", label: "Round" },
  { id: "oval-tilt", label: "Oval Tilt" },
  { id: "sleepy-top", label: "Sleepy" },
  { id: "angry", label: "Mischievous" },
  { id: "determined", label: "Focused" },
  { id: "v-happy", label: "Cheerful" },
  { id: "wide-ovals", label: "Wide Awake" },
  { id: "side-eye", label: "Side Eye" },
  { id: "skeptical", label: "Curious" },
  { id: "shy-tilt", label: "Shy Tilt" },
  { id: "squint-happy", label: "Cozy" },
  { id: "look-down", label: "Bashful" },
  { id: "flat-line", label: "Deadpan" },
  { id: "tiny-dots", label: "Tiny Dots" },
];

export function getClusterProfileMeta(name: string): {
  initials: string;
  bgColor: string;
  shortName: string;
  autoCharacterColor: string;
} {
  const clean = name.trim();
  let target = clean;
  const embeddedArnIdx = clean.indexOf("_arn:");
  if (embeddedArnIdx > 0) {
    target = clean.slice(0, embeddedArnIdx);
  } else if (clean.includes("/")) {
    const afterSlash = clean.slice(clean.lastIndexOf("/") + 1).trim();
    if (afterSlash) target = afterSlash;
  }

  const parts = target.split(/[-_./:\s]+/).filter(Boolean);
  let initials = "CL";
  if (parts.length >= 2) {
    initials = parts
      .slice(0, 3)
      .map((p) => p[0] ?? "")
      .join("")
      .toUpperCase();
  } else if (target.length <= 3 && target.length > 0) {
    initials = target.toUpperCase();
  } else if (target.length > 3) {
    initials = target.slice(0, 2).toUpperCase();
  }

  let hash = 0;
  for (let i = 0; i < clean.length; i += 1) {
    hash = (hash * 31 + clean.charCodeAt(i)) >>> 0;
  }
  const bgColor = PROFILE_PALETTE[hash % PROFILE_PALETTE.length] ?? PROFILE_PALETTE[0]!;
  const autoCharacterColor =
    AVATAR_COLOR_SWATCHES[hash % AVATAR_COLOR_SWATCHES.length] ?? "#e040c8";
  return { initials, bgColor, shortName: target, autoCharacterColor };
}

function parseHex(hex: string): [number, number, number] {
  const clean = hex.replace("#", "").trim();
  const full =
    clean.length === 3
      ? clean
          .split("")
          .map((c) => c + c)
          .join("")
      : clean.padEnd(6, "0").slice(0, 6);
  const num = Number.parseInt(full, 16);
  if (Number.isNaN(num)) return [224, 64, 200];
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

function mixHex(baseHex: string, targetHex: string, amount: number): string {
  const [r1, g1, b1] = parseHex(baseHex);
  const [r2, g2, b2] = parseHex(targetHex);
  const r = Math.round(r1 + (r2 - r1) * amount);
  const g = Math.round(g1 + (g2 - g1) * amount);
  const b = Math.round(b1 + (b2 - b1) * amount);
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

function shapePath(shape: AvatarShape): string {
  switch (shape) {
    case "circle":
      return "M32 8 C45.25 8 56 18.75 56 32 C56 45.25 45.25 56 32 56 C18.75 56 8 45.25 8 32 C8 18.75 18.75 8 32 8 Z";
    case "blob":
      // Playful organic plush pebble tilted slightly like the pink mascot
      return "M35 8.5 C47.5 8 56.5 16.5 55.5 29.5 C54.5 43 46.5 55 32.5 55.5 C18.5 56 8 47.5 8.5 34.5 C9 20.5 20.5 9.2 35 8.5 Z";
    case "squircle":
      return "M20 9 H44 C51 9 55 13 55 20 V44 C55 51 51 55 44 55 H20 C13 55 9 51 9 44 V20 C9 13 13 9 20 9 Z";
    case "pill":
      return "M20 17 H44 C52.5 17 58 23.5 58 32 C58 40.5 52.5 47 44 47 H20 C11.5 47 6 40.5 6 32 C6 23.5 11.5 17 20 17 Z";
    case "triangle":
      return "M27.4 12.2 C29.5 8.6 34.5 8.6 36.6 12.2 L54.6 43.8 C56.7 47.5 54 52 49.8 52 H14.2 C10 52 7.3 47.5 9.4 43.8 Z";
    case "hexagon":
      return "M21.2 11.2 H42.8 C45.2 11.2 47.4 12.5 48.6 14.6 L56.8 28.8 C58 30.8 58 33.2 56.8 35.2 L48.6 49.4 C47.4 51.5 45.2 52.8 42.8 52.8 H21.2 C18.8 52.8 16.6 51.5 15.4 49.4 L7.2 35.2 C6 33.2 6 30.8 7.2 28.8 L15.4 14.6 C16.6 12.5 18.8 11.2 21.2 11.2 Z";
    case "cloud":
      return "M22 49 C13 49 7 43 7 35.5 C7 29.2 11.4 24.1 17.5 22.8 C19.8 14.8 26.5 10.5 33.8 10.5 C41.8 10.5 48.2 15.6 49.6 23.2 C54.4 25.1 57.5 29.7 57.5 35.2 C57.5 43 51.4 49 43 49 Z";
    case "square":
      return "M16 10 H48 C51.3 10 54 12.7 54 16 V48 C54 51.3 51.3 54 48 54 H16 C12.7 54 10 51.3 10 48 V16 C10 12.7 12.7 10 16 10 Z";
    case "diamond":
      return "M27.8 9.2 C30.1 6.9 33.9 6.9 36.2 9.2 L54.8 27.8 C57.1 30.1 57.1 33.9 54.8 36.2 L36.2 54.8 C33.9 57.1 30.1 57.1 27.8 54.8 L9.2 36.2 C6.9 33.9 6.9 30.1 9.2 27.8 Z";
    case "pentagon":
      return "M28.6 9.8 C30.6 8.3 33.4 8.3 35.4 9.8 L53.4 23 C55.4 24.5 56.2 27.1 55.5 29.4 L48.8 49.8 C48 52.1 45.8 53.6 43.4 53.6 H20.6 C18.2 53.6 16 52.1 15.2 49.8 L8.5 29.4 C7.8 27.1 8.6 24.5 10.6 23 Z";
  }
}

function EyesLayer({
  eyes,
  finish,
  yOffset = 0,
}: {
  eyes: AvatarEyes;
  finish: AvatarFinish;
  yOffset?: number;
}) {
  const fill = finish === "plush" ? "#f6f2e2" : "#ffffff";
  const shadow = finish === "plush" ? "rgba(0,0,0,0.28)" : "rgba(0,0,0,0.12)";

  const renderPrimitives = (dx = 0, dy = 0, color = fill) => {
    const t = `translate(${dx} ${dy + yOffset})`;
    switch (eyes) {
      case "glance-up":
        return (
          <g transform={t} fill={color}>
            <rect x="33.5" y="18.5" width="3.4" height="6.8" rx="1.7" transform="rotate(-18 35.2 21.9)" />
            <rect x="42.5" y="20" width="3.4" height="6.8" rx="1.7" transform="rotate(-16 44.2 23.4)" />
          </g>
        );
      case "tall-bars":
        return (
          <g transform={t} fill={color}>
            <rect x="24.5" y="25.5" width="3.8" height="9.2" rx="1.9" />
            <rect x="35.7" y="25.5" width="3.8" height="9.2" rx="1.9" />
          </g>
        );
      case "round":
        return (
          <g transform={t} fill={color}>
            <circle cx="24.8" cy="31.5" r="5" />
            <circle cx="39.2" cy="31.5" r="5" />
          </g>
        );
      case "oval-tilt":
        return (
          <g transform={t} fill={color}>
            <ellipse cx="25.2" cy="32" rx="3.4" ry="5.2" transform="rotate(-14 25.2 32)" />
            <ellipse cx="38.8" cy="32" rx="3.4" ry="5.2" transform="rotate(10 38.8 32)" />
          </g>
        );
      case "sleepy-top":
        return (
          <g transform={t} fill={color}>
            <rect x="22" y="27.5" width="6.2" height="3.2" rx="1.6" />
            <rect x="35.8" y="27.5" width="6.2" height="3.2" rx="1.6" />
          </g>
        );
      case "angry":
        return (
          <g transform={t} fill={color}>
            <rect x="22.2" y="27.5" width="6.8" height="3.1" rx="1.55" transform="rotate(24 25.6 29)" />
            <rect x="35" y="27.5" width="6.8" height="3.1" rx="1.55" transform="rotate(-24 38.4 29)" />
          </g>
        );
      case "determined":
        return (
          <g transform={t} fill={color}>
            <rect x="22.8" y="28.2" width="6.5" height="2.8" rx="1.4" transform="rotate(34 26 29.6)" />
            <rect x="34.7" y="28.2" width="6.5" height="2.8" rx="1.4" transform="rotate(-34 38 29.6)" />
          </g>
        );
      case "v-happy":
        return (
          <g transform={t} fill={color}>
            <rect x="24.2" y="26.2" width="3.5" height="8" rx="1.75" transform="rotate(-24 26 30.2)" />
            <rect x="36.3" y="26.2" width="3.5" height="8" rx="1.75" transform="rotate(24 38 30.2)" />
          </g>
        );
      case "wide-ovals":
        return (
          <g transform={t} fill={color}>
            <ellipse cx="25" cy="33.5" rx="3.8" ry="6.2" />
            <ellipse cx="39" cy="33.5" rx="3.8" ry="6.2" />
          </g>
        );
      case "side-eye":
        return (
          <g transform={t} fill={color}>
            <rect x="28" y="27.5" width="3.4" height="7.2" rx="1.7" transform="rotate(-10 29.7 31.1)" />
            <rect x="39" y="28.5" width="5.8" height="3.1" rx="1.55" />
          </g>
        );
      case "skeptical":
        return (
          <g transform={t} fill={color}>
            <rect x="26.2" y="26.5" width="3.4" height="8.4" rx="1.7" />
            <rect x="38.2" y="28" width="3.4" height="6.8" rx="1.7" transform="rotate(-18 39.9 31.4)" />
          </g>
        );
      case "shy-tilt":
        return (
          <g transform={t} fill={color}>
            <rect x="29.5" y="30" width="3.6" height="7.6" rx="1.8" transform="rotate(-16 31.3 33.8)" />
            <rect x="39.8" y="29.5" width="3.6" height="7.6" rx="1.8" transform="rotate(-16 41.6 33.3)" />
          </g>
        );
      case "squint-happy":
        return (
          <g transform={t} fill={color}>
            <rect x="23.2" y="23.5" width="5.4" height="2.8" rx="1.4" />
            <rect x="35.4" y="23.5" width="5.4" height="2.8" rx="1.4" />
          </g>
        );
      case "look-down":
        return (
          <g transform={t} fill={color}>
            <rect x="19.5" y="35" width="3.3" height="6.8" rx="1.65" transform="rotate(-8 21.1 38.4)" />
            <rect x="28.5" y="35.2" width="3.3" height="6.8" rx="1.65" transform="rotate(-8 30.1 38.6)" />
          </g>
        );
      case "flat-line":
        return (
          <g transform={t} fill={color}>
            <rect x="20.5" y="30.8" width="6.8" height="2.5" rx="1.25" />
            <rect x="33.8" y="30.8" width="6.8" height="2.5" rx="1.25" />
          </g>
        );
      case "tiny-dots":
        return (
          <g transform={t} fill={color}>
            <circle cx="26" cy="31.5" r="2.3" />
            <circle cx="38" cy="31.5" r="2.3" />
          </g>
        );
    }
  };

  return (
    <g>
      {renderPrimitives(0, 1.3, shadow)}
      {renderPrimitives(0, 0, fill)}
    </g>
  );
}

export function CharacterAvatarSvg({
  shape,
  finish,
  eyes,
  color,
  animated = true,
}: {
  shape: AvatarShape;
  finish: AvatarFinish;
  eyes: AvatarEyes;
  color: string;
  animated?: boolean;
}) {
  const uid = useId().replace(/:/g, "");
  const path = shapePath(shape);
  const lightTint = mixHex(color, "#ffffff", 0.34);
  const midColor = color;
  const darkShade = mixHex(color, "#000000", 0.34);
  const rimGlow = mixHex(color, "#ffffff", 0.45);
  const yOffset = shape === "triangle" ? 5 : shape === "cloud" ? 2 : 0;

  return (
    <svg
      viewBox="0 0 64 64"
      className="h-full w-full overflow-visible"
      aria-hidden="true"
    >
      <defs>
        <radialGradient id={`plush-grad-${uid}`} cx="34%" cy="26%" r="72%">
          <stop offset="0%" stopColor={lightTint} />
          <stop offset="56%" stopColor={midColor} />
          <stop offset="100%" stopColor={darkShade} />
        </radialGradient>
        <linearGradient id={`flat-sheen-${uid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.16" />
          <stop offset="50%" stopColor="#ffffff" stopOpacity="0" />
          <stop offset="100%" stopColor="#000000" stopOpacity="0.14" />
        </linearGradient>
        {finish === "plush" ? (
          <filter id={`plush-fuzz-${uid}`} x="-12%" y="-12%" width="124%" height="124%">
            <feTurbulence
              type="fractalNoise"
              baseFrequency="0.65"
              numOctaves="2"
              seed="7"
              result="noise"
            />
            <feDisplacementMap
              in="SourceGraphic"
              in2="noise"
              scale="2.2"
              xChannelSelector="R"
              yChannelSelector="G"
            />
          </filter>
        ) : null}
        <clipPath id={`clip-${uid}`}>
          <path d={path} />
        </clipPath>
      </defs>

      <g className={animated ? "kubix-plush-breathe" : undefined}>
        {finish === "plush" ? (
          <>
            {/* Soft contact shadow */}
            <path d={path} fill="rgba(0,0,0,0.32)" transform="translate(0 2.4)" opacity="0.55" />
            {/* Fuzzy plush felt body */}
            <path
              d={path}
              fill={`url(#plush-grad-${uid})`}
              filter={`url(#plush-fuzz-${uid})`}
            />
            {/* Soft top-left velvet highlight */}
            <g clipPath={`url(#clip-${uid})`}>
              <ellipse
                cx="24"
                cy="20"
                rx="16"
                ry="10"
                transform="rotate(-24 24 20)"
                fill={rimGlow}
                opacity="0.28"
              />
              {/* Subtle plush fleece fibers */}
              <path
                d="M15 36 Q18 34 21 37 M42 18 Q45 16 47 20 M44 42 Q47 41 49 44 M22 46 Q25 45 27 48"
                stroke="#ffffff"
                strokeOpacity="0.14"
                strokeWidth="1.2"
                strokeLinecap="round"
                fill="none"
              />
            </g>
          </>
        ) : (
          <>
            <path d={path} fill={midColor} />
            <path d={path} fill={`url(#flat-sheen-${uid})`} />
          </>
        )}

        {/* Expressive Eyes with natural periodic blink */}
        <g className={animated ? "kubix-eyes-blink" : undefined}>
          <EyesLayer eyes={eyes} finish={finish} yOffset={yOffset} />
        </g>
      </g>
    </svg>
  );
}

export interface ClusterAvatarProps {
  contextName: string;
  config?: ClusterAvatarConfig;
  size?: "xs" | "sm" | "md" | "lg" | "xl";
  animated?: boolean;
  className?: string;
}

export function ClusterAvatar({
  contextName,
  config,
  size = "md",
  animated = true,
  className = "",
}: ClusterAvatarProps) {
  const profile = getClusterProfileMeta(contextName);
  const sizeClass =
    size === "xs"
      ? "h-7 w-7 rounded-lg text-[9.5px]"
      : size === "sm"
        ? "h-8 w-8 rounded-lg text-[10.5px]"
        : size === "lg"
          ? "h-12 w-12 rounded-xl text-[14px]"
          : size === "xl"
            ? "h-16 w-16 rounded-2xl text-[18px]"
            : "h-10 w-10 rounded-xl text-[11px]";

  if (config?.kind === "image" && config.dataUrl) {
    return (
      <span
        data-testid="cluster-avatar"
        data-avatar-kind="image"
        className={`relative flex shrink-0 items-center justify-center overflow-hidden bg-elevated shadow-sm ${sizeClass} ${className}`}
      >
        <img
          src={config.dataUrl}
          alt={profile.shortName}
          className="h-full w-full object-cover"
          draggable={false}
        />
        {config.animatedRing ? (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 rounded-[inherit] ring-2 ring-inset ring-cyan-400/75 kubix-pulse-ring"
          />
        ) : null}
      </span>
    );
  }

  if (config?.kind === "character") {
    const resolvedColor =
      config.color === "auto" || !config.color ? profile.autoCharacterColor : config.color;
    return (
      <span
        data-testid="cluster-avatar"
        data-avatar-kind="character"
        data-avatar-shape={config.shape}
        data-avatar-finish={config.finish}
        data-avatar-eyes={config.eyes}
        data-avatar-color={config.color}
        className={`relative flex shrink-0 items-center justify-center ${sizeClass} ${className}`}
      >
        <CharacterAvatarSvg
          shape={config.shape}
          finish={config.finish}
          eyes={config.eyes}
          color={resolvedColor}
          animated={animated}
        />
      </span>
    );
  }

  const label = (config?.kind === "initials" && config.label?.trim()) || profile.initials;
  const bg = (config?.kind === "initials" && config.bgColor) || profile.bgColor;

  return (
    <span
      data-testid="cluster-avatar"
      data-avatar-kind="initials"
      style={{ backgroundColor: bg }}
      className={`relative flex shrink-0 items-center justify-center font-bold uppercase tracking-tight text-white shadow-sm ${sizeClass} ${className}`}
    >
      <span className="truncate px-0.5">{label}</span>
    </span>
  );
}
