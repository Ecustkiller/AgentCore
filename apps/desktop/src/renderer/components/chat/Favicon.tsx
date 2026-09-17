import { cn } from "@/lib/utils";
import { BASE_URL } from "@/services/api";
import { useState } from "react";

/**
 * URL of the backend favicon proxy for a domain. The proxy fetches the site's
 * icon server-side (relaxed TLS + `<link rel=icon>` discovery + caching), which is
 * far more reliable than the renderer hitting `https://{site}/favicon.ico` directly
 * — a China-hosted client fails the TLS handshake for many `*.gov.cn` sites. A
 * resolvable icon comes back as image bytes; an unresolvable one as 404, so the
 * `<img>` `onError` fallback still applies.
 */
export function faviconUrl(domain: string): string {
  return `${BASE_URL}/v1/favicon?domain=${encodeURIComponent(domain)}`;
}

/**
 * Site favicon avatar. Loads via the backend proxy ({@link faviconUrl}); on
 * failure (or unparseable host) falls back to a letter.
 *
 * The box's `em` is the box itself (`font-size` = `size`), so a sentence-level
 * `"1em"` matches the surrounding text. Do not put a smaller `text-*` class on
 * this node — that would shrink `width: 1em` with the letter. Letter scale lives
 * on an inner span. Inline alignment is Font Awesome's `vertical-align: -0.125em`
 * (not `text-bottom`, which parks a 1em box on the descender).
 */
export function Favicon({
  site,
  title,
  size = 16,
  className,
}: {
  /** Display hostname (sans leading www.); empty when the URL had no host. */
  site?: string;
  /** Fallback letter source when there's no host. */
  title?: string;
  /** CSS length. Numbers are px (chrome rows); `"1em"` for sentence-level marks. */
  size?: number | string;
  /** Extra classes on the avatar wrapper (e.g. an overlap ring). */
  className?: string;
}) {
  const domain = site?.trim();
  // Track the domain whose favicon failed (not a bare bool) so a re-rendered mark
  // pointing at a *different* source retries the image instead of staying blank.
  const [failedDomain, setFailedDomain] = useState<string | null>(null);

  const letter = (domain || title || "?").charAt(0).toUpperCase();
  const showImg = !!domain && failedDomain !== domain;

  return (
    <span
      className={cn(
        "inline-block shrink-0 overflow-hidden rounded-full bg-muted align-[-0.125em] leading-none text-muted-foreground",
        className,
      )}
      style={{ width: size, height: size, fontSize: size }}
      aria-hidden
    >
      {showImg ? (
        <img
          src={faviconUrl(domain)}
          alt=""
          loading="lazy"
          onError={() => setFailedDomain(domain)}
          className="block size-full object-contain"
        />
      ) : (
        <span className="flex size-full items-center justify-center text-[0.65em] font-medium leading-none">
          {letter}
        </span>
      )}
    </span>
  );
}
