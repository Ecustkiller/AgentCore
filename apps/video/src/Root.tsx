import "./core/styles.css";
import { Composition, Still } from "remotion";
import { ensurePromoFonts } from "./core/fonts";
import { filmsManifest } from "./films/manifest";
import { kitManifest } from "./kit/manifest";
import { stillsManifest } from "./stills/manifest";

ensurePromoFonts();

/** Remotion root — kit + stills + films. New film: add src/films/<id>/, register in films/manifest.ts. */
export const RemotionRoot: React.FC = () => {
  return (
    <>
      {kitManifest.compositions.map((c) => (
        <Composition
          key={c.id}
          id={c.id}
          component={c.component}
          durationInFrames={c.durationInFrames}
          fps={c.fps}
          width={c.width}
          height={c.height}
          defaultProps={c.defaultProps}
        />
      ))}

      {kitManifest.stills.map((s) => (
        <Still
          key={s.id}
          id={s.id}
          component={s.component}
          width={s.width}
          height={s.height}
          defaultProps={s.defaultProps}
        />
      ))}

      {stillsManifest.stills.map((s) => (
        <Still
          key={s.id}
          id={s.id}
          component={s.component}
          width={s.width}
          height={s.height}
          defaultProps={s.defaultProps}
        />
      ))}

      {filmsManifest.compositions.map((c) => (
        <Composition
          key={c.id}
          id={c.id}
          component={c.component}
          durationInFrames={c.durationInFrames}
          fps={c.fps}
          width={c.width}
          height={c.height}
        />
      ))}
    </>
  );
};
