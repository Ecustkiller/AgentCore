import { useState } from "react";
import { avatarSrc } from "./chatDisplay";

/**
 * The single IM circle: optional contract `avatar_url` (image + onError → letter),
 * else the themed initial, plus the existing online green dot.
 */
export function PresenceAvatar({
  label,
  sizeClass,
  textClass,
  online = false,
  url,
  onClick,
  ariaLabel,
}: {
  /** Fallback initial (already `avatarInitial(name)`). */
  label: string;
  sizeClass: string;
  textClass: string;
  online?: boolean;
  /** Contract `avatar_url` or an already-absolute URL. Null = letter, no request. */
  url?: string | null;
  onClick?: () => void;
  ariaLabel?: string;
}) {
  const src = avatarSrc(url);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const showImg = src != null && src !== failedSrc;

  const circle = (
    <span className={`relative flex shrink-0 ${sizeClass}`}>
      <span
        className={`flex size-full items-center justify-center rounded-full font-medium text-primary ${
          showImg ? "overflow-hidden" : "bg-primary/10"
        }`}
      >
        {showImg ? (
          <img
            src={src}
            alt=""
            className="size-full object-cover"
            onError={() => setFailedSrc(src)}
          />
        ) : (
          <span className={textClass}>{label}</span>
        )}
      </span>
      {online && (
        <span
          aria-label="在线"
          className="absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full bg-success ring-2 ring-background"
        />
      )}
    </span>
  );

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-label={ariaLabel}
        className="shrink-0 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {circle}
      </button>
    );
  }
  return circle;
}
