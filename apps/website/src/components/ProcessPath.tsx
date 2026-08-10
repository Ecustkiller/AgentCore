"use client";

import { useEffect, useRef, useState } from "react";
import { useLang } from "@/components/LangProvider";
import { CTA, MECHANISM } from "@/content/home";
import { WEB_APP_URL } from "@/lib/download";

/**
 * 四步机制：紧凑 2×2 网格（宽屏）/ 竖列（窄屏）。
 *
 * 旧版之字形蛇形光路占 ~1340px 高，竖向太长；现改为网格收高度，
 * 仍用单一滚动进度驱动卡片点亮与末端 CTA。
 */

const CARD_AT = [0, 0.22, 0.45, 0.68];
const ACCENT = ["var(--pp-c1)", "var(--pp-c2)", "var(--pp-c3)", "var(--pp-c4)"];
const GRID_AT = 720;

const STIFFNESS = 70;
const DAMPING = 22;
const MASS = 0.7;
const REST = 0.001;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const ease = (raw: number) =>
  raw <= 0.7 ? (raw / 0.7) * 0.8 : 0.8 + ((raw - 0.7) / 0.3) * 0.2;

const ICONS = [
  <path
    key="i0"
    d="M4 5.5h16v10H9l-5 3.5z"
    strokeLinejoin="round"
    strokeLinecap="round"
  />,
  <g key="i1" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="9" cy="8" r="3" />
    <path d="M3 19a6 6 0 0 1 12 0" />
    <path d="M16.5 6.2a3 3 0 0 1 0 5.6M17 14.4A5.5 5.5 0 0 1 21 19" />
  </g>,
  <g key="i2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="5" cy="12" r="2" />
    <circle cx="19" cy="6" r="2" />
    <circle cx="19" cy="18" r="2" />
    <path d="M7 11.2 17 6.6M7 12.8l10 4.6" />
  </g>,
  <g key="i3" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="8.2" />
    <path d="m8.4 12.2 2.6 2.6 4.6-5" />
  </g>,
];

export default function ProcessPath() {
  const { t } = useLang();
  const hostRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLSpanElement>(null);
  const progressRef = useRef<HTMLDivElement>(null);
  const ctaRef = useRef<HTMLDivElement>(null);
  const slotRefs = useRef<(HTMLDivElement | null)[]>([]);
  const kickRef = useRef<((snap?: boolean) => void) | null>(null);
  const [wide, setWide] = useState(true);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const ro = new ResizeObserver(([e]) =>
      setWide(e.contentRect.width >= GRID_AT),
    );
    ro.observe(host);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const paint = (p: number) => {
      if (railRef.current) railRef.current.style.transform = `scaleY(${p})`;
      if (progressRef.current) {
        progressRef.current.style.setProperty("--pp-p", String(p));
      }
      if (ctaRef.current) {
        const k = clamp01((p - 0.82) / 0.18);
        ctaRef.current.style.filter = `brightness(${0.55 + 0.45 * k}) saturate(${
          0.4 + 0.6 * k
        })`;
      }
      slotRefs.current.forEach((el, i) => {
        el?.classList.toggle("is-active", p > CARD_AT[i]);
      });
    };

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      paint(1);
      kickRef.current = () => paint(1);
      return () => {
        kickRef.current = null;
      };
    }

    let raf = 0;
    let last = 0;
    let target = 0;
    let primed = false;
    const spring = { x: 0, v: 0 };

    const step = (now: number) => {
      const dt = last ? Math.min(0.032, (now - last) / 1000) : 1 / 60;
      last = now;

      const el = trackRef.current;
      if (el) {
        const r = el.getBoundingClientRect();
        const vh = window.innerHeight;
        target = ease(clamp01((vh * 0.85 - r.top) / (r.height + vh * 0.35)));
      }

      if (!primed) {
        primed = true;
        spring.x = target;
        paint(target);
        raf = requestAnimationFrame(step);
        return;
      }

      const a = (-STIFFNESS * (spring.x - target) - DAMPING * spring.v) / MASS;
      spring.v += a * dt;
      spring.x += spring.v * dt;

      if (Math.abs(target - spring.x) < REST && Math.abs(spring.v) < REST) {
        spring.x = target;
        spring.v = 0;
        paint(spring.x);
        raf = 0;
        last = 0;
        return;
      }
      paint(spring.x);
      raf = requestAnimationFrame(step);
    };

    const kick = (snap = false) => {
      if (snap) primed = false;
      if (!raf) {
        last = 0;
        raf = requestAnimationFrame(step);
      }
    };
    kickRef.current = kick;

    const onScroll = () => kick();
    kick();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      kickRef.current = null;
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, []);

  useEffect(() => {
    kickRef.current?.(true);
  }, [wide]);

  useEffect(() => {
    const els = slotRefs.current.filter(Boolean) as HTMLDivElement[];
    if (!els.length) return;

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      els.forEach((el) => el.classList.add("is-in"));
      return;
    }

    const io = new IntersectionObserver(
      (entries) =>
        entries.forEach((e) => {
          if (!e.isIntersecting) return;
          e.target.classList.add("is-in");
          io.unobserve(e.target);
        }),
      { rootMargin: "0px 0px -60px 0px" },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [wide]);

  const steps = MECHANISM.steps;

  const card = (i: number) => (
    <article className="pp-card">
      <span className="pp-icon-wrap" aria-hidden="true">
        <span className="pp-icon">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
          >
            {ICONS[i]}
          </svg>
        </span>
      </span>
      <p className="pp-step">{steps[i].idx}</p>
      <h3 className="pp-title">{t(steps[i].title)}</h3>
      <p className="pp-body">{t(steps[i].body)}</p>
    </article>
  );

  return (
    <div ref={hostRef} className={`pp ${wide ? "pp-wide" : "pp-column"}`.trim()}>
      <div aria-hidden="true" className="pp-aurora" />

      <div ref={trackRef} className={wide ? "pp-grid" : "pp-list"}>
        {wide && (
          <div
            ref={progressRef}
            aria-hidden="true"
            className="pp-progress"
            style={{ ["--pp-p" as string]: 0 }}
          />
        )}
        {!wide && (
          <>
            <span aria-hidden="true" className="pp-rail" />
            <span ref={railRef} aria-hidden="true" className="pp-rail-glow" />
          </>
        )}

        {steps.map((stepItem, i) => (
          <div
            key={stepItem.idx}
            ref={(el) => {
              slotRefs.current[i] = el;
            }}
            className={`pp-slot${wide ? "" : " pp-slot-row"}${i === 0 ? " is-in" : ""}`}
            style={
              {
                "--pp-accent": ACCENT[i],
                transitionDelay: `${i * 70}ms`,
              } as React.CSSProperties
            }
          >
            {!wide && <span aria-hidden="true" className="pp-dot" />}
            {card(i)}
          </div>
        ))}
      </div>

      <div ref={ctaRef} className="pp-cta">
        <a
          href={WEB_APP_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="pp-cta-btn"
        >
          <span aria-hidden="true" className="pp-cta-shine" />
          <span className="pp-cta-label">{t(CTA.webApp)}</span>
          <span aria-hidden="true" className="pp-cta-arrow">
            ↗
          </span>
        </a>
      </div>
    </div>
  );
}
