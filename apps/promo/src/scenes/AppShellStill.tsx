import { AbsoluteFill } from "remotion";
import { PromoCanvas } from "../chrome/PromoCanvas";
import { PromoShell } from "../chrome/PromoShell";

/*
 * 领衔 promo still: the full desktop shell (TitleBar + Sidebar) with the product's
 * 对话级画布 (Canvas view) running inside the main area — the one image that says both
 * "this is a real product" and "a real team is alive in it", shown through the actual
 * Canvas UX (turn spine + a focused turn expanded into its live worker DAG + the 常驻
 * 命令栏). Reuses the real chrome pieces: PromoShell + PromoCanvas (which embeds the
 * real GraphStage butterfly), frozen at a settled mid-run frame.
 */

// 4:3 desktop window (unified promo ratio): 1920×1440. The shell is responsive, so a
// taller window is a faithful screenshot — it just gives the Canvas spine more room.
export const APPSHELL_W = 1920;
export const APPSHELL_H = 1440;

export function AppShellStill() {
  return (
    <AbsoluteFill className="bg-background">
      <PromoShell>
        <PromoCanvas />
      </PromoShell>
    </AbsoluteFill>
  );
}
