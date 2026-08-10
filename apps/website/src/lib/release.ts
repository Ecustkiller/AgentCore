export type DesktopChannelArtifacts = {
  version: string;
  releaseNotesUrl: string;
  winUrl: string;
  winFilename: string;
  macUrl: string;
  macFilename: string;
};

export type ReleaseArtifacts = DesktopChannelArtifacts & {
  androidUrl: string;
  androidFilename: string;
  androidVersion: string;
  /** 测试通道；无资产时为 null（官网隐藏次入口）。 */
  beta: DesktopChannelArtifacts | null;
};

export const DESKTOP_RELEASE_API = "/api/desktop-release" as const;
