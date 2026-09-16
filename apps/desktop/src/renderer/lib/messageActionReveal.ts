/** Bubble chrome: always on below md; hover / focus-within from md up. */
export const MESSAGE_ACTION_REVEAL_CLASS =
  "opacity-100 transition-opacity duration-fast motion-reduce:transition-none md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100";

/** User bubble footer: in-flow below md; from md up overlay the list gap (full bubble width) so idle chrome doesn't pad the following assistant reply. */
export const USER_MESSAGE_CHROME_OVERLAY_CLASS =
  "md:absolute md:inset-x-0 md:top-full md:z-10 md:flex md:justify-end md:pt-1.5 md:pointer-events-none md:group-hover:pointer-events-auto md:focus-within:pointer-events-auto";
