import { Composition, Still } from 'remotion';
import { Thumbnail } from './Thumbnail';
import timeline from './timeline.json';
import { Main, Teaser, TEASER_BEATS, teaserLength } from './Video';

export function Root() {
  const fps = timeline.fps;
  return (
    <>
      <Composition id="Main" component={Main} fps={fps} width={1920} height={1080} durationInFrames={Math.round(timeline.total * fps)} />
      <Composition id="Teaser" component={Teaser} fps={fps} width={1920} height={1080} durationInFrames={Math.round(teaserLength(TEASER_BEATS) * fps)} />
      <Still id="Thumbnail" component={Thumbnail} width={1920} height={1080} />
      <Still id="ProductImage" component={Thumbnail} width={1920} height={1080} defaultProps={{ product: true }} />
    </>
  );
}
