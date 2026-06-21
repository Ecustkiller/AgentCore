import DownloadPanel from "@/components/DownloadPanel";
import {
  DESKTOP_VERSION,
  DOWNLOAD_PAGE_PATH,
  INSTALL_STEPS,
} from "@/lib/download";
import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: `下载 AgentCore ${DESKTOP_VERSION} — 协作智能平台`,
  description:
    "下载 AgentCore 桌面客户端 for Windows。Multi-Agent 协作工作台，自动更新，全程可见的团队执行。",
};

function BrandMark() {
  return (
    <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true">
      <line x1="6" y1="7" x2="13" y2="13" stroke="var(--border)" strokeWidth="1.5" />
      <line x1="20" y1="7" x2="13" y2="13" stroke="var(--border)" strokeWidth="1.5" />
      <line x1="7" y1="20" x2="13" y2="13" stroke="var(--border)" strokeWidth="1.5" />
      <circle cx="13" cy="13" r="3.4" fill="var(--primary)" />
      <circle cx="6" cy="7" r="2.2" fill="var(--brand-2)" />
      <circle cx="20" cy="7" r="2.2" fill="var(--brand-2)" />
      <circle cx="7" cy="20" r="2.2" fill="var(--brand-2)" />
    </svg>
  );
}

export default function DownloadPage() {
  return (
    <div className="relative min-h-screen">
      <header className="sticky top-0 z-50 border-b border-border/60 bg-[color-mix(in_oklab,var(--background),transparent_25%)] backdrop-blur-xl">
        <nav className="container-x flex h-16 items-center justify-between">
          <Link href="/" className="flex items-center gap-2.5">
            <BrandMark />
            <span className="text-[1.05rem] font-bold tracking-tight">AgentCore</span>
          </Link>
          <Link href="/" className="text-sm text-muted-foreground hover:text-foreground">
            ← 返回首页
          </Link>
        </nav>
      </header>

      <main className="container-x py-16 sm:py-24">
        <div className="mx-auto max-w-4xl text-center">
          <p className="eyebrow">Desktop · v{DESKTOP_VERSION}</p>
          <h1 className="mt-4 text-4xl font-bold tracking-tight sm:text-5xl">
            下载 AgentCore 桌面客户端
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-lg leading-relaxed text-muted-foreground">
            面向 Windows 的 Multi-Agent 协作工作台。
          </p>
        </div>

        <div className="mx-auto mt-12 max-w-4xl">
          <DownloadPanel />
        </div>

        <section className="mx-auto mt-16 max-w-3xl">
          <h2 className="text-center text-xl font-bold">安装步骤</h2>
          <ol className="mt-8 space-y-4">
            {INSTALL_STEPS.map((step, i) => (
              <li key={step} className="surface flex gap-4 p-5">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-sm font-bold text-primary">
                  {i + 1}
                </span>
                <p className="pt-1 text-muted-foreground">{step}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="mx-auto mt-16 max-w-3xl rounded-2xl border border-border/70 bg-card/40 p-8 text-center">
          <h2 className="text-lg font-bold">已有客户端？</h2>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
            打开 AgentCore → 设置 → 关于 → 检查更新。新版本会在后台下载，就绪后提示重启安装。
          </p>
        </section>
      </main>

      <footer className="border-t border-border/60 py-8">
        <div className="container-x text-center text-sm text-muted-foreground">
          <Link href="/" className="hover:text-foreground">
            fashitianxia.xyz
          </Link>
          <span className="mx-2">·</span>
          <span>{DOWNLOAD_PAGE_PATH}</span>
        </div>
      </footer>
    </div>
  );
}
