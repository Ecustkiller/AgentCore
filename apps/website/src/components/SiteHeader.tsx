"use client";

import { useEffect, useState } from "react";
import BrandMark from "@/components/BrandMark";
import { useLang } from "@/components/LangProvider";
import { BRAND, CTA, NAV } from "@/content/home";
import { DOWNLOAD_PAGE_PATH, MOBILE_WEB_URL, WEB_APP_URL } from "@/lib/download";

/**
 * 通栏 sticky 顶栏（适配旧站结构，不是照搬）。
 *
 * 布局：左品牌 · 中分区锚点 · 右语言 / 次操作 / 主 CTA。
 * UI：石墨半透明毛玻璃 + 底缘钢蓝阅读进度；主 CTA 用实心 primary，
 * 不做白胶囊、不做彩虹渐变钮。
 *
 * `home={false}`：子页不列分区锚点，次操作改为「返回首页」。
 */
export default function SiteHeader({ home = true }: { home?: boolean }) {
  const { lang, t, toggle } = useLang();
  const [progress, setProgress] = useState(0);
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const y = window.scrollY;
        const max = document.body.scrollHeight - window.innerHeight;
        setProgress(max > 0 ? Math.min(1, y / max) : 0);
        setScrolled(y > 24);
      });
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [menuOpen]);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  const anchor = (href: string) => (home ? href : `/${href}`);

  return (
    <>
      <header className="site-header fixed inset-x-0 top-0 z-[100]">
        <div
          className="absolute inset-0 transition-[background-color,border-color,backdrop-filter] duration-300"
          style={{
            backgroundColor: scrolled
              ? "color-mix(in oklab, var(--background), transparent 12%)"
              : "color-mix(in oklab, var(--background), transparent 55%)",
            backdropFilter: scrolled ? "blur(16px)" : "blur(10px)",
            WebkitBackdropFilter: scrolled ? "blur(16px)" : "blur(10px)",
            borderBottom: `1px solid ${scrolled ? "var(--border)" : "var(--border-soft)"}`,
          }}
        />
        <div
          aria-hidden="true"
          className="absolute bottom-0 left-0 h-px origin-left bg-[var(--primary)]"
          style={{
            width: "100%",
            transform: `scaleX(${progress})`,
            opacity: scrolled ? 0.9 : 0.55,
          }}
        />

        <div className="container-x relative flex h-14 items-center justify-between gap-6 sm:h-16">
          <a
            href={home ? "#top" : "/"}
            className="flex shrink-0 items-center gap-2.5"
            onClick={() => setMenuOpen(false)}
          >
            <BrandMark size={22} />
            <span className="text-[1.05rem] font-semibold tracking-[-0.02em] text-foreground">
              {BRAND}
            </span>
            <span className="hidden rounded-md border border-border px-2 py-0.5 text-[0.6875rem] text-muted-foreground xl:inline">
              {lang === "zh" ? "协作智能平台" : "Collab intelligence"}
            </span>
          </a>

          {home && (
            <nav className="absolute left-1/2 hidden -translate-x-1/2 items-center gap-7 lg:flex">
              {NAV.map((item) => (
                <a key={item.href} href={item.href} className="site-nav-link">
                  {t(item.label)}
                </a>
              ))}
            </nav>
          )}

          <div className="flex items-center gap-2 sm:gap-3">
            <button
              type="button"
              onClick={toggle}
              aria-label={lang === "zh" ? "Switch to English" : "切换到中文"}
              className="site-lang"
            >
              <span className={lang === "zh" ? "text-foreground" : "text-faint"}>
                中
              </span>
              <span className="text-ghost">/</span>
              <span className={lang === "en" ? "text-foreground" : "text-faint"}>
                EN
              </span>
            </button>

            <a
              href={home ? DOWNLOAD_PAGE_PATH : "/"}
              className="site-nav-link hidden sm:inline-flex"
            >
              {t(home ? CTA.desktop : CTA.backHome)}
            </a>

            {home && (
              <a
                href={MOBILE_WEB_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="site-nav-link hidden md:inline-flex"
              >
                {t(CTA.mobileWeb)}
              </a>
            )}

            <a
              href={WEB_APP_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-primary hidden h-9 px-3.5 py-0 text-[0.8125rem] sm:inline-flex"
            >
              {t(CTA.webAppShort)}
              <span aria-hidden="true" className="text-[0.7rem] opacity-80">
                ↗
              </span>
            </a>

            {home && (
              <button
                type="button"
                onClick={() => setMenuOpen((v) => !v)}
                aria-expanded={menuOpen}
                aria-label={menuOpen ? "关闭菜单" : "打开菜单"}
                className="flex h-9 w-10 flex-col items-center justify-center gap-[5px] rounded-lg border border-border lg:hidden"
              >
                <span
                  className="block h-[1.5px] w-4 rounded-sm bg-foreground/80 transition-transform duration-300"
                  style={
                    menuOpen
                      ? { transform: "translateY(3.25px) rotate(45deg)" }
                      : undefined
                  }
                />
                <span
                  className="block h-[1.5px] w-4 rounded-sm bg-foreground/80 transition-transform duration-300"
                  style={
                    menuOpen
                      ? { transform: "translateY(-3.25px) rotate(-45deg)" }
                      : undefined
                  }
                />
              </button>
            )}
          </div>
        </div>
      </header>

      <div
        className={`fixed inset-x-0 bottom-0 top-14 z-[99] flex-col bg-[color-mix(in_oklab,var(--background),transparent_4%)] px-5 py-5 backdrop-blur-xl sm:top-16 lg:hidden ${
          home && menuOpen ? "flex" : "hidden"
        }`}
      >
        {NAV.map((item, i) => (
          <a
            key={item.href}
            href={anchor(item.href)}
            onClick={() => setMenuOpen(false)}
            className="flex min-h-14 items-center justify-between border-b border-border-soft text-[1.25rem] font-medium text-foreground"
          >
            {t(item.label)}
            <span className="font-mono text-[0.6875rem] text-ghost">
              {String(i + 1).padStart(2, "0")}
            </span>
          </a>
        ))}
        <a
          href={DOWNLOAD_PAGE_PATH}
          onClick={() => setMenuOpen(false)}
          className="flex min-h-14 items-center justify-between border-b border-border-soft text-[1.25rem] font-medium text-foreground"
        >
          {t(CTA.desktop)}
          <span className="font-mono text-[0.6875rem] text-ghost">
            {String(NAV.length + 1).padStart(2, "0")}
          </span>
        </a>
        <a
          href={MOBILE_WEB_URL}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => setMenuOpen(false)}
          className="flex min-h-14 items-center justify-between border-b border-border-soft text-[1.25rem] font-medium text-foreground"
        >
          {t(CTA.mobileWeb)}
          <span className="font-mono text-[0.6875rem] text-ghost">
            {String(NAV.length + 2).padStart(2, "0")}
          </span>
        </a>
        <a
          href={WEB_APP_URL}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => setMenuOpen(false)}
          className="btn btn-primary mt-4 w-full"
        >
          {t(CTA.webApp)}
          <span aria-hidden="true" className="text-[0.75rem]">
            ↗
          </span>
        </a>
      </div>
    </>
  );
}
